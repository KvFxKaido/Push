import { describe, expect, it } from 'vitest';

import type { LlmMessage, PushStreamRequest } from './provider-contract.ts';
import { materializeToolContentBlocks } from './content-blocks.ts';
import {
  expandToolMessagesForOpenAICompat,
  toOpenAIChat,
  toOpenAIResponseFormat,
} from './openai-chat-serializer.ts';

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

  it('can emit max_completion_tokens for callers that opt in', () => {
    const body = toOpenAIChat(reqWith([llm('1', 'user', 'hi')], { maxTokens: 2048 }), {
      maxTokensField: 'max_completion_tokens',
    });
    expect(body).toMatchObject({ max_completion_tokens: 2048 });
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('omits temperature when neither the request nor a default sets it (Worker use)', () => {
    const body = toOpenAIChat(reqWith([llm('1', 'user', 'hi')]));
    expect(body).not.toHaveProperty('temperature');
  });

  it('downcasts flat native function tools + tool_choice when the caller attaches them', () => {
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
    const body = toOpenAIChat(reqWith([llm('1', 'user', 'hi')], { tools: [sampleTool] }));
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'sandbox_write_file',
          description: 'Write a file to the sandbox',
          parameters: sampleTool.input_schema,
        },
      },
    ]);
    expect(body.tool_choice).toBe('auto');
  });

  it('omits tools / tool_choice when the caller attaches none', () => {
    const body = toOpenAIChat(reqWith([llm('1', 'user', 'hi')]));
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('emits stream_options.include_usage only when includeUsage is set', () => {
    const withUsage = toOpenAIChat(reqWith([llm('1', 'user', 'hi')]), { includeUsage: true });
    expect(withUsage.stream_options).toEqual({ include_usage: true });
    const without = toOpenAIChat(reqWith([llm('1', 'user', 'hi')]));
    expect(without).not.toHaveProperty('stream_options');
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

  it('emits plain reasoningContent as reasoning_content on assistant messages', () => {
    const reasoning = 'line one\n  line two with spaces  ';
    const body = toOpenAIChat(
      reqWith([
        llm('1', 'user', 'why?'),
        llm('2', 'assistant', 'because', {
          reasoningContent: reasoning,
        }),
      ]),
    );
    expect(body.messages?.[1]).toEqual({
      role: 'assistant',
      content: 'because',
      reasoning_content: reasoning,
    });
  });

  it('does not emit reasoning_content when reasoningContent is absent or on a non-assistant turn', () => {
    const body = toOpenAIChat(
      reqWith([
        llm('1', 'user', 'why?', {
          reasoningContent: 'not allowed',
        }),
        llm('2', 'assistant', 'because'),
      ]),
    );
    expect(body.messages?.[0]).toEqual({ role: 'user', content: 'why?' });
    expect(body.messages?.[1]).toEqual({ role: 'assistant', content: 'because' });
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

  // ---------------------------------------------------------------------------
  // contentBlocks — slice 1 of the Anthropic-conceptual contract migration.
  // The block model is the canonical hub; the OpenAI serializer DOWNCASTS it.
  // ---------------------------------------------------------------------------

  it('downcasts Anthropic-canonical contentBlocks to OpenAI content parts (base64 + url image)', () => {
    const body = toOpenAIChat(
      reqWith([
        llm('1', 'user', 'fallback', {
          contentBlocks: [
            { type: 'text', text: 'what is this?' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
            },
            { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
          ],
        }),
      ]),
    );
    // base64 source collapses to a `data:` URL; remote source passes verbatim.
    expect(body.messages?.[0].content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
    ]);
  });

  it('prefers contentBlocks over contentParts and the content text fallback', () => {
    const body = toOpenAIChat(
      reqWith([
        llm('1', 'user', 'text fallback', {
          contentParts: [{ type: 'text', text: 'parts fallback' }],
          contentBlocks: [{ type: 'text', text: 'blocks win' }],
        }),
      ]),
    );
    expect(body.messages?.[0].content).toEqual([{ type: 'text', text: 'blocks win' }]);
  });

  it('leaves behavior identical to the legacy path when no contentBlocks are present', () => {
    const body = toOpenAIChat(reqWith([llm('1', 'user', 'plain string')]));
    expect(body.messages?.[0]).toEqual({ role: 'user', content: 'plain string' });
  });

  it('strips per-block cache_control markers when tagCacheBreakpoints is off (default)', () => {
    const body = toOpenAIChat(
      reqWith([
        llm('1', 'user', 'fallback', {
          contentBlocks: [{ type: 'text', text: 'cached?', cache_control: { type: 'ephemeral' } }],
        }),
      ]),
    );
    expect(body.messages?.[0].content).toEqual([{ type: 'text', text: 'cached?' }]);
  });

  it('throws on an unsupported content block rather than dropping it', () => {
    expect(() =>
      toOpenAIChat(
        reqWith([
          llm('1', 'user', 'fallback', {
            // A genuinely unknown block type (not text/image/thinking/tool_*)
            // takes the non-tool path and hits its strict throw.
            contentBlocks: [{ type: 'video' }] as unknown as LlmMessage['contentBlocks'],
          }),
        ]),
      ),
    ).toThrow(/unsupported or malformed content block/);
  });

  it('throws on a malformed image block source rather than emitting an undefined URL', () => {
    // An unknown source.type must fail locally, not fall through to source.url
    // and serialize `image_url: { url: undefined }`.
    expect(() =>
      toOpenAIChat(
        reqWith([
          llm('1', 'user', 'fallback', {
            contentBlocks: [
              { type: 'image', source: { type: 'bogus' } },
            ] as unknown as LlmMessage['contentBlocks'],
          }),
        ]),
      ),
    ).toThrow(/unsupported or malformed content block/);
    // A url source missing its `url`, and a base64 source missing `data`, both throw.
    expect(() =>
      toOpenAIChat(
        reqWith([
          llm('1', 'user', 'fallback', {
            contentBlocks: [
              { type: 'image', source: { type: 'url' } },
            ] as unknown as LlmMessage['contentBlocks'],
          }),
        ]),
      ),
    ).toThrow(/unsupported or malformed content block/);
    expect(() =>
      toOpenAIChat(
        reqWith([
          llm('1', 'user', 'fallback', {
            contentBlocks: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
            ] as unknown as LlmMessage['contentBlocks'],
          }),
        ]),
      ),
    ).toThrow(/unsupported or malformed content block/);
  });

  it('drops thinking / redacted_thinking blocks (OpenAI-compat rejects the signed-reasoning sidecar)', () => {
    const body = toOpenAIChat(
      reqWith([
        llm('1', 'assistant', 'fallback', {
          contentBlocks: [
            { type: 'thinking', text: 'pondering', signature: 'sig' },
            { type: 'text', text: 'the answer' },
            { type: 'redacted_thinking', data: 'opaque' },
          ],
        }),
      ]),
    );
    // Only the visible text survives; the two thinking blocks are dropped, not
    // serialized and not thrown on.
    expect(body.messages?.[0].content).toEqual([{ type: 'text', text: 'the answer' }]);
  });

  it('falls back to an empty text part when a turn carries only thinking blocks', () => {
    const body = toOpenAIChat(
      reqWith([
        llm('1', 'assistant', 'fallback', {
          contentBlocks: [{ type: 'thinking', text: 'just thinking', signature: 'sig' }],
        }),
      ]),
    );
    expect(body.messages?.[0].content).toEqual([{ type: 'text', text: '' }]);
  });

  // ---------------------------------------------------------------------------
  // Tool blocks — slice 3 "boss fight": flatten Anthropic-style tool_use /
  // tool_result blocks into OpenAI's split content + tool_calls + role:tool.
  // ---------------------------------------------------------------------------

  it('materializes paired transcript tool sidecars before OpenAI downcast', () => {
    const toolUse = {
      type: 'tool_use' as const,
      id: 'toolu_read_1',
      name: 'sandbox_read_file',
      input: { path: 'a.ts' },
    };
    const toolResult = {
      type: 'tool_result' as const,
      tool_use_id: toolUse.id,
      content: '[meta] round=1\nfile body',
    };
    const body = toOpenAIChat(
      reqWith([
        {
          ...llm(
            'a1',
            'assistant',
            '```json\n{"tool":"sandbox_read_file","args":{"path":"a.ts"}}\n```',
          ),
          toolUses: [toolUse],
        } as LlmMessage & { toolUses: [typeof toolUse] },
        {
          ...llm('r1', 'user', '[TOOL_RESULT] file body [/TOOL_RESULT]'),
          toolResults: [toolResult],
        } as LlmMessage & { toolResults: [typeof toolResult] },
      ]),
    );

    expect(body.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: toolUse.id,
            type: 'function',
            function: { name: 'sandbox_read_file', arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: toolUse.id, content: '[meta] round=1\nfile body' },
    ]);
  });

  it('flattens text + tool_use into one assistant message with content and tool_calls', () => {
    const body = toOpenAIChat(
      reqWith([
        llm('1', 'assistant', 'fallback', {
          contentBlocks: [
            { type: 'text', text: 'let me check' },
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'sandbox_read_file',
              input: { path: 'a.ts' },
            },
          ],
        }),
      ]),
    );
    expect(body.messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'let me check' }],
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'sandbox_read_file', arguments: '{"path":"a.ts"}' },
          },
        ],
      },
    ]);
  });

  it('attaches reasoning_content to the first flushed assistant message when flattening tool blocks', () => {
    const reasoning = 'tool-bearing thought\n  exact spacing';
    const body = toOpenAIChat(
      reqWith([
        llm('1', 'assistant', 'fallback', {
          reasoningContent: reasoning,
          contentBlocks: [
            { type: 'tool_result', tool_use_id: 'prev', content: 'ok' },
            { type: 'text', text: 'now calling' },
            { type: 'tool_use', id: 'c3', name: 'baz', input: { x: true } },
          ],
        }),
      ]),
    );
    expect(body.messages).toEqual([
      { role: 'tool', tool_call_id: 'prev', content: 'ok' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'now calling' }],
        reasoning_content: reasoning,
        tool_calls: [
          { id: 'c3', type: 'function', function: { name: 'baz', arguments: '{"x":true}' } },
        ],
      },
    ]);
  });

  it('emits content: null when an assistant turn is tool_use only, and stringifies multiple calls', () => {
    const body = toOpenAIChat(
      reqWith([
        llm('1', 'assistant', 'fallback', {
          contentBlocks: [
            { type: 'tool_use', id: 'c1', name: 'foo', input: { a: 1 } },
            { type: 'tool_use', id: 'c2', name: 'bar', input: {} },
          ],
        }),
      ]),
    );
    expect(body.messages?.[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'foo', arguments: '{"a":1}' } },
        { id: 'c2', type: 'function', function: { name: 'bar', arguments: '{}' } },
      ],
    });
  });

  it('expands tool_result blocks into standalone role:tool messages (no spurious main message)', () => {
    const body = toOpenAIChat(
      reqWith([
        llm('1', 'user', 'fallback', {
          contentBlocks: [
            { type: 'tool_result', tool_use_id: 'c1', content: 'file contents' },
            { type: 'tool_result', tool_use_id: 'c2', content: 'boom', is_error: true },
          ],
        }),
      ]),
    );
    // Two tool messages, and NO trailing empty user message.
    expect(body.messages).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'file contents' },
      // is_error has no OpenAI slot; the failure rides in `content`.
      { role: 'tool', tool_call_id: 'c2', content: 'boom' },
    ]);
  });

  it('orders tool-result messages before the main content/tool_calls message; drops thinking', () => {
    const body = toOpenAIChat(
      reqWith([
        llm('1', 'assistant', 'fallback', {
          contentBlocks: [
            { type: 'thinking', text: 'hmm', signature: 's' },
            { type: 'tool_result', tool_use_id: 'prev', content: 'ok' },
            { type: 'text', text: 'now calling' },
            { type: 'tool_use', id: 'c3', name: 'baz', input: { x: true } },
          ],
        }),
      ]),
    );
    expect(body.messages).toEqual([
      { role: 'tool', tool_call_id: 'prev', content: 'ok' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'now calling' }],
        tool_calls: [
          { id: 'c3', type: 'function', function: { name: 'baz', arguments: '{"x":true}' } },
        ],
      },
    ]);
  });

  it('throws on a malformed tool_use block (missing id) and tool_result block (missing tool_use_id)', () => {
    expect(() =>
      toOpenAIChat(
        reqWith([
          llm('1', 'assistant', 'x', {
            contentBlocks: [
              { type: 'tool_use', name: 'foo', input: {} },
            ] as unknown as LlmMessage['contentBlocks'],
          }),
        ]),
      ),
    ).toThrow(/malformed tool_use block/);
    expect(() =>
      toOpenAIChat(
        reqWith([
          llm('1', 'user', 'x', {
            contentBlocks: [
              { type: 'tool_result', content: 'r' },
            ] as unknown as LlmMessage['contentBlocks'],
          }),
        ]),
      ),
    ).toThrow(/malformed tool_result block/);
  });

  it('preserves call→result order: a tool_result after a tool_use flushes the assistant call first', () => {
    // Interleaved within one turn: the assistant message declaring the call must
    // come BEFORE the role:tool result, not after (OpenAI rejects a tool message
    // that precedes its assistant call).
    const body = toOpenAIChat(
      reqWith([
        llm('1', 'assistant', 'fallback', {
          contentBlocks: [
            { type: 'tool_use', id: 'c1', name: 'foo', input: { a: 1 } },
            { type: 'tool_result', tool_use_id: 'c1', content: 'done' },
          ],
        }),
      ]),
    );
    expect(body.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'foo', arguments: '{"a":1}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'done' },
    ]);
  });

  it('maps cache breakpoints to the right wire message even when an earlier message flattens to several', () => {
    const body = toOpenAIChat(
      reqWith(
        [
          // req-index 0 expands to TWO wire messages (assistant call + tool result).
          llm('1', 'assistant', 'fallback', {
            contentBlocks: [
              { type: 'tool_use', id: 'c1', name: 'foo', input: {} },
              { type: 'tool_result', tool_use_id: 'c1', content: 'res' },
            ],
          }),
          // req-index 1 — the breakpoint targets this one.
          llm('2', 'user', 'hi'),
        ],
        { cacheBreakpointIndices: [1] },
      ),
      { tagCacheBreakpoints: true },
    );
    // The breakpoint at req-index 1 must tag the 'hi' user message (wire index 2),
    // not collide with req-index 0's expansion. With the old reqIndex+offset
    // mapping it would have wrongly tagged the tool-result message at wire index 1.
    expect(body.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'foo', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'res' },
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
      },
    ]);
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

