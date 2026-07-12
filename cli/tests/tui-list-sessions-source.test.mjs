/**
 * tui-list-sessions-source.test.mjs — behavioral guards for protocol-first
 * session listing in the TUI resume picker.
 *
 * The picker's rows must be served by the daemon's `list_sessions` RPC when
 * a daemon is connected (the same wire contract the mobile drawer consumes),
 * with the direct `deps.listSessions()` disk read demoted to a fallback for
 * the inline path and older daemons. These tests drive the real startup flow
 * headlessly (`tui-driver.mjs`): the stub daemon serves canned rows while the
 * injected disk lister returns nothing, so the picker opening at all proves
 * which source fed it. Companion to the static ratchet in
 * `tui-import-boundary.test.mjs` — that one pins the imports, this one pins
 * the runtime routing.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHeadlessTui } from './tui-driver.mjs';

function cannedRow(overrides = {}) {
  return {
    sessionId: 'sess_daemonrow_abc123',
    updatedAt: Date.now(),
    provider: 'zen',
    model: 'test-model',
    cwd: process.cwd(),
    sessionName: 'from-daemon',
    lastUserMessage: 'served over the socket',
    mode: 'tui',
    state: 'idle',
    activeRunId: null,
    ...overrides,
  };
}

describe('TUI resume picker session-listing source', () => {
  let tui = null;
  afterEach(async () => {
    if (tui) await tui.stop();
    tui = null;
  });

  it('serves picker rows from the daemon list_sessions RPC, not the disk lister', async () => {
    const row = cannedRow();
    tui = await startHeadlessTui({
      verbResponses: {
        list_sessions: { kind: 'response', ok: true, payload: { sessions: [row] } },
      },
    });

    // The harness disk lister returns [] — the startup picker can only open
    // if the RPC rows reached it.
    const opened = await tui.waitFor(
      () => tui.tuiState?.resumeModalState && tui.tuiState.resumeModalState.loading === false,
    );
    assert.ok(opened, 'startup resume picker should open from RPC-served rows');
    assert.deepEqual(
      tui.tuiState.resumeModalState.rows.map((r) => r.sessionId),
      [row.sessionId],
      'picker rows should be the daemon-served entries',
    );

    const listRequests = tui.requestsOfType('list_sessions');
    assert.ok(listRequests.length >= 1, 'listing should go over the socket');
    for (const req of listRequests) {
      assert.equal(req.payload?.limit, 1000, 'listing should request the server-side cap');
    }

    // Close the picker before teardown: the modal input handler swallows the
    // Ctrl+D that `stop()` sends, and a TUI that never exits keeps its
    // intervals alive — the test child then hangs the whole `--test` run.
    await tui.feed('\x1b');
  });

  it('falls back to the disk lister with a structured warn on a malformed RPC payload', async () => {
    tui = await startHeadlessTui({
      verbResponses: {
        // ok but no sessions array — a broken daemon, not an absent one.
        list_sessions: { kind: 'response', ok: true, payload: {} },
      },
    });

    // Fallback disk lister returns [] → no sessions → no startup picker.
    await tui.waitFor(() => tui.requestsOfType('list_sessions').length >= 1);
    assert.equal(tui.tuiState?.resumeModalState ?? null, null, 'picker should not open');
    const warn = tui.stderrChunks.find((c) => c.includes('tui_list_sessions_rpc_failed'));
    assert.ok(warn, 'malformed payload fallback must emit the structured warn line');
    assert.match(warn, /MALFORMED_PAYLOAD/);
  });

  it('falls back quietly when the daemon predates the verb', async () => {
    tui = await startHeadlessTui({
      verbResponses: {
        list_sessions: { rejectCode: 'UNSUPPORTED_REQUEST_TYPE', message: 'old daemon' },
      },
    });

    await tui.waitFor(() => tui.requestsOfType('list_sessions').length >= 1);
    assert.equal(tui.tuiState?.resumeModalState ?? null, null, 'picker should not open');
    assert.equal(
      tui.stderrChunks.find((c) => c.includes('tui_list_sessions_rpc_failed')),
      undefined,
      'expected fallbacks (older daemon) must stay quiet',
    );
  });
});
