import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';

// Module-level mocks so the stream's runtime dependencies don't hit real
// storage or network. Each test reimports the module to pick these up.

vi.mock('@/hooks/useOllamaConfig', () => ({
  getOllamaKey: () => 'test-key',
}));

vi.mock('./providers', () => ({
  PROVIDER_URLS: {
    ollama: {
      chat: 'https://ollama.example/v1/chat/completions',
      models: 'https://ollama.example/v1/models',
    },
  },
}));

// toLLMMessages pulls in huge dependency graph — stub to a trivial passthrough.
// Preserves `contentBlocks` when present so the native-tool-history flatten can
// be exercised; messages without it serialize exactly as before (most tests).
vi.mock('./orchestrator', () => ({
  toLLMMessages: (messages: Array<ChatMessage & { contentBlocks?: unknown }>) =>
    messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.contentBlocks ? { contentBlocks: m.contentBlocks } : {}),
    })),
}));

// Narrow KNOWN_TOOL_NAMES so tests can assert on known-vs-unknown dispatch
// without depending on the real registry.
vi.mock('./tool-dispatch', () => ({
  KNOWN_TOOL_NAMES: new Set(['sandbox_write_file', 'sandbox_read_file']),
}));

// Default model-catalog stub: non-reasoning model, so the body tests below
// don't pick up an unexpected `reasoning_effort` field. The reasoning-effort
// tests override this per-case with `vi.doMock` before re-importing.
vi.mock('./model-catalog', () => ({
  getModelCapabilities: () => ({
    reasoning: false,
    toolCall: false,
    vision: false,
    imageGen: false,
    structuredOutput: false,
    contextLimit: 0,
  }),
  getReasoningEffort: () => 'medium',
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
  provider: 'ollama',
  model: 'gpt-oss:120b',
  messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 } as unknown as ChatMessage],
};

const sampleTool = {
  name: 'sandbox_write_file',
  description: 'Write a file to the sandbox',
  input_schema: {
    type: 'object' as const,
    properties: { path: { type: 'string' as const } },
    required: ['path'],
    additionalProperties: false as const,
  },
};
const openAITool = {
  type: 'function',
  function: {
    name: sampleTool.name,
    description: sampleTool.description,
    parameters: sampleTool.input_schema,
  },
};

// ---------------------------------------------------------------------------

