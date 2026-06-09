import { describe, expect, it } from 'vitest';

import type { OpenAIChatRequest } from './openai-chat-types.ts';
import {
  anthropicModelRejectsSamplingParams,
  buildAnthropicMessagesRequest,
  createAnthropicTranslatedStream,
} from './openai-anthropic-bridge.ts';

function createEventStreamResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(lines.join('\n')));
        controller.close();
      },
    }),
  );
}

describe('anthropicModelRejectsSamplingParams', () => {
  it('rejects sampling params on Opus 4.7 and later (incl. suffix/tag variants)', () => {
    for (const model of [
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-4-8[1m]',
      'claude-opus-4-7-20260101',
      'claude-opus-4.8',
      'claude-opus-4-7@20260101',
      'claude-opus-5-0',
      'CLAUDE-OPUS-4-8',
    ]) {
      expect(anthropicModelRejectsSamplingParams(model), model).toBe(true);
    }
  });

  it('keeps sampling params on Opus 4.6 and earlier, Sonnet/Haiku, and non-Anthropic models', () => {
    for (const model of [
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-opus-4-1',
      'claude-opus-4-0',
      'claude-opus-4-20250514', // dated Opus 4.0 — the date must not read as minor 20250514
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
      'minimax-m2.5',
      'gpt-5.4',
      '',
    ]) {
      expect(anthropicModelRejectsSamplingParams(model), model).toBe(false);
    }
    expect(anthropicModelRejectsSamplingParams(undefined)).toBe(false);
    expect(anthropicModelRejectsSamplingParams(null)).toBe(false);
  });
});

describe('buildAnthropicMessagesRequest', () => {
  it('strips temperature/top_p for Opus 4.7+ but forwards them for accepting models', () => {
    const base = {
      messages: [{ role: 'user' as const, content: 'Hello' }],
      stream: true,
      temperature: 0.1,
      top_p: 0.9,
    };

    const opus48 = buildAnthropicMessagesRequest({ ...base, model: 'claude-opus-4-8' });
    expect(opus48).not.toHaveProperty('temperature');
    expect(opus48).not.toHaveProperty('top_p');

    const sonnet = buildAnthropicMessagesRequest({ ...base, model: 'claude-sonnet-4-6' });
    expect(sonnet).toMatchObject({ temperature: 0.1, top_p: 0.9 });
  });

  it('maps OpenAI-style messages into Anthropic messages with a shared system block', () => {
    const request: OpenAIChatRequest = {
      model: 'minimax-m2.5',
      messages: [
        { role: 'system', content: 'System guardrail' },
        { role: 'developer', content: [{ type: 'text', text: 'Developer instruction' }] },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ],
      max_completion_tokens: 321,
      stream: true,
      temperature: 0.4,
      top_p: 0.8,
    };

    expect(buildAnthropicMessagesRequest(request)).toEqual({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      ],
      max_tokens: 321,
      stream: true,
      system: 'System guardrail\n\nDeveloper instruction',
      temperature: 0.4,
      top_p: 0.8,
    });
  });

  it('adds an anthropic_version body field only when requested', () => {
    const request: OpenAIChatRequest = {
      model: 'claude',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    };

    expect(
      buildAnthropicMessagesRequest(request, { anthropicVersion: 'vertex-2023-10-16' }),
    ).toMatchObject({
      anthropic_version: 'vertex-2023-10-16',
    });
  });

  it('prepends signed reasoning blocks before text on assistant turns', () => {
    // Anthropic 400s the next request when extended thinking + tool use
    // are combined and the prior assistant turn's signed thinking blocks
    // are missing or out of order. Reasoning blocks MUST appear before
    // text/tool_use in the assistant content[].
    const request: OpenAIChatRequest = {
      model: 'claude-opus-4-7',
      messages: [
        { role: 'user', content: 'Why is the sky blue?' },
        {
          role: 'assistant',
          content: 'It is Rayleigh scattering.',
          reasoning_blocks: [
            { type: 'thinking', text: 'Need to recall optics.', signature: 'sig-abc' },
            { type: 'redacted_thinking', data: 'enc-xyz' },
          ],
        },
        { role: 'user', content: 'Explain like I am five.' },
      ],
      stream: true,
    };

    const body = buildAnthropicMessagesRequest(request) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    expect(body.messages[1].role).toBe('assistant');
    expect(body.messages[1].content).toEqual([
      { type: 'thinking', thinking: 'Need to recall optics.', signature: 'sig-abc' },
      { type: 'redacted_thinking', data: 'enc-xyz' },
      { type: 'text', text: 'It is Rayleigh scattering.' },
    ]);
  });

  it('preserves signed reasoning blocks when the assistant content is multimodal parts', () => {
    const request: OpenAIChatRequest = {
      model: 'claude-opus-4-7',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Here.' }],
          reasoning_blocks: [{ type: 'thinking', text: 'short', signature: 's' }],
        },
      ],
      stream: true,
    };

    const body = buildAnthropicMessagesRequest(request) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(body.messages[0].content[0]).toMatchObject({ type: 'thinking' });
    expect(body.messages[0].content[1]).toMatchObject({ type: 'text', text: 'Here.' });
  });

  it('adds the native web_search tool when anthropic_web_search is true', () => {
    const body = buildAnthropicMessagesRequest({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'Latest TC39 stage-4 proposals?' }],
      stream: true,
      anthropic_web_search: true,
    });
    expect(body).toMatchObject({
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    });
  });

  it('omits the tools field when anthropic_web_search is unset', () => {
    const body = buildAnthropicMessagesRequest({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });
    expect(body).not.toHaveProperty('tools');
  });

  it('uses assistant_content_blocks verbatim on the upstream content when present', () => {
    // Pause-turn replay: the prior assistant turn carries an opaque
    // content[] array that Anthropic recognized as continuation context.
    // The bridge must NOT reconstruct the content from text + reasoning
    // — Anthropic relies on the original block ordering (including
    // server_tool_use / web_search_tool_result blocks) to resume.
    const capturedBlocks = [
      { type: 'text', text: 'I will search for that.' },
      {
        type: 'server_tool_use',
        id: 'su_01',
        name: 'web_search',
        input: { query: 'tc39 stage 4' },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'su_01',
        content: [{ type: 'web_search_result', url: 'https://example.com', title: 'TC39' }],
      },
    ];
    const request: OpenAIChatRequest = {
      model: 'claude-opus-4-7',
      messages: [
        { role: 'user', content: 'What are the latest TC39 stage 4 proposals?' },
        {
          role: 'assistant',
          assistant_content_blocks: capturedBlocks,
          // Reasoning + text content should be IGNORED when the sidecar
          // is set — they were already inside the captured blocks.
          content: 'placeholder text the bridge must drop',
          reasoning_blocks: [{ type: 'thinking', text: 'ignored', signature: 'sig' }],
        },
      ],
      stream: true,
    };

    const body = buildAnthropicMessagesRequest(request) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.messages[1].role).toBe('assistant');
    expect(body.messages[1].content).toEqual(capturedBlocks);
  });

  it('preserves cache_control on text and image content parts', () => {
    // Prompt caching is the LEDE for going direct-Anthropic vs OpenRouter,
    // so a regression here would silently kill cache hit rate on every turn.
    // The bridge previously stripped the field — that's now fixed and pinned.
    const request = {
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'user' as const,
          content: [
            {
              type: 'text' as const,
              text: 'system prefix',
              cache_control: { type: 'ephemeral' as const },
            },
            { type: 'text' as const, text: 'unsafe to cache' },
            {
              type: 'image_url' as const,
              image_url: { url: 'data:image/png;base64,AAAA' },
              cache_control: { type: 'ephemeral' as const },
            },
          ],
        },
      ],
      stream: true,
    };

    const body = buildAnthropicMessagesRequest(request) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const parts = body.messages[0].content;
    expect(parts[0]).toMatchObject({
      type: 'text',
      text: 'system prefix',
      cache_control: { type: 'ephemeral' },
    });
    expect(parts[1]).toMatchObject({ type: 'text', text: 'unsafe to cache' });
    expect(parts[1]).not.toHaveProperty('cache_control');
    expect(parts[2]).toMatchObject({
      type: 'image',
      cache_control: { type: 'ephemeral' },
    });
  });
});

