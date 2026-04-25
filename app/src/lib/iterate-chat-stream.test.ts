import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmMessage, PushStream, PushStreamEvent } from '@push/lib/provider-contract';
import { iterateChatStream } from './iterate-chat-stream';

const messages: LlmMessage[] = [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }];
const baseRequest = {
  provider: 'openrouter' as const,
  model: 'sonnet-4.6',
  messages,
};

function makeStream(events: PushStreamEvent[]): PushStream {
  return () =>
    (async function* () {
      for (const event of events) {
        yield event;
      }
    })();
}

function makeGappedStream(events: { event: PushStreamEvent; gapMs: number }[]): PushStream {
  return () =>
    (async function* () {
      for (const { event, gapMs } of events) {
        if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
        yield event;
      }
    })();
}

function callbacks() {
  return {
    onToken: vi.fn<(token: string) => void>(),
    onDone: vi.fn<(usage?: import('@push/lib/provider-contract').StreamUsage) => void>(),
    onError: vi.fn<(err: Error) => void>(),
    onThinkingToken: vi.fn<(token: string | null) => void>(),
  };
}

describe('iterateChatStream — basic event dispatch', () => {
  it('dispatches text_delta to onToken and done to onDone with usage', async () => {
    const cbs = callbacks();
    await iterateChatStream(
      makeStream([
        { type: 'text_delta', text: 'hello ' },
        { type: 'text_delta', text: 'world' },
        {
          type: 'done',
          finishReason: 'stop',
          usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
        },
      ]),
      baseRequest,
      cbs,
      { telemetry: 'disabled' },
    );

    expect(cbs.onToken).toHaveBeenCalledTimes(2);
    expect(cbs.onToken).toHaveBeenNthCalledWith(1, 'hello ');
    expect(cbs.onToken).toHaveBeenNthCalledWith(2, 'world');
    expect(cbs.onDone).toHaveBeenCalledWith({ inputTokens: 5, outputTokens: 7, totalTokens: 12 });
    expect(cbs.onError).not.toHaveBeenCalled();
  });

  it('dispatches reasoning_delta to onThinkingToken and reasoning_end with null', async () => {
    const cbs = callbacks();
    await iterateChatStream(
      makeStream([
        { type: 'reasoning_delta', text: 'thinking...' },
        { type: 'reasoning_end' },
        { type: 'text_delta', text: 'answer' },
        { type: 'done', finishReason: 'stop' },
      ]),
      baseRequest,
      cbs,
      { telemetry: 'disabled' },
    );

    expect(cbs.onThinkingToken).toHaveBeenCalledWith('thinking...');
    expect(cbs.onThinkingToken).toHaveBeenCalledWith(null);
    expect(cbs.onToken).toHaveBeenCalledWith('answer');
  });

  it('passes the request envelope into the stream factory', async () => {
    let captured: unknown = null;
    const stream: PushStream = (req) => {
      captured = req;
      return (async function* () {
        yield { type: 'done', finishReason: 'stop' };
      })();
    };

    await iterateChatStream(
      stream,
      {
        provider: 'openrouter',
        model: 'sonnet-4.6',
        messages,
        systemPromptOverride: 'sys',
        scratchpadContent: 'scratch',
        todoContent: 'todo',
        workspaceContext: { mode: 'workspace' },
        hasSandbox: true,
      },
      callbacks(),
      { telemetry: 'disabled' },
    );

    const req = captured as {
      provider: string;
      model: string;
      systemPromptOverride?: string;
      scratchpadContent?: string;
      todoContent?: string;
      workspaceContext?: unknown;
      hasSandbox?: boolean;
      signal?: AbortSignal;
    };
    expect(req.provider).toBe('openrouter');
    expect(req.model).toBe('sonnet-4.6');
    expect(req.systemPromptOverride).toBe('sys');
    expect(req.scratchpadContent).toBe('scratch');
    expect(req.todoContent).toBe('todo');
    expect(req.workspaceContext).toEqual({ mode: 'workspace' });
    expect(req.hasSandbox).toBe(true);
    expect(req.signal).toBeInstanceOf(AbortSignal);
  });

  it('settles cleanly when the stream drains without a done event', async () => {
    const cbs = callbacks();
    await iterateChatStream(makeStream([{ type: 'text_delta', text: 'hi' }]), baseRequest, cbs, {
      telemetry: 'disabled',
    });

    expect(cbs.onToken).toHaveBeenCalledWith('hi');
    expect(cbs.onDone).toHaveBeenCalledTimes(1);
    expect(cbs.onError).not.toHaveBeenCalled();
  });
});

/**
 * Hand-rolled async iterable that throws on first `next()`. Avoids
 * `async function*` bodies with a stray `throw` (which trips
 * `require-yield`) when we want a stream that errors instead of yielding.
 */
function throwingStream(err: Error): PushStream {
  return () => ({
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<PushStreamEvent>> {
          return Promise.reject(err);
        },
      };
    },
  });
}

describe('iterateChatStream — error paths', () => {
  it('surfaces upstream errors via onError', async () => {
    const cbs = callbacks();
    await iterateChatStream(throwingStream(new Error('upstream went away')), baseRequest, cbs, {
      telemetry: 'disabled',
    });

    expect(cbs.onError).toHaveBeenCalledTimes(1);
    expect(cbs.onError.mock.calls[0]?.[0]?.message).toBe('upstream went away');
    expect(cbs.onDone).not.toHaveBeenCalled();
  });

  it('treats AbortError without an abortReason as clean settlement', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';

    const cbs = callbacks();
    await iterateChatStream(throwingStream(abortErr), baseRequest, cbs, {
      telemetry: 'disabled',
    });

    expect(cbs.onDone).toHaveBeenCalledTimes(1);
    expect(cbs.onError).not.toHaveBeenCalled();
  });
});