describe('ollamaStream', () => {
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
    const { ollamaStream } = await import('./ollama-stream');
    const events: Promise<PushStreamEvent[]> = collect(ollamaStream(baseRequest));

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

  it('forwards native function tools + tool_choice into the request body', async () => {
    installStreamFetch(fetchMock);
    const { ollamaStream } = await import('./ollama-stream');
    const iter = ollamaStream({ ...baseRequest, tools: [sampleTool] });
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.tools).toEqual([openAITool]);
    expect(body.tool_choice).toBe('auto');
  });

  it('omits tools / tool_choice when no native tools are attached', async () => {
    installStreamFetch(fetchMock);
    const { ollamaStream } = await import('./ollama-stream');
    const iter = ollamaStream(baseRequest);
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  // Tool history shape — when native FC is active, prior tool turns ride the
  // wire as OpenAI-native `tool_calls[]` + `role:'tool'` results rather than the
  // `[TOOL_RESULT]` text envelope (the provenance-confusion fix).
  const toolHistory = (): ChatMessage[] => [
    {
      id: 'a',
      role: 'assistant',
      content: '```json\n{"tool":"sandbox_read_file","args":{"path":"a.ts"}}\n```',
      timestamp: 0,
      contentBlocks: [
        { type: 'tool_use', id: 'toolu_1', name: 'sandbox_read_file', input: { path: 'a.ts' } },
      ],
    } as unknown as ChatMessage,
    {
      id: 'r',
      role: 'user',
      content: '[TOOL_RESULT] file body [/TOOL_RESULT]',
      timestamp: 0,
      contentBlocks: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' }],
    } as unknown as ChatMessage,
  ];

  it("expands tool history into tool_calls + role:'tool' when native tools are attached", async () => {
    installStreamFetch(fetchMock);
    const { ollamaStream } = await import('./ollama-stream');
    const iter = ollamaStream({ ...baseRequest, messages: toolHistory(), tools: [sampleTool] });
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: { name: 'sandbox_read_file', arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'file body' },
    ]);
  });

  it('leaves tool history as plain messages when no native tools are attached', async () => {
    installStreamFetch(fetchMock);
    const { ollamaStream } = await import('./ollama-stream');
    const iter = ollamaStream({ ...baseRequest, messages: toolHistory() });
    void iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    // Gate closed: no flatten, so nothing becomes a `role:'tool'` message.
    expect(body.messages.some((m: { role: string }) => m.role === 'tool')).toBe(false);
    expect(body.messages).toHaveLength(2);
  });

  it('accepts delta.reasoning (modern field name)', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { ollamaStream } = await import('./ollama-stream');
    const events = collect(ollamaStream(baseRequest));

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
    const { ollamaStream } = await import('./ollama-stream');
    const events = collect(ollamaStream(baseRequest));

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
    const { ollamaStream } = await import('./ollama-stream');
    const events = collect(ollamaStream(baseRequest));

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
    const { ollamaStream } = await import('./ollama-stream');
    const events = collect(ollamaStream(baseRequest));

    push(contentFrame('hi'));
    push(finishFrame('stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }));

    const out = await events;
    expect(out[out.length - 1]).toEqual({
      type: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });

  it('strips chat-template control tokens from delta.content', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { ollamaStream } = await import('./ollama-stream');
    const events = collect(ollamaStream(baseRequest));

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
    const { ollamaStream } = await import('./ollama-stream');

    let caught: Error | null = null;
    try {
      await collect(ollamaStream(baseRequest));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/Ollama Cloud/);
    expect(caught!.message).toMatch(/429/);
    expect(caught!.message).toMatch(/rate limited/);
  });

  it('propagates abort to the upstream reader', async () => {
    const { push } = installStreamFetch(fetchMock);
    const controller = new AbortController();
    const { ollamaStream } = await import('./ollama-stream');

    const out: PushStreamEvent[] = [];
    const task = (async () => {
      try {
        for await (const e of ollamaStream({ ...baseRequest, signal: controller.signal })) {
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
    const { ollamaStream } = await import('./ollama-stream');
    const iter = ollamaStream({
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

  it('attaches reasoning_effort for a reasoning-capable model using the saved effort', async () => {
    vi.doMock('./model-catalog', () => ({
      getModelCapabilities: () => ({
        reasoning: true,
        toolCall: false,
        vision: false,
        imageGen: false,
        structuredOutput: false,
        contextLimit: 0,
      }),
      getReasoningEffort: () => 'high',
    }));
    installStreamFetch(fetchMock);
    const { ollamaStream } = await import('./ollama-stream');
    const iter = ollamaStream(baseRequest);
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.reasoning_effort).toBe('high');
  });

  it('maps the "off" effort onto Ollama\'s "none" so thinking can be disabled', async () => {
    vi.doMock('./model-catalog', () => ({
      getModelCapabilities: () => ({
        reasoning: true,
        toolCall: false,
        vision: false,
        imageGen: false,
        structuredOutput: false,
        contextLimit: 0,
      }),
      getReasoningEffort: () => 'off',
    }));
    installStreamFetch(fetchMock);
    const { ollamaStream } = await import('./ollama-stream');
    const iter = ollamaStream(baseRequest);
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.reasoning_effort).toBe('none');
  });

  it('omits reasoning_effort for a non-reasoning model', async () => {
    // Explicit doMock (not the hoisted default) so this case is independent of
    // any reasoning doMock a prior test registered — vi.doMock persists across
    // cases until the next import re-resolves it.
    vi.doMock('./model-catalog', () => ({
      getModelCapabilities: () => ({
        reasoning: false,
        toolCall: false,
        vision: false,
        imageGen: false,
        structuredOutput: false,
        contextLimit: 0,
      }),
      getReasoningEffort: () => 'medium',
    }));
    installStreamFetch(fetchMock);
    const { ollamaStream } = await import('./ollama-stream');
    const iter = ollamaStream(baseRequest);
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('closes cleanly when the stream ends without a [DONE] or finish_reason', async () => {
    const { push, close } = installStreamFetch(fetchMock);
    const { ollamaStream } = await import('./ollama-stream');
    const events = collect(ollamaStream(baseRequest));

    push(contentFrame('partial'));
    close();

    const out = await events;
    expect(out).toEqual([
      { type: 'text_delta', text: 'partial' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('hits PROVIDER_URLS.ollama.chat', async () => {
    installStreamFetch(fetchMock);
    const { ollamaStream } = await import('./ollama-stream');
    const iter = ollamaStream(baseRequest);
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalled();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ollama.example/v1/chat/completions');
  });

  it('sends the configured Bearer token', async () => {
    installStreamFetch(fetchMock);
    const { ollamaStream } = await import('./ollama-stream');
    const iter = ollamaStream(baseRequest);
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toBe('Bearer test-key');
  });

  it('omits Authorization entirely when the client key is empty', async () => {
    // standardAuth('OLLAMA_API_KEY') on the Worker reads any non-empty client
    // Authorization as "key supplied" and skips the keyMissingError 401, so
    // sending `Bearer ` would bypass the configured fallback and forward an
    // empty bearer to Ollama. The stream therefore omits Authorization when
    // there's no client key — letting the Worker (or the upstream) surface a
    // proper key-missing error.
    vi.doMock('@/hooks/useOllamaConfig', () => ({
      getOllamaKey: () => '',
    }));
    installStreamFetch(fetchMock);
    const { ollamaStream } = await import('./ollama-stream');
    const iter = ollamaStream(baseRequest);
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Native tool_call bridge — mirrors the OpenRouter / Zen coverage.
  // -------------------------------------------------------------------------

  it('accumulates native tool_call fragments and flushes them as native_tool_call on finish', async () => {
    const { push } = installStreamFetch(fetchMock);
    const { ollamaStream } = await import('./ollama-stream');
    const events = collect(ollamaStream(baseRequest));

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
    const toolEvents = out.filter(
      (e): e is { type: 'native_tool_call'; call: { name: string; args: unknown } } =>
        e.type === 'native_tool_call',
    );
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].call).toEqual({
      name: 'sandbox_write_file',
      args: { path: 'foo.ts', content: 'x' },
    });
    expect(out[out.length - 1]).toEqual({
      type: 'done',
      finishReason: 'tool_calls',
      usage: undefined,
    });
  });

  it('drops native tool_calls whose name is not in KNOWN_TOOL_NAMES', async () => {
    const { push } = installStreamFetch(fetchMock);
    const { ollamaStream } = await import('./ollama-stream');
    const events = collect(ollamaStream(baseRequest));

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

  // -------------------------------------------------------------------------
  // Think-tag routing — mirrors the OpenRouter / Zen composition test.
  // -------------------------------------------------------------------------

  it('composes with normalizeReasoning to split inline <think> tags out of content', async () => {
    const { push, finish } = installStreamFetch(fetchMock);
    const { ollamaStream } = await import('./ollama-stream');
    const { normalizeReasoning } = await import('@push/lib/reasoning-tokens');

    const composed = normalizeReasoning(ollamaStream(baseRequest));
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
