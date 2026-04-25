import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type {
  AdapterTimeoutConfig,
  LlmMessage,
  PushStream,
  PushStreamEvent,
  StreamUsage,
  AIProviderType,
} from './provider-contract.js';
import { createProviderStreamAdapter, providerStreamFnToPushStream } from './provider-contract.js';
import type { ProviderStreamFn, PushStreamRequest } from './provider-contract.js';

describe('createProviderStreamAdapter', () => {
  const messages: LlmMessage[] = [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }];
  const provider: AIProviderType = 'openrouter';
  const testOptions = { defaultModel: 'test-model' };

  it('maps text_delta events to onToken', async () => {
    const events: PushStreamEvent[] = [
      { type: 'text_delta', text: 'hello' },
      { type: 'text_delta', text: ' world' },
    ];
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      for (const e of events) yield e;
    });

    const adapted = createProviderStreamAdapter(stream, provider, testOptions);
    const tokens: string[] = [];
    await adapted(
      messages,
      (t) => tokens.push(t),
      () => {},
      () => {},
    );
    expect(tokens).toEqual(['hello', ' world']);
  });

  it('maps reasoning_delta events to onThinkingToken', async () => {
    const events: PushStreamEvent[] = [
      { type: 'reasoning_delta', text: 'thinking...' },
      { type: 'reasoning_delta', text: ' still thinking' },
    ];
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      for (const e of events) yield e;
    });

    const adapted = createProviderStreamAdapter(stream, provider, testOptions);
    const thoughts: (string | null)[] = [];
    await adapted(
      messages,
      () => {},
      () => {},
      () => {},
      (t) => thoughts.push(t),
    );
    expect(thoughts).toEqual(['thinking...', ' still thinking']);
  });

  it('maps reasoning_end events to onThinkingToken(null)', async () => {
    const events: PushStreamEvent[] = [
      { type: 'reasoning_delta', text: 'thinking' },
      { type: 'reasoning_end' },
      { type: 'text_delta', text: 'answer' },
      { type: 'done', finishReason: 'stop' },
    ];
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      for (const e of events) yield e;
    });

    const adapted = createProviderStreamAdapter(stream, provider, testOptions);
    const thoughts: (string | null)[] = [];
    const tokens: string[] = [];
    await adapted(
      messages,
      (t) => tokens.push(t),
      () => {},
      () => {},
      (t) => thoughts.push(t),
    );
    // The end-of-reasoning signal is `null`, matching the legacy callback contract.
    expect(thoughts).toEqual(['thinking', null]);
    expect(tokens).toEqual(['answer']);
  });

  it('maps done event to onDone with usage', async () => {
    const usage: StreamUsage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
    const events: PushStreamEvent[] = [
      { type: 'text_delta', text: 'ok' },
      { type: 'done', finishReason: 'stop', usage },
    ];
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      for (const e of events) yield e;
    });

    const adapted = createProviderStreamAdapter(stream, provider, testOptions);
    let receivedUsage: StreamUsage | undefined;
    await adapted(
      messages,
      () => {},
      (u) => {
        receivedUsage = u;
      },
      () => {},
    );
    expect(receivedUsage).toEqual(usage);
  });

  it('calls onError when the gateway stream throws', async () => {
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      throw new Error('network failure');
    });

    const adapted = createProviderStreamAdapter(stream, provider, testOptions);
    let caught: Error | undefined;
    await adapted(
      messages,
      () => {},
      () => {},
      (e) => {
        caught = e;
      },
    );
    expect(caught?.message).toBe('network failure');
  });

  it('calls onError when neither modelOverride nor defaultModel is provided', async () => {
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      yield { type: 'text_delta', text: 'should not run' };
    });

    const adapted = createProviderStreamAdapter(stream, provider);
    let caught: Error | undefined;
    await adapted(
      messages,
      () => {},
      () => {},
      (e) => {
        caught = e;
      },
    );
    expect(caught?.message).toMatch(/no model provided/i);
    expect(stream).not.toHaveBeenCalled();
  });

  it('returns early and calls onDone when signal is aborted before start', async () => {
    const controller = new AbortController();
    controller.abort();

    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      yield { type: 'text_delta', text: 'should not run' };
    });

    const adapted = createProviderStreamAdapter(stream, provider, testOptions);
    let caught: Error | undefined;
    const onDone = vi.fn();
    await adapted(
      messages,
      () => {},
      onDone,
      (e) => {
        caught = e;
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );

    expect(caught).toBeUndefined();
    expect(onDone).toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it('aborts mid-stream when signal fires and calls onDone', async () => {
    const controller = new AbortController();
    const tokens: string[] = [];
    let aborted = false;
    const onDone = vi.fn();
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      yield { type: 'text_delta', text: 'a' };
      controller.abort();
      aborted = true;
      yield { type: 'text_delta', text: 'b' };
      yield { type: 'text_delta', text: 'c' };
    });

    const adapted = createProviderStreamAdapter(stream, provider, testOptions);
    await adapted(
      messages,
      (t) => tokens.push(t),
      onDone,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );

    expect(tokens).toEqual(['a']);
    expect(aborted).toBe(true);
    expect(onDone).toHaveBeenCalled();
  });

  it('forwards runtime-context fields (workspaceContext, hasSandbox, onPreCompact) to gateway', async () => {
    let captured: any;
    const stream: PushStream = vi.fn().mockImplementation(async function* (req) {
      captured = req;
      yield { type: 'done', finishReason: 'stop' };
    });

    const ctx = { mode: 'workspace', description: 'test repo' };
    const preCompact = vi.fn();
    const adapted = createProviderStreamAdapter(stream, provider, testOptions);
    await adapted(
      messages,
      () => {},
      () => {},
      () => {},
      undefined,
      ctx,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      preCompact,
    );

    expect(captured.workspaceContext).toBe(ctx);
    expect(captured.hasSandbox).toBe(true);
    expect(captured.onPreCompact).toBe(preCompact);
  });

  it('passes systemPromptOverride and scratchpadContent to gateway', async () => {
    let captured: any;
    const stream: PushStream = vi.fn().mockImplementation(async function* (req) {
      captured = req;
      yield { type: 'done', finishReason: 'stop' };
    });

    const adapted = createProviderStreamAdapter(stream, provider, testOptions);
    await adapted(
      messages,
      () => {},
      () => {},
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      'system-override',
      'scratch-content',
    );

    expect(captured.systemPromptOverride).toBe('system-override');
    expect(captured.scratchpadContent).toBe('scratch-content');
  });

  it('uses defaultModel from options when no override is present', async () => {
    let capturedModel = '';
    const stream: PushStream = vi.fn().mockImplementation(async function* (req) {
      capturedModel = req.model;
      yield { type: 'done', finishReason: 'stop' };
    });

    const adapted = createProviderStreamAdapter(stream, provider, {
      defaultModel: 'fallback-model',
    });
    await adapted(
      messages,
      () => {},
      () => {},
      () => {},
    );

    expect(capturedModel).toBe('fallback-model');
  });

  it('prioritizes modelOverride over defaultModel', async () => {
    let capturedModel = '';
    const stream: PushStream = vi.fn().mockImplementation(async function* (req) {
      capturedModel = req.model;
      yield { type: 'done', finishReason: 'stop' };
    });

    const adapted = createProviderStreamAdapter(stream, provider, {
      defaultModel: 'fallback-model',
    });
    await adapted(
      messages,
      () => {},
      () => {},
      () => {},
      undefined,
      undefined,
      undefined,
      'primary-model',
    );

    expect(capturedModel).toBe('primary-model');
  });
});

