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

  it('accumulates native tool_call fragments and flushes them as fenced JSON on finish', async () => {
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
    const textEvents = out.filter(
      (e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta',
    );
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].text).toContain('sandbox_write_file');
    expect(textEvents[0].text).toContain('"path":"foo.ts"');
    expect(textEvents[0].text).toContain('"content":"x"');
    expect(textEvents[0].text).toMatch(/```json/);
    expect(out[out.length - 1]).toEqual({
      type: 'done',
      finishReason: 'tool_calls',
      usage: undefined,
    });
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
      'text_delta',
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
    expect(out.filter((e) => e.type === 'text_delta')).toHaveLength(0);
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
    const textEvents = out.filter(
      (e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta',
    );
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].text).toContain('arbitrary_tool');
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
    const textEvents = out.filter(
      (e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta',
    );
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].text).toContain('sandbox_read_file');
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
    const textEvents = out.filter(
      (e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta',
    );
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].text).toContain('sandbox_read_file');
  });

  it('emits a fenced shell with empty args when tool_call arguments are malformed JSON', async () => {
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
    const textEvents = out.filter(
      (e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta',
    );
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].text).toContain('sandbox_write_file');
    expect(textEvents[0].text).toMatch(/"args":\s*\{\s*\}/);
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
    expect(out.filter((e) => e.type === 'text_delta')).toHaveLength(0);
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
    const textEvents = out.filter(
      (e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta',
    );
    expect(textEvents).toHaveLength(2);
    const joined = textEvents.map((e) => e.text).join('|');
    expect(joined).toContain('tool_a');
    expect(joined).toContain('"a":1');
    expect(joined).toContain('tool_b');
    expect(joined).toContain('"b":2');
  });
});
