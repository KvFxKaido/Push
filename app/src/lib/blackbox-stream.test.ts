import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';

vi.mock('@/hooks/useBlackboxConfig', () => ({
  getBlackboxKey: () => 'test-key',
}));

vi.mock('./providers', () => ({
  PROVIDER_URLS: {
    blackbox: {
      chat: 'https://bb.example/api/blackbox/chat',
      models: 'https://bb.example/api/blackbox/models',
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
  return JSON.stringify({ choices: [{ delta: { reasoning: text } }] });
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
  provider: 'blackbox',
  model: 'blackboxai/anthropic/claude-sonnet-4.6',
  messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 } as unknown as ChatMessage],
};

describe('blackboxStream', () => {
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
    const { blackboxStream } = await import('./blackbox-stream');
    const events = collect(blackboxStream(baseRequest));

    push(contentFrame('hello '));
    push(contentFrame('world'));
    finish();

    expect(await events).toEqual([
      { type: 'text_delta', text: 'hello ' },
      { type: 'text_delta', text: 'world' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('forwards reasoning, finish_reason, and usage through the pump', async () => {
    const { push } = installStreamFetch(fetchMock);
    const { blackboxStream } = await import('./blackbox-stream');
    const events = collect(blackboxStream(baseRequest));

    push(reasoningFrame('thinking...'));
    push(contentFrame('answer'));
    push(finishFrame('stop', { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 }));

    expect(await events).toEqual([
      { type: 'reasoning_delta', text: 'thinking...' },
      { type: 'text_delta', text: 'answer' },
      {
        type: 'done',
        finishReason: 'stop',
        usage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 },
      },
    ]);
  });

  it('throws with a Blackbox-prefixed error on non-200 response', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { blackboxStream } = await import('./blackbox-stream');

    let caught: Error | null = null;
    try {
      await collect(blackboxStream(baseRequest));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/Blackbox AI/);
    expect(caught!.message).toMatch(/429/);
    expect(caught!.message).toMatch(/rate limited/);
  });

  it('hits PROVIDER_URLS.blackbox.chat with a Bearer token from getBlackboxKey', async () => {
    installStreamFetch(fetchMock);
    const { blackboxStream } = await import('./blackbox-stream');
    const iter = blackboxStream(baseRequest);
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://bb.example/api/blackbox/chat');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
  });

  it('forwards max_tokens / temperature / top_p into the request body', async () => {
    installStreamFetch(fetchMock);
    const { blackboxStream } = await import('./blackbox-stream');
    const iter = blackboxStream({
      ...baseRequest,
      maxTokens: 2048,
      temperature: 0.3,
      topP: 0.85,
    });
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    // Blackbox sends the model as-stored, including the `blackboxai/` prefix
    // (the prefix is normalized only for display grouping, not wire shape).
    expect(body.model).toBe('blackboxai/anthropic/claude-sonnet-4.6');
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(2048);
    expect(body.temperature).toBe(0.3);
    expect(body.top_p).toBe(0.85);
  });

  it('flushes native tool_calls through the pump using the injected predicate', async () => {
    const { push } = installStreamFetch(fetchMock);
    const { blackboxStream } = await import('./blackbox-stream');
    const events = collect(blackboxStream(baseRequest));

    push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: 'sandbox_write_file', arguments: '{"path":"a"}' } },
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
    expect(textEvents[0].text).toContain('sandbox_write_file');
  });

  it('does not send Zen / OpenRouter-only body fields', async () => {
    installStreamFetch(fetchMock);
    const { blackboxStream } = await import('./blackbox-stream');
    const iter = blackboxStream(baseRequest);
    iter[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('session_id');
    expect(body).not.toHaveProperty('trace');
  });
});
