import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';

// Module-level mocks so the stream's runtime dependencies don't hit real
// storage or network. Each test reimports the module to pick these up.

vi.mock('@/hooks/useKilocodeConfig', () => ({
  getKilocodeKey: () => 'test-key',
}));

vi.mock('./providers', () => ({
  PROVIDER_URLS: {
    kilocode: {
      chat: 'https://kilo.example/api/kilocode/chat',
      models: 'https://kilo.example/api/kilocode/models',
    },
  },
}));

// toLLMMessages pulls in huge dependency graph — stub to a trivial passthrough.
vi.mock('./orchestrator', () => ({
  toLLMMessages: (messages: ChatMessage[]) =>
    messages.map((m) => ({ role: m.role, content: m.content })),
}));

// Narrow KNOWN_TOOL_NAMES so tests can assert on known-vs-unknown dispatch
// without depending on the real registry.
vi.mock('./tool-dispatch', () => ({
  KNOWN_TOOL_NAMES: new Set(['sandbox_write_file', 'sandbox_read_file']),
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
  provider: 'kilocode',
  model: 'kilo-default',
  messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 } as unknown as ChatMessage],
};

// ---------------------------------------------------------------------------

describe('kilocodeStream', () => {
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
    const { kilocodeStream } = await import('./kilocode-stream');
    const events: Promise<PushStreamEvent[]> = collect(kilocodeStream(baseRequest));

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

  it('accepts delta.reasoning (modern field name)', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { kilocodeStream } = await import('./kilocode-stream');
    const events = collect(kilocodeStream(baseRequest));

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

  it('accepts delta.reasoning_content (legacy field name)', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { kilocodeStream } = await import('./kilocode-stream');
    const events = collect(kilocodeStream(baseRequest));

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
    const { kilocodeStream } = await import('./kilocode-stream');
    const events = collect(kilocodeStream(baseRequest));

    push(contentFrame('partial...'));
    push(finishFrame('length'));
    finish();

    const out = await events;
    expect(out).toEqual([
      { type: 'text_delta', text: 'partial...' },
      { type: 'done', finishReason: 'length', usage: undefined },
    ]);
  });

  it('maps usage onto the done event', async () => {
    const { push } = installStreamFetch(fetchMock);
    const { kilocodeStream } = await import('./kilocode-stream');
    const events = collect(kilocodeStream(baseRequest));

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
    const { kilocodeStream } = await import('./kilocode-stream');
    const events = collect(kilocodeStream(baseRequest));

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
    const { kilocodeStream } = await import('./kilocode-stream');
    const events = collect(kilocodeStream(baseRequest));

    push(contentFrame('<|start|>hello<|im_end|>'));
    finish();

    const out = await events;
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
    const { kilocodeStream } = await import('./kilocode-stream');

    let caught: Error | null = null;
    try {
      await collect(kilocodeStream(baseRequest));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/Kilo Code/);
    expect(caught!.message).toMatch(/429/);
    expect(caught!.message).toMatch(/rate limited/);
  });

  it('propagates abort to the upstream reader', async () => {
    const { push } = installStreamFetch(fetchMock);
    const controller = new AbortController();
    const { kilocodeStream } = await import('./kilocode-stream');

    const out: PushStreamEvent[] = [];
    const task = (async () => {
      try {
        for await (const e of kilocodeStream({ ...baseRequest, signal: controller.signal })) {
          out.push(e);
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') throw err;
      }
    })();

    push(contentFrame('hi'));
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await task;

    expect(out).toEqual([{ type: 'text_delta', text: 'hi' }]);
  });

  it('forwards max_tokens / temperature / top_p into the request body', async () => {
    installStreamFetch(fetchMock);
    const { kilocodeStream } = await import('./kilocode-stream');
    const iter = kilocodeStream({
      ...baseRequest,
      maxTokens: 1234,
      temperature: 0.7,
      topP: 0.9,
    });
    const it = iter[Symbol.asyncIterator]();
    it.next().catch(() => {});
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
    const { kilocodeStream } = await import('./kilocode-stream');
    const events = collect(kilocodeStream(baseRequest));

    push(contentFrame('partial'));
    close();

    const out = await events;
    expect(out).toEqual([
      { type: 'text_delta', text: 'partial' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('hits PROVIDER_URLS.kilocode.chat', async () => {
    installStreamFetch(fetchMock);
    const { kilocodeStream } = await import('./kilocode-stream');
    const iter = kilocodeStream(baseRequest);
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalled();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://kilo.example/api/kilocode/chat');
  });

  // -------------------------------------------------------------------------
  // Native tool_call bridge — mirrors the OpenRouter / Zen coverage.
  // -------------------------------------------------------------------------

  it('accumulates native tool_call fragments and flushes them as fenced JSON on finish', async () => {
    const { push } = installStreamFetch(fetchMock);
    const { kilocodeStream } = await import('./kilocode-stream');
    const events = collect(kilocodeStream(baseRequest));

    push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: 'sandbox_write_file' } }],
            },
          },
        ],
      }),
    );
    push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"path":"foo.ts"' } }],
            },
          },
        ],
      }),
    );
    push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: ',"content":"x"}' } }],
            },
          },
        ],
      }),
    );
    push(
      JSON.stringify({
        choices: [{ finish_reason: 'tool_calls', delta: {} }],
      }),
    );

    const out = await events;
    const textEvents = out.filter(
      (e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta',
    );
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].text).toContain('sandbox_write_file');
    expect(textEvents[0].text).toContain('"path":"foo.ts"');
    expect(textEvents[0].text).toContain('"content":"x"');
    expect(textEvents[0].text).toMatch(/```json/);
    expect(out[out.length - 1]).toEqual({
      type: 'done',
      finishReason: 'tool_calls',
      usage: undefined,
    });
  });

  it('yields a tool_call_delta per fragment so the adapter sees progress while buffering', async () => {
    const { push } = installStreamFetch(fetchMock);
    const { kilocodeStream } = await import('./kilocode-stream');
    const events = collect(kilocodeStream(baseRequest));

    push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: 'sandbox_write_file' } }],
            },
          },
        ],
      }),
    );
    push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"path":"foo.ts"' } }],
            },
          },
        ],
      }),
    );
    push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: ',"content":"x"}' } }],
            },
          },
        ],
      }),
    );
    push(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }] }));

    const out = await events;
    expect(out.filter((e) => e.type === 'tool_call_delta')).toHaveLength(3);
    expect(out.map((e) => e.type)).toEqual([
      'tool_call_delta',
      'tool_call_delta',
      'tool_call_delta',
      'text_delta',
      'done',
    ]);
  });

  it('drops native tool_calls whose name is not in KNOWN_TOOL_NAMES', async () => {
    const { push } = installStreamFetch(fetchMock);
    const { kilocodeStream } = await import('./kilocode-stream');
    const events = collect(kilocodeStream(baseRequest));

    push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: 'node_source', arguments: '{"x":1}' } }],
            },
          },
        ],
      }),
    );
    push(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }] }));

    const out = await events;
    const textEvents = out.filter((e) => e.type === 'text_delta');
    expect(textEvents).toHaveLength(0);
    expect(out[out.length - 1]).toEqual({
      type: 'done',
      finishReason: 'tool_calls',
      usage: undefined,
    });
  });

  it('flushes pending native tool_calls on [DONE] even without finish_reason', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { kilocodeStream } = await import('./kilocode-stream');
    const events = collect(kilocodeStream(baseRequest));

    push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { name: 'sandbox_read_file', arguments: '{"path":"a"}' },
                },
              ],
            },
          },
        ],
      }),
    );
    finish();

    const out = await events;
    const textEvents = out.filter(
      (e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta',
    );
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].text).toContain('sandbox_read_file');
  });

  it('emits a fenced shell with empty args when tool_call arguments are malformed JSON', async () => {
    const { push } = installStreamFetch(fetchMock);
    const { kilocodeStream } = await import('./kilocode-stream');
    const events = collect(kilocodeStream(baseRequest));

    push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { name: 'sandbox_write_file', arguments: '{broken json' },
                },
              ],
            },
          },
        ],
      }),
    );
    push(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }] }));

    const out = await events;
    const textEvents = out.filter(
      (e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta',
    );
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].text).toContain('sandbox_write_file');
    expect(textEvents[0].text).toMatch(/"args":\s*\{\s*\}/);
  });

  // -------------------------------------------------------------------------
  // Think-tag routing — mirrors the OpenRouter / Zen composition test.
  // -------------------------------------------------------------------------

  it('composes with normalizeReasoning to split inline <think> tags out of content', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { kilocodeStream } = await import('./kilocode-stream');
    const { normalizeReasoning } = await import('@push/lib/reasoning-tokens');

    const composed = normalizeReasoning(kilocodeStream(baseRequest));
    const events = collect(composed);

    push(contentFrame('<think>pondering</think>answer'));
    finish();

    const out = await events;
    const textEvents = out.filter(
      (e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta',
    );
    const reasoningEvents = out.filter(
      (e): e is { type: 'reasoning_delta'; text: string } => e.type === 'reasoning_delta',
    );
    expect(reasoningEvents.map((e) => e.text).join('')).toBe('pondering');
    expect(textEvents.map((e) => e.text).join('')).toBe('answer');
  });
});
