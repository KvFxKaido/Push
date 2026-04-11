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
});
