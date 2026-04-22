import { describe, it, expect } from 'vitest';
import type { PushStreamEvent, StreamUsage } from './provider-contract.js';
import { normalizeReasoning } from './reasoning-tokens.js';

async function* streamOf(events: PushStreamEvent[]): AsyncIterable<PushStreamEvent> {
  for (const event of events) yield event;
}

function textChunks(...chunks: string[]): PushStreamEvent[] {
  return chunks.map((text) => ({ type: 'text_delta', text }));
}

/**
 * Collapse adjacent `text_delta` / `reasoning_delta` events into single
 * semantic sections so assertions stay decoupled from chunk boundaries.
 * Section shapes:
 *   { kind: 'text'; text: string }
 *   { kind: 'reasoning'; text: string }
 *   { kind: 'reasoning_end' }
 *   { kind: 'done'; finishReason: string; usage?: StreamUsage }
 */
type Section =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'reasoning_end' }
  | { kind: 'done'; finishReason: string; usage?: StreamUsage };

function summarize(events: PushStreamEvent[]): Section[] {
  const sections: Section[] = [];
  for (const event of events) {
    if (event.type === 'text_delta') {
      const last = sections[sections.length - 1];
      if (last && last.kind === 'text') last.text += event.text;
      else sections.push({ kind: 'text', text: event.text });
    } else if (event.type === 'reasoning_delta') {
      const last = sections[sections.length - 1];
      if (last && last.kind === 'reasoning') last.text += event.text;
      else sections.push({ kind: 'reasoning', text: event.text });
    } else if (event.type === 'reasoning_end') {
      sections.push({ kind: 'reasoning_end' });
    } else {
      sections.push({ kind: 'done', finishReason: event.finishReason, usage: event.usage });
    }
  }
  return sections;
}

async function run(events: PushStreamEvent[]): Promise<Section[]> {
  const out: PushStreamEvent[] = [];
  for await (const event of normalizeReasoning(streamOf(events))) out.push(event);
  return summarize(out);
}

