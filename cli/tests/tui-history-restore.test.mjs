/**
 * Resume-time chat-history restore (`cli/tui-history.ts` + the TUI seeding
 * call sites). Before this, resuming a session restored `state.messages` for
 * the model but left the visible transcript blank — history only ever
 * appeared in the exit-time stdout dump.
 *
 * Two layers:
 *   - unit pins on `sessionMessagesToTranscriptRows` (filtering rules shared
 *     with the exit dump: paired internal envelopes skipped via
 *     `isInternalEnvelope`, tool-call JSON fences stripped from assistant
 *     prose via the same `parseJsonToolCalls` check the live renderer uses),
 *   - headless end-to-end pins on BOTH resume paths: startup resume
 *     (runTUI({sessionId})) and the in-TUI `/resume <id>` switch
 *     (switchToSessionById), asserting the real transcript contents via the
 *     harness's onState seam.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionMessagesToTranscriptRows } from '../tui-history.ts';
import { createSessionState, saveSessionState } from '../session-store.ts';
import { startHeadlessTui } from './tui-driver.mjs';

describe('sessionMessagesToTranscriptRows', () => {
  it('maps user and assistant messages, skipping system/tool roles', () => {
    const rows = sessionMessagesToTranscriptRows([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello there' },
      { role: 'assistant', content: 'hi! how can I help?' },
      { role: 'tool', content: 'tool result blob' },
    ]);
    assert.deepEqual(rows, [
      { role: 'user', text: 'hello there' },
      { role: 'assistant', text: 'hi! how can I help?' },
    ]);
  });

  it('skips paired internal-envelope user messages', () => {
    const rows = sessionMessagesToTranscriptRows([
      { role: 'user', content: '[TOOL_RESULT]\n{"ok":true}\n[/TOOL_RESULT]' },
      { role: 'user', content: '[CONTEXT DIGEST]\nsummary\n[/CONTEXT DIGEST]' },
      {
        role: 'user',
        content: '[PROJECT_INSTRUCTIONS source="PUSH.md"]\nrules\n[/PROJECT_INSTRUCTIONS]',
      },
      { role: 'user', content: 'real question' },
    ]);
    assert.deepEqual(rows, [{ role: 'user', text: 'real question' }]);
  });

  it('keeps real user prompts that merely start with a bracket', () => {
    // Blanket "starts with [" filtering regressed these (PR #1413 review);
    // paired-tag matching must keep them visible.
    const rows = sessionMessagesToTranscriptRows([
      { role: 'user', content: '[WIP] refactor auth' },
      { role: 'user', content: '[ ] fix flaky tests' },
      { role: 'user', content: '[TOOL_RESULT] without closer' },
    ]);
    assert.deepEqual(rows, [
      { role: 'user', text: '[WIP] refactor auth' },
      { role: 'user', text: '[ ] fix flaky tests' },
      { role: 'user', text: '[TOOL_RESULT] without closer' },
    ]);
  });

  it('strips fenced JSON tool calls from assistant prose', () => {
    const rows = sessionMessagesToTranscriptRows([
      {
        role: 'assistant',
        content: 'Let me check.\n```json\n{"tool": "read_file", "args": {"path": "a.ts"}}\n```',
      },
      { role: 'assistant', content: '```json\n{"tool": "list_dir"}\n```' },
    ]);
    // The fence-only message reduces to empty and is dropped entirely.
    assert.deepEqual(rows, [{ role: 'assistant', text: 'Let me check.' }]);
  });

  it('keeps JSON fences that are not tool calls', () => {
    // Only fences that parse as tool calls (a `tool` key — the same
    // `parseJsonToolCalls` contract the live renderer applies) are runtime
    // plumbing; a JSON example in an answer is content (PR #1413 review).
    const example = 'Use this config:\n```json\n{"retries": 3, "timeoutMs": 5000}\n```';
    const rows = sessionMessagesToTranscriptRows([{ role: 'assistant', content: example }]);
    assert.deepEqual(rows, [{ role: 'assistant', text: example }]);
  });

  it('extracts text parts from structured content arrays', () => {
    const rows = sessionMessagesToTranscriptRows([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'part one' },
          { type: 'tool_use', id: 'x' },
        ],
      },
    ]);
    assert.deepEqual(rows, [{ role: 'assistant', text: 'part one' }]);
  });

  it('tolerates junk entries and empty input', () => {
    assert.deepEqual(sessionMessagesToTranscriptRows([]), []);
    assert.deepEqual(sessionMessagesToTranscriptRows([null, 42, 'str', { role: 'user' }]), []);
  });
});

describe('TUI resume history restore (headless)', () => {
  let sessionDir;
  let prevSessionDirEnv;

  before(async () => {
    prevSessionDirEnv = process.env.PUSH_SESSION_DIR;
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-tui-history-'));
    process.env.PUSH_SESSION_DIR = sessionDir;
  });

  after(async () => {
    if (prevSessionDirEnv === undefined) delete process.env.PUSH_SESSION_DIR;
    else process.env.PUSH_SESSION_DIR = prevSessionDirEnv;
    await fs.rm(sessionDir, { recursive: true, force: true });
  });

  async function persistSession(sessionId, messages) {
    const state = {
      ...createSessionState({
        provider: 'zen',
        model: 'test-model',
        cwd: process.cwd(),
        messages,
        sessionId,
        mode: 'tui',
      }),
      sessionName: '',
      workingMemory: {},
    };
    await saveSessionState(state);
    return state;
  }

  function transcriptTexts(h, role) {
    return (h.tuiState?.transcript ?? []).filter((e) => e.role === role).map((e) => e.text);
  }

  it('startup resume seeds the transcript from persisted messages', async () => {
    await persistSession('sess_historystartup_abc123', [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'what is in lib/?' },
      { role: 'assistant', content: 'lib/ holds the shared runtime contracts.' },
    ]);
    const h = await startHeadlessTui({
      runTuiOptions: { sessionId: 'sess_historystartup_abc123' },
    });
    try {
      assert.deepEqual(transcriptTexts(h, 'user'), ['what is in lib/?']);
      assert.deepEqual(transcriptTexts(h, 'assistant'), [
        'lib/ holds the shared runtime contracts.',
      ]);
    } finally {
      await h.stop();
    }
  });

  it('/resume <id> seeds the switched-to session history', async () => {
    await persistSession('sess_historyswitch_abc123', [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ]);
    const h = await startHeadlessTui();
    try {
      await h.typeLine('/resume sess_historyswitch_abc123');
      const restored = await h.waitFor(
        () => transcriptTexts(h, 'assistant').includes('earlier answer'),
        { timeoutMs: 2000 },
      );
      assert.ok(restored, 'switched session history appears in the transcript');
      assert.deepEqual(transcriptTexts(h, 'user'), ['earlier question']);
      // History precedes the switch announcement, so the status line sits below it.
      const transcript = h.tuiState.transcript;
      const answerIdx = transcript.findIndex((e) => e.text === 'earlier answer');
      const statusIdx = transcript.findIndex(
        (e) => typeof e.text === 'string' && e.text.startsWith('Resumed session:'),
      );
      assert.ok(statusIdx > answerIdx, 'Resumed-session status renders after the history');
    } finally {
      await h.stop();
    }
  });
});
