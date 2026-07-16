import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyDaemonTranscriptEvent,
  createDaemonTranscriptMirror,
  rebuildDaemonTranscriptMirror,
  snapshotDaemonTranscript,
} from '../daemon-transcript-mirror.ts';

describe('daemon transcript mirror', () => {
  it('rebuilds full dialogue and settled tool cards from daemon state + events', () => {
    const mirror = rebuildDaemonTranscriptMirror(
      [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'change it' },
        { role: 'assistant', content: 'Done.' },
      ],
      [
        { seq: 1, ts: 1, type: 'user_message', payload: { chars: 9, preview: 'change it' } },
        {
          seq: 2,
          ts: 2,
          type: 'tool.execution_start',
          payload: { toolName: 'edit_file', args: { path: 'a.ts' } },
        },
        {
          seq: 3,
          ts: 3,
          type: 'tool.execution_complete',
          payload: {
            toolName: 'edit_file',
            isError: false,
            durationMs: 12,
            preview: 'updated a.ts',
            card: { type: 'ci-status', data: { checks: [] } },
            diff: {
              path: 'a.ts',
              adds: 1,
              dels: 1,
              lines: [
                { kind: 'del', oldLine: 1, text: 'old' },
                { kind: 'add', newLine: 1, text: 'new' },
              ],
            },
          },
        },
        { seq: 4, ts: 4, type: 'assistant_done', payload: {} },
      ],
    );

    assert.deepEqual(
      mirror.rows.map((row) => [row.kind, row.role, row.text]),
      [
        ['message', 'user', 'change it'],
        ['tool', 'coder', 'edit_file'],
        ['message', 'assistant', 'Done.'],
      ],
    );
    assert.equal(mirror.rows[1].pending, false);
    assert.equal(mirror.rows[1].resultPreview, 'updated a.ts');
    assert.equal(mirror.rows[1].diff.path, 'a.ts');
    assert.deepEqual(mirror.rows[1].card, { type: 'ci-status', data: { checks: [] } });
    assert.equal(mirror.rows[0].timestampMs, 1);
    assert.equal(mirror.rows[2].timestampMs, 4);
  });

  it('preserves unknown future card types for the renderer tombstone', () => {
    const mirror = createDaemonTranscriptMirror();
    applyDaemonTranscriptEvent(mirror, {
      seq: 1,
      type: 'tool.execution_complete',
      payload: {
        toolName: 'future_tool',
        isError: false,
        card: { type: 'future-card', data: { version: 2 } },
      },
    });
    assert.deepEqual(mirror.rows[0].card, {
      type: 'future-card',
      data: { version: 2 },
    });
  });

  it('applies the same broadcast reducer live and round-trips a snapshot', () => {
    const mirror = createDaemonTranscriptMirror();
    applyDaemonTranscriptEvent(mirror, {
      seq: 1,
      type: 'user_message',
      payload: { chars: 4, preview: 'full', text: 'full' },
    });
    applyDaemonTranscriptEvent(mirror, {
      seq: 2,
      type: 'assistant_token',
      payload: { text: 'hel' },
    });
    applyDaemonTranscriptEvent(mirror, {
      seq: 3,
      type: 'assistant_token',
      payload: { text: 'lo' },
    });
    applyDaemonTranscriptEvent(mirror, { seq: 4, type: 'assistant_done', payload: {} });

    const adopted = createDaemonTranscriptMirror(snapshotDaemonTranscript(mirror));
    assert.deepEqual(
      adopted.rows.map((row) => row.text),
      ['full', 'hello'],
    );
    assert.equal(adopted.liveText, '');
    assert.equal(adopted.lastSeq, 4);
  });

  it('replaces streamed tool-round text with ordered render-only tool prose', () => {
    const mirror = createDaemonTranscriptMirror();
    applyDaemonTranscriptEvent(mirror, {
      seq: 1,
      type: 'assistant_token',
      payload: { text: 'I’ll inspect it.' },
    });
    applyDaemonTranscriptEvent(mirror, { seq: 2, type: 'assistant_done', payload: {} });
    applyDaemonTranscriptEvent(mirror, {
      seq: 3,
      type: 'assistant.tool_prose',
      payload: { round: 0, text: 'I’ll inspect it.' },
    });
    applyDaemonTranscriptEvent(mirror, {
      seq: 4,
      type: 'tool.execution_start',
      payload: { toolName: 'read_file', args: { path: 'README.md' } },
    });

    assert.deepEqual(
      mirror.rows.map((row) => [row.kind, row.text]),
      [
        ['tool_prose', 'I’ll inspect it.'],
        ['tool', 'read_file'],
      ],
    );
  });

  it('preserves dialogue order for legacy sessions without an event journal', () => {
    const mirror = rebuildDaemonTranscriptMirror(
      [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'three' },
      ],
      [],
    );
    assert.deepEqual(
      mirror.rows.map((row) => row.text),
      ['one', 'two', 'three'],
    );
  });

  it('uses structured tool events to suppress tool-call rounds without consuming later prose', () => {
    const mirror = rebuildDaemonTranscriptMirror(
      [
        { role: 'user', content: 'inspect it' },
        {
          role: 'assistant',
          content: '```json\n{"tool":"read_file","args":{"path":"a.ts"}}\n```',
        },
        { role: 'assistant', content: 'Here is the result.' },
      ],
      [
        { seq: 1, ts: 1, type: 'user_message', payload: { chars: 10, preview: 'inspect it' } },
        { seq: 2, ts: 2, type: 'assistant_done', payload: {} },
        {
          seq: 3,
          ts: 3,
          type: 'tool.execution_start',
          payload: { toolName: 'read_file', args: { path: 'a.ts' } },
        },
        {
          seq: 4,
          ts: 4,
          type: 'tool.execution_complete',
          payload: { toolName: 'read_file', isError: false, preview: 'contents' },
        },
        { seq: 5, ts: 5, type: 'assistant_done', payload: {} },
      ],
    );
    assert.deepEqual(
      mirror.rows.map((row) => row.text),
      ['inspect it', 'read_file', 'Here is the result.'],
    );
  });

  it('suppresses malformed tool-call rounds from resumed transcripts', () => {
    const malformed = '```json\n{"tool":"unknown_tool","args":{}}\n```';
    const mirror = rebuildDaemonTranscriptMirror(
      [
        { role: 'user', content: 'try it' },
        { role: 'assistant', content: malformed },
        { role: 'assistant', content: 'I could not run that tool.' },
      ],
      [
        { seq: 1, ts: 1, type: 'user_message', payload: { text: 'try it' } },
        { seq: 2, ts: 2, type: 'assistant_done', payload: {} },
        {
          seq: 3,
          ts: 3,
          type: 'tool.call_malformed',
          payload: { message: 'Unknown tool: unknown_tool' },
        },
        { seq: 4, ts: 4, type: 'assistant_done', payload: {} },
      ],
    );

    assert.equal(
      mirror.rows.some((row) => row.text === malformed),
      false,
      'raw malformed tool payload must stay out of the resumed transcript',
    );
    assert.deepEqual(
      mirror.rows.map((row) => row.text),
      ['try it', 'Unknown tool: unknown_tool', 'I could not run that tool.'],
    );
  });

  it('builds expandable review-card text from reviewer outcomes', () => {
    const mirror = createDaemonTranscriptMirror();
    applyDaemonTranscriptEvent(mirror, {
      seq: 8,
      type: 'subagent.completed',
      payload: {
        agent: 'reviewer',
        role: 'reviewer',
        summary: 'One issue found',
        reviewResult: {
          summary: 'One issue found',
          comments: [{ path: 'a.ts', line: 12, body: 'Handle the rejected promise.' }],
        },
      },
    });
    assert.equal(mirror.rows[0].kind, 'review');
    assert.match(mirror.rows[0].text, /a\.ts:12 · Handle the rejected promise/);
  });

  it('does not resurrect pre-mutation turns from the append-only event journal', () => {
    // After session_reverted, messages hold only the remaining dialogue while
    // the journal still has the dropped turn's user/tool/assistant events.
    const mirror = rebuildDaemonTranscriptMirror(
      [
        { role: 'user', content: 'keep me' },
        { role: 'assistant', content: 'kept' },
      ],
      [
        { seq: 1, ts: 1, type: 'user_message', payload: { chars: 7, preview: 'keep me' } },
        { seq: 2, ts: 2, type: 'assistant_done', payload: {} },
        { seq: 3, ts: 3, type: 'user_message', payload: { chars: 9, preview: 'drop this' } },
        {
          seq: 4,
          ts: 4,
          type: 'tool.execution_start',
          payload: { toolName: 'edit_file', args: { path: 'gone.ts' } },
        },
        {
          seq: 5,
          ts: 5,
          type: 'tool.execution_complete',
          payload: { toolName: 'edit_file', isError: false, preview: 'edited' },
        },
        { seq: 6, ts: 6, type: 'assistant_done', payload: {} },
        {
          seq: 7,
          ts: 7,
          type: 'session_reverted',
          payload: { turns: 1, removedCount: 2, remainingTurns: 1 },
        },
      ],
    );

    assert.deepEqual(
      mirror.rows.map((row) => [row.kind, row.role, row.text]),
      [
        ['message', 'user', 'keep me'],
        ['message', 'assistant', 'kept'],
      ],
    );
    assert.equal(
      mirror.rows.some((row) => row.text === 'drop this' || row.toolName === 'edit_file'),
      false,
    );
    assert.equal(mirror.lastSeq, 7);
  });

  it('replays only post-compaction events against rewritten messages', () => {
    const mirror = rebuildDaemonTranscriptMirror(
      [
        { role: 'user', content: 'summary of older work' },
        { role: 'assistant', content: 'ready' },
        { role: 'user', content: 'new ask' },
        { role: 'assistant', content: 'new answer' },
      ],
      [
        { seq: 1, ts: 1, type: 'user_message', payload: { chars: 10, preview: 'old ask' } },
        {
          seq: 2,
          ts: 2,
          type: 'tool.execution_start',
          payload: { toolName: 'read_file', args: { path: 'old.ts' } },
        },
        {
          seq: 3,
          ts: 3,
          type: 'tool.execution_complete',
          payload: { toolName: 'read_file', isError: false, preview: 'old contents' },
        },
        { seq: 4, ts: 4, type: 'assistant_done', payload: {} },
        {
          seq: 5,
          ts: 5,
          type: 'context_compacted',
          payload: { beforeTokens: 9000, afterTokens: 1200 },
        },
        { seq: 6, ts: 6, type: 'user_message', payload: { chars: 7, preview: 'new ask' } },
        {
          seq: 7,
          ts: 7,
          type: 'tool.execution_start',
          payload: { toolName: 'edit_file', args: { path: 'new.ts' } },
        },
        {
          seq: 8,
          ts: 8,
          type: 'tool.execution_complete',
          payload: { toolName: 'edit_file', isError: false, preview: 'updated' },
        },
        { seq: 9, ts: 9, type: 'assistant_done', payload: {} },
      ],
    );

    // Surviving/summary dialogue is seeded first; post-mutation events pair
    // with the dialogue tail and re-interleave tool cards correctly.
    assert.deepEqual(
      mirror.rows.map((row) => [row.kind, row.role, row.text]),
      [
        ['message', 'user', 'summary of older work'],
        ['message', 'assistant', 'ready'],
        ['message', 'user', 'new ask'],
        ['tool', 'coder', 'edit_file'],
        ['message', 'assistant', 'new answer'],
      ],
    );
    assert.equal(
      mirror.rows.some((row) => row.toolName === 'read_file' || row.text === 'old ask'),
      false,
    );
    assert.equal(mirror.lastSeq, 9);
  });

  it('pairs parallel same-tool results to their call by executionId, not name order', () => {
    // Two concurrent read_file calls, each with its own executionId. Under the
    // legacy name+pending reverse-scan a result matched the LAST pending row of
    // that name, so FIFO completions cross-attributed output onto the wrong
    // call (a.ts showing b.ts's contents and vice-versa). Correlate by id.
    const mirror = createDaemonTranscriptMirror();
    applyDaemonTranscriptEvent(mirror, {
      seq: 1,
      type: 'tool.execution_start',
      payload: { executionId: 'exec-A', toolName: 'read_file', args: { path: 'a.ts' } },
    });
    applyDaemonTranscriptEvent(mirror, {
      seq: 2,
      type: 'tool.execution_start',
      payload: { executionId: 'exec-B', toolName: 'read_file', args: { path: 'b.ts' } },
    });
    applyDaemonTranscriptEvent(mirror, {
      seq: 3,
      type: 'tool.execution_complete',
      payload: {
        executionId: 'exec-A',
        toolName: 'read_file',
        isError: false,
        preview: 'RESULT-A',
      },
    });
    applyDaemonTranscriptEvent(mirror, {
      seq: 4,
      type: 'tool.execution_complete',
      payload: {
        executionId: 'exec-B',
        toolName: 'read_file',
        isError: false,
        preview: 'RESULT-B',
      },
    });

    const rowFor = (path) =>
      mirror.rows.find(
        (row) =>
          row.kind === 'tool' && row.args && typeof row.args === 'object' && row.args.path === path,
      );
    assert.equal(mirror.rows.filter((row) => row.kind === 'tool').length, 2);
    assert.equal(rowFor('a.ts').resultPreview, 'RESULT-A');
    assert.equal(rowFor('b.ts').resultPreview, 'RESULT-B');
    assert.equal(rowFor('a.ts').pending, false);
    assert.equal(rowFor('b.ts').pending, false);
  });

  it('keeps each completes-only parallel result on its own row (daemon kernel shape)', () => {
    // The CLI kernel emits execution_complete without a paired start, so no
    // pending row exists to match — each completion must land on its own row.
    const mirror = createDaemonTranscriptMirror();
    applyDaemonTranscriptEvent(mirror, {
      seq: 1,
      type: 'tool.execution_complete',
      payload: { executionId: 'exec-A', toolName: 'read_file', isError: false, preview: 'first' },
    });
    applyDaemonTranscriptEvent(mirror, {
      seq: 2,
      type: 'tool.execution_complete',
      payload: { executionId: 'exec-B', toolName: 'read_file', isError: false, preview: 'second' },
    });
    assert.deepEqual(
      mirror.rows.filter((row) => row.kind === 'tool').map((row) => row.resultPreview),
      ['first', 'second'],
    );
  });
});
