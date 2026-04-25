import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';

// Module-level mocks isolate the stream's runtime dependencies from
// real network and storage. The shared SSE parser already has full
// coverage in `lib/openai-sse-pump.test.ts`; tests here focus on the
// wrapper-specific surface (URL, auth, error prefix, body shape, that
// pump events flow through unchanged).

vi.mock('@/hooks/useOpenAdapterConfig', () => ({
  getOpenAdapterKey: () => 'test-key',
}));

vi.mock('./providers', () => ({
  PROVIDER_URLS: {
    openadapter: {
      chat: 'https://oa.example/api/openadapter/chat',
      models: 'https://oa.example/api/openadapter/models',
    },
  },
}));

vi.mock('./orchestrator', () => ({
  toLLMMessages: (messages: ChatMessage[]) =>
    messages.map((m) => ({ role: m.role, content: m.content })),
}));

vi.mock('./tool-dispatch', () => ({
  KNOWN_TOOL_NAMES: new Set(['sandbox_write_file', 'sandbox_read_file']),
}));

interface ControllableStream {
  response: Response;
  push(frame: string): void;
  finish(): void;
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
    finish() {
      if (closed) return;
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
      closed = true;
    },
  };
}

function installStreamFetch(fetchMock: ReturnType<typeof vi.fn>): ControllableStream {
  const stream = makeControllableStream();
  fetchMock.mockImplementation(async () => stream.response);
  return stream;
}

function contentFrame(text: string): string {
  return JSON.stringify({ choices: [{ delta: { content: text } }] });
}

function reasoningFrame(text: string): string {
  return JSON.stringify({ choices: [{ delta: { reasoning: text } }] });
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
  provider: 'openadapter',
  model: 'oa-default',
  messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 } as unknown as ChatMessage],
};

describe('openadapterStream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let collect: (stream: AsyncIterable<PushStreamEvent>) => Promise<PushStreamEvent[]>;

  beforeEach(() => {
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

  it('parses text_delta frames through the shared pump and closes on [DONE]', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { openadapterStream } = await import('./openadapter-stream');
    const events = collect(openadapterStream(baseRequest));

    push(contentFrame('hello '));
    push(contentFrame('world'));
    finish();

    expect(await events).toEqual([
      { type: 'text_delta', text: 'hello ' },
      { type: 'text_delta', text: 'world' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('forwards reasoning, finish_reason, and usage through the pump', async () => {
    const { push } = installStreamFetch(fetchMock);
    const { openadapterStream } = await import('./openadapter-stream');
    const events = collect(openadapterStream(baseRequest));

    push(reasoningFrame('thinking...'));
    push(contentFrame('answer'));
    push(finishFrame('length', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }));

    expect(await events).toEqual([
      { type: 'reasoning_delta', text: 'thinking...' },
      { type: 'text_delta', text: 'answer' },
      {
        type: 'done',
        finishReason: 'length',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    ]);
  });

  it('throws with an OpenAdapter-prefixed error on non-200 response', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { openadapterStream } = await import('./openadapter-stream');

    let caught: Error | null = null;
    try {
      await collect(openadapterStream(baseRequest));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/OpenAdapter/);
    expect(caught!.message).toMatch(/429/);
    expect(caught!.message).toMatch(/rate limited/);
  });

  it('hits PROVIDER_URLS.openadapter.chat with a Bearer token from getOpenAdapterKey', async () => {
    installStreamFetch(fetchMock);
    const { openadapterStream } = await import('./openadapter-stream');
    const iter = openadapterStream(baseRequest);
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oa.example/api/openadapter/chat');
    const auth = (init as RequestInit).headers as Record<string, string>;
    expect(auth.Authorization).toBe('Bearer test-key');
  });

  it('forwards max_tokens / temperature / top_p into the request body', async () => {
    installStreamFetch(fetchMock);
    const { openadapterStream } = await import('./openadapter-stream');
    const iter = openadapterStream({
      ...baseRequest,
      maxTokens: 1234,
      temperature: 0.7,
      topP: 0.9,
    });
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('oa-default');
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(1234);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
  });

  it('does not send Zen / OpenRouter-only body fields', async () => {
    installStreamFetch(fetchMock);
    const { openadapterStream } = await import('./openadapter-stream');
    const iter = openadapterStream(baseRequest);
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('session_id');
    expect(body).not.toHaveProperty('trace');
  });

  it('flushes native tool_calls through the pump using the injected predicate', async () => {
    const { push } = installStreamFetch(fetchMock);
    const { openadapterStream } = await import('./openadapter-stream');
    const events = collect(openadapterStream(baseRequest));

    push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: 'sandbox_write_file', arguments: '{"path":"a"}' } },
              ],
            },
          },
        ],
      }),
    );
    push(finishFrame('tool_calls'));

    const out = await events;
    const textEvents = out.filter(
      (e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta',
    );
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].text).toContain('sandbox_write_file');
    expect(out[out.length - 1].type).toBe('done');
  });

  it('drops native tool_calls whose name is unknown to the predicate', async () => {
    const { push } = installStreamFetch(fetchMock);
    const { openadapterStream } = await import('./openadapter-stream');
    const events = collect(openadapterStream(baseRequest));

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
    push(finishFrame('tool_calls'));

    const out = await events;
    expect(out.filter((e) => e.type === 'text_delta')).toHaveLength(0);
  });

  it('omits Authorization entirely when the client key is empty', async () => {
    // standardAuth('OPENADAPTER_API_KEY') on the Worker reads any non-empty
    // client Authorization as "key supplied" and skips the keyMissingError
    // 401, so sending `Bearer ` would bypass the configured fallback and
    // forward an empty bearer to OpenAdapter. The stream therefore omits
    // Authorization when there's no client key.
    vi.doMock('@/hooks/useOpenAdapterConfig', () => ({
      getOpenAdapterKey: () => '',
    }));
    installStreamFetch(fetchMock);
    const { openadapterStream } = await import('./openadapter-stream');
    const iter = openadapterStream(baseRequest);
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});
