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

// The Worker translates Gemini frames back into OpenAI SSE before the client
// adapter sees anything, so this fake stream emits OpenAI-shaped frames — the
// `geminiStream` adapter just consumes `openAISSEPump` like every other
// adapter and shouldn't carry any Gemini-specific shape internally.
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

  it('sends google_search_grounding: true when requested', async () => {
    installStreamFetch(fetchMock);
    const { geminiStream } = await import('./gemini-stream');
    const iter = geminiStream({ ...baseRequest, googleSearchGrounding: true });
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.google_search_grounding).toBe(true);
  });

});