// ---------------------------------------------------------------------------
// Timer machinery
// ---------------------------------------------------------------------------

/**
 * Controllable async-iterable stream for timer tests. The generator awaits on
 * a shared notify promise when the queue is empty, which lets tests push
 * events interleaved with `vi.advanceTimersByTimeAsync` calls.
 *
 * The returned generator respects `req.signal`: aborting the signal makes
 * the iterator return, matching how a real PushStream implementation
 * propagates cancellation down to its fetch reader.
 */
function makeControllableEventStream() {
  const events: PushStreamEvent[] = [];
  let finished = false;
  let thrownError: Error | null = null;
  let notify: (() => void) | null = null;

  function signal(): void {
    const n = notify;
    notify = null;
    n?.();
  }

  async function* iter(sig?: AbortSignal): AsyncIterable<PushStreamEvent> {
    const onAbort = () => signal();
    sig?.addEventListener('abort', onAbort);
    try {
      while (true) {
        if (sig?.aborted) return;
        if (thrownError) throw thrownError;
        const next = events.shift();
        if (next) {
          yield next;
          continue;
        }
        if (finished) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    } finally {
      sig?.removeEventListener('abort', onAbort);
    }
  }

  return {
    stream: (req: { signal?: AbortSignal }) => iter(req.signal),
    push(event: PushStreamEvent) {
      events.push(event);
      signal();
    },
    end() {
      finished = true;
      signal();
    },
    throwErr(err: Error) {
      thrownError = err;
      signal();
    },
  };
}

/** Yield to pending microtasks so awaited iterator + event dispatch settle. */
async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('createProviderStreamAdapter timer machinery', () => {
  const messages: LlmMessage[] = [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }];
  const provider: AIProviderType = 'openrouter';
  const testOptions = { defaultModel: 'test-model' };

  const timeouts: AdapterTimeoutConfig = {
    eventTimeoutMs: 10_000,
    contentTimeoutMs: 20_000,
    totalTimeoutMs: 60_000,
    errorMessages: {
      event: (s) => `event ${s}s`,
      content: (s) => `content ${s}s`,
      total: (s) => `total ${s}s`,
    },
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fires eventTimeoutMs when no events arrive at all', async () => {
    const { stream } = makeControllableEventStream();
    const adapted = createProviderStreamAdapter(stream as PushStream, provider, {
      ...testOptions,
      timeouts,
    });
    const onError = vi.fn();
    const onDone = vi.fn();
    const done = adapted(messages, () => {}, onDone, onError);

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(11_000);
    await done;

    expect(onDone).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('event 10s');
  });

  it('resets eventTimeoutMs on every event including reasoning_end', async () => {
    const { stream, push, end } = makeControllableEventStream();
    const adapted = createProviderStreamAdapter(stream as PushStream, provider, {
      ...testOptions,
      timeouts,
    });
    const onError = vi.fn();
    const onDone = vi.fn();
    const done = adapted(messages, () => {}, onDone, onError);

    await flushMicrotasks();
    // Walk 6s, push reasoning_end (resets event timer even though not content).
    await vi.advanceTimersByTimeAsync(6_000);
    push({ type: 'reasoning_end' });
    await flushMicrotasks();
    // Another 6s — inside the reset event window.
    await vi.advanceTimersByTimeAsync(6_000);
    push({ type: 'reasoning_end' });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(6_000);
    end();
    await flushMicrotasks();
    await done;

    expect(onError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it('contentTimeoutMs fires when stream stays active with no user-visible deltas', async () => {
    // Regression guard for PR #384 review: contentTimer must arm at the
    // start of iteration (parity with legacy stallTimeoutMs which armed
    // at response-landing). A stream that keeps the event timer alive
    // via structural events but never emits text_delta/reasoning_delta
    // should still trip the content timeout.
    const { stream, push } = makeControllableEventStream();
    const adapted = createProviderStreamAdapter(stream as PushStream, provider, {
      ...testOptions,
      timeouts,
    });
    const onError = vi.fn();
    const onDone = vi.fn();
    const done = adapted(messages, () => {}, onDone, onError);

    await flushMicrotasks();
    // Push reasoning_end every 5s — keeps eventTimer (10s) alive but
    // never touches contentTimer (20s). Content should fire first.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      push({ type: 'reasoning_end' });
      await flushMicrotasks();
    }
    await done;

    expect(onDone).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('content 20s');
  });

  it('text_delta resets contentTimeoutMs', async () => {
    const { stream, push, end } = makeControllableEventStream();
    const adapted = createProviderStreamAdapter(stream as PushStream, provider, {
      ...testOptions,
      timeouts,
    });
    const onError = vi.fn();
    const onDone = vi.fn();
    const done = adapted(messages, () => {}, onDone, onError);

    await flushMicrotasks();
    // Five text events 8s apart — total 40s, well past contentTimeoutMs of 20s.
    // contentTimer must reset each time to avoid tripping.
    for (let i = 0; i < 5; i++) {
      push({ type: 'text_delta', text: `chunk-${i}` });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(8_000);
    }
    end();
    await flushMicrotasks();
    await done;

    expect(onError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it('reasoning_delta resets contentTimeoutMs', async () => {
    const { stream, push, end } = makeControllableEventStream();
    const adapted = createProviderStreamAdapter(stream as PushStream, provider, {
      ...testOptions,
      timeouts,
    });
    const onError = vi.fn();
    const onDone = vi.fn();
    const done = adapted(messages, () => {}, onDone, onError);

    await flushMicrotasks();
    for (let i = 0; i < 5; i++) {
      push({ type: 'reasoning_delta', text: `thinking-${i}` });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(8_000);
    }
    end();
    await flushMicrotasks();
    await done;

    expect(onError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it('reasoning_end does NOT reset contentTimeoutMs', async () => {
    // Events arrive (reset eventTimer) but none carry content. Content timer
    // should still fire at contentTimeoutMs since reasoning_end is
    // structural, not user-visible progress.
    const { stream, push } = makeControllableEventStream();
    const adapted = createProviderStreamAdapter(stream as PushStream, provider, {
      ...testOptions,
      timeouts,
    });
    const onError = vi.fn();
    const onDone = vi.fn();
    const done = adapted(messages, () => {}, onDone, onError);

    await flushMicrotasks();
    // Seed with a reasoning_delta to arm the content timer.
    push({ type: 'reasoning_delta', text: 'warmup' });
    await flushMicrotasks();
    // From here on, only reasoning_end events — keeps event timer alive but
    // leaves content timer ticking against the 20s deadline.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      push({ type: 'reasoning_end' });
      await flushMicrotasks();
    }
    await done;

    expect(onDone).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('content 20s');
  });

  it('totalTimeoutMs fires regardless of continuous event activity', async () => {
    const { stream, push } = makeControllableEventStream();
    const adapted = createProviderStreamAdapter(stream as PushStream, provider, {
      ...testOptions,
      timeouts,
    });
    const onError = vi.fn();
    const onDone = vi.fn();
    const done = adapted(messages, () => {}, onDone, onError);

    await flushMicrotasks();
    // Push a text event every 5s. eventTimer and contentTimer never fire
    // because each push resets both. Total should fire at 60s.
    for (let i = 0; i < 13; i++) {
      push({ type: 'text_delta', text: `chunk-${i}` });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await done;

    expect(onDone).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('total 60s');
  });

  it('external abort wins cleanly over internal timeout and settles via onDone', async () => {
    const { stream, push } = makeControllableEventStream();
    const adapted = createProviderStreamAdapter(stream as PushStream, provider, {
      ...testOptions,
      timeouts,
    });
    const abortController = new AbortController();
    const onError = vi.fn();
    const onDone = vi.fn();
    const done = adapted(
      messages,
      () => {},
      onDone,
      onError,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      abortController.signal,
    );

    await flushMicrotasks();
    push({ type: 'text_delta', text: 'hi' });
    await flushMicrotasks();
    // Abort mid-stream. External abort should beat any pending timer.
    abortController.abort();
    await flushMicrotasks();
    await done;

    expect(onError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('done event clears all timers', async () => {
    const { stream, push } = makeControllableEventStream();
    const adapted = createProviderStreamAdapter(stream as PushStream, provider, {
      ...testOptions,
      timeouts,
    });
    const onError = vi.fn();
    const onDone = vi.fn();
    const usage: StreamUsage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    const done = adapted(messages, () => {}, onDone, onError);

    await flushMicrotasks();
    push({ type: 'text_delta', text: 'hi' });
    await flushMicrotasks();
    push({ type: 'done', finishReason: 'stop', usage });
    await flushMicrotasks();
    // Advance well past every timer — if any timer survived, it would fire.
    await vi.advanceTimersByTimeAsync(120_000);
    await done;

    expect(onError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(usage);
  });

  it('upstream thrown error clears timers and routes to onError', async () => {
    const { stream, throwErr } = makeControllableEventStream();
    const adapted = createProviderStreamAdapter(stream as PushStream, provider, {
      ...testOptions,
      timeouts,
    });
    const onError = vi.fn();
    const onDone = vi.fn();
    const done = adapted(messages, () => {}, onDone, onError);

    await flushMicrotasks();
    throwErr(new Error('upstream 500'));
    await flushMicrotasks();
    // Advance past every timer — shouldn't fire because they were cleared.
    await vi.advanceTimersByTimeAsync(120_000);
    await done;

    expect(onDone).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('upstream 500');
  });

  it('works without any timeouts config (backward compatible)', async () => {
    const { stream, push, end } = makeControllableEventStream();
    const adapted = createProviderStreamAdapter(stream as PushStream, provider, testOptions);
    const onError = vi.fn();
    const onDone = vi.fn();
    const done = adapted(messages, () => {}, onDone, onError);

    await flushMicrotasks();
    push({ type: 'text_delta', text: 'hi' });
    await flushMicrotasks();
    // Advance arbitrarily — no timers should exist to fire.
    await vi.advanceTimersByTimeAsync(600_000);
    end();
    await flushMicrotasks();
    await done;

    expect(onError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it('falls back to a generic message when per-reason renderer is missing', async () => {
    const { stream } = makeControllableEventStream();
    const adapted = createProviderStreamAdapter(stream as PushStream, provider, {
      ...testOptions,
      timeouts: {
        eventTimeoutMs: 5_000,
        // No errorMessages at all.
      },
    });
    const onError = vi.fn();
    const done = adapted(
      messages,
      () => {},
      () => {},
      onError,
    );

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(6_000);
    await done;

    expect(onError).toHaveBeenCalledTimes(1);
    const msg = (onError.mock.calls[0][0] as Error).message;
    expect(msg).toMatch(/no events for 5s/);
  });
});

// ---------------------------------------------------------------------------
// Telemetry hook
// ---------------------------------------------------------------------------

describe('createProviderStreamAdapter telemetry hook', () => {
  const messages: LlmMessage[] = [
    { id: '1', role: 'user', content: 'hi', timestamp: 0 },
    { id: '2', role: 'assistant', content: 'previous reply', timestamp: 1 },
  ];
  const provider: AIProviderType = 'openrouter';
  const testOptions = { defaultModel: 'test-model' };

  async function streamFrom(events: PushStreamEvent[]): Promise<PushStream> {
    return vi.fn().mockImplementation(async function* () {
      for (const e of events) yield e;
    });
  }

  it('invokes wrap with a start context and finalize with a clean result on done', async () => {
    const events: PushStreamEvent[] = [
      { type: 'text_delta', text: 'hello' },
      { type: 'text_delta', text: ' world' },
      {
        type: 'done',
        finishReason: 'stop',
        usage: { inputTokens: 7, outputTokens: 11, totalTokens: 18 },
      },
    ];
    const stream = await streamFrom(events);

    let capturedCtx: unknown;
    let capturedResult: unknown;
    const telemetry = {
      wrap: vi.fn(async (ctx: unknown, run: (finalize: (r: unknown) => void) => Promise<void>) => {
        capturedCtx = ctx;
        await run((r) => {
          capturedResult = r;
        });
      }),
    };

    const adapted = createProviderStreamAdapter(stream, provider, {
      ...testOptions,
      telemetry,
    });
    await adapted(
      messages,
      () => {},
      () => {},
      () => {},
    );

    expect(telemetry.wrap).toHaveBeenCalledTimes(1);
    expect(capturedCtx).toEqual({
      provider: 'openrouter',
      model: 'test-model',
      messageCount: 2,
    });
    expect(capturedResult).toEqual({
      abortReason: null,
      eventCount: 3,
      textChars: 'hello'.length + ' world'.length,
      reasoningChars: 0,
      usage: { inputTokens: 7, outputTokens: 11, totalTokens: 18 },
      error: undefined,
    });
  });

  it('tallies reasoning_delta chars separately and preserves reasoning_end in event count', async () => {
    const events: PushStreamEvent[] = [
      { type: 'reasoning_delta', text: 'thinking' },
      { type: 'reasoning_delta', text: ' more' },
      { type: 'reasoning_end' },
      { type: 'text_delta', text: 'answer' },
      { type: 'done', finishReason: 'stop' },
    ];
    const stream = await streamFrom(events);

    let capturedResult: unknown;
    const adapted = createProviderStreamAdapter(stream, provider, {
      ...testOptions,
      telemetry: {
        wrap: async (_ctx, run) => {
          await run((r) => {
            capturedResult = r;
          });
        },
      },
    });
    await adapted(
      messages,
      () => {},
      () => {},
      () => {},
      () => {},
    );

    expect(capturedResult).toMatchObject({
      eventCount: 5,
      textChars: 'answer'.length,
      reasoningChars: 'thinking'.length + ' more'.length,
      abortReason: null,
    });
  });

  it('reports abortReason and error on timeout', async () => {
    vi.useFakeTimers();
    try {
      // Use the signal-aware controllable stream from the timer-machinery
      // suite above — it respects `req.signal` so when the event timer
      // fires the generator returns instead of hanging forever.
      const { stream } = makeControllableEventStream();

      let capturedResult: AdapterTimeoutEndLike | undefined;
      const adapted = createProviderStreamAdapter(stream as PushStream, provider, {
        ...testOptions,
        timeouts: {
          eventTimeoutMs: 5_000,
          errorMessages: { event: (s) => `event ${s}s` },
        },
        telemetry: {
          wrap: async (_ctx, run) => {
            await run((r) => {
              capturedResult = r as AdapterTimeoutEndLike;
            });
          },
        },
      });
      const done = adapted(
        messages,
        () => {},
        () => {},
        () => {},
      );
      await vi.advanceTimersByTimeAsync(6_000);
      await done;

      expect(capturedResult?.abortReason).toBe('event');
      expect(capturedResult?.error?.message).toBe('event 5s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports abortReason user and no error on external abort', async () => {
    const controller = new AbortController();
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      yield { type: 'text_delta', text: 'a' };
      controller.abort();
      yield { type: 'text_delta', text: 'b' };
    });

    let capturedResult: AdapterTimeoutEndLike | undefined;
    const adapted = createProviderStreamAdapter(stream, provider, {
      ...testOptions,
      telemetry: {
        wrap: async (_ctx, run) => {
          await run((r) => {
            capturedResult = r as AdapterTimeoutEndLike;
          });
        },
      },
    });
    await adapted(
      messages,
      () => {},
      () => {},
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );

    expect(capturedResult?.abortReason).toBe('user');
    expect(capturedResult?.error).toBeUndefined();
  });

  it('reports thrown upstream error via result.error', async () => {
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      throw new Error('network boom');
    });

    let capturedResult: AdapterTimeoutEndLike | undefined;
    const adapted = createProviderStreamAdapter(stream, provider, {
      ...testOptions,
      telemetry: {
        wrap: async (_ctx, run) => {
          await run((r) => {
            capturedResult = r as AdapterTimeoutEndLike;
          });
        },
      },
    });
    await adapted(
      messages,
      () => {},
      () => {},
      () => {},
    );

    expect(capturedResult?.abortReason).toBeNull();
    expect(capturedResult?.error?.message).toBe('network boom');
  });

  it('no-op path works with telemetry omitted (backward compat)', async () => {
    const stream = await streamFrom([
      { type: 'text_delta', text: 'hi' },
      { type: 'done', finishReason: 'stop' },
    ]);
    const adapted = createProviderStreamAdapter(stream, provider, testOptions);
    const onDone = vi.fn();
    await adapted(
      messages,
      () => {},
      onDone,
      () => {},
    );
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  // ----------------------------------------------------------------------
  // Review-feedback regression guards (PR #385)
  // ----------------------------------------------------------------------

  it('passes the same Error instance to onError and telemetry result on timeout', async () => {
    vi.useFakeTimers();
    try {
      const { stream } = makeControllableEventStream();
      let capturedTelemetryError: Error | undefined;
      let capturedCallerError: Error | undefined;
      const adapted = createProviderStreamAdapter(stream as PushStream, provider, {
        ...testOptions,
        timeouts: {
          eventTimeoutMs: 5_000,
          errorMessages: { event: (s) => `event ${s}s` },
        },
        telemetry: {
          wrap: async (_ctx, run) => {
            await run((r) => {
              capturedTelemetryError = r.error;
            });
          },
        },
      });
      const done = adapted(
        messages,
        () => {},
        () => {},
        (e) => {
          capturedCallerError = e;
        },
      );
      await vi.advanceTimersByTimeAsync(6_000);
      await done;

      expect(capturedCallerError).toBeDefined();
      expect(capturedTelemetryError).toBeDefined();
      // Same identity — not two Error instances with the same message.
      expect(capturedCallerError).toBe(capturedTelemetryError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards hasSandbox and workspaceMode into the telemetry start context', async () => {
    const events: PushStreamEvent[] = [{ type: 'done', finishReason: 'stop' }];
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      for (const e of events) yield e;
    });
    let capturedCtx: AdapterTelemetryStartContextLike | undefined;
    const adapted = createProviderStreamAdapter(stream, provider, {
      ...testOptions,
      telemetry: {
        wrap: async (ctx, run) => {
          capturedCtx = ctx as AdapterTelemetryStartContextLike;
          await run(() => {});
        },
      },
    });
    await adapted(
      messages,
      () => {},
      () => {},
      () => {},
      undefined,
      { mode: 'workspace', description: 'foo' } as unknown as undefined,
      true,
    );
    expect(capturedCtx).toMatchObject({
      provider: 'openrouter',
      hasSandbox: true,
      workspaceMode: 'workspace',
    });
  });

  it('omits workspaceMode when no workspaceContext is supplied', async () => {
    const events: PushStreamEvent[] = [{ type: 'done', finishReason: 'stop' }];
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      for (const e of events) yield e;
    });
    let capturedCtx: AdapterTelemetryStartContextLike | undefined;
    const adapted = createProviderStreamAdapter(stream, provider, {
      ...testOptions,
      telemetry: {
        wrap: async (ctx, run) => {
          capturedCtx = ctx as AdapterTelemetryStartContextLike;
          await run(() => {});
        },
      },
    });
    await adapted(
      messages,
      () => {},
      () => {},
      () => {},
    );
    expect(capturedCtx?.workspaceMode).toBeUndefined();
  });

  it('falls back to no-telemetry path when wrap rejects before invoking run', async () => {
    const events: PushStreamEvent[] = [
      { type: 'text_delta', text: 'hi' },
      { type: 'done', finishReason: 'stop' },
    ];
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      for (const e of events) yield e;
    });
    const onDone = vi.fn();
    const onError = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapted = createProviderStreamAdapter(stream, provider, {
      ...testOptions,
      telemetry: {
        wrap: async () => {
          throw new Error('tracer broken');
        },
      },
    });
    await adapted(messages, () => {}, onDone, onError);

    // The ProviderStreamFn contract still fires — stream runs via fallback.
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('swallows wrap rejections that happen after run settled (no second settlement)', async () => {
    const events: PushStreamEvent[] = [{ type: 'done', finishReason: 'stop' }];
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      for (const e of events) yield e;
    });
    const onDone = vi.fn();
    const onError = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapted = createProviderStreamAdapter(stream, provider, {
      ...testOptions,
      telemetry: {
        wrap: async (_ctx, run) => {
          await run(() => {});
          throw new Error('post-run telemetry failure');
        },
      },
    });
    await adapted(messages, () => {}, onDone, onError);

    // onDone already fired inside `run`; post-run wrap error must not
    // trigger a second settlement.
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// Helper shape for start-context assertions — avoids awkward casts in tests.
describe('providerStreamFnToPushStream', () => {
  const baseRequest: PushStreamRequest = {
    provider: 'openrouter',
    model: 'test-model',
    messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
  };

  async function collect<M>(stream: AsyncIterable<PushStreamEvent>): Promise<PushStreamEvent[]> {
    const out: PushStreamEvent[] = [];
    for await (const event of stream) out.push(event);
    return out;
  }

  it('maps onToken + onDone to text_delta + done', async () => {
    const streamFn: ProviderStreamFn = async (_msgs, onToken, onDone) => {
      onToken('hello');
      onToken(' world');
      onDone({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
    };
    const push = providerStreamFnToPushStream(streamFn);
    const events = await collect(push(baseRequest));
    expect(events).toEqual([
      { type: 'text_delta', text: 'hello' },
      { type: 'text_delta', text: ' world' },
      {
        type: 'done',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    ]);
  });

  it('maps onThinkingToken deltas to reasoning_delta and null to reasoning_end', async () => {
    const streamFn: ProviderStreamFn = async (_msgs, _onToken, onDone, _onError, onThinking) => {
      onThinking?.('thinking...');
      onThinking?.(' still');
      onThinking?.(null);
      onDone();
    };
    const push = providerStreamFnToPushStream(streamFn);
    const events = await collect(push(baseRequest));
    expect(events).toEqual([
      { type: 'reasoning_delta', text: 'thinking...' },
      { type: 'reasoning_delta', text: ' still' },
      { type: 'reasoning_end' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('drops zero-length token/thinking callbacks', async () => {
    const streamFn: ProviderStreamFn = async (_msgs, onToken, onDone, _onError, onThinking) => {
      onToken('');
      onThinking?.('');
      onToken('real');
      onDone();
    };
    const events = await collect(providerStreamFnToPushStream(streamFn)(baseRequest));
    expect(events).toEqual([
      { type: 'text_delta', text: 'real' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('propagates onError as an iterator throw', async () => {
    const boom = new Error('upstream failed');
    const streamFn: ProviderStreamFn = async (_msgs, _onToken, _onDone, onError) => {
      onError(boom);
    };
    const push = providerStreamFnToPushStream(streamFn);
    let caught: unknown;
    try {
      await collect(push(baseRequest));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
  });

  it('converts a thrown streamFn into an iterator throw', async () => {
    const boom = new Error('sync throw');
    const streamFn: ProviderStreamFn = async () => {
      throw boom;
    };
    const push = providerStreamFnToPushStream(streamFn);
    let caught: unknown;
    try {
      await collect(push(baseRequest));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
  });

  it('forwards request fields into the legacy callback positional args', async () => {
    const received: Record<string, unknown> = {};
    const signal = new AbortController().signal;
    const onPreCompact = vi.fn();
    const workspaceContext = { mode: 'test-mode' };
    const streamFn: ProviderStreamFn<LlmMessage, { mode: string }> = async (
      messages,
      _onToken,
      onDone,
      _onError,
      _onThinkingToken,
      ws,
      hasSandbox,
      modelOverride,
      systemPromptOverride,
      scratchpadContent,
      sig,
      onPreCompactCb,
      todoContent,
    ) => {
      received.messageCount = messages.length;
      received.ws = ws;
      received.hasSandbox = hasSandbox;
      received.modelOverride = modelOverride;
      received.systemPromptOverride = systemPromptOverride;
      received.scratchpadContent = scratchpadContent;
      received.sig = sig;
      received.onPreCompactCb = onPreCompactCb;
      received.todoContent = todoContent;
      onDone();
    };
    const push = providerStreamFnToPushStream(streamFn);
    await collect(
      push({
        ...baseRequest,
        systemPromptOverride: 'sys',
        scratchpadContent: 'scratch',
        todoContent: 'todo',
        workspaceContext,
        hasSandbox: true,
        signal,
        onPreCompact,
      }),
    );
    expect(received.messageCount).toBe(1);
    expect(received.ws).toBe(workspaceContext);
    expect(received.hasSandbox).toBe(true);
    expect(received.modelOverride).toBe('test-model');
    expect(received.systemPromptOverride).toBe('sys');
    expect(received.scratchpadContent).toBe('scratch');
    expect(received.sig).toBe(signal);
    expect(received.onPreCompactCb).toBe(onPreCompact);
    expect(received.todoContent).toBe('todo');
  });

  it('stops iterating after a done event even if more callbacks follow', async () => {
    const streamFn: ProviderStreamFn = async (_msgs, onToken, onDone) => {
      onToken('before');
      onDone();
      // Producer misbehaves and keeps emitting — consumer must not see these.
      onToken('after');
    };
    const events = await collect(providerStreamFnToPushStream(streamFn)(baseRequest));
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'done']);
  });

  it('emits a done event when streamFn resolves without invoking onDone/onError', async () => {
    const streamFn: ProviderStreamFn = async (_msgs, onToken) => {
      onToken('partial');
      // Resolves silently — no onDone, no onError.
    };
    const events = await collect(providerStreamFnToPushStream(streamFn)(baseRequest));
    expect(events).toEqual([
      { type: 'text_delta', text: 'partial' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('settles with finishReason aborted when req.signal aborts mid-stream', async () => {
    const controller = new AbortController();
    // streamFn that ignores cancellation and never settles its callbacks.
    const streamFn: ProviderStreamFn = (_msgs, onToken) =>
      new Promise(() => {
        onToken('pre-abort');
      });

    const iter = providerStreamFnToPushStream(streamFn)({
      ...baseRequest,
      signal: controller.signal,
    });
    const it = iter[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value).toEqual({ type: 'text_delta', text: 'pre-abort' });
    controller.abort();
    const second = await it.next();
    expect(second.value).toEqual({ type: 'done', finishReason: 'aborted' });
    const third = await it.next();
    expect(third.done).toBe(true);
  });

  it('returns immediately with a done event when req.signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    const streamFn: ProviderStreamFn = async () => {
      invoked = true;
    };
    const events = await collect(
      providerStreamFnToPushStream(streamFn)({ ...baseRequest, signal: controller.signal }),
    );
    expect(events).toEqual([{ type: 'done', finishReason: 'aborted' }]);
    // The streamFn is still kicked off (so it can clean up resources via signal),
    // but the bridge already settled before its callbacks could matter.
    expect(invoked).toBe(true);
  });
});

interface AdapterTelemetryStartContextLike {
  provider: string;
  model: string;
  messageCount: number;
  hasSandbox?: boolean;
  workspaceMode?: string;
}

// Helper shape used by the telemetry tests above.
interface AdapterTimeoutEndLike {
  abortReason: 'event' | 'content' | 'total' | 'user' | null;
  eventCount: number;
  textChars: number;
  reasoningChars: number;
  usage?: StreamUsage;
  error?: Error;
}
