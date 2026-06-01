/**
 * pushd-sandbox-exec-cancel.test.mjs — Coverage for the daemon-side
 * mid-run cancellation surface added in Phase 1.f of the remote-
 * sessions track. `handleSandboxExec` registers its child's
 * AbortController in the per-WS `wsState.activeRuns` map, keyed by
 * the `runId` in the payload; `handleCancelRun` with an empty
 * `sessionId` + matching `runId` aborts the child on the SAME
 * connection.
 *
 * Drives `handleRequest` directly with a synthesized `wsState` so the
 * per-connection scoping is exercised without booting a real WS.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../pushd.ts';
import { PROTOCOL_VERSION } from '../../lib/protocol-schema.ts';

const NOOP_EMIT = () => {};

function makeRequest(type, payload = {}, sessionId = null) {
  return {
    v: PROTOCOL_VERSION,
    kind: 'request',
    requestId: `req_test_${type}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    sessionId,
    payload,
  };
}

function makeWsState() {
  return { activeRuns: new Map() };
}

describe('sandbox_exec + cancel_run (Phase 1.f mid-run cancel)', () => {
  it('runs without a runId or wsState and behaves like the legacy path', async () => {
    const res = await handleRequest(
      makeRequest('sandbox_exec', { command: 'echo legacy' }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.exitCode, 0);
    assert.notEqual(res.payload.cancelled, true);
  });

  it('registers the in-flight child in wsState.activeRuns under the runId', async () => {
    const wsState = makeWsState();
    const runId = 'run_test_register';
    // Use a short sleep so the assertion lands while the child is
    // still running. Fire-and-await — the assert runs from a parallel
    // setTimeout that races the exec.
    const execPromise = handleRequest(
      makeRequest('sandbox_exec', { command: 'sleep 0.3', runId, timeoutMs: 5_000 }),
      NOOP_EMIT,
      { wsState },
    );
    // Give the handler a tick to register the controller.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(wsState.activeRuns.has(runId), true, 'controller registered during exec');
    const res = await execPromise;
    assert.equal(res.ok, true);
    assert.equal(wsState.activeRuns.has(runId), false, 'controller cleared in finally');
    assert.equal(res.payload.exitCode, 0);
    assert.notEqual(res.payload.cancelled, true);
  });

  it('cancel_run with matching runId aborts the in-flight child', async () => {
    const wsState = makeWsState();
    const runId = 'run_test_cancel';
    // Long sleep so the cancel definitely lands first.
    const execPromise = handleRequest(
      makeRequest('sandbox_exec', { command: 'sleep 30', runId, timeoutMs: 60_000 }),
      NOOP_EMIT,
      { wsState },
    );
    await new Promise((r) => setTimeout(r, 50));
    const cancelRes = await handleRequest(makeRequest('cancel_run', { runId }), NOOP_EMIT, {
      wsState,
    });
    assert.equal(cancelRes.ok, true);
    assert.equal(cancelRes.payload.accepted, true);
    assert.equal(cancelRes.payload.runId, runId);
    const execRes = await execPromise;
    // The exec still resolves with ok=true (non-zero exit is not an
    // RPC failure) but carries cancelled: true so the caller can
    // distinguish from a normal exit or timeout.
    assert.equal(execRes.ok, true);
    assert.equal(execRes.payload.cancelled, true);
    assert.equal(execRes.payload.timedOut, false);
  });

  it('cancel_run on a different wsState cannot reach the run', async () => {
    // The active-runs map is per-connection. A cancel arriving on a
    // different WS (different wsState object) MUST NOT find the
    // registered runId — that's the cross-connection isolation
    // guarantee the per-WS scoping exists to provide.
    const wsStateA = makeWsState();
    const wsStateB = makeWsState();
    const runId = 'run_test_cross_ws';
    const execPromise = handleRequest(
      makeRequest('sandbox_exec', { command: 'sleep 1', runId, timeoutMs: 5_000 }),
      NOOP_EMIT,
      { wsState: wsStateA },
    );
    await new Promise((r) => setTimeout(r, 50));
    const cancelRes = await handleRequest(makeRequest('cancel_run', { runId }), NOOP_EMIT, {
      wsState: wsStateB,
    });
    assert.equal(cancelRes.ok, false);
    assert.equal(cancelRes.error.code, 'NO_ACTIVE_RUN');
    // The exec on A finishes normally — B's cancel didn't touch it.
    const execRes = await execPromise;
    assert.notEqual(execRes.payload.cancelled, true, 'B cancel must not flag A as cancelled');
    assert.equal(execRes.payload.exitCode, 0);
  });

  it('cancel_run with only runId and no wsState refuses with NO_ACTIVE_RUN', async () => {
    // The Unix-socket caller doesn't pass wsState. A sessionless
    // cancel_run there has nowhere to look up the runId, so we refuse
    // cleanly — never accidentally fall back to a global map (which
    // would re-open the cross-connection vector).
    const res = await handleRequest(
      makeRequest('cancel_run', { runId: 'run_no_wsstate' }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'NO_ACTIVE_RUN');
  });

  it('cancel_run with neither sessionId nor runId refuses with INVALID_REQUEST', async () => {
    const res = await handleRequest(makeRequest('cancel_run', {}), NOOP_EMIT, {
      wsState: makeWsState(),
    });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_REQUEST');
  });

  it('cancel_run with an unknown runId refuses with NO_ACTIVE_RUN', async () => {
    const res = await handleRequest(
      makeRequest('cancel_run', { runId: 'run_does_not_exist' }),
      NOOP_EMIT,
      { wsState: makeWsState() },
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'NO_ACTIVE_RUN');
  });
});

// Remote Control Surface Audit #3: on the relay transport every paired phone
// shares ONE daemon-side wsState, so connection-scoping alone can't isolate
// them. The relay DO stamps a per-phone sender id onto each forwarded frame,
// surfaced to handlers as `context.relaySenderId`. A run records that as its
// `ownerId`; a sessionless cancel_run must arrive from the same sender id.
// Runs with no owner id (loopback — no relay sender) stay connection-scoped.
describe('sandbox_exec + cancel_run owner-id binding (Audit #3)', () => {
  it('records the relay sender id and accepts a cancel from the same phone', async () => {
    const wsState = makeWsState();
    const runId = 'run_owned_match';
    const senderId = 'phone-conn-aaaa';
    const execPromise = handleRequest(
      makeRequest('sandbox_exec', { command: 'sleep 30', runId, timeoutMs: 60_000 }),
      NOOP_EMIT,
      { wsState, relaySenderId: senderId },
    );
    await new Promise((r) => setTimeout(r, 50));
    // Registration carries the owner id alongside the controller.
    assert.equal(wsState.activeRuns.get(runId)?.ownerId, senderId);
    const cancelRes = await handleRequest(makeRequest('cancel_run', { runId }), NOOP_EMIT, {
      wsState,
      relaySenderId: senderId,
    });
    assert.equal(cancelRes.ok, true);
    assert.equal(cancelRes.payload.accepted, true);
    const execRes = await execPromise;
    assert.equal(execRes.payload.cancelled, true);
  });

  it('refuses a cancel from a different phone (NO_ACTIVE_RUN, no oracle)', async () => {
    const wsState = makeWsState();
    const runId = 'run_owned_wrong';
    const execPromise = handleRequest(
      makeRequest('sandbox_exec', { command: 'sleep 1', runId, timeoutMs: 5_000 }),
      NOOP_EMIT,
      { wsState, relaySenderId: 'phone-conn-aaaa' },
    );
    await new Promise((r) => setTimeout(r, 50));
    // A different phone sharing the same relay wsState guesses the runId, but
    // its DO-stamped sender id differs.
    const cancelRes = await handleRequest(makeRequest('cancel_run', { runId }), NOOP_EMIT, {
      wsState,
      relaySenderId: 'phone-conn-bbbb',
    });
    assert.equal(cancelRes.ok, false);
    // Reported as NO_ACTIVE_RUN — same shape as a non-existent runId, so the
    // other phone can't tell "exists, other owner" from "doesn't exist."
    assert.equal(cancelRes.error.code, 'NO_ACTIVE_RUN');
    const execRes = await execPromise;
    assert.notEqual(execRes.payload.cancelled, true, 'other-phone cancel must not abort the run');
    assert.equal(execRes.payload.exitCode, 0);
  });

  it('refuses an owned-run cancel that carries NO sender id', async () => {
    const wsState = makeWsState();
    const runId = 'run_owned_nosender';
    const execPromise = handleRequest(
      makeRequest('sandbox_exec', { command: 'sleep 1', runId, timeoutMs: 5_000 }),
      NOOP_EMIT,
      { wsState, relaySenderId: 'phone-conn-aaaa' },
    );
    await new Promise((r) => setTimeout(r, 50));
    const cancelRes = await handleRequest(makeRequest('cancel_run', { runId }), NOOP_EMIT, {
      wsState,
    });
    assert.equal(cancelRes.ok, false);
    assert.equal(cancelRes.error.code, 'NO_ACTIVE_RUN');
    const execRes = await execPromise;
    assert.notEqual(execRes.payload.cancelled, true);
  });

  it('an unowned run (loopback, no relay sender) still cancels with only the runId', async () => {
    // No relaySenderId on the context → ownerId is null → the legacy
    // connection-scoped behavior is preserved (loopback gives each connection
    // its own wsState, so the runId alone is sufficient).
    const wsState = makeWsState();
    const runId = 'run_loopback_unowned';
    const execPromise = handleRequest(
      makeRequest('sandbox_exec', { command: 'sleep 30', runId, timeoutMs: 60_000 }),
      NOOP_EMIT,
      { wsState },
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(wsState.activeRuns.get(runId)?.ownerId, null);
    const cancelRes = await handleRequest(makeRequest('cancel_run', { runId }), NOOP_EMIT, {
      wsState,
    });
    assert.equal(cancelRes.ok, true);
    assert.equal(cancelRes.payload.accepted, true);
    const execRes = await execPromise;
    assert.equal(execRes.payload.cancelled, true);
  });
});