describe('normalizeReasoning', () => {
  it('passes plain text through as text_delta', async () => {
    expect(
      await run([...textChunks('hello ', 'world'), { type: 'done', finishReason: 'stop' }]),
    ).toEqual([
      { kind: 'text', text: 'hello world' },
      { kind: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('splits a simple <think>...</think> block in a single chunk', async () => {
    expect(
      await run([
        { type: 'text_delta', text: '<think>pondering</think>answer' },
        { type: 'done', finishReason: 'stop' },
      ]),
    ).toEqual([
      { kind: 'reasoning', text: 'pondering' },
      { kind: 'reasoning_end' },
      { kind: 'text', text: 'answer' },
      { kind: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('handles an opening tag split across chunk boundaries', async () => {
    expect(
      await run([
        ...textChunks('<thi', 'nk>pondering</think>answer'),
        { type: 'done', finishReason: 'stop' },
      ]),
    ).toEqual([
      { kind: 'reasoning', text: 'pondering' },
      { kind: 'reasoning_end' },
      { kind: 'text', text: 'answer' },
      { kind: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('handles a closing tag split across chunk boundaries', async () => {
    expect(
      await run([
        ...textChunks('<think>pondering</thi', 'nk>answer'),
        { type: 'done', finishReason: 'stop' },
      ]),
    ).toEqual([
      { kind: 'reasoning', text: 'pondering' },
      { kind: 'reasoning_end' },
      { kind: 'text', text: 'answer' },
      { kind: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('emits text before and after a think block in order', async () => {
    expect(
      await run([
        { type: 'text_delta', text: 'prefix<think>inner</think>suffix' },
        { type: 'done', finishReason: 'stop' },
      ]),
    ).toEqual([
      { kind: 'text', text: 'prefix' },
      { kind: 'reasoning', text: 'inner' },
      { kind: 'reasoning_end' },
      { kind: 'text', text: 'suffix' },
      { kind: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('handles multiple <think> blocks with text between', async () => {
    expect(
      await run([
        { type: 'text_delta', text: '<think>first</think>mid<think>second</think>end' },
        { type: 'done', finishReason: 'stop' },
      ]),
    ).toEqual([
      { kind: 'reasoning', text: 'first' },
      { kind: 'reasoning_end' },
      { kind: 'text', text: 'mid' },
      { kind: 'reasoning', text: 'second' },
      { kind: 'reasoning_end' },
      { kind: 'text', text: 'end' },
      { kind: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('strips leading whitespace immediately after </think>', async () => {
    expect(
      await run([
        { type: 'text_delta', text: '<think>inner</think>\n\nanswer' },
        { type: 'done', finishReason: 'stop' },
      ]),
    ).toEqual([
      { kind: 'reasoning', text: 'inner' },
      { kind: 'reasoning_end' },
      { kind: 'text', text: 'answer' },
      { kind: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('passes native reasoning_delta through and closes on text transition', async () => {
    expect(
      await run([
        { type: 'reasoning_delta', text: 'thinking hard' },
        { type: 'text_delta', text: 'ok here it is' },
        { type: 'done', finishReason: 'stop' },
      ]),
    ).toEqual([
      { kind: 'reasoning', text: 'thinking hard' },
      { kind: 'reasoning_end' },
      { kind: 'text', text: 'ok here it is' },
      { kind: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('forwards an explicit reasoning_end from the source stream', async () => {
    expect(
      await run([
        { type: 'reasoning_delta', text: 'native' },
        { type: 'reasoning_end' },
        { type: 'text_delta', text: 'after' },
        { type: 'done', finishReason: 'stop' },
      ]),
    ).toEqual([
      { kind: 'reasoning', text: 'native' },
      { kind: 'reasoning_end' },
      { kind: 'text', text: 'after' },
      { kind: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('flushes an unclosed <think> block at end of stream as reasoning', async () => {
    expect(
      await run([
        { type: 'text_delta', text: '<think>incomplete reasoning' },
        { type: 'done', finishReason: 'stop' },
      ]),
    ).toEqual([
      { kind: 'reasoning', text: 'incomplete reasoning' },
      { kind: 'reasoning_end' },
      { kind: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('flushes a trailing partial-tag prefix as text when it never completes', async () => {
    expect(
      await run([
        { type: 'text_delta', text: 'answer<' },
        { type: 'done', finishReason: 'stop' },
      ]),
    ).toEqual([
      { kind: 'text', text: 'answer<' },
      { kind: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('forwards usage on done unchanged', async () => {
    const usage: StreamUsage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
    expect(
      await run([
        { type: 'text_delta', text: 'hi' },
        { type: 'done', finishReason: 'stop', usage },
      ]),
    ).toEqual([
      { kind: 'text', text: 'hi' },
      { kind: 'done', finishReason: 'stop', usage },
    ]);
  });

  it('emits reasoning_end for an empty <think></think> block', async () => {
    // Matches createReasoningTokenParser semantics — the UI sees the thinking
    // block open and close even if no content was emitted.
    expect(
      await run([
        { type: 'text_delta', text: '<think></think>answer' },
        { type: 'done', finishReason: 'stop' },
      ]),
    ).toEqual([
      { kind: 'reasoning_end' },
      { kind: 'text', text: 'answer' },
      { kind: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('holds an unresolved < prefix without emitting it prematurely', async () => {
    // Deliver `<thi` with no `done` event. The transducer's finally block
    // flushes the buffered prefix as text because the stream ended before
    // the tag could complete.
    const out: PushStreamEvent[] = [];
    for await (const ev of normalizeReasoning(streamOf([{ type: 'text_delta', text: '<thi' }]))) {
      out.push(ev);
    }
    expect(summarize(out)).toEqual([{ kind: 'text', text: '<thi' }]);
  });

  it('preserves full reasoning content across chunk boundaries inside a think block', async () => {
    expect(
      await run([
        ...textChunks('<think>first part ', 'second part</think>done'),
        { type: 'done', finishReason: 'stop' },
      ]),
    ).toEqual([
      { kind: 'reasoning', text: 'first part second part' },
      { kind: 'reasoning_end' },
      { kind: 'text', text: 'done' },
      { kind: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('does not emit a reasoning_end if no reasoning happened at all', async () => {
    expect(
      await run([
        { type: 'text_delta', text: 'just content' },
        { type: 'done', finishReason: 'stop' },
      ]),
    ).toEqual([
      { kind: 'text', text: 'just content' },
      { kind: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });
});
