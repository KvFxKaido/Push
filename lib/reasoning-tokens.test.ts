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
 *   { kind: 'tool_call_delta' }
 *   { kind: 'done'; finishReason: string; usage?: StreamUsage }
 */
type Section =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'reasoning_end' }
  | { kind: 'tool_call_delta' }
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
    } else if (event.type === 'tool_call_delta') {
      sections.push({ kind: 'tool_call_delta' });
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

  it('forwards tool_call_delta through unchanged', async () => {
    // tool_call_delta is structural — the transducer must pass it through
    // without affecting the reasoning latch or buffer state.
    expect(
      await run([
        { type: 'text_delta', text: 'before' },
        { type: 'tool_call_delta' },
        { type: 'tool_call_delta' },
        { type: 'text_delta', text: 'after' },
        { type: 'done', finishReason: 'tool_calls' },
      ]),
    ).toEqual([
      { kind: 'text', text: 'before' },
      { kind: 'tool_call_delta' },
      { kind: 'tool_call_delta' },
      { kind: 'text', text: 'after' },
      { kind: 'done', finishReason: 'tool_calls', usage: undefined },
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
    // Deliver `<thi` with no `done` event. When iteration completes normally,
    // flushRemaining runs after the for-await loop (the finally block only
    // handles orphaned reasoning_end cleanup), flushing the buffered prefix
    // as text because the stream ended before the tag could complete.
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

  it('latches on native reasoning_delta and passes <think>-tagged content through unchanged', async () => {
    // Once a native reasoning_delta is seen, subsequent text_delta events
    // are trusted as-is. A hybrid provider that emits both channels in the
    // same stream won't double-report reasoning.
    expect(
      await run([
        { type: 'reasoning_delta', text: 'native thinking' },
        { type: 'text_delta', text: '<think>native thinking</think>answer' },
        { type: 'done', finishReason: 'stop' },
      ]),
    ).toEqual([
      { kind: 'reasoning', text: 'native thinking' },
      { kind: 'reasoning_end' },
      // The `<think>...</think>` content passes through verbatim — latched
      // mode ignores inline tags because the native channel is authoritative.
      { kind: 'text', text: '<think>native thinking</think>answer' },
      { kind: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('does not latch on a bare upstream reasoning_end with no preceding reasoning_delta', async () => {
    // A bare reasoning_end doesn't prove the provider is using the native
    // channel — it's just a close marker — so <think> parsing stays active.
    expect(
      await run([
        { type: 'reasoning_end' },
        { type: 'text_delta', text: '<think>still parsed</think>answer' },
        { type: 'done', finishReason: 'stop' },
      ]),
    ).toEqual([
      { kind: 'reasoning_end' },
      { kind: 'reasoning', text: 'still parsed' },
      { kind: 'reasoning_end' },
      { kind: 'text', text: 'answer' },
      { kind: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('flushes in-progress inline reasoning before engaging the latch', async () => {
    // Pathological provider: starts with inline <think> then switches to
    // native mid-stream. The buffered inline reasoning is flushed as
    // reasoning_delta before the native event, then the latch engages so
    // any leftover tags in subsequent text are passed through as-is.
    expect(
      await run([
        { type: 'text_delta', text: '<think>inline start' },
        { type: 'reasoning_delta', text: ' native continuation' },
        { type: 'text_delta', text: '</think>answer' },
        { type: 'done', finishReason: 'stop' },
      ]),
    ).toEqual([
      { kind: 'reasoning', text: 'inline start native continuation' },
      { kind: 'reasoning_end' },
      // `</think>` survives into visible text because the latch short-circuited
      // the parser. This is documented pathological behavior — a real hybrid
      // provider wouldn't leave an orphan closing tag in content.
      { kind: 'text', text: '</think>answer' },
      { kind: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });
});
