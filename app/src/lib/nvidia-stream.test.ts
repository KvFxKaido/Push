import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';

vi.mock('@/hooks/useNvidiaConfig', () => ({
  getNvidiaKey: () => 'test-key',
}));

vi.mock('./providers', () => ({
  PROVIDER_URLS: {
    nvidia: {
      chat: 'https://nv.example/api/nvidia/chat',
      models: 'https://nv.example/api/nvidia/models',
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
  return JSON.stringify({ choices: [{ delta: { reasoning_content: text } }] });
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
  provider: 'nvidia',
  model: 'meta/llama-3.1-70b-instruct',
  messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 } as unknown as ChatMessage],
};

describe('nvidiaStream', () => {
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
    const { nvidiaStream } = await import('./nvidia-stream');
    const events = collect(nvidiaStream(baseRequest));

    push(contentFrame('hello '));
    push(contentFrame('world'));
    finish();

    expect(await events).toEqual([
      { type: 'text_delta', text: 'hello ' },
      { type: 'text_delta', text: 'world' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('forwards reasoning_content (Nvidia-hosted DeepSeek-R1 shape) through the pump', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { nvidiaStream } = await import('./nvidia-stream');
    const events = collect(nvidiaStream(baseRequest));

    push(reasoningFrame('thinking...'));
    push(contentFrame('answer'));
    finish();

    expect(await events).toEqual([
      { type: 'reasoning_delta', text: 'thinking...' },
      { type: 'text_delta', text: 'answer' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('maps usage onto the done event', async () => {
    const { push } = installStreamFetch(fetchMock);
    const { nvidiaStream } = await import('./nvidia-stream');
    const events = collect(nvidiaStream(baseRequest));

    push(contentFrame('hi'));
    push(finishFrame('stop', { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }));

    const out = await events;
    expect(out[out.length - 1]).toEqual({
      type: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
    });
  });

  it('throws with an Nvidia NIM-prefixed error on non-200 response', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { nvidiaStream } = await import('./nvidia-stream');

    let caught: Error | null = null;
    try {
      await collect(nvidiaStream(baseRequest));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/Nvidia NIM/);
    expect(caught!.message).toMatch(/429/);
    expect(caught!.message).toMatch(/rate limited/);
  });

  it('hits PROVIDER_URLS.nvidia.chat with a Bearer token from getNvidiaKey', async () => {
    installStreamFetch(fetchMock);
    const { nvidiaStream } = await import('./nvidia-stream');
    const iter = nvidiaStream(baseRequest);
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://nv.example/api/nvidia/chat');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
  });

  it('forwards max_tokens / temperature / top_p into the request body', async () => {
    installStreamFetch(fetchMock);
    const { nvidiaStream } = await import('./nvidia-stream');
    const iter = nvidiaStream({
      ...baseRequest,
      maxTokens: 1024,
      temperature: 0.5,
      topP: 0.95,
    });
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe('meta/llama-3.1-70b-instruct');
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBe(0.95);
  });

  it('flushes native tool_calls through the pump using the injected predicate', async () => {
    const { push } = installStreamFetch(fetchMock);
    const { nvidiaStream } = await import('./nvidia-stream');
    const events = collect(nvidiaStream(baseRequest));

    push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: 'sandbox_read_file', arguments: '{"path":"a"}' } },
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
    expect(textEvents[0].text).toContain('sandbox_read_file');
  });

  it('does not send Zen / OpenRouter-only body fields', async () => {
    installStreamFetch(fetchMock);
    const { nvidiaStream } = await import('./nvidia-stream');
    const iter = nvidiaStream(baseRequest);
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('session_id');
    expect(body).not.toHaveProperty('trace');
  });

  it('omits Authorization entirely when the client key is empty', async () => {
    // standardAuth('NVIDIA_API_KEY') on the Worker reads any non-empty
    // client Authorization as "key supplied" and skips the keyMissingError
    // 401, so sending `Bearer ` would bypass the configured fallback and
    // forward an empty bearer to Nvidia. The stream therefore omits
    // Authorization when there's no client key.
    vi.doMock('@/hooks/useNvidiaConfig', () => ({
      getNvidiaKey: () => '',
    }));
    installStreamFetch(fetchMock);
    const { nvidiaStream } = await import('./nvidia-stream');
    const iter = nvidiaStream(baseRequest);
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
