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

  it('returns usage captured from the done event', async () => {
    const stream = makePushStream([
      { type: 'text_delta', text: 'hi' },
      {
        type: 'done',
        finishReason: 'stop',
        usage: { inputTokens: 90, outputTokens: 12, totalTokens: 102 },
      },
    ]);

    const promise = iteratePushStreamText(
      stream,
      { provider: 'openrouter', model: 'm', messages: [] },
      100,
      'timed out',
    );
    await vi.runAllTimersAsync();
    const { error, text, usage } = await promise;

    expect(error).toBeNull();
    expect(text).toBe('hi');
    expect(usage).toEqual({ inputTokens: 90, outputTokens: 12, totalTokens: 102 });
  });

  it('returns undefined usage when the done event omits it', async () => {
    const stream = makePushStream([
      { type: 'text_delta', text: 'hi' },
      { type: 'done', finishReason: 'stop' },
    ]);

    const promise = iteratePushStreamText(
      stream,
      { provider: 'openrouter', model: 'm', messages: [] },
      100,
      'timed out',
    );
    await vi.runAllTimersAsync();
    const { usage } = await promise;

    expect(usage).toBeUndefined();
  });

  it('returns provider replay sidecars emitted by the stream', async () => {
    const block = { type: 'thinking' as const, text: 'Need the repo shape.', signature: 'sig-1' };
    const responsesItem = {
      type: 'reasoning' as const,
      id: 'rs_1',
      encrypted_content: 'provider-ciphertext',
      summary: [],
    };
    const stream = makePushStream([
      { type: 'reasoning_delta', text: block.text },
      { type: 'reasoning_block', block },
      { type: 'responses_reasoning_item', item: responsesItem },
      { type: 'text_delta', text: 'reading files' },
      { type: 'done', finishReason: 'stop' },
    ]);

    const promise = iteratePushStreamText(
      stream,
      { provider: 'anthropic', model: 'claude-opus-4-7', messages: [] },
      100,
      'timed out',
    );
    await vi.runAllTimersAsync();
    const { error, reasoningText, reasoningBlocks, responsesReasoningItems, text } = await promise;

    expect(error).toBeNull();
    expect(reasoningText).toBe(block.text);
    expect(reasoningBlocks).toEqual([block]);
    expect(responsesReasoningItems).toEqual([responsesItem]);
    expect(text).toBe('reading files');
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

  it('resets the activity timer on reasoning_delta when the heavy-reasoner opt-in is set', async () => {
    // Same gapped stream as the default-semantics test above, but with
    // `reasoningResetsActivityTimer` the reasoning gaps count as progress
    // and the stream survives to deliver its text. The deep reviewer opts
    // in (glm-5.1 reasons >60s before its first token on big rounds; an
    // actively-progressing round died on the activity timeout — PR #907).
    const stream = makeGappedPushStream([
      { event: { type: 'reasoning_delta', text: 'thinking 1' }, gapMs: 40 },
      { event: { type: 'reasoning_delta', text: 'thinking 2' }, gapMs: 40 },
      { event: { type: 'text_delta', text: 'final answer' }, gapMs: 40 },
      { event: { type: 'done', finishReason: 'stop' }, gapMs: 0 },
    ]);

    const promise = iteratePushStreamText(
      stream,
      { provider: 'openrouter', model: 'm', messages: [] },
      50,
      'timed out',
      undefined,
      undefined,
      { reasoningResetsActivityTimer: true },
    );
    await vi.runAllTimersAsync();
    const { error, text } = await promise;

    expect(error).toBeNull();
    expect(text).toBe('final answer');
  });

  it('allows a slow first token within firstTokenGraceMs, then tightens', async () => {
    // First token lands at 120ms — past the 50ms activity timeout but within
    // the 200ms first-token grace, so it survives (mirrors a Workers AI model
    // with a slow time-to-first-token). Subsequent gaps use the tight 50ms.
    const stream = makeGappedPushStream([
      { event: { type: 'text_delta', text: 'late ' }, gapMs: 120 },
      { event: { type: 'text_delta', text: 'start' }, gapMs: 30 },
      { event: { type: 'done', finishReason: 'stop' }, gapMs: 10 },
    ]);

    const promise = iteratePushStreamText(
      stream,
      { provider: 'openrouter', model: 'm', messages: [] },
      50,
      'timed out',
      undefined,
      undefined,
      { firstTokenGraceMs: 200 },
    );
    await vi.runAllTimersAsync();
    const { error, text } = await promise;

    expect(error).toBeNull();
    expect(text).toBe('late start');
  });

  it('tightens to timeoutMs after the first token — a mid-stream stall still trips', async () => {
    // First token survives via the grace; the second is 120ms later, past the
    // tight 50ms inter-token window now in effect, so the activity timer fires.
    const stream = makeGappedPushStream([
      { event: { type: 'text_delta', text: 'ok ' }, gapMs: 120 },
      { event: { type: 'text_delta', text: 'then stall' }, gapMs: 120 },
      { event: { type: 'done', finishReason: 'stop' }, gapMs: 10 },
    ]);

    const promise = iteratePushStreamText(
      stream,
      { provider: 'openrouter', model: 'm', messages: [] },
      50,
      'timed out',
      undefined,
      undefined,
      { firstTokenGraceMs: 200 },
    );
    await vi.runAllTimersAsync();
    const { error, text } = await promise;

    expect(error).not.toBeNull();
    expect(error?.message).toBe('timed out');
    expect(text).toBe('ok ');
  });

  it('applies the first-token grace to a slow first reasoning token (heavy-reasoner opt-in)', async () => {
    // The kimi/glm inline case: the first activity is a reasoning token at
    // 120ms. With the opt-in it counts as activity, and the grace covers its
    // slow arrival, so the round is not killed as "unresponsive".
    const stream = makeGappedPushStream([
      { event: { type: 'reasoning_delta', text: 'thinking' }, gapMs: 120 },
      { event: { type: 'text_delta', text: 'answer' }, gapMs: 30 },
      { event: { type: 'done', finishReason: 'stop' }, gapMs: 10 },
    ]);

    const promise = iteratePushStreamText(
      stream,
      { provider: 'openrouter', model: 'm', messages: [] },
      50,
      'timed out',
      undefined,
      undefined,
      { reasoningResetsActivityTimer: true, firstTokenGraceMs: 200 },
    );
    await vi.runAllTimersAsync();
    const { error, text } = await promise;

    expect(error).toBeNull();
    expect(text).toBe('answer');
  });

  it('wall-clock still bounds an endless reasoner even with the opt-in', async () => {
    // Reasoning deltas every 30ms keep the 50ms activity timer alive
    // forever; the 100ms wall-clock backstop is what ends the round — the
    // documented precondition for opting in.
    const events: { event: PushStreamEvent; gapMs: number }[] = [];
    for (let i = 0; i < 20; i++) {
      events.push({ event: { type: 'reasoning_delta', text: `loop ${i}` }, gapMs: 30 });
    }
    const stream = makeGappedPushStream(events);

    const promise = iteratePushStreamText(
      stream,
      { provider: 'openrouter', model: 'm', messages: [] },
      50,
      'activity timed out',
      100,
      'wall-clock cap hit',
      { reasoningResetsActivityTimer: true },
    );
    await vi.runAllTimersAsync();
    const { error } = await promise;

    expect(error?.message).toBe('wall-clock cap hit');
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

  it('returns native tool calls separately and counts them as activity', async () => {
    const stream = makeGappedPushStream([
      {
        event: {
          type: 'native_tool_call',
          call: { id: 'call_1', name: 'sandbox_read_file', args: { path: 'README.md' } },
        },
        gapMs: 30,
      },
      { event: { type: 'done', finishReason: 'tool_calls' }, gapMs: 30 },
    ]);

    const promise = iteratePushStreamText(
      stream,
      { provider: 'openrouter', model: 'm', messages: [] },
      50,
      'timed out',
    );
    await vi.runAllTimersAsync();
    const { error, text, nativeToolCalls } = await promise;

    expect(error).toBeNull();
    expect(text).toBe('');
    expect(nativeToolCalls).toEqual([
      { id: 'call_1', name: 'sandbox_read_file', args: { path: 'README.md' } },
    ]);
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

  it('fires the wall-clock backstop when text_delta keeps resetting the activity timer', async () => {
    // 50ms gaps between text_deltas with a 100ms activity timeout (never trips)
    // and a 120ms wall-clock cap. The third text_delta lands at t=150ms, past
    // the wall-clock — so the stream must abort with the wall-clock message.
    const stream = makeGappedPushStream([
      { event: { type: 'text_delta', text: 'a' }, gapMs: 50 },
      { event: { type: 'text_delta', text: 'b' }, gapMs: 50 },
      { event: { type: 'text_delta', text: 'c' }, gapMs: 50 },
      { event: { type: 'text_delta', text: 'd' }, gapMs: 50 },
      { event: { type: 'done', finishReason: 'stop' }, gapMs: 0 },
    ]);

    const promise = iteratePushStreamText(
      stream,
      { provider: 'openrouter', model: 'm', messages: [] },
      100,
      'activity timed out',
      120,
      'wall-clock timed out',
    );
    await vi.runAllTimersAsync();
    const { error } = await promise;

    expect(error).not.toBeNull();
    expect(error?.message).toBe('wall-clock timed out');
  });

  it('does not fire the wall-clock backstop when the stream completes within the cap', async () => {
    const stream = makeGappedPushStream([
      { event: { type: 'text_delta', text: 'hello ' }, gapMs: 20 },
      { event: { type: 'text_delta', text: 'world' }, gapMs: 20 },
      { event: { type: 'done', finishReason: 'stop' }, gapMs: 10 },
    ]);

    const promise = iteratePushStreamText(
      stream,
      { provider: 'openrouter', model: 'm', messages: [] },
      100,
      'activity timed out',
      500,
      'wall-clock timed out',
    );
    await vi.runAllTimersAsync();
    const { error, text } = await promise;

    expect(error).toBeNull();
    expect(text).toBe('hello world');
  });

  it('falls back to the activity-timeout message when wall-clock is set but activity fires first', async () => {
    // 60ms reasoning_delta gaps (don't reset activity) with a 50ms activity
    // timeout and a generous 5000ms wall-clock. Activity fires first.
    const stream = makeGappedPushStream([
      { event: { type: 'reasoning_delta', text: 'thinking' }, gapMs: 60 },
      { event: { type: 'text_delta', text: 'never reached' }, gapMs: 0 },
      { event: { type: 'done', finishReason: 'stop' }, gapMs: 0 },
    ]);

    const promise = iteratePushStreamText(
      stream,
      { provider: 'openrouter', model: 'm', messages: [] },
      50,
      'activity timed out',
      5000,
      'wall-clock timed out',
    );
    await vi.runAllTimersAsync();
    const { error } = await promise;

    expect(error?.message).toBe('activity timed out');
  });

  it('preserves the first-to-fire winner even when the other timer would have fired during teardown', async () => {
    // Activity timer (50ms) trips on a long reasoning gap. After abort,
    // we run all pending timers — including a wall-clock timer (60ms) whose
    // deadline has now passed. The "first to fire wins" rule must keep the
    // activity message: the wall-clock callback should bail because
    // timeoutKind is already set.
    const stream = makeGappedPushStream([
      { event: { type: 'reasoning_delta', text: 'long thought' }, gapMs: 100 },
      { event: { type: 'text_delta', text: 'never reached' }, gapMs: 0 },
      { event: { type: 'done', finishReason: 'stop' }, gapMs: 0 },
    ]);

    const promise = iteratePushStreamText(
      stream,
      { provider: 'openrouter', model: 'm', messages: [] },
      50,
      'activity timed out',
      60,
      'wall-clock timed out',
    );
    await vi.runAllTimersAsync();
    const { error } = await promise;

    expect(error?.message).toBe('activity timed out');
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
