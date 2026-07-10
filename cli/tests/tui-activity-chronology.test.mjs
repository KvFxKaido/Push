/**
 * Regression net for the #1402 activity-hierarchy follow-up (three defects that
 * survived review of the chronological-activity feature):
 *
 *   1. Orphaned phase on a transcript swap — a daemon resync (another client
 *      compacts/reverts) splices the transcript out from under the active group
 *      pointer, so subsequent thoughts/tools append into a group no longer in
 *      the transcript and never render.
 *   2. Chronology inversion — a status/warning/error/delegation entry did not
 *      close the active phase, so a later thought/tool folded back into the
 *      earlier group and rendered *above* the intervening entry.
 *   3. Unbounded phase growth — one phase had no item cap, and it reframes on
 *      every append (O(n^2) over a long run).
 *
 * Same harness as tui-remote-user-message.test.mjs: drive the REAL daemon-event
 * → handleEngineEvent → transcript-mutation path against the stub client via
 * `emitDaemonEvent`, then read `tuiState` directly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHeadlessTui } from './tui-driver.mjs';
import { MAX_ACTIVITY_ITEMS } from '../tui.ts';

function activityGroups(h) {
  return (h.tuiState?.transcript ?? []).filter((e) => e.role === 'activity_group');
}

let seqCounter = 0;
function emit(h, type, payload) {
  h.emitDaemonEvent({
    v: 1,
    kind: 'event',
    sessionId: 'stub-session',
    runId: 'run_test',
    seq: ++seqCounter,
    ts: Date.now(),
    type,
    payload,
  });
}

describe('TUI activity chronology (headless characterization)', () => {
  it('starts a new phase after an interrupting status entry, preserving order (#2)', async () => {
    const h = await startHeadlessTui({});
    try {
      const g0 = activityGroups(h).length;

      emit(h, 'tool_call', { toolName: 'read_file', args: { path: 'a.ts' } });
      await h.waitFor(() => activityGroups(h).length === g0 + 1);

      emit(h, 'status', { detail: 'Committing changes' });
      const statused = await h.waitFor(() =>
        (h.tuiState?.transcript ?? []).some(
          (e) => e.role === 'status' && e.text === 'Committing changes',
        ),
      );
      assert.ok(statused, 'status entry should land');
      // The interrupting entry must have closed the active phase.
      assert.equal(
        h.tuiState.activeActivityGroup,
        null,
        'a non-activity entry ends the current phase',
      );

      emit(h, 'tool_call', { toolName: 'write_file', args: { path: 'a.ts' } });
      await h.waitFor(() => activityGroups(h).length === g0 + 2);

      const t = h.tuiState.transcript;
      const gs = activityGroups(h);
      const g1 = gs.at(-2);
      const g2 = gs.at(-1);
      // The second tool started a fresh phase — it did NOT fold back into the
      // first group (which would render it above the status entry).
      assert.deepEqual(
        g1.items.map((i) => i.text),
        ['read_file'],
      );
      assert.deepEqual(
        g2.items.map((i) => i.text),
        ['write_file'],
      );
      const iG1 = t.indexOf(g1);
      const iG2 = t.indexOf(g2);
      const iStatus = t.findIndex(
        (e, i) => i > iG1 && e.role === 'status' && e.text === 'Committing changes',
      );
      assert.ok(
        iG1 < iStatus && iStatus < iG2,
        'status must render chronologically between the two phases',
      );
    } finally {
      await h.stop();
    }
  });

  it('drops the active-phase pointer when a daemon resync swaps the transcript (#1)', async () => {
    const h = await startHeadlessTui({
      verbResponses: {
        // start_session binds the daemon session lazily on the first user
        // message; resyncDaemonTranscript no-ops until then. Bind it, then
        // drive the resync.
        send_user_message: { ok: true, payload: { runId: 'run_own', accepted: true } },
        get_session_messages: { ok: true, payload: { messages: [] } },
      },
    });
    try {
      await h.typeLine('kick off a run');
      await h.waitFor(() => h.requestsOfType('send_user_message').length > 0);

      emit(h, 'tool_call', { toolName: 'read_file', args: { path: 'a.ts' } });
      await h.waitFor(() => h.tuiState?.activeActivityGroup != null);

      // Another client compacts/reverts → resyncDaemonTranscript clears the
      // transcript, splicing out the group the pointer still references.
      emit(h, 'session_reverted', { turns: 1, removedCount: 2, remainingTurns: 0 });
      await h.waitFor(() => h.requestsOfType('get_session_messages').length > 0);
      const cleared = await h.waitFor(() => h.tuiState?.activeActivityGroup == null);
      assert.ok(cleared, 'resync must clear the active-phase pointer');

      // A tool on the ongoing run must open a FRESH group that actually renders
      // — not append into the spliced-out orphan (which `activityGroups` can't
      // see, because it only reads the live transcript).
      emit(h, 'tool_call', { toolName: 'grep', args: { pattern: 'x' } });
      const rendered = await h.waitFor(() =>
        activityGroups(h).some((g) => g.items.some((i) => i.text === 'grep')),
      );
      assert.ok(rendered, 'post-resync tool must render in a live group, not the orphan');

      // Unblock runPrompt's pending completion before teardown so `stop()`
      // can't hang on a dangling turn.
      emit(h, 'run_complete', { outcome: 'success' });
      await h.waitFor(() => h.tuiState?.runState === 'idle');
    } finally {
      await h.stop();
    }
  });

  it('splits an oversized phase at the cap to bound reframe cost (#3)', async () => {
    const h = await startHeadlessTui({});
    try {
      const g0 = activityGroups(h).length;
      // One past the cap: the last append can't fit the first group and starts
      // a second.
      for (let i = 0; i <= MAX_ACTIVITY_ITEMS; i++) {
        emit(h, 'tool_call', { toolName: `tool_${i}`, args: {} });
      }
      await h.waitFor(() => activityGroups(h).length === g0 + 2);

      const gs = activityGroups(h);
      assert.equal(
        gs.at(-2).items.length,
        MAX_ACTIVITY_ITEMS,
        'first phase caps at the split threshold',
      );
      assert.equal(gs.at(-1).items.length, 1, 'the overflow item starts a fresh phase');
    } finally {
      await h.stop();
    }
  });
});
