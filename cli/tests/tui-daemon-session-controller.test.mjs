/**
 * Integration tests for the DaemonSessionController extraction (TUI
 * Decomposition Phase 1, `cli/tui-daemon-session.ts`) through the Phase 0
 * headless harness — the REAL wiring: `runTUI` constructs the controller
 * with its hook seam, the stub daemon client stands in for pushd, and these
 * drive the lifecycle paths the session-verb characterization suite doesn't
 * touch: socket close → disconnect UI → backoff reconnect → recovery.
 *
 * Timing note: the reconnect coordinator's first retry fires after
 * RECONNECT_BACKOFF_MS[0] (1s), so the reconnect test genuinely waits that
 * out — the point is to pin the real timer path, not a simulated one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHeadlessTui } from './tui-driver.mjs';

const transcriptTexts = (h) =>
  (h.tuiState?.transcript ?? []).map((e) => (typeof e.text === 'string' ? e.text : ''));

describe('DaemonSessionController lifecycle (headless)', () => {
  it('socket close clears daemon state, announces, and reconnects on the backoff timer', async () => {
    const h = await startHeadlessTui();
    try {
      // Simulate a workspace-state chip so the disconnect path has something
      // to clear (the close hook owns this — snapshot source guard's runtime
      // counterpart).
      h.tuiState.workspaceStateView = { state: { activeBranch: 'main' } };

      h.stubClient._socket.emit('close');
      await h.waitFor(() =>
        transcriptTexts(h).some((t) => t.startsWith('Daemon disconnected. Reconnecting')),
      );
      assert.equal(h.tuiState.workspaceStateView, null, 'stale workspace chip must clear');
      assert.ok(
        transcriptTexts(h).some((t) =>
          t.includes('Daemon disconnected. Reconnecting in the background'),
        ),
        'disconnect must be announced once',
      );

      // The coordinator's first retry (1s backoff) re-dials through
      // `deps.tryConnect` — the stub accepts again and the controller
      // announces recovery.
      const reconnected = await h.waitFor(
        () => transcriptTexts(h).some((t) => t === 'Reconnected to pushd daemon.'),
        { timeoutMs: 4000 },
      );
      assert.ok(reconnected, 'backoff retry must reconnect through deps.tryConnect');

      // The recovered connection is usable: a session verb still round-trips
      // (fresh session — the headless run is not persisted, so the controller
      // start_sessions rather than attaching).
      await h.typeLine('/children');
      await h.waitFor(() => h.requestsOfType('list_children').length > 0);
      const sent = h.requestsOfType('list_children');
      assert.equal(sent.length, 1, 'verb round-trips after reconnect');
      assert.equal(sent[0].payload.sessionId, 'stub-session');
    } finally {
      await h.stop();
    }
  });

  it('a verb before any session bind lazily start_sessions through ensureReady', async () => {
    const h = await startHeadlessTui();
    try {
      // No message has been sent yet, so no session exists — the verb path
      // must bind one (attach falls through to start_session on a fresh,
      // unpersisted session) instead of failing.
      await h.typeLine('/revert 2');
      await h.waitFor(() => h.requestsOfType('session_revert').length > 0);
      const starts = h.requestsOfType('start_session');
      assert.equal(starts.length, 1, 'ensureReady must bind a session first');
      const verb = h.requestsOfType('session_revert')[0];
      assert.equal(verb.payload.sessionId, 'stub-session');
      assert.equal(verb.payload.attachToken, 'stub-token', 'bearer attached uniformly');
    } finally {
      await h.stop();
    }
  });
});
