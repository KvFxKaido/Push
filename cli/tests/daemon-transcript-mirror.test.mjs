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
});
