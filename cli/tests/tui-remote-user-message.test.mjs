/**
 * Characterization tests for live-rendering a `user_message` broadcast in the
 * TUI — the daemon-side half of this fix is `handleSendUserMessage`
 * broadcasting the event to every attached client (cli/pushd.ts), not just
 * persisting it. This file pins the TUI-side render + de-dup behavior against
 * the real `handleEngineEvent` path.
 *
 * Same harness as `tui-rc.test.mjs`: drive the REAL daemon-event → dispatch →
 * render path against the stub daemon client via `emitDaemonEvent`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHeadlessTui } from './tui-driver.mjs';

function transcriptEntries(h, role) {
  return (h.tuiState?.transcript ?? []).filter((e) => e.role === role);
}

describe('TUI user_message broadcast (headless characterization)', () => {
  it('renders a user_message from another attached client (phone on Remote)', async () => {
    const h = await startHeadlessTui({});
    try {
      const before = transcriptEntries(h, 'user').length;

      h.emitDaemonEvent({
        v: 1,
        kind: 'event',
        sessionId: 'stub-session',
        runId: 'run_from_phone',
        seq: 1,
        ts: Date.now(),
        type: 'user_message',
        payload: { chars: 24, preview: 'what changed recently in push' },
      });
      await h.waitFor(() => transcriptEntries(h, 'user').length > before);

      const entries = transcriptEntries(h, 'user');
      assert.equal(entries.length, before + 1);
      assert.equal(entries.at(-1).text, 'what changed recently in push');
    } finally {
      await h.stop();
    }
  });

  it('marks truncation visually when preview is shorter than chars', async () => {
    const h = await startHeadlessTui({});
    try {
      const before = transcriptEntries(h, 'user').length;
      h.emitDaemonEvent({
        v: 1,
        kind: 'event',
        sessionId: 'stub-session',
        runId: 'run_from_phone',
        seq: 1,
        ts: Date.now(),
        type: 'user_message',
        payload: { chars: 500, preview: 'x'.repeat(280) },
      });
      await h.waitFor(() => transcriptEntries(h, 'user').length > before);

      const entry = transcriptEntries(h, 'user').at(-1);
      assert.ok(entry.text.endsWith('…'), 'truncated preview should end with an ellipsis');
      assert.equal(entry.text.length, 281);
    } finally {
      await h.stop();
    }
  });

  it("does not double-render this TUI's own message when the broadcast echoes back", async () => {
    const h = await startHeadlessTui({
      verbResponses: {
        send_user_message: { ok: true, payload: { runId: 'run_own', accepted: true } },
      },
    });
    try {
      const before = transcriptEntries(h, 'user').length;

      await h.typeLine('hello from me');
      // Local echo (addTranscriptEntry at submit time) already landed.
      assert.equal(transcriptEntries(h, 'user').length, before + 1);

      // The daemon now fans the same user_message back to every attached
      // client, including the sender — simulate that echo.
      h.emitDaemonEvent({
        v: 1,
        kind: 'event',
        sessionId: 'stub-session',
        runId: 'run_own',
        seq: 1,
        ts: Date.now(),
        type: 'user_message',
        payload: { chars: 13, preview: 'hello from me' },
      });
      await h.waitFor(() => h.requestsOfType('send_user_message').length > 0);
      // Give the echo a moment to be (correctly) dropped rather than rendered.
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Unblock runPrompt's pending completionPromise BEFORE asserting, so a
      // failed assertion can't leave the turn dangling and hang h.stop() in
      // the finally block below.
      h.emitDaemonEvent({
        v: 1,
        kind: 'event',
        sessionId: 'stub-session',
        runId: 'run_own',
        seq: 2,
        ts: Date.now(),
        type: 'run_complete',
        payload: { outcome: 'success' },
      });
      await h.waitFor(() => h.tuiState?.runState === 'idle');

      assert.equal(
        transcriptEntries(h, 'user').length,
        before + 1,
        'own message must not render twice',
      );
    } finally {
      await h.stop();
    }
  });
});
