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

  it('keeps tool-call-only assistant rounds from consuming later visible prose', () => {
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
});
