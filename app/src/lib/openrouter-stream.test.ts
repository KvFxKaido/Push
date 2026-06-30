import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';

vi.mock('@/hooks/useOpenRouterConfig', () => ({
  getOpenRouterKey: () => 'test-key',
}));

vi.mock('./openrouter-session', () => ({
  getOpenRouterSessionId: () => null,
  buildOpenRouterTrace: () => ({ trace_name: 'test' }),
}));

vi.mock('./model-catalog', () => ({
  openRouterModelSupportsReasoning: () => false,
  getReasoningEffort: () => 'off',
}));

vi.mock('./web-search-mode', () => ({
  isNativeWebSearchEnabled: () => true,
}));

// toLLMMessages pulls in a huge dependency graph. Stub it, but run the real
// materializeToolContentBlocks when native tools are active so the request-body
// tests still exercise Push's production tool pairing/adjacency path.
vi.mock('./orchestrator', async () => {
  const { materializeToolContentBlocks } = await import('@push/lib/content-blocks');
  return {
    toLLMMessages: (
      messages: Array<ChatMessage & { contentBlocks?: unknown }>,
      opts?: { emitContentBlocks?: boolean },
    ) => {
      const prepared = opts?.emitContentBlocks
        ? (materializeToolContentBlocks(messages as never) as typeof messages)
        : messages;
      return prepared.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.contentBlocks ? { contentBlocks: m.contentBlocks } : {}),
      }));
    },
  };
});

vi.mock('./tool-dispatch', () => ({
  KNOWN_TOOL_NAMES: new Set(['sandbox_write_file', 'sandbox_read_file']),
}));

