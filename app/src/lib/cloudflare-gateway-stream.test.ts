import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';

// Module-level mocks so the stream's runtime dependencies don't hit real
// storage or network. Each test reimports the module to pick these up.

vi.mock('./providers', () => ({
  PROVIDER_URLS: {
    'cloudflare-gateway': {
      chat: 'https://cf.example/api/cloudflare-gateway/chat',
      models: 'https://cf.example/api/cloudflare-gateway/models',
    },
  },
}));

// The leaf reads the Settings-saved Cloudflare token through this getter.
// Mutable holder so individual tests can flip keyed vs keyless.
const keyHolder: { key: string | null } = { key: null };
vi.mock('@/hooks/useCloudflareGatewayConfig', () => ({
  getCloudflareGatewayKey: () => keyHolder.key,
}));

// toLLMMessages pulls in a huge dependency graph — stub to a trivial passthrough.
vi.mock('./orchestrator', () => ({
  toLLMMessages: (messages: ChatMessage[]) =>
    messages.map((m) => ({ role: m.role, content: m.content })),
}));

vi.mock('./tool-dispatch', () => ({
  KNOWN_TOOL_NAMES: new Set(['sandbox_write_file', 'sandbox_read_file']),
}));

// ---------------------------------------------------------------------------
// Test harness — fetch-mock + controllable ReadableStream
// ---------------------------------------------------------------------------

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
  fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return stream.response;
  });
  return stream;
}

function contentFrame(text: string): string {
  return JSON.stringify({ choices: [{ delta: { content: text } }] });
}

const baseRequest: PushStreamRequest<ChatMessage> = {
  provider: 'cloudflare-gateway',
  model: 'openai/gpt-5-mini',
  messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 } as unknown as ChatMessage],
};

// ---------------------------------------------------------------------------

describe('cloudflareGatewayStream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let collect: (stream: AsyncIterable<PushStreamEvent>) => Promise<PushStreamEvent[]>;

  beforeEach(async () => {
    vi.resetModules();
    keyHolder.key = null;
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
    const { cloudflareGatewayStream } = await import('./cloudflare-gateway-stream');
    const events = collect(cloudflareGatewayStream(baseRequest));

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

  it('hits PROVIDER_URLS["cloudflare-gateway"].chat', async () => {
    installStreamFetch(fetchMock);
    const { cloudflareGatewayStream } = await import('./cloudflare-gateway-stream');
    const iter = cloudflareGatewayStream(baseRequest);
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalled();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cf.example/api/cloudflare-gateway/chat');
  });

  it('passes the prefixed {gateway-provider}/{model} id through untouched', async () => {
    // The compat endpoint's routing lives entirely in the model id — a
    // client-side rewrite here would silently re-route the request.
    installStreamFetch(fetchMock);
    const { cloudflareGatewayStream } = await import('./cloudflare-gateway-stream');
    const iter = cloudflareGatewayStream({
      ...baseRequest,
      model: 'workers-ai/@cf/zai-org/glm-5.2',
    });
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('workers-ai/@cf/zai-org/glm-5.2');
  });

  it('sends a Settings-saved Cloudflare token as Authorization: Bearer', async () => {
    keyHolder.key = 'cf-token-123';
    installStreamFetch(fetchMock);
    const { cloudflareGatewayStream } = await import('./cloudflare-gateway-stream');
    const iter = cloudflareGatewayStream(baseRequest);
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer cf-token-123');
  });

  it('omits Authorization when no local token is saved (Worker secret covers it)', async () => {
    // Keyless client + CF_AI_GATEWAY_TOKEN on the Worker is the primary
    // deployment shape; the header must be absent so `standardAuth` resolves
    // the server secret instead of a blank bearer.
    installStreamFetch(fetchMock);
    const { cloudflareGatewayStream } = await import('./cloudflare-gateway-stream');
    const iter = cloudflareGatewayStream(baseRequest);
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('throws with a useful error on the Worker not-configured 401', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: 'Cloudflare AI Gateway is not configured on this Worker.',
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    );
    const { cloudflareGatewayStream } = await import('./cloudflare-gateway-stream');

    let caught: Error | null = null;
    try {
      await collect(cloudflareGatewayStream(baseRequest));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/Cloudflare AI Gateway/);
    expect(caught!.message).toMatch(/401/);
    expect(caught!.message).toMatch(/not configured/);
  });

  it('serializes tools + tool_choice into the body when present', async () => {
    installStreamFetch(fetchMock);
    const { cloudflareGatewayStream } = await import('./cloudflare-gateway-stream');
    const tools = [
      {
        name: 'exec',
        description: 'Run a shell command',
        input_schema: {
          type: 'object' as const,
          properties: { command: { type: 'string' as const } },
          required: ['command'],
          additionalProperties: false as const,
        },
      },
    ];
    const iter = cloudflareGatewayStream({ ...baseRequest, tools });
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: tools[0].name,
          description: tools[0].description,
          parameters: tools[0].input_schema,
        },
      },
    ]);
    expect(body.tool_choice).toBe('auto');
  });
});
