import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';

vi.mock('@/hooks/useAnthropicConfig', () => ({
  getAnthropicKey: () => 'test-key',
}));

vi.mock('./providers', () => ({
  PROVIDER_URLS: {
    anthropic: {
      chat: 'https://app.example/api/anthropic/chat',
      models: 'https://app.example/api/anthropic/models',
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

let webSearchMode: 'auto' | 'off' | 'duckduckgo' | 'google-grounding' = 'auto';
vi.mock('./web-search-mode', () => ({
  getWebSearchMode: () => webSearchMode,
  isNativeWebSearchEnabled: (provider: string, _modelId?: string, mode?: string) => {
    const m = mode ?? webSearchMode;
    if (m === 'off') return false;
    if (m === 'auto')
      return provider === 'google' || provider === 'anthropic' || provider === 'vertex';
    if (m === 'google-grounding') return provider === 'google';
    return false;
  },
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

const baseRequest: PushStreamRequest<ChatMessage> = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 } as unknown as ChatMessage],
};

describe('anthropicStream', () => {
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

  it('parses content frames returned through the Worker bridge and closes on [DONE]', async () => {
    // The Worker translates Anthropic SSE → OpenAI SSE shape via the bridge, so
    // from the client's perspective the response stream is OpenAI-shaped.
    const { push, finish } = installStreamFetch(fetchMock);
    const { anthropicStream } = await import('./anthropic-stream');
    const events = collect(anthropicStream(baseRequest));

    push(contentFrame('hello'));
    finish();

    const out = await events;
    expect(out).toEqual([
      { type: 'text_delta', text: 'hello' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('hits PROVIDER_URLS.anthropic.chat', async () => {
    installStreamFetch(fetchMock);
    const { anthropicStream } = await import('./anthropic-stream');
    const iter = anthropicStream(baseRequest);
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://app.example/api/anthropic/chat');
  });

  it('sends Bearer token from the client-side key (Worker overrides server-side)', async () => {
    installStreamFetch(fetchMock);
    const { anthropicStream } = await import('./anthropic-stream');
    const iter = anthropicStream(baseRequest);
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    // Client sends Bearer for dev/unconfigured-Worker paths. The Worker's
    // buildAnthropicAuth strips the prefix server-side before forwarding as
    // x-api-key to api.anthropic.com — that flip lives in the Worker tests.
    expect(headers.Authorization).toBe('Bearer test-key');
  });

  it('omits Authorization when the client key is empty', async () => {
    vi.doMock('@/hooks/useAnthropicConfig', () => ({
      getAnthropicKey: () => '',
    }));
    installStreamFetch(fetchMock);
    const { anthropicStream } = await import('./anthropic-stream');
    const iter = anthropicStream(baseRequest);
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('throws with a useful error on non-200 response', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { anthropicStream } = await import('./anthropic-stream');

    let caught: Error | null = null;
    try {
      await collect(anthropicStream(baseRequest));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/Anthropic/);
    expect(caught!.message).toMatch(/401/);
    expect(caught!.message).toMatch(/invalid x-api-key/);
  });

  it('forwards max_tokens / temperature / top_p into the request body', async () => {
    installStreamFetch(fetchMock);
    const { anthropicStream } = await import('./anthropic-stream');
    const iter = anthropicStream({ ...baseRequest, maxTokens: 4096, temperature: 0.5, topP: 0.95 });
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

  it('defaults anthropic_web_search on in auto mode', async () => {
    installStreamFetch(fetchMock);
    const { anthropicStream } = await import('./anthropic-stream');
    const iter = anthropicStream(baseRequest);
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.anthropic_web_search).toBe(true);
  });

  it('omits anthropic_web_search when web search is off', async () => {
    installStreamFetch(fetchMock);
    webSearchMode = 'off';
    try {
      const { anthropicStream } = await import('./anthropic-stream');
      const iter = anthropicStream(baseRequest);
      void iter[Symbol.asyncIterator]()
        .next()
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 0));

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.anthropic_web_search).toBeUndefined();
    } finally {
      webSearchMode = 'auto';
    }
  });

  it('replays a paused turn by appending captured assistant blocks to the next request', async () => {
    // pause_turn fires when Anthropic's server-side sampling loop runs out
    // of iterations mid-turn (web_search_20250305 in particular). The
    // adapter must issue a follow-up request with the captured assistant
    // content[] so Anthropic can resume; from the round loop's perspective
    // it should look like one continuous stream — pause_turn never surfaces.
    const responses: Array<ControllableStream> = [];
    const responsesQueue = [() => makeControllableStream(), () => makeControllableStream()];
    fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const factory = responsesQueue.shift() ?? (() => makeControllableStream());
      const s = factory();
      responses.push(s);
      init?.signal?.addEventListener('abort', () => s.abort());
      return s.response;
    });
    const { anthropicStream } = await import('./anthropic-stream');
    const events = collect(anthropicStream(baseRequest));

    // Wait for first request to fire, then push partial text + pause_turn.
    await new Promise((r) => setTimeout(r, 0));
    const first = responses[0];
    first.push(JSON.stringify({ choices: [{ delta: { content: 'Searching' } }] }));
    first.push(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'pause_turn',
            delta: {
              assistant_content_blocks: [
                { type: 'text', text: 'Searching' },
                { type: 'server_tool_use', id: 'su_01', name: 'web_search', input: {} },
              ],
            },
          },
        ],
      }),
    );
    first.finish();

    // Adapter should issue a second request — wait for it, then deliver the
    // terminal stream.
    await new Promise((r) => setTimeout(r, 5));
    const second = responses[1];
    expect(second).toBeDefined();
    second.push(JSON.stringify({ choices: [{ delta: { content: ' done.' } }] }));
    second.push(JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] }));
    second.finish();

    const out = await events;
    // pause_turn was an internal continuation signal — it should never
    // surface to the consumer.
    expect(out.some((e) => e.type === 'pause_turn')).toBe(false);
    expect(out.some((e) => e.type === 'done')).toBe(true);
    const textDeltas = out.filter(
      (e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta',
    );
    expect(textDeltas.map((e) => e.text).join('')).toBe('Searching done.');

    // The second request's body must carry the captured blocks as the
    // prior assistant turn so Anthropic can resume the paused sampling.
    const secondInit = fetchMock.mock.calls[1][1] as RequestInit;
    const secondBody = JSON.parse(secondInit.body as string);
    const trailingAssistant = secondBody.messages[secondBody.messages.length - 1];
    expect(trailingAssistant.role).toBe('assistant');
    expect(trailingAssistant.assistant_content_blocks).toEqual([
      { type: 'text', text: 'Searching' },
      { type: 'server_tool_use', id: 'su_01', name: 'web_search', input: {} },
    ]);
  });

  it('lets an explicit anthropicWebSearch=false override the default', async () => {
    installStreamFetch(fetchMock);
    const { anthropicStream } = await import('./anthropic-stream');
    const iter = anthropicStream({ ...baseRequest, anthropicWebSearch: false });
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.anthropic_web_search).toBeUndefined();
  });
});
