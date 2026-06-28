import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushStreamEvent } from './provider-contract.js';
import {
  mapOpenAIFinishReason,
  mapOpenAIUsage,
  openAISSEPump,
  stripTemplateTokens,
} from './openai-sse-pump.js';

// ---------------------------------------------------------------------------
// Test harness — controllable ReadableStream that simulates the SSE wire
// ---------------------------------------------------------------------------

interface Controllable {
  body: ReadableStream<Uint8Array>;
  push(frame: string): void;
  pushRaw(raw: string): void;
  finish(): void;
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

async function collect(stream: AsyncIterable<PushStreamEvent>): Promise<PushStreamEvent[]> {
  const out: PushStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
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

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('mapOpenAIFinishReason', () => {
  it('maps stop / end_turn to "stop"', () => {
    expect(mapOpenAIFinishReason('stop')).toBe('stop');
    expect(mapOpenAIFinishReason('end_turn')).toBe('stop');
  });

  it('maps length to "length"', () => {
    expect(mapOpenAIFinishReason('length')).toBe('length');
  });

  it('maps tool_calls / function_call to "tool_calls"', () => {
    expect(mapOpenAIFinishReason('tool_calls')).toBe('tool_calls');
    expect(mapOpenAIFinishReason('function_call')).toBe('tool_calls');
  });

  it('maps unknown / null / undefined to "unknown"', () => {
    expect(mapOpenAIFinishReason('content_filter')).toBe('unknown');
    expect(mapOpenAIFinishReason(null)).toBe('unknown');
    expect(mapOpenAIFinishReason(undefined)).toBe('unknown');
  });
});

describe('mapOpenAIUsage', () => {
  it('translates OpenAI usage fields to StreamUsage', () => {
    expect(mapOpenAIUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it('zero-fills missing fields', () => {
    expect(mapOpenAIUsage({})).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it('captures OpenAI-shaped cache-read tokens (prompt_tokens_details.cached_tokens)', () => {
    expect(
      mapOpenAIUsage({
        prompt_tokens: 5952,
        completion_tokens: 1,
        total_tokens: 5953,
        prompt_tokens_details: { cached_tokens: 5951 },
      }),
    ).toEqual({ inputTokens: 5952, outputTokens: 1, totalTokens: 5953, cachedInputTokens: 5951 });
  });

  it('captures DeepSeek-shaped cache-read tokens (prompt_cache_hit_tokens)', () => {
    expect(
      mapOpenAIUsage({
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_cache_hit_tokens: 64,
      }),
    ).toEqual({ inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 64 });
  });

  it('preserves a reported cold cache (0) so it stays distinct from no-cache-support', () => {
    expect(
      mapOpenAIUsage({
        prompt_tokens: 5,
        completion_tokens: 1,
        total_tokens: 6,
        prompt_tokens_details: { cached_tokens: 0 },
      }),
    ).toEqual({ inputTokens: 5, outputTokens: 1, totalTokens: 6, cachedInputTokens: 0 });
  });

  it('omits cachedInputTokens entirely when the provider reports no cache field', () => {
    const usage = mapOpenAIUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect('cachedInputTokens' in usage).toBe(false);
  });
});

describe('stripTemplateTokens', () => {
  it('strips chat-template control tokens like <|im_end|>', () => {
    expect(stripTemplateTokens('<|start|>hello<|im_end|>')).toBe('hello');
  });

  it('leaves regular text untouched', () => {
    expect(stripTemplateTokens('plain answer')).toBe('plain answer');
  });
});

// ---------------------------------------------------------------------------
// Pump
// ---------------------------------------------------------------------------

describe('openAISSEPump', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('parses text_delta frames and closes on [DONE]', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));

    s.push(contentFrame('hello '));
    s.push(contentFrame('world'));
    s.finish();

    expect(await events).toEqual([
      { type: 'text_delta', text: 'hello ' },
      { type: 'text_delta', text: 'world' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('reassembles a frame split across multiple ReadableStream chunks', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));

    // Split the SSE wire mid-frame — pump must buffer until the trailing \n.
    s.pushRaw('data: {"choices":[{"delta":{"con');
    s.pushRaw('tent":"hello"}}]}\n');
    s.pushRaw('\ndata: ');
    s.pushRaw(contentFrame('world'));
    s.pushRaw('\n\n');
    s.finish();

    const out = await events;
    const text = out
      .filter((e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('helloworld');
    expect(out[out.length - 1].type).toBe('done');
  });

  it('handles multiple data: lines packed into a single chunk', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));

    s.pushRaw(
      `data: ${contentFrame('a')}\n\ndata: ${contentFrame('b')}\n\ndata: ${contentFrame('c')}\n\n`,
    );
    s.finish();

    const out = await events;
    const text = out
      .filter((e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('abc');
  });

  it('accepts both data: [DONE] spacings', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));

    s.push(contentFrame('hi'));
    // No leading space after the colon — some upstreams ship it tight.
    s.pushRaw('data:[DONE]\n\n');

    expect(await events).toEqual([
      { type: 'text_delta', text: 'hi' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('accepts delta.reasoning (modern field name)', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));

    s.push(reasoningFrame('thinking...', 'reasoning'));
    s.push(contentFrame('answer'));
    s.finish();

    expect(await events).toEqual([
      { type: 'reasoning_delta', text: 'thinking...' },
      { type: 'text_delta', text: 'answer' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('accepts delta.reasoning_content (legacy field name)', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));

    s.push(reasoningFrame('thinking...', 'reasoning_content'));
    s.push(contentFrame('answer'));
    s.finish();

    expect(await events).toEqual([
      { type: 'reasoning_delta', text: 'thinking...' },
      { type: 'text_delta', text: 'answer' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('prefers delta.reasoning when both fields are present', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));

    s.push(
      JSON.stringify({
        choices: [{ delta: { reasoning: 'modern', reasoning_content: 'legacy' } }],
      }),
    );
    s.finish();

    const out = await events;
    expect(out[0]).toEqual({ type: 'reasoning_delta', text: 'modern' });
  });

  it('maps finish_reason onto the done event', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));

    s.push(contentFrame('partial...'));
    s.push(finishFrame('length'));
    s.finish();

    expect(await events).toEqual([
      { type: 'text_delta', text: 'partial...' },
      { type: 'done', finishReason: 'length', usage: undefined },
    ]);
  });

  it('falls back to done (not pause_turn) when finish_reason=pause_turn arrives without blocks', async () => {
    // Defense against an upstream that emits pause_turn with no replay
    // payload (or a non-Anthropic provider that happens to use the same
    // string): the consumer's continuation loop would issue a request with
    // an empty assistant turn and spin until the iteration cap. Synthesize
    // a clean terminal event instead.
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));

    s.push(contentFrame('partial answer'));
    s.push(
      JSON.stringify({
        choices: [{ finish_reason: 'pause_turn', delta: {} }],
      }),
    );
    s.finish();

    const out = await events;
    expect(out.some((e) => e.type === 'pause_turn')).toBe(false);
    expect(out.some((e) => e.type === 'done')).toBe(true);
  });

  it('also falls back to done when assistant_content_blocks is an empty array', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));

    s.push(
      JSON.stringify({
        choices: [{ finish_reason: 'pause_turn', delta: { assistant_content_blocks: [] } }],
      }),
    );
    s.finish();

    const out = await events;
    expect(out.some((e) => e.type === 'pause_turn')).toBe(false);
    expect(out.some((e) => e.type === 'done')).toBe(true);
  });

  it('emits a pause_turn event (not done) when finish_reason is pause_turn', async () => {
    // The Anthropic bridge surfaces `pause_turn` with the captured
    // assistant content[] as a sidecar so the stream adapter can replay
    // them in a continuation request. The pump must not synthesize a
    // terminal `done` event for this case — the turn is still in
    // progress from the consumer's perspective.
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));

    s.push(contentFrame('Looking up the answer.'));
    s.push(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'pause_turn',
            delta: {
              assistant_content_blocks: [
                { type: 'text', text: 'Looking up the answer.' },
                { type: 'server_tool_use', id: 'su_01', name: 'web_search', input: {} },
              ],
            },
          },
        ],
      }),
    );
    s.finish();

    const out = await events;
    const pause = out.find((e) => e.type === 'pause_turn');
    expect(pause).toBeDefined();
    if (pause && pause.type === 'pause_turn') {
      expect(pause.assistantBlocks).toHaveLength(2);
      expect(pause.assistantBlocks[1]).toMatchObject({ type: 'server_tool_use', id: 'su_01' });
    }
    // No `done` should fire — the consumer is expected to drive the
    // continuation via a new request, not treat pause_turn as terminal.
    expect(out.some((e) => e.type === 'done')).toBe(false);
  });

  it('maps usage onto the done event', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));

    s.push(contentFrame('hi'));
    s.push(finishFrame('stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }));

    const out = await events;
    expect(out[out.length - 1]).toEqual({
      type: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });

  it('picks up usage from an intermediate frame before finish_reason', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));

    s.push(
      JSON.stringify({
        choices: [{ delta: { content: 'ok' } }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      }),
    );
    s.push(finishFrame('stop'));

    const out = await events;
    expect(out[out.length - 1]).toEqual({
      type: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
    });
  });

  it('strips chat-template control tokens from delta.content', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));

    s.push(contentFrame('<|start|>hello<|im_end|>'));
    s.finish();

    const out = await events;
    expect(out[0]).toEqual({ type: 'text_delta', text: 'hello' });
  });

  it('skips a content frame whose stripped text is empty', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));

    s.push(contentFrame('<|im_end|>'));
    s.finish();

    const out = await events;
    expect(out.filter((e) => e.type === 'text_delta')).toHaveLength(0);
  });

  it('skips malformed JSON frames without aborting the stream', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));

    s.pushRaw('data: {not json}\n\n');
    s.pushRaw(': keepalive comment line\n\n');
    s.push(contentFrame('survived'));
    s.finish();

    expect(await events).toEqual([
      { type: 'text_delta', text: 'survived' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('closes cleanly when the stream ends without [DONE] or finish_reason', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));

    s.push(contentFrame('partial'));
    s.close();

    expect(await events).toEqual([
      { type: 'text_delta', text: 'partial' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  it('cancels the upstream reader when the abort signal fires', async () => {
    const s = makeStream();
    const controller = new AbortController();

    const out: PushStreamEvent[] = [];
    const task = (async () => {
      try {
        for await (const e of openAISSEPump({ body: s.body, signal: controller.signal })) {
          out.push(e);
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') throw err;
      }
    })();

    s.push(contentFrame('hi'));
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    s.abort();
    await task;

    expect(out[0]).toEqual({ type: 'text_delta', text: 'hi' });
  });

  it('releases the reader lock so callers can re-acquire after settlement', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));

    s.push(contentFrame('hi'));
    s.finish();
    await events;

    // After the pump finishes, releaseLock has been called — getReader()
    // must not throw "ReadableStream is locked."
    expect(() => s.body.getReader()).not.toThrow();
  });

  it('returns without emitting a final done when abort races a clean close', async () => {
    // Abort race: the abort listener calls reader.cancel(), which resolves
    // the pending read with { done: true }. The pre-fix pump would then
    // fall through to the post-loop tail and yield a spurious
    // { type: 'done', finishReason: 'stop' } even though the consumer asked
    // to abort. Verify the recheck after `reader.read()` short-circuits.
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const ac = new AbortController();

    const out: PushStreamEvent[] = [];
    const task = (async () => {
      for await (const e of openAISSEPump({ body, signal: ac.signal })) {
        out.push(e);
      }
    })();

    controller.enqueue(encoder.encode(`data: ${contentFrame('hi')}\n\n`));
    await new Promise((r) => setTimeout(r, 0));
    // Fire the abort (cancels the reader, which resolves read() cleanly with
    // done: true). No `controller.error` — this is the clean-close race.
    ac.abort();
    await task;

    // The 'hi' fragment was delivered before the abort. No spurious 'done'
    // should follow once the signal is aborted.
    expect(out).toEqual([{ type: 'text_delta', text: 'hi' }]);
  });

  it('flushes the decoder so a final char split across chunks is preserved', async () => {
    // "✓" (U+2713) encodes as three UTF-8 bytes (0xE2 0x9C 0x93). Split it
    // across two chunks so the first decode(stream:true) call returns a
    // partial replacement; the post-loop decoder.decode() flush must
    // reassemble the trailing two bytes into the real char.
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });

    const events = collect(openAISSEPump({ body }));

    const frame = contentFrame('done ✓');
    const bytes = encoder.encode(`data: ${frame}\n\n`);
    // Split inside the multi-byte ✓ sequence (the byte BEFORE 0x93 trail
    // sits a couple of bytes inside the JSON string). Cut one byte off
    // the end so the trailing byte is delivered separately.
    controller.enqueue(bytes.slice(0, bytes.length - 1));
    controller.enqueue(bytes.slice(bytes.length - 1));
    controller.close();

    const out = await events;
    const text = out
      .filter((e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('done ✓');
  });

  it('parses a trailing complete frame that arrived without a closing newline', async () => {
    // Some upstreams ship the last data: line without a final \n\n. The
    // pump's line-split keeps that line in `buffer`; after the reader
    // closes, the post-loop block must run it through the parser before
    // emitting the clean close.
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });

    const events = collect(openAISSEPump({ body }));

    controller.enqueue(encoder.encode(`data: ${contentFrame('first')}\n`));
    // No trailing newline on the second frame.
    controller.enqueue(encoder.encode(`data: ${contentFrame('last')}`));
    controller.close();

    const out = await events;
    const text = out
      .filter((e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('firstlast');
  });

  it('handles a trailing frame that itself carries the [DONE] sentinel', async () => {
    // Trailing-buffer parse path: if the last bytes from the upstream are
    // `data: [DONE]` with no closing newline, the pump should still treat
    // it as the explicit close and not emit a second clean-close `done`.
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });

    const events = collect(openAISSEPump({ body }));

    controller.enqueue(encoder.encode(`data: ${contentFrame('hi')}\n\n`));
    controller.enqueue(encoder.encode('data: [DONE]'));
    controller.close();

    const out = await events;
    expect(out.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(out).toEqual([
      { type: 'text_delta', text: 'hi' },
      { type: 'done', finishReason: 'stop', usage: undefined },
    ]);
  });

  // -------------------------------------------------------------------------
  // Native delta.tool_calls accumulation
  // -------------------------------------------------------------------------

  it('accumulates native tool_call fragments and flushes them as native_tool_call on finish', async () => {
    const s = makeStream();
    const events = collect(
      openAISSEPump({
        body: s.body,
        isKnownToolName: (n) => n === 'sandbox_write_file',
      }),
    );

    s.push(
      JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: 'sandbox_write_file' } }] } },
        ],
      }),
    );
    s.push(
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
    s.push(
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
    s.push(finishFrame('tool_calls'));

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

  it('captures the Gemini thoughtSignature from each compat wire shape (sibling / extra_content / function-nested)', async () => {
    // The capture peer of the serializer's emit. A Gemini-fronting compat
    // upstream carries the signature in one of three shapes; the pump must lift
    // whichever onto the neutral call so the REAL signature (not the placeholder)
    // round-trips. Ollama Cloud uses the nested `function.thought_signature` shape
    // (ref ollama/ollama#14676) — the one prior fixes never read.
    const shapes: Array<[string, Record<string, unknown>]> = [
      ['top-level sibling', { thoughtSignature: 'sig-1' }],
      ['extra_content envelope', { extra_content: { google: { thought_signature: 'sig-1' } } }],
      ['function-nested (Ollama)', { function: { thought_signature: 'sig-1' } }],
    ];
    for (const [, extra] of shapes) {
      const s = makeStream();
      const events = collect(openAISSEPump({ body: s.body, isKnownToolName: () => true }));
      const fnBase = (extra.function as Record<string, unknown>) ?? {};
      s.push(
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    ...extra,
                    function: { name: 'sandbox_read_file', arguments: '{"path":"a"}', ...fnBase },
                  },
                ],
              },
            },
          ],
        }),
      );
      s.push(finishFrame('tool_calls'));
      const out = await events;
      const call = out.find(
        (e): e is { type: 'native_tool_call'; call: { thoughtSignature?: string } } =>
          e.type === 'native_tool_call',
      )?.call;
      expect(call?.thoughtSignature).toBe('sig-1');
    }
  });

  it('yields a tool_call_delta per fragment so the adapter sees progress while buffering', async () => {
    const s = makeStream();
    const events = collect(
      openAISSEPump({
        body: s.body,
        isKnownToolName: () => true,
      }),
    );

    s.push(
      JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: 'sandbox_write_file' } }] } },
        ],
      }),
    );
    s.push(
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
    s.push(
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
    s.push(finishFrame('tool_calls'));

    const out = await events;
    expect(out.filter((e) => e.type === 'tool_call_delta')).toHaveLength(3);
    expect(out.map((e) => e.type)).toEqual([
      'tool_call_delta',
      'tool_call_delta',
      'tool_call_delta',
      'native_tool_call',
      'done',
    ]);
  });

  it('drops native tool_calls whose name is rejected by the predicate', async () => {
    const s = makeStream();
    const events = collect(
      openAISSEPump({
        body: s.body,
        // Pretend nothing is known — every accumulated call should be dropped.
        isKnownToolName: () => false,
      }),
    );

    s.push(
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
    s.push(finishFrame('tool_calls'));

    const out = await events;
    expect(out.filter((e) => e.type === 'native_tool_call')).toHaveLength(0);
    expect(out[out.length - 1]).toEqual({
      type: 'done',
      finishReason: 'tool_calls',
      usage: undefined,
    });
  });

  it('flushes every accumulated call when no predicate is supplied', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));

    s.push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: 'arbitrary_tool', arguments: '{"x":1}' } },
              ],
            },
          },
        ],
      }),
    );
    s.push(finishFrame('tool_calls'));

    const out = await events;
    const toolEvents = out.filter(
      (e): e is { type: 'native_tool_call'; call: { name: string; args: unknown } } =>
        e.type === 'native_tool_call',
    );
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].call).toEqual({ name: 'arbitrary_tool', args: { x: 1 } });
  });

  it('flushes pending native tool_calls on [DONE] without a prior finish_reason frame', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body, isKnownToolName: () => true }));

    s.push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: 'sandbox_read_file', arguments: '{"path":"a"}' } },
              ],
            },
          },
        ],
      }),
    );
    s.finish();

    const out = await events;
    const toolEvents = out.filter(
      (e): e is { type: 'native_tool_call'; call: { name: string; args: unknown } } =>
        e.type === 'native_tool_call',
    );
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].call).toEqual({ name: 'sandbox_read_file', args: { path: 'a' } });
  });

  it('flushes pending tool_calls on clean stream close (no [DONE] / no finish_reason)', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body, isKnownToolName: () => true }));

    s.push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: 'sandbox_read_file', arguments: '{"p":"a"}' } },
              ],
            },
          },
        ],
      }),
    );
    s.close();

    const out = await events;
    const toolEvents = out.filter(
      (e): e is { type: 'native_tool_call'; call: { name: string; args: unknown } } =>
        e.type === 'native_tool_call',
    );
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].call).toEqual({ name: 'sandbox_read_file', args: { p: 'a' } });
  });

  it('emits a native tool call with empty args when tool_call arguments are malformed JSON', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body, isKnownToolName: () => true }));

    s.push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: 'sandbox_write_file', arguments: '{broken json' } },
              ],
            },
          },
        ],
      }),
    );
    s.push(finishFrame('tool_calls'));

    const out = await events;
    const toolEvents = out.filter(
      (e): e is { type: 'native_tool_call'; call: { name: string; args: unknown } } =>
        e.type === 'native_tool_call',
    );
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].call).toEqual({ name: 'sandbox_write_file', args: {} });
  });

  it('warns and drops a native tool_call that arrived with no function name', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body, isKnownToolName: () => true }));

    s.push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }],
            },
          },
        ],
      }),
    );
    s.push(finishFrame('tool_calls'));

    const out = await events;
    expect(out.filter((e) => e.type === 'native_tool_call')).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no function name'),
      expect.any(String),
    );
  });

  it('keeps tool_calls indexed by `index` so two parallel calls flush separately', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body, isKnownToolName: () => true }));

    // Two interleaved tool calls with different indexes.
    s.push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: 'tool_a', arguments: '{"a":1' } },
                { index: 1, function: { name: 'tool_b', arguments: '{"b":' } },
              ],
            },
          },
        ],
      }),
    );
    s.push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '}' } },
                { index: 1, function: { arguments: '2}' } },
              ],
            },
          },
        ],
      }),
    );
    s.push(finishFrame('tool_calls'));

    const out = await events;
    const toolEvents = out.filter(
      (e): e is { type: 'native_tool_call'; call: { name: string; args: unknown } } =>
        e.type === 'native_tool_call',
    );
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents.map((e) => e.call)).toEqual([
      { name: 'tool_a', args: { a: 1 } },
      { name: 'tool_b', args: { b: 2 } },
    ]);
  });

  it('parses delta.reasoning_block into a structured reasoning_block event', async () => {
    // The Anthropic bridge translator emits one structured
    // `delta.reasoning_block` per `content_block_stop`. The pump must
    // surface it as a typed `reasoning_block` event without conflating
    // with the `reasoning_delta` text channel — they're independent
    // (text drives display, structured carries the signature).
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));
    s.push(
      JSON.stringify({
        choices: [
          {
            delta: {
              reasoning_block: {
                type: 'thinking',
                text: 'thinking out loud',
                signature: 'sig-A',
              },
            },
          },
        ],
      }),
    );
    s.push(contentFrame('answer'));
    s.finish();

    const out = await events;
    const blocks = out.filter(
      (e): e is { type: 'reasoning_block'; block: { type: string } } =>
        e.type === 'reasoning_block',
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].block).toEqual({
      type: 'thinking',
      text: 'thinking out loud',
      signature: 'sig-A',
    });

    const reasoningDeltas = out.filter((e) => e.type === 'reasoning_delta');
    expect(reasoningDeltas).toHaveLength(0);
  });

  it('drops malformed reasoning_block payloads without killing the stream', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));
    // Missing signature on a thinking block — soft-drop.
    s.push(
      JSON.stringify({
        choices: [{ delta: { reasoning_block: { type: 'thinking', text: 'orphan' } } }],
      }),
    );
    // Unknown block type — soft-drop.
    s.push(
      JSON.stringify({
        choices: [{ delta: { reasoning_block: { type: 'mystery', payload: '?' } } }],
      }),
    );
    s.push(contentFrame('still works'));
    s.finish();

    const out = await events;
    expect(out.filter((e) => e.type === 'reasoning_block')).toHaveLength(0);
    expect(out.some((e) => e.type === 'text_delta' && e.text === 'still works')).toBe(true);
    expect(out.some((e) => e.type === 'done')).toBe(true);
  });

  it('normalizes delta.annotations url_citations into a citations event', async () => {
    // OpenRouter's `openrouter:web_search` returns web sources as
    // `delta.annotations[].url_citation`. The pump must flatten the wire
    // shape (snake_case offsets, nested object) into the normalized
    // `UrlCitation` shape on a `citations` event, additive to text.
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));
    s.push(
      JSON.stringify({
        choices: [
          {
            delta: {
              annotations: [
                {
                  type: 'url_citation',
                  url_citation: {
                    url: 'https://example.com/a',
                    title: 'Example A',
                    content: 'excerpt A',
                    start_index: 5,
                    end_index: 12,
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    s.push(contentFrame('grounded answer'));
    s.finish();

    const out = await events;
    const citationEvents = out.filter(
      (e): e is { type: 'citations'; citations: import('./provider-contract.js').UrlCitation[] } =>
        e.type === 'citations',
    );
    expect(citationEvents).toHaveLength(1);
    expect(citationEvents[0].citations).toEqual([
      {
        url: 'https://example.com/a',
        title: 'Example A',
        content: 'excerpt A',
        startIndex: 5,
        endIndex: 12,
      },
    ]);
    // Answer text still streams independently of the citations event.
    expect(out.some((e) => e.type === 'text_delta' && e.text === 'grounded answer')).toBe(true);
  });

  it('zero-fills missing offsets and drops non-url_citation / urlless entries', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));
    s.push(
      JSON.stringify({
        choices: [
          {
            delta: {
              annotations: [
                // Kept — offsets/title/content default cleanly.
                { type: 'url_citation', url_citation: { url: 'https://ok.test' } },
                // Dropped — not a url_citation.
                { type: 'file_citation', file_citation: { file_id: 'x' } },
                // Dropped — no url.
                { type: 'url_citation', url_citation: { title: 'no url' } },
              ],
            },
          },
        ],
      }),
    );
    s.finish();

    const out = await events;
    const citationEvents = out.filter(
      (e): e is { type: 'citations'; citations: import('./provider-contract.js').UrlCitation[] } =>
        e.type === 'citations',
    );
    expect(citationEvents).toHaveLength(1);
    expect(citationEvents[0].citations).toEqual([
      { url: 'https://ok.test', title: '', content: '', startIndex: 0, endIndex: 0 },
    ]);
  });

  it('emits no citations event when annotations is empty or absent', async () => {
    const s = makeStream();
    const events = collect(openAISSEPump({ body: s.body }));
    s.push(JSON.stringify({ choices: [{ delta: { annotations: [] } }] }));
    s.push(contentFrame('hi'));
    s.finish();

    const out = await events;
    expect(out.some((e) => e.type === 'citations')).toBe(false);
  });
});
