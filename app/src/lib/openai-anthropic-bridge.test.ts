import { describe, expect, it } from 'vitest';

import type { OpenAIChatRequest } from './chat-request-guardrails';
import {
  buildAnthropicMessagesRequest,
  createAnthropicTranslatedStream,
} from './openai-anthropic-bridge';

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

describe('buildAnthropicMessagesRequest', () => {
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