describe('expandToolMessagesForOpenAICompat', () => {
  const toolUse = {
    type: 'tool_use' as const,
    id: 'toolu_read_1',
    name: 'sandbox_read_file',
    input: { path: 'a.ts' },
  };
  const toolResult = {
    type: 'tool_result' as const,
    tool_use_id: toolUse.id,
    content: 'file body',
  };

  it('expands an assistant tool_use turn into a tool_calls message', () => {
    expect(
      expandToolMessagesForOpenAICompat([{ role: 'assistant', contentBlocks: [toolUse] }]),
    ).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: toolUse.id,
            type: 'function',
            function: { name: 'sandbox_read_file', arguments: '{"path":"a.ts"}' },
          },
        ],
      },
    ]);
  });

  it("expands a tool_result turn into a standalone role:'tool' message", () => {
    expect(
      expandToolMessagesForOpenAICompat([{ role: 'user', contentBlocks: [toolResult] }]),
    ).toEqual([{ role: 'tool', tool_call_id: toolUse.id, content: 'file body' }]);
  });

  it('passes a plain string turn through by reference, untouched', () => {
    const plain = { role: 'user' as const, content: 'hi' };
    const out = expandToolMessagesForOpenAICompat([plain]);
    expect(out[0]).toBe(plain);
  });

  it('downcasts a non-tool contentBlocks turn and drops the contentBlocks field', () => {
    // Multimodal/attachment turns carry non-tool contentBlocks; these must NOT
    // ride onto the OpenAI wire as the Push-private `contentBlocks` field.
    const out = expandToolMessagesForOpenAICompat([
      {
        role: 'user',
        content: 'fallback text',
        contentBlocks: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
        ],
      },
    ]);
    expect(out[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
      ],
    });
    expect('contentBlocks' in (out[0] as Record<string, unknown>)).toBe(false);
  });

  it('reads the web wire-shaped reasoning_content for the flushed assistant turn', () => {
    const out = expandToolMessagesForOpenAICompat([
      { role: 'assistant', reasoning_content: 'thought', contentBlocks: [toolUse] },
    ]);
    expect(out[0]).toMatchObject({ role: 'assistant', reasoning_content: 'thought' });
  });

  // Integration with the REAL materializeToolContentBlocks (the production path:
  // toLLMMessages runs it under emitContentBlocks, then the adapter expands).
  it('composes with materializeToolContentBlocks: paired flattens, no contentBlocks leak', () => {
    const materialized = materializeToolContentBlocks([
      {
        role: 'assistant',
        content: '```json\n{"tool":"sandbox_read_file","args":{"path":"a.ts"}}\n```',
        toolUses: [toolUse],
      },
      {
        role: 'user',
        content: '[TOOL_RESULT] file body [/TOOL_RESULT]',
        toolResults: [toolResult],
      },
    ]);
    const wire = expandToolMessagesForOpenAICompat(materialized);
    expect(wire).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: toolUse.id,
            type: 'function',
            function: { name: 'sandbox_read_file', arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: toolUse.id, content: 'file body' },
    ]);
    for (const m of wire) expect('contentBlocks' in (m as Record<string, unknown>)).toBe(false);
  });

  it('composes with materializeToolContentBlocks: an unpaired tool result degrades to text', () => {
    const materialized = materializeToolContentBlocks([
      {
        role: 'user',
        content: '[TOOL_RESULT] orphan [/TOOL_RESULT]',
        toolResults: [{ type: 'tool_result', tool_use_id: 'missing', content: 'orphan' }],
      },
    ]);
    // No pair → materialize adds no contentBlocks → expand leaves the text turn.
    const wire = expandToolMessagesForOpenAICompat(materialized);
    expect(wire.some((m) => (m as { role?: string }).role === 'tool')).toBe(false);
    expect(wire[0]).toMatchObject({ role: 'user', content: '[TOOL_RESULT] orphan [/TOOL_RESULT]' });
    expect('contentBlocks' in (wire[0] as Record<string, unknown>)).toBe(false);
  });
});
