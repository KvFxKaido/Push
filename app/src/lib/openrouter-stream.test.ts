import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';

// Module-level mocks so the stream's runtime dependencies don't hit real
// storage or network. Each test reimports the module to pick these up.

vi.mock('@/hooks/useOpenRouterConfig', () => ({
  getOpenRouterKey: () => 'test-key',
}));

vi.mock('./openrouter-session', () => ({
  getOpenRouterSessionId: () => null,
  buildOpenRouterTrace: () => ({ trace_name: 'test' }),
}));

vi.mock('./model-catalog', () => ({
  openRouterModelSupportsReasoning: () => false,
  getReasoningEffort: () => 'off',
}));

// toLLMMessages pulls in huge dependency graph — stub to a trivial passthrough.
vi.mock('./orchestrator', () => ({
  toLLMMessages: (messages: ChatMessage[]) =>
    messages.map((m) => ({ role: m.role, content: m.content })),
}));

// ---------------------------------------------------------------------------
// Test harness — fetch-mock + controllable ReadableStream
// ---------------------------------------------------------------------------

interface ControllableStream {
  response: Response;
  push(frame: string): void;
  pushRaw(raw: string): void;
  finish(): void;
  close(): void;
  abort(): void;
}

function makeControllableStream(status = 200): ControllableStream {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const response = new Response(stream, {
    status,
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

function installStreamFetch(fetchMock: ReturnType<typeof vi.fn>): ControllableStream {
  const stream = makeControllableStream();
  fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    init?.signal?.addEventListener('abort', () => stream.abort());
    return stream.response;
  });
  return stream;
}

function contentFrame(text: string): string {
  return JSON.stringify({ choices: [{ delta: { content: text } }] });
}

function reasoningFrame(
  text: string,
  field: 'reasoning' | 'reasoning_content' = 'reasoning',
): string {
  return JSON.stringify({ choices: [{ delta: { [field]: text } }] });
}

function finishFrame(
  reason: string,
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number },
): string {
  return JSON.stringify({
    choices: [{ finish_reason: reason, delta: {} }],
    ...(usage ? { usage } : {}),
  });
}

const baseRequest: PushStreamRequest<ChatMessage> = {
  provider: 'openrouter',
  model: 'moonshotai/kimi-k2.6',
  messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 } as unknown as ChatMessage],
};

// ---------------------------------------------------------------------------

