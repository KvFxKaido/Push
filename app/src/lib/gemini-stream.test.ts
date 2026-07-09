import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';

vi.mock('@/hooks/useGoogleConfig', () => ({
  getGoogleKey: () => 'AIza-test',
}));

vi.mock('./providers', () => ({
  PROVIDER_URLS: {
    google: {
      chat: 'https://app.example/api/google/chat',
      models: 'https://app.example/api/google/models',
    },
  },
}));

vi.mock('./model-catalog', () => ({
  resolvePushCapabilityProfile: () => ({
    toolCalling: 'native',
    streamingTools: true,
    multimodal: true,
    structuredOutput: 'none',
    contentBlocks: true,
    reasoningBlocks: false,
    context: 'medium',
  }),
}));

vi.mock('./orchestrator', () => ({
  toLLMMessages: (messages: ChatMessage[]) =>
    messages.map((m) => ({ role: m.role, content: m.content })),
}));

vi.mock('./tool-dispatch', () => ({
  KNOWN_TOOL_NAMES: new Set(['sandbox_write_file', 'sandbox_read_file']),
}));

let webSearchMode: 'auto' | 'google-grounding' | 'off' | 'duckduckgo' = 'auto';
vi.mock('./web-search-mode', () => ({
  getWebSearchMode: () => webSearchMode,
  isNativeWebSearchEnabled: (provider: string, _modelId?: string, mode?: string) => {
    const m = mode ?? webSearchMode;
    if (m === 'off') return false;
    if (m === 'auto') return provider === 'google' || provider === 'anthropic';
    if (m === 'google-grounding') return provider === 'google';
    return false;
  },
}));

interface ControllableStream {
  response: Response;
  push(frame: string): void;
  finish(): void;
}

// The Worker now proxies Gemini's raw SSE, so this fake stream emits native
// Gemini frames (`candidates[].content.parts[]`) that the `geminiStream` adapter
// parses with `geminiEventStream`. Gemini has no `[DONE]` sentinel on the wire;
// the pump emits its terminal `done` on stream close (the fake sends a harmless
// `[DONE]` that the pump ignores).
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

const baseRequest: PushStreamRequest<ChatMessage> = {
  provider: 'google',
  model: 'gemini-3.1-pro-preview',
  messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 } as unknown as ChatMessage],
};

const readFileTool = {
  name: 'sandbox_read_file',
  description: 'Read a file',
  input_schema: {
    type: 'object' as const,
    properties: { path: { type: 'string' as const } },
    required: ['path'],
    additionalProperties: false as const,
  },
};

