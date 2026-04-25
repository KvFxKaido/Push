import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types';
import type { StreamProviderConfig } from './orchestrator-streaming';
import { hasFinishReason, parseProviderError } from './orchestrator-streaming';
import { streamSSEChatOnce } from './orchestrator';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface ControllableStream {
  response: Response;
  /** Enqueue an SSE frame (`data: {...}\n\n`). */
  push(frame: string): void;
  /** Push a raw SSE data line (caller supplies framing). */
  pushRaw(raw: string): void;
  /** Emit `data: [DONE]\n\n` and close the stream. */
  finish(): void;
  /** Close the stream without a trailing [DONE]. */
  close(): void;
  /** Error the stream (simulates a real fetch abort tearing down the body). */
  abort(): void;
}

function makeControllableStream(): ControllableStream {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  return {
    response,
    push(frame) {
      if (closed) return;
      controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
    },
    pushRaw(raw) {
      if (closed) return;
      controller.enqueue(encoder.encode(raw));
    },
    finish() {
      if (closed) return;
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
      closed = true;
    },
    close() {
      if (closed) return;
      controller.close();
      closed = true;
    },
    abort() {
      if (closed) return;
      controller.error(new DOMException('aborted', 'AbortError'));
      closed = true;
    },
  };
}

/**
 * Install a fetch mock that returns a controllable stream and ties `fetch`'s
 * AbortSignal to the stream — aborting the signal errors the stream with an
 * AbortError, matching how a real fetch tears down the body on cancellation.
 * Without this, a timer-fired controller.abort() would leave `reader.read()`
 * hanging forever under fake timers.
 */
function installStreamFetch(fetchMock: ReturnType<typeof vi.fn>): ControllableStream {
  const stream = makeControllableStream();
  fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    init?.signal?.addEventListener('abort', () => stream.abort());
    return stream.response;
  });
  return stream;
}

/** Yield to pending microtasks so awaited reader.read() + JSON.parse can settle. */
async function flushMicrotasks(): Promise<void> {
  // `advanceTimersByTimeAsync(0)` flushes the microtask queue between timer ticks.
  await vi.advanceTimersByTimeAsync(0);
}

function testConfig(overrides: Partial<StreamProviderConfig> = {}): StreamProviderConfig {
  return {
    name: 'TestProvider',
    apiUrl: 'https://test.invalid/chat',
    apiKey: 'test-key',
    model: 'test-model',
    connectTimeoutMs: 10_000,
    idleTimeoutMs: 20_000,
    progressTimeoutMs: 15_000,
    stallTimeoutMs: 25_000,
    totalTimeoutMs: 120_000,
    errorMessages: {
      connect: (s) => `connect ${s}s`,
      idle: (s) => `idle ${s}s`,
      progress: (s) => `progress ${s}s`,
      stall: (s) => `stall ${s}s`,
      total: (s) => `total ${s}s`,
      network: 'network',
    },
    parseError: (p, f) => parseProviderError(p, f),
    checkFinishReason: (c) => hasFinishReason(c, ['stop', 'length', 'tool_calls']),
    ...overrides,
  };
}

function contentFrame(text: string): string {
  return JSON.stringify({ choices: [{ delta: { content: text } }] });
}

function toolCallFrame(name: string, args: string, index = 0): string {
  return JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index, function: { name, arguments: args } }] } }],
  });
}

function emptyDeltaFrame(): string {
  return JSON.stringify({ choices: [{ delta: {} }] });
}

// ---------------------------------------------------------------------------

describe('streamSSEChatOnce timer machinery', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fires the progress timeout when frames stop after the first parse', async () => {
    const { push } = installStreamFetch(fetchMock);

    const onError = vi.fn();
    const onDone = vi.fn();
    const messages: ChatMessage[] = [];
    const done = streamSSEChatOnce(testConfig(), messages, () => {}, onDone, onError);

    await flushMicrotasks();
    // One parseable frame — arms the progress timer.
    push(contentFrame('hello'));
    await flushMicrotasks();

    // Walk the clock past progressTimeoutMs without another frame.
    await vi.advanceTimersByTimeAsync(16_000);
    await done;

    expect(onDone).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('progress 15s');
  });

  it('falls through to idle when the response yields no body bytes (fix #5)', async () => {
    // Body stream stays open but never emits a chunk. The pre-regression bug
    // was that progressTimer, armed right after fetch returned, could race
    // idleTimer and surface "data is arriving" when no data had arrived.
    // After the fix, progressTimer is only armed on the first parseable frame
    // so idleTimer wins here unambiguously.
    installStreamFetch(fetchMock);

    const onError = vi.fn();
    const done = streamSSEChatOnce(
      testConfig(),
      [],
      () => {},
      () => {},
      onError,
    );

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(21_000);
    await done;

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('idle 20s');
  });

  it('keeps resetting the progress timer while parseable frames keep arriving', async () => {
    const { push, finish } = installStreamFetch(fetchMock);

    const onDone = vi.fn();
    const onError = vi.fn();
    const done = streamSSEChatOnce(testConfig(), [], () => {}, onDone, onError);

    await flushMicrotasks();

    // Three frames, each well within progressTimeoutMs (15s). Total
    // elapsed would be 30s — far past the window if the timer didn't reset.
    for (let i = 0; i < 3; i++) {
      push(contentFrame(`chunk-${i}`));
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    finish();
    await flushMicrotasks();
    await done;

    expect(onError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('resets the stall timer on native tool_call deltas (locks in fix #1)', async () => {
    // Tool-call argument streams are user-visible progress in a different
    // channel than delta.content. Before the fix, a pure-tool-calls stream
    // would hit stallTimeoutMs mid-generation. Here we stream tool-call
    // fragments 10s apart under a 25s stall window; without the reset, the
    // second 10s gap would land past the stall boundary relative to the
    // first tool-call frame.
    const { push, finish } = installStreamFetch(fetchMock);

    const onError = vi.fn();
    const onDone = vi.fn();
    const done = streamSSEChatOnce(testConfig(), [], () => {}, onDone, onError);

    await flushMicrotasks();

    // First tool-call frame — arms progress AND resets stall.
    push(toolCallFrame('sandbox_write_file', '{"path":"'));
    await flushMicrotasks();
    // Eat 10s of budget.
    await vi.advanceTimersByTimeAsync(10_000);
    // Second tool-call frame — must reset stall OR we'd trip at 25s.
    push(toolCallFrame('sandbox_write_file', 'foo.ts"'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10_000);
    // Third — still within reset window relative to previous frame.
    push(toolCallFrame('sandbox_write_file', ',"content":"x"}'));
    await flushMicrotasks();
    // Close with a stop finish_reason so the loop exits cleanly.
    push(JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] }));
    await flushMicrotasks();
    finish();
    await flushMicrotasks();
    await done;

    expect(onError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('fires the stall timeout when frames carry no content/reasoning/tool_calls', async () => {
    // Empty-delta frames (no content, no reasoning, no tool_calls) keep
    // progress alive (they parse) but don't reset stall. Stall should win
    // at stallTimeoutMs regardless of progress arming.
    const { push } = installStreamFetch(fetchMock);

    const onError = vi.fn();
    const done = streamSSEChatOnce(
      testConfig(),
      [],
      () => {},
      () => {},
      onError,
    );

    await flushMicrotasks();

    // Push empty-delta frames every 5s — parses successfully (resets progress)
    // but doesn't reset stall.
    for (let i = 0; i < 6; i++) {
      push(emptyDeltaFrame());
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await done;

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('stall 25s');
  });
});