interface ControllableStream {
  response: Response;
  push(frame: string): void;
  pushRaw(raw: string): void;
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

function responseEvent(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

function textFrame(text: string): string {
  return responseEvent({ type: 'response.output_text.delta', delta: text });
}

function reasoningFrame(
  text: string,
  type:
    | 'response.reasoning_summary_text.delta'
    | 'response.reasoning_summary.delta' = 'response.reasoning_summary_text.delta',
): string {
  return responseEvent({ type, delta: text });
}

function completedFrame(usage?: {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}): string {
  return responseEvent({
    type: 'response.completed',
    response: {
      status: 'completed',
      ...(usage ? { usage } : {}),
    },
  });
}

function chatContentFrame(text: string): string {
  return JSON.stringify({ choices: [{ delta: { content: text } }] });
}

const baseRequest: PushStreamRequest<ChatMessage> = {
  provider: 'openrouter',
  model: 'moonshotai/kimi-k2.6',
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

const responsesTool = {
  type: 'function',
  name: sampleTool.name,
  description: sampleTool.description,
  parameters: sampleTool.input_schema,
};

async function pullRequestBody(
  fetchMock: ReturnType<typeof vi.fn>,
  request: PushStreamRequest<ChatMessage>,
): Promise<Record<string, unknown>> {
  installStreamFetch(fetchMock);
  const { openrouterStream } = await import('./openrouter-stream');
  const iter = openrouterStream(request);
  iter[Symbol.asyncIterator]()
    .next()
    .catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(fetchMock).toHaveBeenCalled();
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('openrouterStream', () => {
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
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses Responses text deltas and response.completed usage', async () => {
    const { push, close } = installStreamFetch(fetchMock);
    const { openrouterStream } = await import('./openrouter-stream');
    const events = collect(openrouterStream(baseRequest));

    push(textFrame('hello '));
    push(textFrame('world'));
    push(completedFrame({ input_tokens: 10, output_tokens: 2, total_tokens: 12 }));
    close();

    expect(await events).toEqual([
      { type: 'text_delta', text: 'hello ' },
      { type: 'text_delta', text: 'world' },
      {
        type: 'done',
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      },
    ]);
  });

  it('accepts Responses reasoning summary deltas', async () => {
    const { push, close } = installStreamFetch(fetchMock);
    const { openrouterStream } = await import('./openrouter-stream');
    const events = collect(openrouterStream(baseRequest));

    push(reasoningFrame('thinking...'));
    push(reasoningFrame('legacy-ish', 'response.reasoning_summary.delta'));
    push(textFrame('answer'));
    push(completedFrame());
    close();

    expect(await events).toEqual([
      { type: 'reasoning_delta', text: 'thinking...' },
      { type: 'reasoning_delta', text: 'legacy-ish' },
      { type: 'text_delta', text: 'answer' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('maps response.incomplete max_output_tokens onto length', async () => {
    const { push, close } = installStreamFetch(fetchMock);
    const { openrouterStream } = await import('./openrouter-stream');
    const events = collect(openrouterStream(baseRequest));

    push(textFrame('partial...'));
    push(
      responseEvent({
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
        },
      }),
    );
    close();

    expect(await events).toEqual([
      { type: 'text_delta', text: 'partial...' },
      {
        type: 'done',
        finishReason: 'length',
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
    ]);
  });

  it('throws with a useful error on non-200 response', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { openrouterStream } = await import('./openrouter-stream');

    await expect(collect(openrouterStream(baseRequest))).rejects.toThrow(/429.*rate limited/);
  });

  it('propagates abort to the upstream reader', async () => {
    const { push } = installStreamFetch(fetchMock);
    const controller = new AbortController();
    const { openrouterStream } = await import('./openrouter-stream');
    const out: PushStreamEvent[] = [];
    const task = (async () => {
      try {
        for await (const e of openrouterStream({ ...baseRequest, signal: controller.signal })) {
          out.push(e);
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') throw err;
      }
    })();

    push(textFrame('hi'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await task;

    expect(out).toEqual([{ type: 'text_delta', text: 'hi' }]);
  });

  it('forwards max_output_tokens / temperature / top_p into the Responses body', async () => {
    const body = await pullRequestBody(fetchMock, {
      ...baseRequest,
      maxTokens: 1234,
      temperature: 0.7,
      topP: 0.9,
    });

    expect(body.max_output_tokens).toBe(1234);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
    expect(body.max_tokens).toBeUndefined();
  });

  it('serializes responseFormat as Responses text.format json_schema', async () => {
    const body = await pullRequestBody(fetchMock, {
      ...baseRequest,
      responseFormat: { name: 'verdict', schema: { type: 'object' } },
    });

    expect(body.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'verdict',
        strict: true,
        schema: { type: 'object' },
      },
    });
    expect(body.response_format).toBeUndefined();
    expect(body.provider).toEqual({ require_parameters: true });
  });

  it('omits text.format and provider routing when no structured output is set', async () => {
    const body = await pullRequestBody(fetchMock, baseRequest);

    expect(body.text).toBeUndefined();
    expect(body.provider).toBeUndefined();
  });

  it('injects the openrouter:web_search server tool by default', async () => {
    const body = await pullRequestBody(fetchMock, baseRequest);

    expect(body.tools).toEqual([{ type: 'openrouter:web_search' }]);
    expect(body.tool_choice).toBeUndefined();
    expect(body.provider).toBeUndefined();
  });

  it('omits the web_search tool when openrouterWebSearch=false', async () => {
    const body = await pullRequestBody(fetchMock, { ...baseRequest, openrouterWebSearch: false });

    expect(body.tools).toBeUndefined();
  });

  it('injects the web_search tool when openrouterWebSearch=true', async () => {
    const body = await pullRequestBody(fetchMock, { ...baseRequest, openrouterWebSearch: true });

    expect(body.tools).toEqual([{ type: 'openrouter:web_search' }]);
  });

  it('forwards native function tools as flat Responses tools', async () => {
    const body = await pullRequestBody(fetchMock, {
      ...baseRequest,
      openrouterWebSearch: false,
      tools: [sampleTool],
    });

    expect(body.tools).toEqual([responsesTool]);
    expect(body.tool_choice).toBe('auto');
    expect(body.provider).toEqual({ require_parameters: true });
  });

  it('merges native function tools with the web_search server tool', async () => {
    const body = await pullRequestBody(fetchMock, {
      ...baseRequest,
      openrouterWebSearch: true,
      tools: [sampleTool],
    });

    expect(body.tools).toEqual([responsesTool, { type: 'openrouter:web_search' }]);
    expect(body.tool_choice).toBe('auto');
    expect(body.provider).toEqual({ require_parameters: true });
  });

  const toolHistory = (): ChatMessage[] => [
    {
      id: 'a',
      role: 'assistant',
      content: '```json\n{"tool":"sandbox_read_file","args":{"path":"a.ts"}}\n```',
      timestamp: 0,
      toolUses: [
        { type: 'tool_use', id: 'toolu_1', name: 'sandbox_read_file', input: { path: 'a.ts' } },
      ],
    } as unknown as ChatMessage,
    {
      id: 'r',
      role: 'user',
      content: '[TOOL_RESULT] file body [/TOOL_RESULT]',
      timestamp: 0,
      toolResults: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' }],
    } as unknown as ChatMessage,
  ];

  it('serializes prior tool history as Responses function_call items when native tools are attached', async () => {
    const body = await pullRequestBody(fetchMock, {
      ...baseRequest,
      openrouterWebSearch: false,
      messages: toolHistory(),
      tools: [sampleTool],
    });

    expect(body.input).toEqual([
      {
        type: 'function_call',
        call_id: 'toolu_1',
        name: 'sandbox_read_file',
        arguments: '{"path":"a.ts"}',
        status: 'completed',
      },
      { type: 'function_call_output', call_id: 'toolu_1', output: 'file body' },
    ]);
  });

  it('leaves tool history as plain message items when no native tools are attached', async () => {
    const body = await pullRequestBody(fetchMock, { ...baseRequest, messages: toolHistory() });

    const input = body.input as Array<Record<string, unknown>>;
    expect(input.some((item) => item.type === 'function_call')).toBe(false);
    expect(input).toHaveLength(2);
  });

  it('accumulates Responses native function-call fragments', async () => {
    const { push, close } = installStreamFetch(fetchMock);
    const { openrouterStream } = await import('./openrouter-stream');
    const events = collect(openrouterStream(baseRequest));

    push(
      responseEvent({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'sandbox_write_file',
          arguments: '',
        },
      }),
    );
    push(
      responseEvent({
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"path":"foo.ts"',
      }),
    );
    push(
      responseEvent({
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: ',"content":"x"}',
      }),
    );
    push(
      responseEvent({
        type: 'response.function_call_arguments.done',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'sandbox_write_file',
          arguments: '{"path":"foo.ts","content":"x"}',
        },
      }),
    );
    push(completedFrame());
    close();

    expect(await events).toEqual([
      { type: 'tool_call_delta' },
      { type: 'tool_call_delta' },
      {
        type: 'native_tool_call',
        call: {
          id: 'call_1',
          name: 'sandbox_write_file',
          args: { path: 'foo.ts', content: 'x' },
        },
      },
      { type: 'done', finishReason: 'tool_calls', usage: undefined },
    ]);
  });

  it('drops Responses native tool calls whose name is not known', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { push, close } = installStreamFetch(fetchMock);
    const { openrouterStream } = await import('./openrouter-stream');
    const events = collect(openrouterStream(baseRequest));

    push(
      responseEvent({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'node_source',
          arguments: '{"x":1}',
        },
      }),
    );
    push(
      responseEvent({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'node_source',
          arguments: '{"x":1}',
        },
      }),
    );
    push(completedFrame());
    close();

    const out = await events;
    expect(out.filter((event) => event.type === 'native_tool_call')).toHaveLength(0);
    expect(out[out.length - 1]).toEqual({ type: 'done', finishReason: 'stop', usage: undefined });
    warnSpy.mockRestore();
  });

  it('composes with normalizeReasoning to split inline think tags out of content', async () => {
    const { push, close } = installStreamFetch(fetchMock);
    const { openrouterStream } = await import('./openrouter-stream');
    const { normalizeReasoning } = await import('@push/lib/reasoning-tokens');
    const events = collect(normalizeReasoning(openrouterStream(baseRequest)));

    push(textFrame('<think>pondering</think>answer'));
    push(completedFrame());
    close();

    const out = await events;
    expect(
      out
        .filter(
          (event): event is { type: 'reasoning_delta'; text: string } =>
            event.type === 'reasoning_delta',
        )
        .map((event) => event.text)
        .join(''),
    ).toBe('pondering');
    expect(
      out
        .filter(
          (event): event is { type: 'text_delta'; text: string } => event.type === 'text_delta',
        )
        .map((event) => event.text)
        .join(''),
    ).toBe('answer');
  });

  it('omits Authorization entirely when the client key is empty', async () => {
    vi.doMock('@/hooks/useOpenRouterConfig', () => ({
      getOpenRouterKey: () => '',
    }));
    installStreamFetch(fetchMock);
    const { openrouterStream } = await import('./openrouter-stream');
    const iter = openrouterStream(baseRequest);
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('keeps a legacy Chat Completions transport behind VITE_OPENROUTER_TRANSPORT=chat', async () => {
    vi.stubEnv('VITE_OPENROUTER_TRANSPORT', 'chat');
    const { push, close } = installStreamFetch(fetchMock);
    const { openrouterStream } = await import('./openrouter-stream');
    const events = collect(
      openrouterStream({
        ...baseRequest,
        maxTokens: 42,
        openrouterWebSearch: false,
      }),
    );

    push(chatContentFrame('legacy'));
    push(JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] }));
    close();

    expect(await events).toEqual([
      { type: 'text_delta', text: 'legacy' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.input).toBeUndefined();
    expect(body.max_tokens).toBe(42);
    expect(body.max_output_tokens).toBeUndefined();
  });
});
