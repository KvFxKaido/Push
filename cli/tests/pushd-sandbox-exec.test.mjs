/**
 * pushd-sandbox-exec.test.mjs — Coverage for the WS-reachable
 * `sandbox_exec` and `daemon_identify` request handlers added in
 * PR 3c.1 of the remote-sessions track. Drives `handleRequest`
 * directly (Unix-socket-compatible signature) so the dispatcher
 * path is exercised alongside the per-handler logic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../pushd.ts';
import { PROTOCOL_VERSION } from '../../lib/protocol-schema.ts';

const NOOP_EMIT = () => {};

function makeRequest(type, payload = {}) {
  return {
    v: PROTOCOL_VERSION,
    kind: 'request',
    requestId: `req_test_${type}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    sessionId: null,
    payload,
  };
}

describe('sandbox_exec', () => {
  it('runs a successful command and returns exit code 0 with captured stdout', async () => {
    const res = await handleRequest(
      makeRequest('sandbox_exec', { command: 'echo hello-3c1' }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true, 'RPC should succeed');
    assert.equal(res.type, 'sandbox_exec');
    assert.equal(res.payload.exitCode, 0);
    assert.match(res.payload.stdout, /hello-3c1/);
    assert.equal(typeof res.payload.durationMs, 'number');
    assert.equal(res.payload.truncated, false);
  });

  it('reports a non-zero exit code without flipping ok to false', async () => {
    // Non-zero exits are normal results, not RPC failures — the model
    // needs to see the exit code to diagnose. Forcing ok=false here
    // would conflate "transport failed" with "command failed."
    const res = await handleRequest(
      makeRequest('sandbox_exec', { command: 'sh -c "exit 7"' }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true, 'RPC succeeded — the command ran');
    assert.equal(res.payload.exitCode, 7);
  });

  it('rejects an empty or missing command with INVALID_REQUEST', async () => {
    const missing = await handleRequest(makeRequest('sandbox_exec', {}), NOOP_EMIT);
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'INVALID_REQUEST');

    const empty = await handleRequest(makeRequest('sandbox_exec', { command: '' }), NOOP_EMIT);
    assert.equal(empty.ok, false);
    assert.equal(empty.error.code, 'INVALID_REQUEST');
  });

  it('respects timeoutMs and surfaces timedOut: true on kill', async () => {
    const res = await handleRequest(
      makeRequest('sandbox_exec', { command: 'sleep 10', timeoutMs: 1_000 }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true, 'RPC succeeded — the command ran but was killed');
    assert.equal(res.payload.timedOut, true);
    // The timer-kill exit code varies by platform; 124 is the shell
    // convention for timeout, but a SIGTERM-killed Node child may
    // surface as `null` → coerced to 124 in the handler. Either way
    // it's non-zero.
    assert.notEqual(res.payload.exitCode, 0);
  });

  it('runs in the daemon process cwd by default', async () => {
    const res = await handleRequest(makeRequest('sandbox_exec', { command: 'pwd' }), NOOP_EMIT);
    assert.equal(res.ok, true);
    assert.equal(res.payload.exitCode, 0);
    // Trim trailing newline; pwd may add one.
    assert.equal(res.payload.stdout.trim(), process.cwd());
  });
});

describe('daemon_identify', () => {
  // Phase 3 slice 2 made daemon_identify read from the auth principal
  // (which can be either a device or an attach token) rather than the
  // legacy `record` field. The shape used to be `{ record }`; tests
  // here now exercise `{ auth }`. The handler resolves the parent
  // device tokenId so attach-token-authed clients see the device
  // identity, not the rotating attach tokenId.
  function deviceAuth(tokenId, boundOrigin = 'http://localhost:5173') {
    return {
      kind: 'device',
      tokenId,
      parentDeviceTokenId: tokenId,
      boundOrigin,
      lastUsedAt: null,
      deviceRecord: {
        tokenId,
        boundOrigin,
        tokenHash: 'irrelevant',
        createdAt: 0,
        lastUsedAt: null,
      },
    };
  }

  it('returns the bound identity for a device-token-authed WS', async () => {
    const auth = deviceAuth('pdt_test_12345');
    const res = await handleRequest(makeRequest('daemon_identify'), NOOP_EMIT, { auth });
    assert.equal(res.ok, true);
    assert.equal(res.payload.tokenId, 'pdt_test_12345');
    assert.equal(res.payload.boundOrigin, 'http://localhost:5173');
    assert.equal(res.payload.authKind, 'device');
    assert.equal(typeof res.payload.daemonVersion, 'string');
    assert.equal(res.payload.protocolVersion, PROTOCOL_VERSION);
  });

  it('returns the PARENT device identity for an attach-token-authed WS', async () => {
    const auth = {
      kind: 'attach',
      tokenId: 'pdat_caller',
      parentDeviceTokenId: 'pdt_parent_1',
      boundOrigin: 'http://localhost:5173',
      lastUsedAt: null,
      deviceRecord: null,
    };
    const res = await handleRequest(makeRequest('daemon_identify'), NOOP_EMIT, { auth });
    assert.equal(res.ok, true);
    // Attach-tokenId is intentionally NOT leaked — the surface is
    // device-identity, not connection-identity. The client knows its
    // own attach tokenId from the mint response.
    assert.equal(res.payload.tokenId, 'pdt_parent_1');
    assert.equal(res.payload.authKind, 'attach');
  });

  it('refuses without an auth context (Unix-socket transport)', async () => {
    const res = await handleRequest(makeRequest('daemon_identify'), NOOP_EMIT);
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'UNSUPPORTED_VIA_TRANSPORT');
  });
});
