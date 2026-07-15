import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateEvent } from '../../lib/protocol-schema.ts';
import { createHeadlessJsonlWriter } from '../headless-jsonl.ts';

describe('createHeadlessJsonlWriter', () => {
  it('writes canonical daemon-compatible envelopes', () => {
    const state = { sessionId: 'sess_jsonl', eventSeq: 7 };
    const lines = [];
    const writer = createHeadlessJsonlWriter(
      state,
      (line) => lines.push(line),
      () => 1234,
    );

    const envelope = writer.emitEngineEvent({
      sessionId: state.sessionId,
      runId: 'run_jsonl',
      type: 'assistant_token',
      payload: { text: 'hello' },
    });

    assert.deepEqual(JSON.parse(lines[0]), envelope);
    assert.equal(envelope.v, 'push.runtime.v1');
    assert.equal(envelope.kind, 'event');
    assert.equal(envelope.seq, 7);
    assert.equal(envelope.ts, 1234);
    assert.deepEqual(validateEvent(envelope), []);
  });

  it('keeps the session journal cursor instead of inventing a replay sequence', () => {
    const state = { sessionId: 'sess_jsonl', eventSeq: 3 };
    const envelopes = [];
    const writer = createHeadlessJsonlWriter(
      state,
      () => {},
      () => 1234,
    );

    envelopes.push(writer.emit('assistant_token', { text: 'a' }, 'run_jsonl'));
    envelopes.push(writer.emit('assistant_token', { text: 'b' }, 'run_jsonl'));
    state.eventSeq = 4;
    envelopes.push(writer.emit('assistant_done', { messageId: 'asst_1' }, 'run_jsonl'));

    assert.deepEqual(
      envelopes.map((event) => event.seq),
      [3, 3, 4],
    );
  });
});
