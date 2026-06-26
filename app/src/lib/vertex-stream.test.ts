import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';
import {
  PUSH_NATIVE_SSE_HEADER,
  PUSH_NATIVE_SSE_HEADER_VALUE,
} from '@push/lib/native-sse-capability';

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

vi.mock('./model-catalog', () => ({
  resolvePushCapabilityProfile: (
    _provider: string,
    _model: string | undefined,
    options?: { requestWire?: 'neutral' | 'openai' },
  ) => ({
    toolCalling: 'native',
    streamingTools: true,
    multimodal: true,
    structuredOutput: 'none',
    contentBlocks: options?.requestWire === 'neutral',
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

// Native-mode Claude on Vertex streams raw Anthropic Messages SSE (the Worker
// proxies it through unchanged), parsed by `anthropicEventStream` — not the
// OpenAI `choices` shape. These helpers build that wire for the native path.
function anthropicTextFrame(text: string): string {
  return JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
}

function anthropicStopFrame(stopReason: string): string {
  return JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason } });
}

const baseRequest: PushStreamRequest<ChatMessage> = {
  provider: 'vertex',
  model: 'claude-sonnet-4@20250115',
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
const openAIReadFileTool = {
  type: 'function',
  function: {
    name: readFileTool.name,
    description: readFileTool.description,
    parameters: readFileTool.input_schema,
  },
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

  it('parses native Anthropic content frames for Claude (native mode)', async () => {
    // baseRequest is a claude-* model in native mode → the Worker proxies raw
    // Anthropic SSE, parsed by `anthropicEventStream` (not the OpenAI pump).
    const { push, finish } = installStreamFetch(fetchMock);
    const { vertexStream } = await import('./vertex-stream');
    const events = collect(vertexStream(baseRequest));

    push(anthropicTextFrame('hello'));
    finish();

    const out = await events;
    expect(out).toEqual([
      { type: 'text_delta', text: 'hello' },
      { type: 'done', finishReason: 'stop' },
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
    expect(headers[PUSH_NATIVE_SSE_HEADER]).toBe(PUSH_NATIVE_SSE_HEADER_VALUE);
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

    push(anthropicTextFrame('hi'));
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await task;

    expect(out).toEqual([{ type: 'text_delta', text: 'hi' }]);
  });

  it('replays pause_turn for Claude-on-Vertex (Anthropic-transport models)', async () => {
    // Vertex Claude can pause_turn the same way direct Anthropic can —
    // mirror the continuation loop from `app/src/lib/anthropic-stream.ts`
    // here so consumers don't see pause_turn leak through and don't get
    // truncated answers.
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
    const { vertexStream } = await import('./vertex-stream');
    const events = collect(vertexStream({ ...baseRequest, model: 'claude-opus-4-7@20251015' }));

    await new Promise((r) => setTimeout(r, 0));
    const first = responses[0];
    // Anthropic Messages SSE: a text block + a server_tool_use block, then a
    // pause_turn message_delta. anthropicEventStream reconstructs the captured
    // assistant content[] from these frames (no OpenAI translator in between).
    first.push(
      JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    );
    first.push(
      JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Searching' },
      }),
    );
    first.push(JSON.stringify({ type: 'content_block_stop', index: 0 }));
    first.push(
      JSON.stringify({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'server_tool_use', id: 'su_01', name: 'web_search', input: {} },
      }),
    );
    first.push(JSON.stringify({ type: 'content_block_stop', index: 1 }));
    first.push(anthropicStopFrame('pause_turn'));
    first.finish();

    await new Promise((r) => setTimeout(r, 5));
    const second = responses[1];
    expect(second).toBeDefined();
    second.push(anthropicTextFrame(' done.'));
    second.push(anthropicStopFrame('end_turn'));
    second.finish();

    const out = await events;
    expect(out.some((e) => e.type === 'pause_turn')).toBe(false);
    expect(out.some((e) => e.type === 'done')).toBe(true);
    const text = out
      .filter((e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('Searching done.');

    // Native mode is the neutral wire: the continuation carries the captured
    // blocks via `replayAssistantTurns` (the Worker forwards them to
    // toAnthropicMessages), not inline on `messages`.
    const secondInit = fetchMock.mock.calls[1][1] as RequestInit;
    const secondBody = JSON.parse(secondInit.body as string);
    expect(secondBody.contract).toBe('push.stream.v1');
    expect(secondBody.replayAssistantTurns).toEqual([
      [
        { type: 'text', text: 'Searching' },
        { type: 'server_tool_use', id: 'su_01', name: 'web_search', input: {} },
      ],
    ]);
  });

  it('sets anthropicWebSearch on Claude (Anthropic-transport) models', async () => {
    installStreamFetch(fetchMock);
    const { vertexStream } = await import('./vertex-stream');
    const iter = vertexStream({ ...baseRequest, model: 'claude-opus-4-7@20251015' });
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.anthropicWebSearch).toBe(true);
    expect(body.googleSearchGrounding).toBeUndefined();
  });

  it('sets googleSearchGrounding on Gemini (OpenAI-compat-transport) models', async () => {
    installStreamFetch(fetchMock);
    const { vertexStream } = await import('./vertex-stream');
    const iter = vertexStream({ ...baseRequest, model: 'gemini-2.5-pro' });
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.googleSearchGrounding).toBe(true);
    // Must NOT leak the Anthropic flag onto a Gemini turn.
    expect(body.anthropicWebSearch).toBeUndefined();
  });

  it('sends the push.stream.v1 neutral wire body in native mode (camelCase scalars)', async () => {
    installStreamFetch(fetchMock);
    const { vertexStream } = await import('./vertex-stream');
    const iter = vertexStream({ ...baseRequest, maxTokens: 4096, temperature: 0.5, topP: 0.95 });
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.contract).toBe('push.stream.v1');
    expect(body.provider).toBe('vertex');
    expect(body.maxTokens).toBe(4096);
    expect(body.temperature).toBe(0.5);
    expect(body.topP).toBe(0.95);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('stream');
  });

  it('carries native function tools on the native neutral wire body', async () => {
    installStreamFetch(fetchMock);
    const { vertexStream } = await import('./vertex-stream');
    const iter = vertexStream({ ...baseRequest, tools: [readFileTool] });
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.contract).toBe('push.stream.v1');
    expect(body.tools).toEqual([readFileTool]);
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('carries responseFormat on the native neutral wire body', async () => {
    installStreamFetch(fetchMock);
    const { vertexStream } = await import('./vertex-stream');
    const responseFormat = { name: 'verdict', schema: { type: 'object' } };
    const iter = vertexStream({ ...baseRequest, responseFormat });
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.contract).toBe('push.stream.v1');
    expect(body.responseFormat).toEqual(responseFormat);
    expect(body).not.toHaveProperty('response_format');
  });

  it('maps finish_reason onto the done event', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { vertexStream } = await import('./vertex-stream');
    const events = collect(vertexStream(baseRequest));

    push(anthropicTextFrame('partial'));
    push(anthropicStopFrame('max_tokens'));
    finish();

    const out = await events;
    expect(out).toEqual([
      { type: 'text_delta', text: 'partial' },
      { type: 'done', finishReason: 'length' },
    ]);
  });

  it('composes with normalizeReasoning to split inline <think> tags out of content', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { vertexStream } = await import('./vertex-stream');
    const { normalizeReasoning } = await import('@push/lib/reasoning-tokens');

    const composed = normalizeReasoning(vertexStream(baseRequest));
    const events = collect(composed);

    push(anthropicTextFrame('<think>pondering</think>answer'));
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

  it('legacy mode keeps the OpenAI Chat Completions body shape (NOT neutral)', async () => {
    // handleLegacyVertexChat does not dual-accept, so the legacy path must keep
    // sending the OpenAI-shaped body — only native mode flips to the wire.
    vi.doMock('@/hooks/useVertexConfig', () => ({
      getVertexBaseUrl: () =>
        'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/endpoints/openapi',
      getVertexKey: () => 'test-key',
      getVertexMode: () => 'legacy' as const,
      getVertexRegion: () => 'us-central1',
    }));
    installStreamFetch(fetchMock);
    const { vertexStream } = await import('./vertex-stream');
    const iter = vertexStream({ ...baseRequest, maxTokens: 4096, temperature: 0.5 });
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.contract).toBeUndefined();
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(4096);
    expect(body.temperature).toBe(0.5);
    expect(body).not.toHaveProperty('maxTokens');
  });

  it('legacy mode carries native function tools on the OpenAI Chat body', async () => {
    vi.doMock('@/hooks/useVertexConfig', () => ({
      getVertexBaseUrl: () =>
        'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/endpoints/openapi',
      getVertexKey: () => 'test-key',
      getVertexMode: () => 'legacy' as const,
      getVertexRegion: () => 'us-central1',
    }));
    installStreamFetch(fetchMock);
    const { vertexStream } = await import('./vertex-stream');
    const iter = vertexStream({ ...baseRequest, model: 'gemini-2.5-pro', tools: [readFileTool] });
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.contract).toBeUndefined();
    expect(body.tools).toEqual([openAIReadFileTool]);
    expect(body.tool_choice).toBe('auto');
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

  it('legacy mode replays pause_turn inline (OpenAI shape) and accumulates across pauses', async () => {
    // Legacy mode keeps the OpenAI body, so pause_turn replay rides inline as
    // `assistant_content_blocks` messages (not the neutral replayAssistantTurns).
    // Two pauses must accumulate cumulatively in the third request's messages.
    vi.doMock('@/hooks/useVertexConfig', () => ({
      getVertexBaseUrl: () =>
        'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/endpoints/openapi',
      getVertexKey: () => 'test-key',
      getVertexMode: () => 'legacy' as const,
      getVertexRegion: () => 'us-central1',
    }));
    const responses: Array<ControllableStream> = [];
    const queue = [
      () => makeControllableStream(),
      () => makeControllableStream(),
      () => makeControllableStream(),
    ];
    fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const s = (queue.shift() ?? (() => makeControllableStream()))();
      responses.push(s);
      init?.signal?.addEventListener('abort', () => s.abort());
      return s.response;
    });
    const { vertexStream } = await import('./vertex-stream');
    const events = collect(vertexStream(baseRequest));

    const pauseFrame = (id: string) =>
      JSON.stringify({
        choices: [
          {
            finish_reason: 'pause_turn',
            delta: { assistant_content_blocks: [{ type: 'text', text: id }] },
          },
        ],
      });

    await new Promise((r) => setTimeout(r, 0));
    responses[0].push(pauseFrame('A'));
    responses[0].finish();
    await new Promise((r) => setTimeout(r, 5));
    responses[1].push(pauseFrame('B'));
    responses[1].finish();
    await new Promise((r) => setTimeout(r, 5));
    responses[2].push(JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] }));
    responses[2].finish();
    await events;

    // Third request: OpenAI shape, with both paused turns appended after the
    // original user turn, oldest-first.
    const thirdBody = JSON.parse(fetchMock.mock.calls[2][1]!.body as string);
    expect(thirdBody.contract).toBeUndefined();
    expect(thirdBody.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', assistant_content_blocks: [{ type: 'text', text: 'A' }] },
      { role: 'assistant', assistant_content_blocks: [{ type: 'text', text: 'B' }] },
    ]);
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
