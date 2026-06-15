import { describe, expect, it } from 'vitest';

import type { LlmMessage, PushStreamRequest } from './provider-contract.ts';
import { toOpenAIChat, toOpenAIResponseFormat } from './openai-chat-serializer.ts';

function llm(
  id: string,
  role: LlmMessage['role'],
  content: string,
  extra?: Partial<LlmMessage>,
): LlmMessage {
  return { id, role, content, timestamp: 0, ...extra };
}

const reqWith = (
  messages: LlmMessage[],
  fields: Partial<PushStreamRequest<LlmMessage>> = {},
): PushStreamRequest<LlmMessage> => ({
  provider: 'openrouter',
  model: 'gpt-5.4',
  messages,
  ...fields,
});

describe('toOpenAIChat', () => {
  it('maps roles + string content 1:1 and applies the sampling defaults', () => {
    const body = toOpenAIChat(reqWith([llm('1', 'user', 'hi'), llm('2', 'assistant', 'yo')]), {
      temperatureDefault: 0.1,
    });
    expect(body).toEqual({
      model: 'gpt-5.4',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'yo' },
      ],
      stream: true,
      temperature: 0.1,
    });
  });

  it('prepends systemPromptOverride as a system message', () => {
    const body = toOpenAIChat(
      reqWith([llm('1', 'user', 'hi')], { systemPromptOverride: 'Be terse.' }),
    );
    expect(body.messages?.[0]).toEqual({ role: 'system', content: 'Be terse.' });
    expect(body.messages?.[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('forwards explicit temperature/topP/maxTokens and honours modelOverride', () => {
    const body = toOpenAIChat(
      reqWith([llm('1', 'user', 'hi')], { temperature: 0.7, topP: 0.5, maxTokens: 2048 }),
      { modelOverride: 'gpt-5.4-mini', temperatureDefault: 0.1 },
    );
    expect(body).toMatchObject({
      model: 'gpt-5.4-mini',
      temperature: 0.7,
      top_p: 0.5,
      max_tokens: 2048,
    });
  });

  it('omits temperature when neither the request nor a default sets it (Worker use)', () => {
    const body = toOpenAIChat(reqWith([llm('1', 'user', 'hi')]));
    expect(body).not.toHaveProperty('temperature');
  });

  it('serializes multimodal contentParts (data + http image URLs both pass natively)', () => {
    const body = toOpenAIChat(
      reqWith([
        llm('1', 'user', 'fallback', {
          contentParts: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
          ],
        }),
      ]),
    );
    expect(body.messages?.[0].content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
    ]);
  });

  it('strips per-part cache_control markers when tagCacheBreakpoints is off (default)', () => {
    const body = toOpenAIChat(
      reqWith([
        llm('1', 'user', 'fallback', {
          contentParts: [
            { type: 'text', text: 'cached?', cache_control: { type: 'ephemeral' } },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
              cache_control: { type: 'ephemeral' },
            },
          ] as unknown as LlmMessage['contentParts'],
        }),
      ]),
    );
    // Push-private markers must not leak to a strict OpenAI-compat endpoint.
    expect(body.messages?.[0].content).toEqual([
      { type: 'text', text: 'cached?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ]);
  });

  it('preserves per-part cache_control markers when tagCacheBreakpoints is on', () => {
    const body = toOpenAIChat(
      reqWith([
        llm('1', 'user', 'fallback', {
          contentParts: [
            { type: 'text', text: 'cached?', cache_control: { type: 'ephemeral' } },
          ] as unknown as LlmMessage['contentParts'],
        }),
      ]),
      { tagCacheBreakpoints: true },
    );
    expect(body.messages?.[0].content).toEqual([
      { type: 'text', text: 'cached?', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('does NOT forward reasoning_blocks (OpenAI-compat endpoints reject the sidecar)', () => {
    const body = toOpenAIChat(
      reqWith([
        llm('1', 'user', 'why?'),
        llm('2', 'assistant', 'because', {
          reasoningBlocks: [{ type: 'thinking', text: 't', signature: 's' }],
        }),
      ]),
    );
    const assistant = body.messages?.[1] as Record<string, unknown>;
    expect(assistant).toEqual({ role: 'assistant', content: 'because' });
    expect('reasoning_blocks' in assistant).toBe(false);
  });

  it('tags cache_control on system + tail when tagCacheBreakpoints is set', () => {
    const body = toOpenAIChat(
      reqWith([llm('1', 'user', 'a'), llm('2', 'assistant', 'b'), llm('3', 'user', 'c')], {
        systemPromptOverride: 'sys',
        cacheBreakpointIndices: [2],
      }),
      { tagCacheBreakpoints: true },
    );
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    // System tagged (promoted to a text part array with the marker).
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ]);
    // Tail user (req index 2 + offset 1 = wire index 3) tagged.
    expect(messages[messages.length - 1].content).toEqual([
      { type: 'text', text: 'c', cache_control: { type: 'ephemeral' } },
    ]);
    // The untagged turn stays a bare string.
    expect(messages[1].content).toBe('a');
  });

  it('does not tag cache_control when tagCacheBreakpoints is false (default)', () => {
    const body = toOpenAIChat(reqWith([llm('1', 'user', 'a')], { cacheBreakpointIndices: [0] }), {
      temperatureDefault: 0.1,
    });
    expect(body.messages?.[0].content).toBe('a');
  });

  it('throws loudly on an unsupported/malformed content part', () => {
    expect(() =>
      toOpenAIChat(
        reqWith([
          llm('1', 'user', 'x', {
            contentParts: [{ type: 'audio' }] as unknown as LlmMessage['contentParts'],
          }),
        ]),
      ),
    ).toThrow(/unsupported or malformed content part/);
  });

  it('omits response_format when no responseFormat is set', () => {
    const body = toOpenAIChat(reqWith([llm('1', 'user', 'hi')]));
    expect(body.response_format).toBeUndefined();
  });

  it('emits response_format from a responseFormat spec', () => {
    const body = toOpenAIChat(
      reqWith([llm('1', 'user', 'hi')], {
        responseFormat: { name: 'verdict', schema: { type: 'object' } },
      }),
    );
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'verdict', strict: true, schema: { type: 'object' } },
    });
  });
});

describe('toOpenAIResponseFormat', () => {
  it('wraps the spec and defaults strict to true', () => {
    expect(toOpenAIResponseFormat({ name: 'v', schema: { type: 'object' } })).toEqual({
      type: 'json_schema',
      json_schema: { name: 'v', strict: true, schema: { type: 'object' } },
    });
  });

  it('honors an explicit strict: false', () => {
    expect(
      toOpenAIResponseFormat({ name: 'v', schema: { type: 'object' }, strict: false }),
    ).toEqual({
      type: 'json_schema',
      json_schema: { name: 'v', strict: false, schema: { type: 'object' } },
    });
  });
});