describe('iterateChatStream — external abort', () => {
  it('settles cleanly when the external signal aborts mid-stream', async () => {
    const controller = new AbortController();
    const cbs = callbacks();

    const stream: PushStream = (req) =>
      (async function* () {
        yield { type: 'text_delta', text: 'partial' };
        // Wait until the consumer aborts the request signal.
        while (!req.signal?.aborted) {
          await new Promise((r) => setTimeout(r, 5));
        }
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      })();

    const promise = iterateChatStream(stream, { ...baseRequest, signal: controller.signal }, cbs, {
      telemetry: 'disabled',
    });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await promise;

    expect(cbs.onToken).toHaveBeenCalledWith('partial');
    expect(cbs.onDone).toHaveBeenCalledTimes(1);
    expect(cbs.onError).not.toHaveBeenCalled();
  });

  it('returns immediately via onDone when the external signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    const stream: PushStream = () => {
      invoked = true;
      return (async function* () {
        yield { type: 'done', finishReason: 'stop' };
      })();
    };

    const cbs = callbacks();
    await iterateChatStream(stream, { ...baseRequest, signal: controller.signal }, cbs, {
      telemetry: 'disabled',
    });

    expect(invoked).toBe(false);
    expect(cbs.onDone).toHaveBeenCalledTimes(1);
    expect(cbs.onError).not.toHaveBeenCalled();
  });
});

describe('iterateChatStream — timer machinery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the event timer when no events arrive within eventTimeoutMs', async () => {
    // Hand-rolled iterable: `next()` waits for the abort signal, then
    // rejects with AbortError. Avoids `async function*` + `throw` (no
    // yield → trips `require-yield`).
    const stream: PushStream = (req) => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<PushStreamEvent>> {
            while (!req.signal?.aborted) {
              await new Promise((r) => setTimeout(r, 5));
            }
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
          },
        };
      },
    });

    const cbs = callbacks();
    const promise = iterateChatStream(stream, baseRequest, cbs, {
      telemetry: 'disabled',
      timeouts: {
        eventTimeoutMs: 100,
        errorMessages: { event: (s) => `idle ${s}s` },
      },
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(cbs.onError).toHaveBeenCalledTimes(1);
    expect(cbs.onError.mock.calls[0]?.[0]?.message).toBe('idle 0s');
    expect(cbs.onDone).not.toHaveBeenCalled();
  });

  it('resets the event timer on every event so active streams survive', async () => {
    // 50ms gaps between events, 100ms eventTimeoutMs — never trips.
    const stream = makeGappedStream([
      { event: { type: 'text_delta', text: 'a' }, gapMs: 50 },
      { event: { type: 'text_delta', text: 'b' }, gapMs: 50 },
      { event: { type: 'done', finishReason: 'stop' }, gapMs: 50 },
    ]);

    const cbs = callbacks();
    const promise = iterateChatStream(stream, baseRequest, cbs, {
      telemetry: 'disabled',
      timeouts: { eventTimeoutMs: 100 },
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(cbs.onError).not.toHaveBeenCalled();
    expect(cbs.onDone).toHaveBeenCalledTimes(1);
  });

  it('fires the content timer when only structural events arrive', async () => {
    // reasoning_end is structural — it doesn't reset the content timer.
    // 80ms gap with a 100ms content timeout trips on the second wait.
    const stream = makeGappedStream([
      { event: { type: 'reasoning_end' }, gapMs: 50 },
      { event: { type: 'reasoning_end' }, gapMs: 80 },
    ]);

    const cbs = callbacks();
    const promise = iterateChatStream(stream, baseRequest, cbs, {
      telemetry: 'disabled',
      timeouts: {
        contentTimeoutMs: 100,
        errorMessages: { content: (s) => `stall ${s}s` },
      },
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(cbs.onError).toHaveBeenCalledTimes(1);
    expect(cbs.onError.mock.calls[0]?.[0]?.message).toBe('stall 0s');
  });

  it('resets the content timer on tool_call_delta (native tool-arg buffering)', async () => {
    const stream = makeGappedStream([
      { event: { type: 'tool_call_delta' }, gapMs: 60 },
      { event: { type: 'tool_call_delta' }, gapMs: 60 },
      { event: { type: 'text_delta', text: 'flushed' }, gapMs: 60 },
      { event: { type: 'done', finishReason: 'stop' }, gapMs: 0 },
    ]);

    const cbs = callbacks();
    const promise = iterateChatStream(stream, baseRequest, cbs, {
      telemetry: 'disabled',
      timeouts: { contentTimeoutMs: 100 },
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(cbs.onError).not.toHaveBeenCalled();
    expect(cbs.onToken).toHaveBeenCalledWith('flushed');
  });

  it('fires the total timer regardless of activity', async () => {
    const stream = makeGappedStream([
      { event: { type: 'text_delta', text: 'a' }, gapMs: 30 },
      { event: { type: 'text_delta', text: 'b' }, gapMs: 30 },
      { event: { type: 'text_delta', text: 'c' }, gapMs: 30 },
      { event: { type: 'text_delta', text: 'd' }, gapMs: 30 },
    ]);

    const cbs = callbacks();
    const promise = iterateChatStream(stream, baseRequest, cbs, {
      telemetry: 'disabled',
      timeouts: {
        eventTimeoutMs: 1000,
        totalTimeoutMs: 60,
        errorMessages: { total: (s) => `wallclock ${s}s` },
      },
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(cbs.onError).toHaveBeenCalledTimes(1);
    expect(cbs.onError.mock.calls[0]?.[0]?.message).toBe('wallclock 0s');
  });
});
