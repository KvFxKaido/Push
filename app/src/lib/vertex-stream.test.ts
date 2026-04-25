import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';

const VALID_SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'test-project',
  client_email: 'test@test-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIBfake==\n-----END PRIVATE KEY-----\n',
});

vi.mock('@/hooks/useVertexConfig', () => ({
  getVertexBaseUrl: () => 'https://us-central1-aiplatform.googleapis.com',
  getVertexKey: () => VALID_SERVICE_ACCOUNT_JSON,
  getVertexMode: () => 'native' as const,
  getVertexRegion: () => 'us-central1',
}));

vi.mock('./providers', () => ({
  PROVIDER_URLS: {
    vertex: {
      chat: 'https://app.example/api/vertex/chat',
      models: 'https://app.example/api/vertex/models',
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
  provider: 'vertex',
  model: 'claude-sonnet-4@20250115',
  messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 } as unknown as ChatMessage],
};

// vi.doMock-altering tests live at the end so their state doesn't pollute
// the default-fixture (native-mode) tests above.

describe('vertexStream', () => {
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

  it('parses text_delta frames and closes on [DONE] (native mode)', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { vertexStream } = await import('./vertex-stream');
    const events = collect(vertexStream(baseRequest));

    push(contentFrame('hello'));
    finish();

    const out = await events;
    expect(out).toEqual([
      { type: 'text_delta', text: 'hello' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('hits PROVIDER_URLS.vertex.chat', async () => {
    installStreamFetch(fetchMock);
    const { vertexStream } = await import('./vertex-stream');
    const iter = vertexStream(baseRequest);
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://app.example/api/vertex/chat');
  });

  it('sends X-Push-Vertex-Service-Account + X-Push-Vertex-Region headers in native mode', async () => {
    installStreamFetch(fetchMock);
    const { vertexStream } = await import('./vertex-stream');
    const iter = vertexStream(baseRequest);
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Push-Vertex-Service-Account']).toBeTruthy();
    expect(headers['X-Push-Vertex-Region']).toBe('us-central1');
    // Native mode never sends Authorization — the Worker uses the encoded
    // service account to mint a Google access token internally.
    expect(headers.Authorization).toBeUndefined();
    // Native mode never sends X-Push-Upstream-Base — the Worker calls
    // Vertex directly rather than proxying to a configured base URL.
    expect(headers['X-Push-Upstream-Base']).toBeUndefined();
  });

  it('throws with a useful error on non-200 response', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { vertexStream } = await import('./vertex-stream');

    let caught: Error | null = null;
    try {
      await collect(vertexStream(baseRequest));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/Google Vertex/);
    expect(caught!.message).toMatch(/429/);
    expect(caught!.message).toMatch(/rate limited/);
  });

  it('propagates abort to the upstream reader', async () => {
    const { push } = installStreamFetch(fetchMock);
    const controller = new AbortController();
    const { vertexStream } = await import('./vertex-stream');

    const out: PushStreamEvent[] = [];
    const task = (async () => {
      try {
        for await (const e of vertexStream({ ...baseRequest, signal: controller.signal })) {
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
    const { vertexStream } = await import('./vertex-stream');
    const iter = vertexStream({ ...baseRequest, maxTokens: 4096, temperature: 0.5, topP: 0.95 });
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
    const { vertexStream } = await import('./vertex-stream');
    const events = collect(vertexStream(baseRequest));

    push(contentFrame('partial'));
    push(finishFrame('length'));
    finish();

    const out = await events;
    expect(out).toEqual([
      { type: 'text_delta', text: 'partial' },
      { type: 'done', finishReason: 'length', usage: undefined },
    ]);
  });

  it('composes with normalizeReasoning to split inline <think> tags out of content', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { vertexStream } = await import('./vertex-stream');
    const { normalizeReasoning } = await import('@push/lib/reasoning-tokens');

    const composed = normalizeReasoning(vertexStream(baseRequest));
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

  // ---- vi.doMock-altering tests below ----

  it('legacy mode sends X-Push-Upstream-Base + Bearer (no service account headers)', async () => {
    vi.doMock('@/hooks/useVertexConfig', () => ({
      getVertexBaseUrl: () =>
        'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/endpoints/openapi',
      getVertexKey: () => 'test-key',
      getVertexMode: () => 'legacy' as const,
      getVertexRegion: () => 'us-central1',
    }));
    installStreamFetch(fetchMock);
    const { vertexStream } = await import('./vertex-stream');
    const iter = vertexStream(baseRequest);
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['X-Push-Upstream-Base']).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/endpoints/openapi',
    );
    expect(headers['X-Push-Vertex-Service-Account']).toBeUndefined();
    expect(headers['X-Push-Vertex-Region']).toBeUndefined();
  });

  it('legacy mode omits Authorization when the client key is empty', async () => {
    vi.doMock('@/hooks/useVertexConfig', () => ({
      getVertexBaseUrl: () =>
        'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/endpoints/openapi',
      getVertexKey: () => '',
      getVertexMode: () => 'legacy' as const,
      getVertexRegion: () => 'us-central1',
    }));
    installStreamFetch(fetchMock);
    const { vertexStream } = await import('./vertex-stream');
    const iter = vertexStream(baseRequest);
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-Push-Upstream-Base']).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/endpoints/openapi',
    );
  });

  it('legacy mode throws when the configured base URL is missing or invalid', async () => {
    vi.doMock('@/hooks/useVertexConfig', () => ({
      getVertexBaseUrl: () => '',
      getVertexKey: () => 'test-key',
      getVertexMode: () => 'legacy' as const,
      getVertexRegion: () => 'us-central1',
    }));
    const { vertexStream } = await import('./vertex-stream');

    let caught: Error | null = null;
    try {
      await vertexStream(baseRequest)[Symbol.asyncIterator]().next();
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/base URL/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('native mode throws when the service account is missing', async () => {
    vi.doMock('@/hooks/useVertexConfig', () => ({
      getVertexBaseUrl: () =>
        'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/endpoints/openapi',
      getVertexKey: () => '',
      getVertexMode: () => 'native' as const,
      getVertexRegion: () => 'us-central1',
    }));
    const { vertexStream } = await import('./vertex-stream');

    let caught: Error | null = null;
    try {
      await vertexStream(baseRequest)[Symbol.asyncIterator]().next();
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/service account/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('native mode throws when the service account JSON is invalid', async () => {
    vi.doMock('@/hooks/useVertexConfig', () => ({
      getVertexBaseUrl: () =>
        'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/endpoints/openapi',
      getVertexKey: () => 'not json',
      getVertexMode: () => 'native' as const,
      getVertexRegion: () => 'us-central1',
    }));
    const { vertexStream } = await import('./vertex-stream');

    let caught: Error | null = null;
    try {
      await vertexStream(baseRequest)[Symbol.asyncIterator]().next();
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/service account/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('native mode throws when the configured region fails format validation', async () => {
    // `normalizeVertexRegion` accepts anything matching the GCP location
    // regex (so it can't reject made-up regions like "narnia-1"), but it
    // does reject malformed values that don't fit the format at all.
    vi.doMock('@/hooks/useVertexConfig', () => ({
      getVertexBaseUrl: () =>
        'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/endpoints/openapi',
      getVertexKey: () => VALID_SERVICE_ACCOUNT_JSON,
      getVertexMode: () => 'native' as const,
      getVertexRegion: () => '1invalid',
    }));
    const { vertexStream } = await import('./vertex-stream');

    let caught: Error | null = null;
    try {
      await vertexStream(baseRequest)[Symbol.asyncIterator]().next();
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/region/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when getVertexMode is 'none' (partial / invalid config)", async () => {
    // `'none'` means neither native nor legacy is fully configured.
    // PROVIDER_READY_CHECKS.vertex normally filters this out before the
    // stream is reached, but a `providerOverride: 'vertex'` could route
    // past that. The stream must fail fast with a local error rather
    // than falling through to a legacy-shaped fetch that would send the
    // service-account JSON as a Bearer token.
    vi.doMock('@/hooks/useVertexConfig', () => ({
      getVertexBaseUrl: () => '',
      getVertexKey: () => VALID_SERVICE_ACCOUNT_JSON,
      getVertexMode: () => 'none' as const,
      getVertexRegion: () => 'us-central1',
    }));
    const { vertexStream } = await import('./vertex-stream');

    let caught: Error | null = null;
    try {
      await vertexStream(baseRequest)[Symbol.asyncIterator]().next();
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/not fully configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
