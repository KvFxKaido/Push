import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { iteratePushStreamText } from './stream-utils.js';
import type { PushStream, PushStreamEvent } from './provider-contract.js';

function makePushStream(events: PushStreamEvent[]): PushStream {
  return () =>
    (async function* () {
      for (const event of events) {
        yield event;
      }
    })();
}

/**
 * Build a PushStream whose iterator pauses for `gapMs` between each event.
 * Used to test the activity-reset timer's behaviour: events that count as
 * activity should keep the stream alive across longer-than-`timeoutMs` gaps;
 * events that don't should let the timer fire.
 */
function makeGappedPushStream(events: { event: PushStreamEvent; gapMs: number }[]): PushStream {
  return () =>
    (async function* () {
      for (const { event, gapMs } of events) {
        if (gapMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, gapMs));
        }
        yield event;
      }
    })();
}

describe('iteratePushStreamText', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resets the activity timer on text_delta events', async () => {
    // 50ms gaps between text_deltas with a 100ms timeout → never trips.
    const stream = makeGappedPushStream([
      { event: { type: 'text_delta', text: 'hello ' }, gapMs: 50 },
      { event: { type: 'text_delta', text: 'world' }, gapMs: 50 },
      { event: { type: 'done', finishReason: 'stop' }, gapMs: 50 },
    ]);

    const promise = iteratePushStreamText(
      stream,
      { provider: 'openrouter', model: 'm', messages: [] },
      100,
      'timed out',
    );
    await vi.runAllTimersAsync();
    const { error, text } = await promise;

    expect(error).toBeNull();
    expect(text).toBe('hello world');
  });

  it('does NOT reset the activity timer on reasoning_delta — long-thinking streams time out', async () => {
    // 60ms gaps with a 50ms timeout. If reasoning_delta reset the timer,
    // the stream would reach text_delta successfully. With text-only reset
    // semantics, the gap before the first text_delta is too long.
    const stream = makeGappedPushStream([
      { event: { type: 'reasoning_delta', text: 'thinking 1' }, gapMs: 60 },
      { event: { type: 'reasoning_delta', text: 'thinking 2' }, gapMs: 60 },
      { event: { type: 'text_delta', text: 'final answer' }, gapMs: 60 },
      { event: { type: 'done', finishReason: 'stop' }, gapMs: 0 },
    ]);

    const promise = iteratePushStreamText(
      stream,
      { provider: 'openrouter', model: 'm', messages: [] },
      50,
      'timed out',
    );
    await vi.runAllTimersAsync();
    const { error, text } = await promise;

    expect(error).not.toBeNull();
    expect(error?.message).toBe('timed out');
    expect(text).toBe('');
  });

  it('does NOT reset the activity timer on tool_call_delta — buffering tool args time out', async () => {
    const stream = makeGappedPushStream([
      { event: { type: 'tool_call_delta' }, gapMs: 60 },
      { event: { type: 'tool_call_delta' }, gapMs: 60 },
      { event: { type: 'text_delta', text: 'flushed' }, gapMs: 60 },
      { event: { type: 'done', finishReason: 'stop' }, gapMs: 0 },
    ]);

    const promise = iteratePushStreamText(
      stream,
      { provider: 'openrouter', model: 'm', messages: [] },
      50,
      'timed out',
    );
    await vi.runAllTimersAsync();
    const { error } = await promise;

    expect(error).not.toBeNull();
    expect(error?.message).toBe('timed out');
  });

  it('returns accumulated text when the stream completes within the activity window', async () => {
    const stream = makePushStream([
      { type: 'text_delta', text: '{"verdict":"safe",' },
      { type: 'text_delta', text: '"summary":"OK","risks":[]}' },
      { type: 'done', finishReason: 'stop' },
    ]);

    vi.useRealTimers();
    const { error, text } = await iteratePushStreamText(
      stream,
      { provider: 'openrouter', model: 'm', messages: [] },
      1000,
      'timed out',
    );

    expect(error).toBeNull();
    expect(text).toBe('{"verdict":"safe","summary":"OK","risks":[]}');
  });

  it('returns the upstream error when the stream throws', async () => {
    vi.useRealTimers();
    const stream: PushStream = () =>
      (async function* () {
        throw new Error('upstream went away');
      })();

    const { error } = await iteratePushStreamText(
      stream,
      { provider: 'openrouter', model: 'm', messages: [] },
      1000,
      'timed out',
    );

    expect(error?.message).toBe('upstream went away');
  });
});