describe('geminiStream', () => {
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

  it('hits PROVIDER_URLS.google.chat', async () => {
    installStreamFetch(fetchMock);
    const { geminiStream } = await import('./gemini-stream');
    const iter = geminiStream(baseRequest);
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://app.example/api/google/chat');
  });

  it('parses native Gemini frames and carries thoughtSignature on the tool call', async () => {
    // Proves the web path now uses the native `geminiEventStream` (not the
    // OpenAI-SSE detour) and that Gemini's `thoughtSignature` rides through as a
    // first-class field on the neutral tool call — the round-trip #1174 needed.
    const { push, finish } = installStreamFetch(fetchMock);
    const { geminiStream } = await import('./gemini-stream');
    const events = collect(geminiStream(baseRequest));

    push(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Reading the file.' },
                {
                  functionCall: { name: 'sandbox_read_file', args: { path: 'README.md' } },
                  thoughtSignature: 'AgQKAabc123==',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      }),
    );
    finish();

    const out = await events;
    expect(out).toEqual([
      { type: 'text_delta', text: 'Reading the file.' },
      { type: 'tool_call_delta' },
      {
        type: 'native_tool_call',
        call: {
          name: 'sandbox_read_file',
          args: { path: 'README.md' },
          thoughtSignature: 'AgQKAabc123==',
        },
      },
      { type: 'done', finishReason: 'tool_calls', usage: undefined },
    ]);
  });

  it('sends Bearer token from the client-side key', async () => {
    installStreamFetch(fetchMock);
    const { geminiStream } = await import('./gemini-stream');
    const iter = geminiStream(baseRequest);
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer AIza-test');
  });

  it('omits Authorization when the client key is empty', async () => {
    vi.doMock('@/hooks/useGoogleConfig', () => ({
      getGoogleKey: () => '',
    }));
    installStreamFetch(fetchMock);
    const { geminiStream } = await import('./gemini-stream');
    const iter = geminiStream(baseRequest);
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('throws a Google-prefixed error on non-200 response', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: 'API key not valid' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { geminiStream } = await import('./gemini-stream');

    let caught: Error | null = null;
    try {
      await collect(geminiStream(baseRequest));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/Google/);
    expect(caught!.message).toMatch(/400/);
    expect(caught!.message).toMatch(/API key not valid/);
  });

  it('does not re-prefix when the Worker error already carries `Google `', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: 'Google 401: bad key' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { geminiStream } = await import('./gemini-stream');

    let caught: Error | null = null;
    try {
      await collect(geminiStream(baseRequest));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught!.message).toBe('Google 401: bad key');
  });

  it('sends the push.stream.v1 neutral wire body (contract + camelCase scalars)', async () => {
    installStreamFetch(fetchMock);
    const { geminiStream } = await import('./gemini-stream');
    const iter = geminiStream({ ...baseRequest, maxTokens: 2048, temperature: 0.4, topP: 0.8 });
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.contract).toBe('push.stream.v1');
    expect(body.provider).toBe('google');
    expect(body.model).toBe('gemini-3.1-pro-preview');
    expect(body.maxTokens).toBe(2048);
    expect(body.temperature).toBe(0.4);
    expect(body.topP).toBe(0.8);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('stream');
  });

  it('carries native function tools on the neutral wire body', async () => {
    installStreamFetch(fetchMock);
    const { geminiStream } = await import('./gemini-stream');
    const iter = geminiStream({ ...baseRequest, tools: [readFileTool] });
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.tools).toEqual([readFileTool]);
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('sends googleSearchGrounding: true when requested', async () => {
    installStreamFetch(fetchMock);
    const { geminiStream } = await import('./gemini-stream');
    const iter = geminiStream({ ...baseRequest, googleSearchGrounding: true });
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.googleSearchGrounding).toBe(true);
    expect(body).not.toHaveProperty('google_search_grounding');
  });

  it('falls back to the web-search-mode pref when the request omits the flag', async () => {
    installStreamFetch(fetchMock);
    webSearchMode = 'google-grounding';
    try {
      const { geminiStream } = await import('./gemini-stream');
      const iter = geminiStream(baseRequest);
      void iter[Symbol.asyncIterator]()
        .next()
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 0));

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.googleSearchGrounding).toBe(true);
    } finally {
      webSearchMode = 'auto';
    }
  });

  it('defaults grounding on in auto mode (no explicit flag, default pref)', async () => {
    installStreamFetch(fetchMock);
    const { geminiStream } = await import('./gemini-stream');
    const iter = geminiStream(baseRequest);
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.googleSearchGrounding).toBe(true);
  });

  it('omits the flag when web search is off', async () => {
    installStreamFetch(fetchMock);
    webSearchMode = 'off';
    try {
      const { geminiStream } = await import('./gemini-stream');
      const iter = geminiStream(baseRequest);
      void iter[Symbol.asyncIterator]()
        .next()
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 0));

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.googleSearchGrounding).toBeUndefined();
    } finally {
      webSearchMode = 'auto';
    }
  });

  it('omits the flag when user picks an explicit non-native backend', async () => {
    installStreamFetch(fetchMock);
    webSearchMode = 'duckduckgo';
    try {
      const { geminiStream } = await import('./gemini-stream');
      const iter = geminiStream(baseRequest);
      void iter[Symbol.asyncIterator]()
        .next()
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 0));

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.googleSearchGrounding).toBeUndefined();
    } finally {
      webSearchMode = 'auto';
    }
  });
});
