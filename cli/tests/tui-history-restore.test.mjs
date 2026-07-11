/**
 * Resume-time chat-history restore (`cli/tui-history.ts` + the TUI seeding
 * call sites). Before this, resuming a session restored `state.messages` for
 * the model but left the visible transcript blank — history only ever
 * appeared in the exit-time stdout dump.
 *
 * Two layers:
 *   - unit pins on `sessionMessagesToTranscriptRows` (filtering rules shared
 *     with the exit dump: synthetic bracket-tagged user messages skipped,
 *     fenced JSON tool calls stripped from assistant prose),
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

  it('skips synthetic bracket-tagged user messages', () => {
    const rows = sessionMessagesToTranscriptRows([
      { role: 'user', content: '[SESSION_RESUMED] continuing from checkpoint' },
      { role: 'user', content: 'real question' },
    ]);
    assert.deepEqual(rows, [{ role: 'user', text: 'real question' }]);
  });

  it('strips fenced JSON tool calls from assistant prose', () => {
    const rows = sessionMessagesToTranscriptRows([
      {
        role: 'assistant',
        content: 'Let me check.\n```json\n{"tool": "read_file", "path": "a.ts"}\n```',
      },
      { role: 'assistant', content: '```json\n{"tool": "list_dir"}\n```' },
    ]);
    // The fence-only message reduces to empty and is dropped entirely.
    assert.deepEqual(rows, [{ role: 'assistant', text: 'Let me check.' }]);
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