describe('openrouterStream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let collect: (stream: AsyncIterable<PushStreamEvent>) => Promise<PushStreamEvent[]>;

  beforeEach(async () => {
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    collect = async (stream) => {
      const out: PushStreamEvent[] = [];
      for await (const e of stream) out.push(e);
      return out;
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses text_delta frames and closes on [DONE]', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { openrouterStream } = await import('./openrouter-stream');
    const events: Promise<PushStreamEvent[]> = collect(openrouterStream(baseRequest));

    push(contentFrame('hello '));
    push(contentFrame('world'));
    finish();

    const out = await events;
    expect(out).toEqual([
      { type: 'text_delta', text: 'hello ' },
      { type: 'text_delta', text: 'world' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('accepts delta.reasoning (Kimi K2.6 field name)', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { openrouterStream } = await import('./openrouter-stream');
    const events = collect(openrouterStream(baseRequest));

    push(reasoningFrame('thinking...', 'reasoning'));
    push(contentFrame('answer'));
    finish();

    const out = await events;
    expect(out).toEqual([
      { type: 'reasoning_delta', text: 'thinking...' },
      { type: 'text_delta', text: 'answer' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('accepts delta.reasoning_content (legacy DeepSeek-R1 / Kimi K2.5 name)', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { openrouterStream } = await import('./openrouter-stream');
    const events = collect(openrouterStream(baseRequest));

    push(reasoningFrame('thinking...', 'reasoning_content'));
    push(contentFrame('answer'));
    finish();

    const out = await events;
    expect(out).toEqual([
      { type: 'reasoning_delta', text: 'thinking...' },
      { type: 'text_delta', text: 'answer' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('maps finish_reason onto the done event', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { openrouterStream } = await import('./openrouter-stream');
    const events = collect(openrouterStream(baseRequest));

    push(contentFrame('partial...'));
    push(finishFrame('length'));
    // `[DONE]` after finish_reason — the stream closes on finish_reason first.
    finish();

    const out = await events;
    expect(out).toEqual([
      { type: 'text_delta', text: 'partial...' },
      { type: 'done', finishReason: 'length', usage: undefined },
    ]);
  });

  it('maps usage onto the done event', async () => {
    const { push } = installStreamFetch(fetchMock);
    const { openrouterStream } = await import('./openrouter-stream');
    const events = collect(openrouterStream(baseRequest));

    push(contentFrame('hi'));
    push(finishFrame('stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }));

    const out = await events;
    expect(out[out.length - 1]).toEqual({
      type: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });

  it('picks up usage from an intermediate frame before finish_reason', async () => {
    const { push } = installStreamFetch(fetchMock);
    const { openrouterStream } = await import('./openrouter-stream');
    const events = collect(openrouterStream(baseRequest));

    // Some providers emit usage on a separate frame before the final one.
    push(
      JSON.stringify({
        choices: [{ delta: { content: 'ok' } }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      }),
    );
    push(finishFrame('stop'));

    const out = await events;
    expect(out[out.length - 1]).toEqual({
      type: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
    });
  });

  it('strips chat-template control tokens from delta.content', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { openrouterStream } = await import('./openrouter-stream');
    const events = collect(openrouterStream(baseRequest));

    push(contentFrame('<|start|>hello<|im_end|>'));
    finish();

    const out = await events;
    // Only the stripped token remains as a text_delta.
    expect(out[0]).toEqual({ type: 'text_delta', text: 'hello' });
  });

  it('throws with a useful error on non-200 response', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { openrouterStream } = await import('./openrouter-stream');

    let caught: Error | null = null;
    try {
      await collect(openrouterStream(baseRequest));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/429/);
    expect(caught!.message).toMatch(/rate limited/);
  });

  it('propagates abort to the upstream reader', async () => {
    const { push } = installStreamFetch(fetchMock);
    const controller = new AbortController();
    const { openrouterStream } = await import('./openrouter-stream');

    // Abort raises AbortError from the underlying reader — that's
    // by design. The adapter layer catches and routes to onDone; when
    // callers iterate the PushStream directly they handle it here.
    const out: PushStreamEvent[] = [];
    const task = (async () => {
      try {
        for await (const e of openrouterStream({ ...baseRequest, signal: controller.signal })) {
          out.push(e);
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') throw err;
      }
    })();

    push(contentFrame('hi'));
    // Let the reader microtask pick up the chunk before aborting — without
    // this tick, abort can race ahead of delivery and the event is lost.
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await task;

    expect(out).toEqual([{ type: 'text_delta', text: 'hi' }]);
  });

  it('forwards max_tokens / temperature / top_p into the request body', async () => {
    installStreamFetch(fetchMock);
    const { openrouterStream } = await import('./openrouter-stream');
    const iter = openrouterStream({
      ...baseRequest,
      maxTokens: 1234,
      temperature: 0.7,
      topP: 0.9,
    });
    // Pull one to trigger the fetch, then stop iterating.
    const it = iter[Symbol.asyncIterator]();
    // Fire off the promise but don't await — we just need fetch to be called.
    it.next().catch(() => {});
    // Yield so the fetch mock runs.
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(1234);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
  });

  it('closes cleanly when the stream ends without a [DONE] or finish_reason', async () => {
    const { push, close } = installStreamFetch(fetchMock);
    const { openrouterStream } = await import('./openrouter-stream');
    const events = collect(openrouterStream(baseRequest));

    push(contentFrame('partial'));
    close();

    const out = await events;
    expect(out).toEqual([
      { type: 'text_delta', text: 'partial' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });
});
