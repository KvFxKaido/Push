import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushStreamEvent } from './provider-contract.js';
import {
  mapOpenAIResponsesUsage,
  OpenAIResponsesStreamError,
  openAIResponsesSSEPump,
} from './openai-responses-sse-pump.js';

interface Controllable {
  body: ReadableStream<Uint8Array>;
  push(event: Record<string, unknown>): void;
  pushRaw(raw: string): void;
  close(): void;
  abort(): void;
}

function makeStream(): Controllable {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    body,
    push(event) {
      if (closed) return;
      controller.enqueue(
        encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
      );
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

async function collect(stream: AsyncIterable<PushStreamEvent>): Promise<PushStreamEvent[]> {
  const out: PushStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('mapOpenAIResponsesUsage', () => {
  it('translates Responses usage fields to StreamUsage', () => {
    expect(
      mapOpenAIResponsesUsage({
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 7 },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 7 });
  });

  it('zero-fills missing fields', () => {
    expect(mapOpenAIResponsesUsage({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });
});

describe('openAIResponsesSSEPump', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('parses text deltas and usage from response.completed', async () => {
    const s = makeStream();
    const events = collect(openAIResponsesSSEPump({ body: s.body }));

    s.push({ type: 'response.created', response: { id: 'resp_1' } });
    s.push({ type: 'response.output_text.delta', delta: 'hello ' });
    s.push({ type: 'response.output_text.delta', delta: 'world' });
    s.push({
      type: 'response.completed',
      response: {
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    });
    s.close();

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

  it('parses OpenRouter documented content, reasoning, and terminal events', async () => {
    const s = makeStream();
    const events = collect(openAIResponsesSSEPump({ body: s.body }));

    s.push({ type: 'response.reasoning.delta', delta: 'thinking ' });
    s.push({ type: 'response.content_part.delta', delta: 'the answer' });
    s.push({
      type: 'response.done',
      response: {
        status: 'completed',
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      },
    });
    s.close();

    expect(await events).toEqual([
      { type: 'reasoning_delta', text: 'thinking ' },
      { type: 'text_delta', text: 'the answer' },
      {
        type: 'done',
        finishReason: 'stop',
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      },
    ]);
  });

  it('emits reasoning_delta for both the summary and reasoning_text families', async () => {
    // OpenAI streams `reasoning_summary_text.delta`; GLM / DeepSeek / Kimi stream
    // `reasoning_text.delta`. The pump must surface both, or reasoning (and, for
    // answer-in-reasoning models, the whole turn) is silently dropped.
    const s = makeStream();
    const events = collect(openAIResponsesSSEPump({ body: s.body }));

    s.push({ type: 'response.reasoning_summary_text.delta', delta: 'weighing options ' });
    s.push({ type: 'response.reasoning_text.delta', delta: 'still thinking ' });
    s.push({ type: 'response.output_text.delta', delta: 'the answer' });
    s.push({ type: 'response.completed', response: { status: 'completed' } });
    s.close();

    expect(await events).toEqual([
      { type: 'reasoning_delta', text: 'weighing options ' },
      { type: 'reasoning_delta', text: 'still thinking ' },
      { type: 'text_delta', text: 'the answer' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('surfaces url_citation annotations as citations events (native web search)', async () => {
    const s = makeStream();
    const events = collect(openAIResponsesSSEPump({ body: s.body }));

    s.push({ type: 'response.output_text.delta', delta: 'Per the latest docs, ' });
    s.push({
      type: 'response.output_text.annotation.added',
      annotation: {
        type: 'url_citation',
        url: 'https://example.com/article',
        title: 'The Article',
        start_index: 4,
        end_index: 20,
      },
    });
    s.push({ type: 'response.completed', response: { status: 'completed' } });
    s.close();

    expect(await events).toEqual([
      { type: 'text_delta', text: 'Per the latest docs, ' },
      {
        type: 'citations',
        citations: [
          {
            url: 'https://example.com/article',
            title: 'The Article',
            content: '',
            startIndex: 4,
            endIndex: 20,
          },
        ],
      },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('normalizes final response output annotations into citations', async () => {
    const s = makeStream();
    const events = collect(openAIResponsesSSEPump({ body: s.body }));

    s.push({
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'answer',
                annotations: [
                  {
                    type: 'url_citation',
                    url_citation: {
                      url: 'https://example.com/b',
                      title: 'Example B',
                      content: 'excerpt B',
                      start_index: 0,
                      end_index: 6,
                    },
                  },
                  { type: 'file_citation', file_id: 'file_1' },
                  { type: 'url_citation', url_citation: { title: 'no url' } },
                ],
              },
            ],
          },
        ],
      },
    });
    s.close();

    expect(await events).toEqual([
      {
        type: 'citations',
        citations: [
          {
            url: 'https://example.com/b',
            title: 'Example B',
            content: 'excerpt B',
            startIndex: 0,
            endIndex: 6,
          },
        ],
      },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('drops a malformed annotation without disturbing the text stream', async () => {
    const s = makeStream();
    const events = collect(openAIResponsesSSEPump({ body: s.body }));

    s.push({ type: 'response.output_text.delta', delta: 'hi' });
    // Missing url — not a usable citation.
    s.push({
      type: 'response.output_text.annotation.added',
      annotation: { type: 'url_citation', title: 'No URL' },
    });
    s.push({ type: 'response.completed', response: { status: 'completed' } });
    s.close();

    expect(await events).toEqual([
      { type: 'text_delta', text: 'hi' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('surfaces refusal deltas as text so a refused turn is not blank', async () => {
    const s = makeStream();
    const events = collect(openAIResponsesSSEPump({ body: s.body }));

    s.push({ type: 'response.refusal.delta', delta: "I can't help with that." });
    s.push({
      type: 'response.completed',
      response: {
        status: 'completed',
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      },
    });
    s.close();

    expect(await events).toEqual([
      { type: 'text_delta', text: "I can't help with that." },
      {
        type: 'done',
        finishReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
    ]);
  });

  it('throws a structured non-retryable 404 for nested response.failed errors', async () => {
    const s = makeStream();
    const events = collect(openAIResponsesSSEPump({ body: s.body }));

    s.push({
      type: 'response.failed',
      response: {
        status: 'failed',
        error: {
          code: 'NOT_FOUND',
          type: 'not_found_error',
          message: 'model not found',
        },
      },
    });
    s.close();

    await expect(events).rejects.toMatchObject({
      name: 'OpenAIResponsesStreamError',
      code: 'NOT_FOUND',
      status: 404,
      retryable: false,
      message: expect.stringContaining('NOT_FOUND: model not found'),
    });
    await expect(events).rejects.toBeInstanceOf(OpenAIResponsesStreamError);
  });

  it('marks in-band rate-limit errors retryable', async () => {
    const s = makeStream();
    const events = collect(openAIResponsesSSEPump({ body: s.body }));

    s.push({
      type: 'error',
      error: {
        code: 'rate_limit_exceeded',
        type: 'rate_limit_error',
        message: 'slow down',
      },
    });
    s.close();

    await expect(events).rejects.toMatchObject({
      code: 'rate_limit_exceeded',
      status: 429,
      retryable: true,
    });
  });

  it('maps in-band service unavailable errors to a retryable 503', async () => {
    const s = makeStream();
    const events = collect(openAIResponsesSSEPump({ body: s.body }));

    s.push({
      type: 'response.failed',
      response: {
        status: 'failed',
        error: {
          code: 'service_unavailable',
          type: 'service_unavailable',
          message: 'temporarily unavailable',
        },
      },
    });
    s.close();

    await expect(events).rejects.toMatchObject({
      name: 'OpenAIResponsesStreamError',
      code: 'service_unavailable',
      status: 503,
      retryable: true,
    });
  });

  it('fails open (retryable, no status) on an unclassifiable in-band error code', async () => {
    const s = makeStream();
    const events = collect(openAIResponsesSSEPump({ body: s.body }));

    s.push({
      type: 'response.failed',
      response: {
        status: 'failed',
        error: {
          code: 'provider_sideways',
          type: 'provider_sideways',
          message: 'temporarily sideways',
        },
      },
    });
    s.close();

    // No status maps from the code, so the error must stay retryable rather
    // than hard-failing the turn on a likely-transient blip.
    await expect(events).rejects.toMatchObject({
      name: 'OpenAIResponsesStreamError',
      code: 'provider_sideways',
      retryable: true,
    });
    await expect(events).rejects.toHaveProperty('status', undefined);
  });

  it('accumulates function call argument deltas into a native_tool_call', async () => {
    const s = makeStream();
    const events = collect(openAIResponsesSSEPump({ body: s.body }));

    s.push({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'sandbox_read_file',
        arguments: '',
      },
    });
    s.push({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path"' });
    s.push({ type: 'response.function_call_arguments.delta', output_index: 0, delta: ':"a.ts"}' });
    s.push({
      type: 'response.function_call_arguments.done',
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'sandbox_read_file',
        arguments: '{"path":"a.ts"}',
      },
    });
    s.push({
      type: 'response.completed',
      response: {
        status: 'completed',
        usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
      },
    });
    s.close();

    expect(await events).toEqual([
      { type: 'tool_call_delta' },
      { type: 'tool_call_delta' },
      {
        type: 'native_tool_call',
        call: { id: 'call_1', name: 'sandbox_read_file', args: { path: 'a.ts' } },
      },
      {
        type: 'done',
        finishReason: 'tool_calls',
        usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
      },
    ]);
  });

  it('flushes function calls from the final response output array', async () => {
    const s = makeStream();
    const events = collect(openAIResponsesSSEPump({ body: s.body }));

    s.push({
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'sandbox_read_file',
            arguments: '{"path":"late.ts"}',
          },
        ],
        usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
      },
    });
    s.close();

    expect(await events).toEqual([
      {
        type: 'native_tool_call',
        call: { id: 'call_1', name: 'sandbox_read_file', args: { path: 'late.ts' } },
      },
      {
        type: 'done',
        finishReason: 'tool_calls',
        usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
      },
    ]);
  });

  it('waits for completed output when argument completion has no function-call name', async () => {
    const s = makeStream();
    const events = collect(openAIResponsesSSEPump({ body: s.body }));

    s.push({
      type: 'response.function_call_arguments.done',
      output_index: 0,
      arguments: '{"path":"late.ts"}',
    });
    s.push({
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'sandbox_read_file',
            arguments: '{"path":"late.ts"}',
          },
        ],
      },
    });
    s.close();

    expect(await events).toEqual([
      {
        type: 'native_tool_call',
        call: { id: 'call_1', name: 'sandbox_read_file', args: { path: 'late.ts' } },
      },
      { type: 'done', finishReason: 'tool_calls', usage: undefined },
    ]);
  });

  it('maps response.incomplete max_output_tokens to length', async () => {
    const s = makeStream();
    const events = collect(openAIResponsesSSEPump({ body: s.body }));

    s.push({ type: 'response.output_text.delta', delta: 'partial' });
    s.push({
      type: 'response.incomplete',
      response: {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      },
    });
    s.close();

    expect(await events).toEqual([
      { type: 'text_delta', text: 'partial' },
      {
        type: 'done',
        finishReason: 'length',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    ]);
  });

  it('throws on error events', async () => {
    const s = makeStream();
    const events = collect(openAIResponsesSSEPump({ body: s.body }));
    s.push({
      type: 'error',
      error: { code: 'bad_request', message: 'Nope.' },
    });
    s.close();

    await expect(events).rejects.toThrow(/bad_request: Nope/);
  });

  it('honors an aborted signal — emits nothing and no terminal done', async () => {
    const s = makeStream();
    const ac = new AbortController();
    ac.abort();
    const events = collect(openAIResponsesSSEPump({ body: s.body, signal: ac.signal }));
    // Anything enqueued after abort must not surface, and the pump must not
    // synthesize a `done` (the round loop treats abort as cancellation, not
    // completion).
    s.push({ type: 'response.output_text.delta', delta: 'should not appear' });
    s.close();

    expect(await events).toEqual([]);
  });
});
