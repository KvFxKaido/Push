/**
 * Characterization tests for the TUI's addressable session verbs (shipped in
 * PR #740, inline in `runTUI`). They pin the input→dispatch→send contract via
 * the headless harness (TUI Decomposition Phase 0), exercising the REAL path:
 * keystrokes → parseKey → composer → sendMessage → handleSlashCommand →
 * the DaemonSessionController's verb methods (`cli/tui-daemon-session.ts`)
 * → daemon `request()`.
 *
 * This retroactively closes the "no automated test" gap consciously punted in
 * #740, and — unlike a formatter unit test — a wiring regression anywhere on
 * that path (key parse, command dispatch, payload shape, error rendering)
 * fails these. It was the behavior-preservation net for the Phase 1
 * DaemonSessionController extraction, which it survived unchanged.
 *
 * Each test runs a fresh `runTUI` instance for isolation (no busy-state bleed,
 * independent request log). The stub daemon client answers the connect
 * handshake + `start_session`, then records every verb `request()`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHeadlessTui } from './tui-driver.mjs';

/** Verb requests, excluding the connect/session-bootstrap traffic. */
function verbRequests(h) {
  return h.requests.filter((r) => r.type !== 'hello' && r.type !== 'start_session');
}

async function runVerb(line, opts = {}) {
  const h = await startHeadlessTui(opts);
  await h.typeLine(line);
  await h.waitFor(() => verbRequests(h).length > 0 || opts.expectNoSend, { timeoutMs: 1500 });
  return h;
}

describe('TUI session verbs (headless characterization)', () => {
  it('/revert 3 → session_revert {turns: 3}', async () => {
    const h = await runVerb('/revert 3');
    try {
      const sent = h.requestsOfType('session_revert');
      assert.equal(sent.length, 1, 'exactly one session_revert');
      assert.equal(sent[0].payload.turns, 3, 'turns parsed from the argument');
      assert.equal(sent[0].payload.sessionId, 'stub-session', 'addressed to the session');
    } finally {
      await h.stop();
    }
  });

  it('/revert (no arg) → session_revert {turns: 1}', async () => {
    const h = await runVerb('/revert');
    try {
      const sent = h.requestsOfType('session_revert');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].payload.turns, 1, 'defaults to a single turn');
    } finally {
      await h.stop();
    }
  });

  it('/unrevert → session_unrevert', async () => {
    const h = await runVerb('/unrevert');
    try {
      assert.equal(h.requestsOfType('session_unrevert').length, 1);
    } finally {
      await h.stop();
    }
  });

  it('/children → list_children {includeEventDerived: true}', async () => {
    const h = await runVerb('/children');
    try {
      const sent = h.requestsOfType('list_children');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].payload.includeEventDerived, true);
    } finally {
      await h.stop();
    }
  });

  it('/compact (daemon) → session_summarize {preserveTurns: 6}', async () => {
    const h = await runVerb('/compact');
    try {
      const sent = h.requestsOfType('session_summarize');
      assert.equal(sent.length, 1, 'daemon /compact summarizes server-side');
      assert.equal(sent[0].payload.preserveTurns, 6);
    } finally {
      await h.stop();
    }
  });

  it('a NOTHING_TO_UNREVERT rejection renders as a status, not an error', async () => {
    // The daemon client REJECTS on a non-ok envelope (attaching err.code); the
    // verb handler maps NOTHING_TO_UNREVERT to a benign status line. This pins
    // that it is NOT surfaced as a scary error entry.
    const h = await runVerb('/unrevert', {
      verbResponses: {
        session_unrevert: { rejectCode: 'NOTHING_TO_UNREVERT', message: 'Nothing to unrevert.' },
      },
    });
    try {
      assert.equal(h.requestsOfType('session_unrevert').length, 1, 'the verb was still sent');
      const transcript = h.tuiState?.transcript ?? [];
      const statusEntry = transcript.find(
        (e) => e.role === 'status' && /unrevert/i.test(e.text ?? ''),
      );
      assert.ok(statusEntry, 'the rejection rendered as a status entry');
      const errorEntry = transcript.find((e) => e.role === 'error');
      assert.equal(errorEntry, undefined, 'no error entry for an expected no-op');
    } finally {
      await h.stop();
    }
  });
});
