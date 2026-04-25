import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';

vi.mock('@/hooks/useExperimentalProviderConfig', () => ({
  getAzureBaseUrl: () => 'https://my-resource.openai.azure.com/openai/v1',
  getAzureKey: () => 'test-key',
}));

vi.mock('./providers', () => ({
  PROVIDER_URLS: {
    azure: {
      chat: 'https://app.example/api/azure/chat',
      models: 'https://app.example/api/azure/models',
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

function finishFrame(reason: string): string {
  return JSON.stringify({ choices: [{ finish_reason: reason, delta: {} }] });
}

const baseRequest: PushStreamRequest<ChatMessage> = {
  provider: 'azure',
  model: 'gpt-4o',
  messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 } as unknown as ChatMessage],
};

// `vi.resetModules()` in beforeEach reloads the test module so module-level
// mocks re-apply, but vi.doMock state from previous tests persists. Tests
// that override mocks via `vi.doMock` therefore live at the end of the suite
// so they don't bleed into the default-fixture tests below.

describe('azureStream', () => {
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
    const { azureStream } = await import('./azure-stream');
    const events = collect(azureStream(baseRequest));

    push(contentFrame('hello'));
    finish();

    const out = await events;
    expect(out).toEqual([
      { type: 'text_delta', text: 'hello' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('hits PROVIDER_URLS.azure.chat', async () => {
    installStreamFetch(fetchMock);
    const { azureStream } = await import('./azure-stream');
    const iter = azureStream(baseRequest);
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://app.example/api/azure/chat');
  });

  it('sends X-Push-Upstream-Base + Bearer token from configured key', async () => {
    installStreamFetch(fetchMock);
    const { azureStream } = await import('./azure-stream');
    const iter = azureStream(baseRequest);
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Push-Upstream-Base']).toBe('https://my-resource.openai.azure.com/openai/v1');
    expect(headers.Authorization).toBe('Bearer test-key');
  });

  it('throws with a useful error on non-200 response', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { azureStream } = await import('./azure-stream');

    let caught: Error | null = null;
    try {
      await collect(azureStream(baseRequest));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/Azure OpenAI/);
    expect(caught!.message).toMatch(/429/);
    expect(caught!.message).toMatch(/rate limited/);
  });

  it('propagates abort to the upstream reader', async () => {
    const { push } = installStreamFetch(fetchMock);
    const controller = new AbortController();
    const { azureStream } = await import('./azure-stream');

    const out: PushStreamEvent[] = [];
    const task = (async () => {
      try {
        for await (const e of azureStream({ ...baseRequest, signal: controller.signal })) {
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
    const { azureStream } = await import('./azure-stream');
    const iter = azureStream({ ...baseRequest, maxTokens: 4096, temperature: 0.5, topP: 0.95 });
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(4096);
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBe(0.95);
  });

  it('maps finish_reason onto the done event', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { azureStream } = await import('./azure-stream');
    const events = collect(azureStream(baseRequest));

    push(contentFrame('partial'));
    push(finishFrame('length'));
    finish();

    const out = await events;
    expect(out).toEqual([
      { type: 'text_delta', text: 'partial' },
      { type: 'done', finishReason: 'length', usage: undefined },
    ]);
  });

  it('drops native tool_calls whose name is not in KNOWN_TOOL_NAMES', async () => {
    const { push } = installStreamFetch(fetchMock);
    const { azureStream } = await import('./azure-stream');
    const events = collect(azureStream(baseRequest));

    push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: 'node_source', arguments: '{}' } }],
            },
          },
        ],
      }),
    );
    push(finishFrame('tool_calls'));

    const out = await events;
    expect(out.filter((e) => e.type === 'text_delta')).toHaveLength(0);
  });

  it('composes with normalizeReasoning to split inline <think> tags out of content', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { azureStream } = await import('./azure-stream');
    const { normalizeReasoning } = await import('@push/lib/reasoning-tokens');

    const composed = normalizeReasoning(azureStream(baseRequest));
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

  // ---- vi.doMock-altering tests below; placed at the end so their mock
  //      state doesn't bleed into the default-fixture tests above. ----

  it('omits Authorization when the client key is empty', async () => {
    vi.doMock('@/hooks/useExperimentalProviderConfig', () => ({
      getAzureBaseUrl: () => 'https://my-resource.openai.azure.com/openai/v1',
      getAzureKey: () => '',
    }));
    installStreamFetch(fetchMock);
    const { azureStream } = await import('./azure-stream');
    const iter = azureStream(baseRequest);
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-Push-Upstream-Base']).toBe('https://my-resource.openai.azure.com/openai/v1');
  });

  it('throws when the configured base URL is missing or invalid', async () => {
    vi.doMock('@/hooks/useExperimentalProviderConfig', () => ({
      getAzureBaseUrl: () => '',
      getAzureKey: () => 'test-key',
    }));
    const { azureStream } = await import('./azure-stream');

    let caught: Error | null = null;
    try {
      await azureStream(baseRequest)[Symbol.asyncIterator]().next();
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/base URL/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