describe('createAnthropicTranslatedStream', () => {
  it('translates Anthropic SSE events into OpenAI-style SSE chunks', async () => {
    const upstream = createEventStreamResponse([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","usage":{"input_tokens":11,"output_tokens":5}}}',
    ]);

    const translated = createAnthropicTranslatedStream(upstream, 'minimax-m2.5');
    const text = await new Response(translated).text();
    const payloads = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6));

    expect(payloads.at(-1)).toBe('[DONE]');
    const jsonPayloads = payloads
      .filter((line) => line !== '[DONE]')
      .map(
        (line) =>
          JSON.parse(line) as {
            choices: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          },
      );

    expect(jsonPayloads.some((payload) => payload.choices[0]?.delta?.content === 'Hello')).toBe(
      true,
    );
    expect(jsonPayloads.some((payload) => payload.choices[0]?.finish_reason === 'stop')).toBe(true);
    expect(jsonPayloads.some((payload) => payload.usage?.total_tokens === 16)).toBe(true);
  });

  it('captures signed thinking + signature deltas as a single reasoning_block chunk', async () => {
    // Anthropic streams thinking in three frames: content_block_start
    // declares the block, content_block_delta carries `thinking_delta`
    // text and a `signature_delta` separately, content_block_stop closes
    // it. The translator must accumulate text + signature and emit one
    // structured `delta.reasoning_block` so the OpenAI pump can persist
    // a complete signed block on the assistant message.
    const upstream = createEventStreamResponse([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":4,"output_tokens":0}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Hmm "}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"let me think."}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-zzz"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done."}}',
      'data: {"type":"content_block_stop","index":1}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","usage":{"input_tokens":4,"output_tokens":3}}}',
    ]);

    const translated = createAnthropicTranslatedStream(upstream, 'claude-opus-4-7');
    const text = await new Response(translated).text();
    const jsonPayloads = text
      .split('\n')
      .filter((line) => line.startsWith('data: ') && !line.endsWith('[DONE]'))
      .map((line) => line.slice(6))
      .map(
        (line) =>
          JSON.parse(line) as {
            choices: Array<{
              delta?: {
                content?: string;
                reasoning_block?: {
                  type: string;
                  text?: string;
                  signature?: string;
                  data?: string;
                };
              };
            }>;
          },
      );

    const reasoningBlocks = jsonPayloads
      .map((p) => p.choices[0]?.delta?.reasoning_block)
      .filter((b): b is NonNullable<typeof b> => Boolean(b));
    expect(reasoningBlocks).toHaveLength(1);
    expect(reasoningBlocks[0]).toEqual({
      type: 'thinking',
      text: 'Hmm let me think.',
      signature: 'sig-zzz',
    });

    const textChunks = jsonPayloads
      .map((p) => p.choices[0]?.delta?.content)
      .filter((c): c is string => typeof c === 'string');
    expect(textChunks.join('')).toBe('Done.');
  });

  it('emits redacted_thinking blocks verbatim', async () => {
    const upstream = createEventStreamResponse([
      'data: {"type":"message_start","message":{}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"enc-payload-xyz"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    ]);

    const translated = createAnthropicTranslatedStream(upstream, 'claude-opus-4-7');
    const text = await new Response(translated).text();
    const blocks = text
      .split('\n')
      .filter((line) => line.startsWith('data: ') && !line.endsWith('[DONE]'))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
      .map(
        (p) =>
          (p as { choices?: Array<{ delta?: { reasoning_block?: unknown } }> }).choices?.[0]?.delta
            ?.reasoning_block,
      )
      .filter((b): b is { type: string; data: string } => Boolean(b)) as Array<{
      type: string;
      data: string;
    }>;

    expect(blocks).toEqual([{ type: 'redacted_thinking', data: 'enc-payload-xyz' }]);
  });

  it('captures assistant content blocks and emits pause_turn finish_reason on stop_reason=pause_turn', async () => {
    // Web search server-tool turns can pause when Anthropic hits its
    // internal sampling-loop cap. The translator must capture the full
    // assistant content[] (text + server_tool_use + web_search_tool_result)
    // and emit `finish_reason: pause_turn` with the blocks as a sidecar so
    // the stream adapter can replay them in a continuation request.
    const upstream = createEventStreamResponse([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Looking up "}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"the answer."}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"su_01","name":"web_search","input":{}}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"tc39 stage 4\\"}"}}',
      'data: {"type":"content_block_stop","index":1}',
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"web_search_tool_result","tool_use_id":"su_01","content":[{"type":"web_search_result","url":"https://example.com","title":"TC39"}]}}',
      'data: {"type":"content_block_stop","index":2}',
      'data: {"type":"message_delta","delta":{"stop_reason":"pause_turn","usage":{"input_tokens":11,"output_tokens":12}}}',
    ]);

    const translated = createAnthropicTranslatedStream(upstream, 'claude-opus-4-7');
    const text = await new Response(translated).text();
    const payloads = text
      .split('\n')
      .filter((line) => line.startsWith('data: ') && !line.endsWith('[DONE]'))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);

    type Chunk = {
      choices?: Array<{
        delta?: { content?: string; assistant_content_blocks?: Array<Record<string, unknown>> };
        finish_reason?: string;
      }>;
    };
    const final = payloads.at(-1) as Chunk;
    expect(final.choices?.[0]?.finish_reason).toBe('pause_turn');
    const blocks = final.choices?.[0]?.delta?.assistant_content_blocks;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks).toHaveLength(3);
    expect(blocks?.[0]).toMatchObject({ type: 'text', text: 'Looking up the answer.' });
    expect(blocks?.[1]).toMatchObject({
      type: 'server_tool_use',
      id: 'su_01',
      name: 'web_search',
      input: { query: 'tc39 stage 4' },
    });
    expect(blocks?.[2]).toMatchObject({
      type: 'web_search_tool_result',
      tool_use_id: 'su_01',
    });

    // Text deltas still flow through normally on the way to the pause — the
    // user sees the partial response in the UI while the adapter sets up
    // the continuation request.
    const textContent = payloads
      .map((p) => (p as Chunk).choices?.[0]?.delta?.content ?? '')
      .join('');
    expect(textContent).toBe('Looking up the answer.');
  });

  it('drops thinking blocks that arrive without a signature rather than emitting a poison block', async () => {
    // A thinking block without signature can't round-trip — Anthropic
    // would 400 the next request. Drop it on the floor; the text channel
    // already covers display.
    const upstream = createEventStreamResponse([
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"orphan"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    ]);
    const translated = createAnthropicTranslatedStream(upstream, 'claude-opus-4-7');
    const text = await new Response(translated).text();
    const reasoningEmitted = text
      .split('\n')
      .filter((line) => line.startsWith('data: ') && !line.endsWith('[DONE]'))
      .some((line) => line.includes('reasoning_block'));
    expect(reasoningEmitted).toBe(false);
  });
});
