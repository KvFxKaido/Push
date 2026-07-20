import { describe, expect, it } from 'vitest';

import type { LlmMessage, PushStreamRequest } from './provider-contract.ts';
import { toOpenAIResponses, toOpenAIResponsesTextFormat } from './openai-responses-serializer.ts';
import { GEMINI_MISSING_THOUGHT_SIGNATURE_PLACEHOLDER } from './gemini-thought-signature.ts';

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
  provider: 'openai',
  model: 'gpt-5.4',
  messages,
  ...fields,
});

describe('toOpenAIResponses', () => {
  it('maps neutral messages into Responses input items', () => {
    const body = toOpenAIResponses(reqWith([llm('1', 'user', 'hi'), llm('2', 'assistant', 'yo')]), {
      temperatureDefault: 0.1,
    });
    expect(body).toEqual({
      model: 'gpt-5.4',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'yo' }] },
      ],
      stream: true,
      store: false,
      temperature: 0.1,
    });
  });

  it('prepends systemPromptOverride as a system input item', () => {
    const body = toOpenAIResponses(
      reqWith([llm('1', 'user', 'hi')], { systemPromptOverride: 'Be terse.' }),
    );
    expect(body.input[0]).toEqual({
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: 'Be terse.' }],
    });
    expect(body.input[1]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hi' }],
    });
  });

  it('forwards sampling and maxTokens through Responses field names', () => {
    const body = toOpenAIResponses(
      reqWith([llm('1', 'user', 'hi')], { temperature: 0.7, topP: 0.5, maxTokens: 2048 }),
      { modelOverride: 'gpt-5.4-mini', temperatureDefault: 0.1 },
    );
    expect(body).toMatchObject({
      model: 'gpt-5.4-mini',
      temperature: 0.7,
      top_p: 0.5,
      max_output_tokens: 2048,
    });
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('maps structured output to text.format', () => {
    const schema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    };
    const body = toOpenAIResponses(
      reqWith([llm('1', 'user', 'json')], {
        responseFormat: { name: 'verdict', schema },
      }),
    );
    expect(body.text).toEqual({
      format: { type: 'json_schema', name: 'verdict', strict: true, schema },
    });
    expect(body).not.toHaveProperty('response_format');
    expect(toOpenAIResponsesTextFormat({ name: 'loose', schema, strict: false })).toEqual({
      type: 'json_schema',
      name: 'loose',
      strict: false,
      schema,
    });
  });

  it('serializes native function tools in the Responses flat shape', () => {
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
    const body = toOpenAIResponses(reqWith([llm('1', 'user', 'hi')], { tools: [sampleTool] }));
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'sandbox_write_file',
        description: 'Write a file to the sandbox',
        parameters: sampleTool.input_schema,
      },
    ]);
    expect(body.tool_choice).toBe('auto');
  });

  it('serializes multimodal contentParts to input_text/input_image content', () => {
    const body = toOpenAIResponses(
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
    expect(body.input[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'what is this?' },
        {
          type: 'input_image',
          image_url: 'data:image/png;base64,iVBORw0KGgo=',
          detail: 'auto',
        },
        { type: 'input_image', image_url: 'https://example.com/cat.png', detail: 'auto' },
      ],
    });
  });

  it('injects the server-side web_search tool when responsesWebSearch is set', () => {
    const body = toOpenAIResponses(reqWith([llm('1', 'user', 'hi')], { responsesWebSearch: true }));
    expect(body.tools).toEqual([{ type: 'web_search' }]);
    expect(body.tool_choice).toBe('auto');
  });

  it('merges web_search after native function tools (web search last)', () => {
    const body = toOpenAIResponses(
      reqWith([llm('1', 'user', 'hi')], {
        responsesWebSearch: true,
        tools: [
          {
            name: 'sandbox_read_file',
            description: 'Read a file',
            input_schema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      }),
    );
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'sandbox_read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      { type: 'web_search' },
    ]);
    expect(body.tool_choice).toBe('auto');
  });

  it('omits the web_search tool when responsesWebSearch is unset or false', () => {
    expect(toOpenAIResponses(reqWith([llm('1', 'user', 'hi')])).tools).toBeUndefined();
    expect(
      toOpenAIResponses(reqWith([llm('1', 'user', 'hi')], { responsesWebSearch: false })).tools,
    ).toBeUndefined();
  });

  it('suppresses web_search on structured-output turns (responseFormat set)', () => {
    const body = toOpenAIResponses(
      reqWith([llm('1', 'user', 'hi')], {
        responsesWebSearch: true,
        responseFormat: { name: 'verdict', schema: { type: 'object' } },
      }),
    );
    // The strict json_schema text.format is present; web_search is held back.
    expect(body.text).toEqual({
      format: { type: 'json_schema', name: 'verdict', strict: true, schema: { type: 'object' } },
    });
    expect(body.tools).toBeUndefined();
  });

  it('serializes tool_use/tool_result blocks as Responses function items', () => {
    const body = toOpenAIResponses(
      reqWith([
        llm('1', 'assistant', '', {
          contentBlocks: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'call_1', name: 'sandbox_read_file', input: { path: 'a.ts' } },
          ],
        }),
        llm('2', 'user', '', {
          contentBlocks: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file text' }],
        }),
      ]),
    );
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'input_text', text: 'Checking.' }],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'sandbox_read_file',
        arguments: JSON.stringify({ path: 'a.ts' }),
        status: 'completed',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'file text' },
    ]);
  });

  it('requests, preserves, and orders encrypted reasoning items for stateless replay', () => {
    const reasoningItem = {
      type: 'reasoning' as const,
      id: 'rs_1',
      encrypted_content: 'opaque-ciphertext',
      summary: [{ type: 'summary_text', text: 'brief summary' }],
      status: 'completed',
    };
    const body = toOpenAIResponses(
      reqWith([
        llm('1', 'assistant', '', {
          responsesReasoningItems: [reasoningItem],
          contentBlocks: [
            { type: 'tool_use', id: 'call_1', name: 'sandbox_read_file', input: { path: 'a.ts' } },
          ],
        }),
        llm('2', 'user', '', {
          contentBlocks: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file text' }],
        }),
      ]),
      { encryptedReasoningReplay: true },
    );

    expect(body.include).toEqual(['reasoning.encrypted_content']);
    expect(body.input).toEqual([
      reasoningItem,
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'sandbox_read_file',
        arguments: JSON.stringify({ path: 'a.ts' }),
        status: 'completed',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'file text' },
    ]);
  });

  it('does not leak encrypted reasoning items to Responses adapters that did not opt in', () => {
    const body = toOpenAIResponses(
      reqWith([
        llm('1', 'assistant', 'answer', {
          responsesReasoningItems: [
            { type: 'reasoning', encrypted_content: 'provider-bound-ciphertext' },
          ],
        }),
      ]),
    );
    expect(body.include).toBeUndefined();
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'input_text', text: 'answer' }],
      },
    ]);
  });

  it('can backfill Gemini thought signatures on Responses function_call history', () => {
    const body = toOpenAIResponses(
      reqWith([
        llm('1', 'assistant', '', {
          contentBlocks: [
            { type: 'tool_use', id: 'call_1', name: 'sandbox_read_file', input: { path: 'a.ts' } },
          ],
        }),
      ]),
      { geminiThoughtSignatureFallback: true },
    );

    expect(body.input[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_1',
      thoughtSignature: GEMINI_MISSING_THOUGHT_SIGNATURE_PLACEHOLDER,
      extra_content: {
        google: { thought_signature: GEMINI_MISSING_THOUGHT_SIGNATURE_PLACEHOLDER },
      },
      function: { thought_signature: GEMINI_MISSING_THOUGHT_SIGNATURE_PLACEHOLDER },
    });
  });
});
