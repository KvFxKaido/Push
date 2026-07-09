import { describe, expect, it } from 'vitest';

import type { OpenAIChatRequest, OpenAIContentPart, OpenAIMessage } from './openai-chat-types.ts';
import type { LlmMessage, PushStreamRequest } from './provider-contract.ts';
import { MAX_ROLLING_CACHE_BREAKPOINTS } from './context-transformer.ts';
import {
  anthropicEventStream,
  anthropicModelEnforcesSamplingExclusivity,
  anthropicModelRejectsSamplingParams,
  anthropicModelThinksByDefault,
  buildAnthropicMessagesRequest,
  STRUCTURED_OUTPUT_TOOL_NAME,
  toAnthropicMessages,
} from './anthropic-bridge.ts';
import { anthropicModelSupportsNativeStructuredOutput } from './anthropic-structured-output.ts';
import type { PushStreamEvent } from './provider-contract.ts';

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
  it('rejects sampling params on Opus 4.7+, Sonnet 5, and Fable/Mythos 5 variants', () => {
    for (const model of [
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-4-8[1m]',
      'claude-opus-4-7-20260101',
      'claude-opus-4.8',
      'claude-opus-4-7@20260101',
      'claude-opus-5-0',
      'CLAUDE-OPUS-4-8',
      'claude-sonnet-5',
      'anthropic/claude-sonnet-5',
      'claude-fable-5',
      'claude-mythos-5',
    ]) {
      expect(anthropicModelRejectsSamplingParams(model), model).toBe(true);
    }
  });

  it('keeps sampling params on Opus 4.6 and earlier, Sonnet 4.x, Haiku, and non-Anthropic models', () => {
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

describe('anthropicModelSupportsNativeStructuredOutput', () => {
  it('recognizes supported Claude JSON-output model id shapes', () => {
    for (const model of [
      'claude-fable-5',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-opus-4-8',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5@20250929',
      'anthropic/claude-sonnet-4.6:nitro',
    ]) {
      expect(anthropicModelSupportsNativeStructuredOutput(model), model).toBe(true);
    }
  });

  it('rejects older Claude and non-Claude Anthropic-transport ids', () => {
    for (const model of [
      'claude-sonnet-4@20250514',
      'claude-opus-4-1@20250805',
      'claude-3-5-sonnet-20241022',
      'minimax-m3',
    ]) {
      expect(anthropicModelSupportsNativeStructuredOutput(model), model).toBe(false);
    }
  });
});

describe('anthropicModelEnforcesSamplingExclusivity', () => {
  it('flags Claude 4+ models (Opus/Sonnet/Haiku, any id shape)', () => {
    for (const model of [
      'claude-opus-4-8',
      'claude-opus-4-6',
      'claude-opus-4-0',
      'claude-opus-4-20250514', // dated Opus 4.0
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-haiku-4-5-20251001',
      'claude-opus-5-0',
      'CLAUDE-SONNET-4-6',
      'anthropic.claude-sonnet-4-6', // Bedrock-style prefix (not a current code path, but pinned)
    ]) {
      expect(anthropicModelEnforcesSamplingExclusivity(model), model).toBe(true);
    }
  });

  it('does not flag Claude 3.x or non-Anthropic models', () => {
    for (const model of [
      'claude-3-opus-20240229',
      'claude-3-5-sonnet-20241022',
      'anthropic.claude-3-5-sonnet-20241022', // Bedrock-style 3.x prefix
      'claude-3-7-sonnet-20250219',
      'claude-3-haiku-20240307',
      'minimax-m2.5',
      'gpt-5.4',
      'claude',
      '',
    ]) {
      expect(anthropicModelEnforcesSamplingExclusivity(model), model).toBe(false);
    }
    expect(anthropicModelEnforcesSamplingExclusivity(undefined)).toBe(false);
    expect(anthropicModelEnforcesSamplingExclusivity(null)).toBe(false);
  });
});

describe('anthropicModelThinksByDefault', () => {
  it('flags Fable/Mythos 5 and Sonnet 5 (thinking on by default, omitted display)', () => {
    for (const model of [
      'claude-fable-5',
      'claude-mythos-5',
      'claude-sonnet-5',
      'anthropic/claude-sonnet-5',
      'claude-fable-5[1m]',
      'CLAUDE-SONNET-5',
    ]) {
      expect(anthropicModelThinksByDefault(model), model).toBe(true);
    }
  });

  it('leaves think-off-by-omission and non-Anthropic models alone', () => {
    for (const model of [
      // Opus 4.7/4.8 run thinking OFF when omitted — forcing adaptive would
      // change their behavior, so they must stay false.
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-opus-4-20250514',
      'gpt-5-mini',
      'minimax-m2',
      '',
    ]) {
      expect(anthropicModelThinksByDefault(model), model).toBe(false);
    }
    expect(anthropicModelThinksByDefault(undefined)).toBe(false);
    expect(anthropicModelThinksByDefault(null)).toBe(false);
  });
});

describe('buildAnthropicMessagesRequest', () => {
  it('requests summarized thinking for Fable/Sonnet 5, but not for Opus 4.8', () => {
    const base = {
      messages: [{ role: 'user' as const, content: 'Hello' }],
      stream: true,
    };

    for (const model of ['claude-fable-5', 'claude-sonnet-5']) {
      const body = buildAnthropicMessagesRequest({ ...base, model });
      // Summarized display makes the otherwise-silent (omitted) thinking phase
      // stream reasoning text, which keeps the client content-stall timer alive.
      expect(body.thinking, model).toEqual({ type: 'adaptive', display: 'summarized' });
    }

    // Opus 4.8 runs thinking off when omitted — the bridge must NOT enable it.
    const opus48 = buildAnthropicMessagesRequest({ ...base, model: 'claude-opus-4-8' });
    expect(opus48).not.toHaveProperty('thinking');

    // Sonnet 4.6 (existing picker entry) is likewise unaffected.
    const sonnet46 = buildAnthropicMessagesRequest({ ...base, model: 'claude-sonnet-4-6' });
    expect(sonnet46).not.toHaveProperty('thinking');
  });

  it('strips temperature/top_p for newer Claude ids, and drops top_p when both set on Claude 4+', () => {
    const base = {
      messages: [{ role: 'user' as const, content: 'Hello' }],
      stream: true,
      temperature: 0.1,
      top_p: 0.9,
    };

    // Opus 4.7+ removed sampling params entirely — both stripped.
    const opus48 = buildAnthropicMessagesRequest({ ...base, model: 'claude-opus-4-8' });
    expect(opus48).not.toHaveProperty('temperature');
    expect(opus48).not.toHaveProperty('top_p');

    const sonnet5 = buildAnthropicMessagesRequest({ ...base, model: 'claude-sonnet-5' });
    expect(sonnet5).not.toHaveProperty('temperature');
    expect(sonnet5).not.toHaveProperty('top_p');

    const fable5 = buildAnthropicMessagesRequest({ ...base, model: 'claude-fable-5' });
    expect(fable5).not.toHaveProperty('temperature');
    expect(fable5).not.toHaveProperty('top_p');

    // Sonnet 4.6 accepts sampling but is Claude 4+, so temperature and top_p
    // are mutually exclusive — keep temperature, drop top_p (a 400 otherwise).
    const sonnetBoth = buildAnthropicMessagesRequest({ ...base, model: 'claude-sonnet-4-6' });
    expect(sonnetBoth).toMatchObject({ temperature: 0.1 });
    expect(sonnetBoth).not.toHaveProperty('top_p');

    // Only one of the pair set — forwarded unchanged on Claude 4+.
    const sonnetTopPOnly = buildAnthropicMessagesRequest({
      ...base,
      temperature: undefined,
      model: 'claude-sonnet-4-6',
    });
    expect(sonnetTopPOnly).toMatchObject({ top_p: 0.9 });
    expect(sonnetTopPOnly).not.toHaveProperty('temperature');

    // Claude 3.x accepts both together — neither dropped.
    const sonnet35 = buildAnthropicMessagesRequest({
      ...base,
      model: 'claude-3-5-sonnet-20241022',
    });
    expect(sonnet35).toMatchObject({ temperature: 0.1, top_p: 0.9 });
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

  it('translates native function tools to Anthropic flat custom-tool shape', () => {
    const params = {
      type: 'object' as const,
      properties: { path: { type: 'string' as const } },
      required: ['path'],
      additionalProperties: false as const,
    };
    const body = buildAnthropicMessagesRequest({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'read it' }],
      stream: true,
      // buildAnthropicMessagesRequest takes an OpenAIChatRequest (OpenAI-nested
      // tools); it un-nests to the flat canonical, then emits the Anthropic
      // custom-tool shape.
      tools: [
        {
          type: 'function',
          function: { name: 'sandbox_read_file', description: 'Read a file', parameters: params },
        },
      ],
    });
    // Output is the Anthropic flat custom-tool shape { name, description, input_schema }.
    expect(body.tools).toEqual([
      { name: 'sandbox_read_file', description: 'Read a file', input_schema: params },
    ]);
  });

  it('merges native function tools with the web_search server tool (function first)', () => {
    const body = buildAnthropicMessagesRequest({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      anthropic_web_search: true,
      tools: [
        {
          type: 'function',
          function: {
            name: 'sandbox_read_file',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: {},
              required: [],
              additionalProperties: false,
            },
          },
        },
      ],
    });
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: 'sandbox_read_file' });
    expect(tools[1]).toEqual({ type: 'web_search_20250305', name: 'web_search' });
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

describe('toAnthropicMessages — native tools', () => {
  // The neutral entry point Zen Go actually uses (buildAnthropicMessagesRequest
  // shares the same assembleAnthropicBody translation; this pins the neutral path
  // directly rather than only transitively through the worker integration test).
  it('translates req.tools to Anthropic flat custom-tool shape, merged with web search', () => {
    const params = {
      type: 'object' as const,
      properties: { path: { type: 'string' as const } },
      required: ['path'],
      additionalProperties: false as const,
    };
    const body = toAnthropicMessages(
      {
        provider: 'zen',
        model: 'minimax-m3',
        messages: [{ id: '1', role: 'user', content: 'read it', timestamp: 0 } as LlmMessage],
        tools: [
          {
            name: 'sandbox_read_file',
            description: 'Read a file',
            input_schema: params,
          },
        ],
      } as PushStreamRequest<LlmMessage>,
      { enableWebSearch: true },
    );
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toEqual([
      { name: 'sandbox_read_file', description: 'Read a file', input_schema: params },
      { type: 'web_search_20250305', name: 'web_search' },
    ]);
  });

  it('omits tools when req.tools is empty and web search is off', () => {
    const body = toAnthropicMessages({
      provider: 'zen',
      model: 'minimax-m3',
      messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 } as LlmMessage],
    } as PushStreamRequest<LlmMessage>);
    expect(body).not.toHaveProperty('tools');
  });
});

describe('toAnthropicMessages — contentBlocks (multimodal near-identity; tool turns structural)', () => {
  const req = (message: Partial<LlmMessage>): PushStreamRequest<LlmMessage> =>
    ({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      messages: [{ id: '1', content: 'fallback', timestamp: 0, ...message } as LlmMessage],
    }) as PushStreamRequest<LlmMessage>;
  const msgs = (body: Record<string, unknown>) =>
    body.messages as Array<{ role: string; content: unknown }>;

  it('maps an assistant turn (thinking + text + tool_use) to Anthropic content, in order', () => {
    const body = toAnthropicMessages(
      req({
        role: 'assistant',
        contentBlocks: [
          { type: 'thinking', text: 'pondering', signature: 'sig' },
          { type: 'text', text: 'here goes' },
          { type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a.ts' } },
        ],
      }),
    );
    expect(msgs(body)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'pondering', signature: 'sig' },
          { type: 'text', text: 'here goes' },
          { type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a.ts' } },
        ],
      },
    ]);
  });

  it('preserves the is_error flag on tool_result (the slot OpenAI lacks)', () => {
    const body = toAnthropicMessages(
      req({
        role: 'user',
        contentBlocks: [
          { type: 'tool_result', tool_use_id: 'c1', content: 'boom', is_error: true },
        ],
      }),
    );
    expect(msgs(body)).toEqual([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'boom', is_error: true }],
      },
    ]);
  });

  it('materializes paired transcript tool sidecars before the Anthropic downcast', () => {
    const toolUse = {
      type: 'tool_use' as const,
      id: 'toolu_read_1',
      name: 'read_file',
      input: { path: 'README.md' },
    };
    const toolResult = {
      type: 'tool_result' as const,
      tool_use_id: toolUse.id,
      content: '[meta] round=1\nfile body',
    };
    const body = toAnthropicMessages({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          content: '```json\n{"tool":"read_file","args":{"path":"README.md"}}\n```',
          timestamp: 0,
          toolUses: [toolUse],
        } as LlmMessage & { toolUses: [typeof toolUse] },
        {
          id: 'r1',
          role: 'user',
          content: '[TOOL_RESULT] file body [/TOOL_RESULT]',
          timestamp: 0,
          toolResults: [toolResult],
        } as LlmMessage & { toolResults: [typeof toolResult] },
      ],
    });

    expect(msgs(body)).toEqual([
      {
        role: 'assistant',
        content: [toolUse],
      },
      {
        role: 'user',
        content: [toolResult],
      },
    ]);
  });

  it('coalesces consecutive tool_result-only user messages after a batched tool_use turn', () => {
    const readA = {
      type: 'tool_use' as const,
      id: 'toolu_a',
      name: 'read_file',
      input: { path: 'a.ts' },
    };
    const readB = {
      type: 'tool_use' as const,
      id: 'toolu_b',
      name: 'read_file',
      input: { path: 'b.ts' },
    };
    const resultA = { type: 'tool_result' as const, tool_use_id: readA.id, content: 'A' };
    const resultB = { type: 'tool_result' as const, tool_use_id: readB.id, content: 'B' };

    const body = toAnthropicMessages({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          content: 'fenced fallback',
          timestamp: 0,
          toolUses: [readA, readB],
        } as LlmMessage & { toolUses: [typeof readA, typeof readB] },
        {
          id: 'r1',
          role: 'user',
          content: '[TOOL_RESULT] A [/TOOL_RESULT]',
          timestamp: 0,
          toolResults: [resultA],
        } as LlmMessage & { toolResults: [typeof resultA] },
        {
          id: 'r2',
          role: 'user',
          content: '[TOOL_RESULT] B [/TOOL_RESULT]',
          timestamp: 0,
          toolResults: [resultB],
        } as LlmMessage & { toolResults: [typeof resultB] },
      ],
    } as PushStreamRequest<LlmMessage>);

    expect(msgs(body)).toEqual([
      { role: 'assistant', content: [readA, readB] },
      { role: 'user', content: [resultA, resultB] },
    ]);
  });

  it('carries an image block source verbatim (already Anthropic shape)', () => {
    const body = toAnthropicMessages(
      req({
        role: 'user',
        contentBlocks: [
          { type: 'text', text: 'see' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      }),
    );
    expect(msgs(body)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
    ]);
  });

  it('prefers contentBlocks and does NOT double-apply the reasoningBlocks sidecar', () => {
    const body = toAnthropicMessages(
      req({
        role: 'assistant',
        content: 'text fallback',
        contentParts: [{ type: 'text', text: 'parts fallback' }],
        reasoningBlocks: [{ type: 'thinking', text: 'sidecar', signature: 'sidesig' }],
        contentBlocks: [
          { type: 'thinking', text: 'in-stream', signature: 'streamsig' },
          { type: 'text', text: 'blocks win' },
        ],
      }),
    );
    // In-stream thinking is used; the sidecar is not prepended (no duplication).
    expect(msgs(body)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'in-stream', signature: 'streamsig' },
          { type: 'text', text: 'blocks win' },
        ],
      },
    ]);
  });

  it('throws on a malformed content block', () => {
    expect(() =>
      toAnthropicMessages(
        req({
          role: 'user',
          contentBlocks: [
            { type: 'tool_use', name: 'no-id' },
          ] as unknown as LlmMessage['contentBlocks'],
        }),
      ),
    ).toThrow(/unsupported or malformed content block/);
  });

  it('honors contentBlocks on a system turn (serialized to body.system, not dropped)', () => {
    const body = toAnthropicMessages(
      req({ role: 'system', content: '', contentBlocks: [{ type: 'text', text: 'be terse' }] }),
    );
    // The system prompt reaches body.system via the contentBlocks precedence,
    // even though `content` is the empty-string fallback the producer leaves.
    // (toAnthropicMessages injects a placeholder user turn since Anthropic
    // requires a non-empty `messages`, so we assert on `system` specifically.)
    expect(body.system).toBe('be terse');
  });
});

describe('Anthropic structured outputs', () => {
  const schema = {
    type: 'object',
    properties: { verdict: { type: 'string' } },
    required: ['verdict'],
    additionalProperties: false,
  };

  it('toAnthropicMessages prefers native output_config.format on supported Claude models', () => {
    const body = toAnthropicMessages({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      messages: [{ id: '1', role: 'user', content: 'audit', timestamp: 0 } as LlmMessage],
      responseFormat: { name: 'auditor_verdict', schema },
    } as PushStreamRequest<LlmMessage>);
    expect(body.output_config).toEqual({
      format: {
        type: 'json_schema',
        schema,
      },
    });
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('tools');
  });

  it('buildAnthropicMessagesRequest prefers native output_config.format on supported Claude models', () => {
    const body = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'audit' }],
      stream: true,
      response_format: { type: 'json_schema', json_schema: { name: 'auditor_verdict', schema } },
    });
    expect(body.output_config).toEqual({
      format: {
        type: 'json_schema',
        schema,
      },
    });
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('tools');
  });

  it('falls back to a forced tool on Anthropic routes without native JSON outputs', () => {
    const body = toAnthropicMessages({
      provider: 'zen',
      model: 'minimax-m3',
      messages: [{ id: '1', role: 'user', content: 'audit', timestamp: 0 } as LlmMessage],
      responseFormat: { name: 'auditor_verdict', schema },
    } as PushStreamRequest<LlmMessage>);
    expect(body.tools).toEqual([
      {
        name: STRUCTURED_OUTPUT_TOOL_NAME,
        description: expect.any(String),
        input_schema: schema,
        strict: true,
      },
    ]);
    expect(body.tool_choice).toEqual({ type: 'tool', name: STRUCTURED_OUTPUT_TOOL_NAME });
    expect(body).not.toHaveProperty('output_config');
  });

  it('falls back to a forced tool when strict mode is explicitly disabled', () => {
    const body = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'audit' }],
      stream: true,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'auditor_verdict', schema, strict: false },
      },
    });
    expect(body.tools).toEqual([
      {
        name: STRUCTURED_OUTPUT_TOOL_NAME,
        description: expect.any(String),
        input_schema: schema,
        strict: false,
      },
    ]);
    expect(body.tool_choice).toEqual({ type: 'tool', name: STRUCTURED_OUTPUT_TOOL_NAME });
    expect(body).not.toHaveProperty('output_config');
  });

  it('drops summarized thinking on the forced-tool fallback for think-by-default ids', () => {
    // strict:false forces the tool_choice-pinned bridge even on a native-capable
    // model. Anthropic rejects a forced tool_choice alongside thinking, so a
    // think-by-default id (Sonnet 5) must NOT carry the thinking config here.
    const forced = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'audit' }],
      stream: true,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'auditor_verdict', schema, strict: false },
      },
    });
    expect(forced.tool_choice).toEqual({ type: 'tool', name: STRUCTURED_OUTPUT_TOOL_NAME });
    expect(forced).not.toHaveProperty('thinking');

    // The native output_config path (default for Sonnet 5) is thinking-compatible,
    // so it keeps summarized thinking.
    const native = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'audit' }],
      stream: true,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'auditor_verdict', schema },
      },
    });
    expect(native).toHaveProperty('output_config');
    expect(native).not.toHaveProperty('tool_choice');
    expect(native.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('keeps summarized thinking alongside regular + web_search tools (no forced tool_choice)', () => {
    // Boundary the forced-tool gate pins: ordinary function tools and the
    // web_search server tool populate `tools` but never a forced `tool_choice`,
    // so a think-by-default id keeps thinking. Only the structured-output
    // forced-tool fallback (strict:false) sets tool_choice and drops thinking.
    const body = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'read it' }],
      stream: true,
      anthropic_web_search: true,
      tools: [
        {
          type: 'function',
          function: {
            name: 'sandbox_read_file',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        },
      ],
    });
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body).toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('omits tool_choice when no responseFormat is set', () => {
    const body = toAnthropicMessages({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 } as LlmMessage],
    } as PushStreamRequest<LlmMessage>);
    expect(body).not.toHaveProperty('tool_choice');
  });
});

// ---------------------------------------------------------------------------
// Phase 2: direct neutral -> Anthropic serializer (toAnthropicMessages)
//
// `toAnthropicMessages` builds the Anthropic body straight from the neutral
// `PushStreamRequest`, replacing the old two-step CLI path (neutral -> OpenAI
// shape -> buildAnthropicMessagesRequest). This suite pins it byte-for-byte
// against that legacy detour so Phase 3 can delete the detour with confidence.
// (The CLI adapter's own body-capture suite, cli/tests/anthropic-stream.test.mjs,
// is the independent oracle for the cache-tagging edges.)
// ---------------------------------------------------------------------------

/** Mirrors the pre-Phase-2 `cli/anthropic-stream.ts` cache tagger. */
function legacyTagWithCacheControl(message: OpenAIMessage): void {
  if (typeof message.content === 'string') {
    message.content = [
      { type: 'text', text: message.content, cache_control: { type: 'ephemeral' } },
    ];
    return;
  }
  if (Array.isArray(message.content) && message.content.length > 0) {
    const lastPart: OpenAIContentPart | undefined = message.content[message.content.length - 1];
    if (lastPart && lastPart.type === 'text') {
      lastPart.cache_control = { type: 'ephemeral' };
    }
  }
}

/**
 * Reproduces the exact pre-Phase-2 path: PushStreamRequest -> OpenAI Chat
 * shape -> buildAnthropicMessagesRequest -> re-attach `model`. This is the
 * behavior `toAnthropicMessages` must preserve.
 */
function legacyDetour(
  req: PushStreamRequest<LlmMessage>,
  opts: { model: string; enableWebSearch: boolean },
): Record<string, unknown> {
  const openAIMessages: OpenAIMessage[] = [];
  const systemPrependOffset =
    typeof req.systemPromptOverride === 'string' && req.systemPromptOverride ? 1 : 0;
  if (systemPrependOffset === 1) {
    openAIMessages.push({ role: 'system', content: req.systemPromptOverride as string });
  }
  for (const m of req.messages) {
    const msg: OpenAIMessage = { role: m.role, content: m.content };
    if (m.reasoningBlocks && m.reasoningBlocks.length > 0) {
      msg.reasoning_blocks = m.reasoningBlocks;
    }
    openAIMessages.push(msg);
  }
  const rawBreakpoints = req.cacheBreakpointIndices;
  if (Array.isArray(rawBreakpoints) && rawBreakpoints.length > 0) {
    if (openAIMessages[0]?.role === 'system') legacyTagWithCacheControl(openAIMessages[0]);
    for (const reqIndex of rawBreakpoints.slice(-MAX_ROLLING_CACHE_BREAKPOINTS)) {
      const wireIndex = reqIndex + systemPrependOffset;
      const target = openAIMessages[wireIndex];
      if (!target) continue;
      if (wireIndex === 0 && openAIMessages[0]?.role === 'system') continue;
      legacyTagWithCacheControl(target);
    }
  }
  const openAIRequest: OpenAIChatRequest = {
    model: opts.model,
    messages: openAIMessages,
    stream: true,
    temperature: req.temperature ?? 0.1,
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(opts.enableWebSearch ? { anthropic_web_search: true } : {}),
  };
  return { ...buildAnthropicMessagesRequest(openAIRequest), model: opts.model };
}

function llm(
  id: string,
  role: LlmMessage['role'],
  content: string,
  reasoningBlocks?: LlmMessage['reasoningBlocks'],
): LlmMessage {
  return { id, role, content, timestamp: 0, ...(reasoningBlocks ? { reasoningBlocks } : {}) };
}

describe('toAnthropicMessages — drift vs legacy OpenAI-detour path', () => {
  const corpus: Array<{
    name: string;
    req: PushStreamRequest<LlmMessage>;
    enableWebSearch: boolean;
  }> = [
    {
      name: 'single user turn (8192 default, 0.1 temp default)',
      req: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        messages: [llm('1', 'user', 'hi')],
      },
      enableWebSearch: false,
    },
    {
      name: 'system override + multi-turn + web search',
      req: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        systemPromptOverride: 'Be terse.',
        messages: [
          llm('1', 'user', 'Hi'),
          llm('2', 'assistant', 'Hello'),
          llm('3', 'user', 'More'),
        ],
      },
      enableWebSearch: true,
    },
    {
      name: 'signed reasoning blocks prepended on assistant turn',
      req: {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        messages: [
          llm('1', 'user', 'Why is the sky blue?'),
          llm('2', 'assistant', 'Rayleigh scattering.', [
            { type: 'thinking', text: 'Recall optics.', signature: 'sig-abc' },
            { type: 'redacted_thinking', data: 'enc-xyz' },
          ]),
          llm('3', 'user', 'More'),
        ],
      },
      enableWebSearch: false,
    },
    {
      name: 'Opus 4.8 strips temperature + top_p',
      req: {
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        temperature: 0.4,
        topP: 0.9,
        messages: [llm('1', 'user', 'hi')],
      },
      enableWebSearch: false,
    },
    {
      name: 'Sonnet 5 strips temperature + top_p',
      req: {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        temperature: 0.4,
        topP: 0.9,
        messages: [llm('1', 'user', 'hi')],
      },
      enableWebSearch: false,
    },
    {
      name: 'Sonnet keeps temperature, drops top_p (Claude 4+ mutual exclusion)',
      req: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        temperature: 0.7,
        topP: 0.5,
        messages: [llm('1', 'user', 'hi')],
      },
      enableWebSearch: false,
    },
    {
      name: 'cache breakpoints: override system + tail user',
      req: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        systemPromptOverride: 'sys',
        messages: [llm('1', 'user', 'a'), llm('2', 'assistant', 'b'), llm('3', 'user', 'c')],
        cacheBreakpointIndices: [2],
      },
      enableWebSearch: false,
    },
    {
      name: 'cache breakpoints capped at MAX_ROLLING_CACHE_BREAKPOINTS',
      req: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        systemPromptOverride: 'sys',
        messages: [0, 1, 2, 3, 4, 5].map((i) => llm(String(i), 'user', `q${i}`)),
        cacheBreakpointIndices: [0, 1, 2, 3, 4, 5],
      },
      enableWebSearch: true,
    },
    {
      name: 'user-first transcript: breakpoint 0 tags the user turn',
      req: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        messages: [llm('0', 'user', 'u0'), llm('1', 'user', 'u1')],
        cacheBreakpointIndices: [0],
      },
      enableWebSearch: false,
    },
    {
      name: 'system role inside messages (no override)',
      req: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        messages: [llm('0', 'system', 'sysmsg'), llm('1', 'user', 'u1')],
        cacheBreakpointIndices: [0, 1],
      },
      enableWebSearch: false,
    },
    {
      name: 'explicit maxTokens',
      req: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        maxTokens: 2048,
        messages: [llm('1', 'user', 'hi')],
      },
      enableWebSearch: false,
    },
    {
      name: 'empty breakpoints array tags nothing',
      req: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        systemPromptOverride: 'sys',
        messages: [llm('1', 'user', 'hi')],
        cacheBreakpointIndices: [],
      },
      enableWebSearch: false,
    },
  ];

  for (const { name, req, enableWebSearch } of corpus) {
    it(`byte-equal to legacy detour: ${name}`, () => {
      const direct = toAnthropicMessages(req, {
        modelOverride: req.model,
        enableWebSearch,
        temperatureDefault: 0.1,
      });
      const legacy = legacyDetour(req, { model: req.model, enableWebSearch });
      expect(direct).toEqual(legacy);
    });
  }

  it('falls back to req.model when no modelOverride is given, and emits it', () => {
    const body = toAnthropicMessages({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      messages: [llm('1', 'user', 'hi')],
    });
    expect(body.model).toBe('claude-sonnet-4-6');
  });

  it('reads a system message from contentParts (cacheable web materializer shape)', () => {
    // `toLLMMessages` for anthropic/openrouter emits the system prompt as a
    // content-part array so cache_control survives; the wire validator lands it
    // on `contentParts` with an empty `content`. Reading `content` alone would
    // silently drop the whole system prompt — this pins the contentParts path.
    const body = toAnthropicMessages({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      messages: [
        {
          id: 's',
          role: 'system',
          content: '',
          timestamp: 0,
          contentParts: [{ type: 'text', text: 'be terse', cache_control: { type: 'ephemeral' } }],
        },
        llm('1', 'user', 'hi'),
      ],
    });
    // System prompt preserved; the cache_control marker selects the array shape.
    expect(body.system).toEqual([
      { type: 'text', text: 'be terse', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('omits the top-level model when emitModel is false (URL/out-of-band transports)', () => {
    const body = toAnthropicMessages(
      { provider: 'anthropic', model: 'claude-sonnet-4-6', messages: [llm('1', 'user', 'hi')] },
      { emitModel: false },
    );
    expect(body).not.toHaveProperty('model');
    // The body is otherwise complete — messages still serialize.
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('emitModel:false still runs the sampling-capability gate on the resolved model', () => {
    // Opus 4.7+ removed temperature/top_p — the gate must strip them even though
    // the model id is not emitted into the body.
    const body = toAnthropicMessages(
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        temperature: 0.5,
        messages: [llm('1', 'user', 'hi')],
      },
      { emitModel: false },
    );
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('temperature');
  });

  it('keeps an explicit top_p instead of injecting the default temperature', () => {
    // The CLI passes temperatureDefault: 0.1. A request that explicitly sets
    // only top_p must not get the default temperature filled in — on Claude 4+
    // that would force the exclusivity guard to drop the user's explicit top_p.
    const body = toAnthropicMessages(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        topP: 0.3,
        messages: [llm('1', 'user', 'hi')],
      },
      { temperatureDefault: 0.1 },
    );
    expect(body).toMatchObject({ top_p: 0.3 });
    expect(body).not.toHaveProperty('temperature');
  });

  it('still applies the default temperature when no sampling param is set', () => {
    const body = toAnthropicMessages(
      { provider: 'anthropic', model: 'claude-sonnet-4-6', messages: [llm('1', 'user', 'hi')] },
      { temperatureDefault: 0.1 },
    );
    expect(body).toMatchObject({ temperature: 0.1 });
    expect(body).not.toHaveProperty('top_p');
  });

  it('appends pause-turn replay turns as verbatim trailing assistant messages', () => {
    const replayA = [{ type: 'text', text: 'paused-a' }];
    const replayB = [{ type: 'text', text: 'paused-b' }];
    const body = toAnthropicMessages(
      { provider: 'anthropic', model: 'claude-sonnet-4-6', messages: [llm('1', 'user', 'hi')] },
      {
        modelOverride: 'claude-sonnet-4-6',
        enableWebSearch: false,
        replayAssistantTurns: [replayA, replayB],
      },
    );
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[messages.length - 2]).toEqual({ role: 'assistant', content: replayA });
    expect(messages[messages.length - 1]).toEqual({ role: 'assistant', content: replayB });
  });
});

// ---------------------------------------------------------------------------
// Phase 3a: anthropicEventStream — Anthropic SSE parsed directly into neutral
// PushStreamEvents. This is the production response path for every
// Anthropic-Messages route (CLI, direct web Anthropic, and the multiplexed
// Vertex-Claude / Zen-Go routes, whose Workers proxy the raw upstream SSE).
// Expected sequences below were pinned from the now-removed
// createAnthropicTranslatedStream -> openAISSEPump detour the CLI used before,
// so the native pump stays event-for-event identical to that baseline.
// ---------------------------------------------------------------------------

async function collectEvents(stream: AsyncIterable<PushStreamEvent>): Promise<PushStreamEvent[]> {
  const out: PushStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('anthropicEventStream — Anthropic SSE -> neutral events', () => {
  const corpus: Array<{ name: string; lines: string[]; expected: PushStreamEvent[] }> = [
    {
      name: 'text deltas + end_turn + usage',
      lines: [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","usage":{"input_tokens":11,"output_tokens":5}}}',
      ],
      expected: [
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' world' },
        {
          type: 'done',
          finishReason: 'stop',
          usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
        },
      ],
    },
    {
      name: 'signed thinking block then text',
      lines: [
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
      ],
      expected: [
        // Thinking streams live as reasoning_delta (resets the consumer's
        // content timer + drives the thinking panel) while the whole signed
        // block is still emitted at content_block_stop for replay.
        { type: 'reasoning_delta', text: 'Hmm ' },
        { type: 'reasoning_delta', text: 'let me think.' },
        {
          type: 'reasoning_block',
          block: { type: 'thinking', text: 'Hmm let me think.', signature: 'sig-zzz' },
        },
        { type: 'text_delta', text: 'Done.' },
        {
          type: 'done',
          finishReason: 'stop',
          usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
        },
      ],
    },
    {
      name: 'redacted_thinking block',
      lines: [
        'data: {"type":"message_start","message":{}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"enc-payload-xyz"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      ],
      expected: [
        { type: 'reasoning_block', block: { type: 'redacted_thinking', data: 'enc-payload-xyz' } },
        { type: 'done', finishReason: 'stop' },
      ],
    },
    {
      name: 'signature-less thinking streams live but its block is dropped',
      lines: [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"orphan"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      ],
      // The live delta still streams for display; only the reasoning_block is
      // dropped (signature-less thinking can't round-trip on replay).
      expected: [
        { type: 'reasoning_delta', text: 'orphan' },
        { type: 'done', finishReason: 'stop' },
      ],
    },
    {
      name: 'max_tokens -> length',
      lines: [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"cut"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
      ],
      expected: [
        { type: 'text_delta', text: 'cut' },
        { type: 'done', finishReason: 'length' },
      ],
    },
    {
      name: 'tool_use -> tool_calls',
      lines: [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"calling"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      ],
      expected: [
        { type: 'text_delta', text: 'calling' },
        { type: 'done', finishReason: 'tool_calls' },
      ],
    },
    {
      // The structured-output forced tool: its `input` must stream out as plain
      // text content (NOT a tool call), so callers JSON.parse the accumulated
      // text like an OpenAI response_format body. Both paths must agree.
      name: 'structured-output forced tool -> text content',
      lines: [
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_so","name":"${STRUCTURED_OUTPUT_TOOL_NAME}","input":{}}}`,
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"verdict\\":"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"SAFE\\"}"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      ],
      expected: [
        { type: 'text_delta', text: '{"verdict":' },
        { type: 'text_delta', text: '"SAFE"}' },
        { type: 'done', finishReason: 'tool_calls' },
      ],
    },
    {
      // A model `tool_use` block: both paths stream tool_call_delta markers and
      // flush the call as a structured native_tool_call on stop.
      name: 'native tool_use block -> native tool call',
      lines: [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":0}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me check."}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01","name":"sandbox_read_file","input":{}}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"a.ts\\"}"}}',
        'data: {"type":"content_block_stop","index":1}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","usage":{"input_tokens":9,"output_tokens":7}}}',
      ],
      expected: [
        { type: 'text_delta', text: 'Let me check.' },
        { type: 'tool_call_delta' },
        { type: 'tool_call_delta' },
        { type: 'tool_call_delta' },
        {
          type: 'native_tool_call',
          call: { id: 'toolu_01', name: 'sandbox_read_file', args: { path: 'a.ts' } },
        },
        {
          type: 'done',
          finishReason: 'tool_calls',
          usage: { inputTokens: 9, outputTokens: 7, totalTokens: 16 },
        },
      ],
    },
    {
      name: 'pause_turn with captured server-tool blocks',
      lines: [
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
      ],
      expected: [
        { type: 'text_delta', text: 'Looking up ' },
        { type: 'text_delta', text: 'the answer.' },
        {
          type: 'pause_turn',
          assistantBlocks: [
            { type: 'text', text: 'Looking up the answer.' },
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
          ],
        },
      ],
    },
    {
      name: 'clean close without message_stop',
      lines: [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"trailing"}}',
      ],
      expected: [
        { type: 'text_delta', text: 'trailing' },
        { type: 'done', finishReason: 'stop' },
      ],
    },
    {
      name: 'upstream [DONE] sentinel',
      lines: [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}',
        'data: [DONE]',
      ],
      expected: [
        { type: 'text_delta', text: 'x' },
        { type: 'done', finishReason: 'stop' },
      ],
    },
    {
      // Both paths run text through stripTemplateTokens: mixed text keeps the
      // prose, drops the control marker.
      name: 'text with a chat-template control token is stripped',
      lines: [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi<|im_end|>"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      ],
      expected: [
        { type: 'text_delta', text: 'hi' },
        { type: 'done', finishReason: 'stop' },
      ],
    },
    {
      // A delta that is entirely control tokens strips to '' — neither path
      // emits a text_delta for it.
      name: 'text that is only a control token yields no text_delta',
      lines: [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"<|im_end|>"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      ],
      expected: [{ type: 'done', finishReason: 'stop' }],
    },
  ];

  for (const { name, lines, expected } of corpus) {
    it(`parses: ${name}`, async () => {
      const direct = await collectEvents(anthropicEventStream(createEventStreamResponse(lines)));
      expect(direct).toEqual(expected);
    });
  }

  it('emits a terminal done on a bodyless upstream', async () => {
    const events = await collectEvents(anthropicEventStream(new Response(null)));
    expect(events).toEqual([{ type: 'done', finishReason: 'stop' }]);
  });

  it('stops cleanly when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const events = await collectEvents(
      anthropicEventStream(
        createEventStreamResponse([
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"never"}}',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
        ]),
        ac.signal,
      ),
    );
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Multimodal: toAnthropicMessages serializes LlmMessage.contentParts (text +
// image), preferring it over `content`, with LOUD failures for unsupported
// parts so image content can never be silently dropped on the neutral path.
// ---------------------------------------------------------------------------

describe('toAnthropicMessages — multimodal contentParts', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const userWithParts = (parts: unknown): LlmMessage =>
    ({
      id: '1',
      role: 'user',
      content: 'text fallback',
      contentParts: parts,
      timestamp: 0,
    }) as unknown as LlmMessage;
  const reqWith = (m: LlmMessage, extra: Partial<PushStreamRequest<LlmMessage>> = {}) =>
    toAnthropicMessages({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      messages: [m],
      ...extra,
    } as PushStreamRequest<LlmMessage>);
  const firstContent = (body: Record<string, unknown>): Array<Record<string, unknown>> =>
    (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;

  it('serializes text + base64 image parts, preferring contentParts over content', () => {
    const body = reqWith(
      userWithParts([
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', image_url: { url: PNG } },
      ]),
    );
    expect(firstContent(body)).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
  });

  it('carries an http(s) image URL as a url source', () => {
    const body = reqWith(
      userWithParts([{ type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }]),
    );
    expect(firstContent(body)[0]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/cat.png' },
    });
  });

  it('tags the last text part with cache_control at a breakpoint index', () => {
    const body = reqWith(
      userWithParts([
        { type: 'text', text: 'a' },
        { type: 'image_url', image_url: { url: PNG } },
        { type: 'text', text: 'b' },
      ]),
      { cacheBreakpointIndices: [0] },
    );
    const content = firstContent(body);
    expect(content[2]).toEqual({ type: 'text', text: 'b', cache_control: { type: 'ephemeral' } });
    expect(content[0].cache_control).toBeUndefined();
    expect(content[1].cache_control).toBeUndefined();
  });

  it('prepends signed reasoning blocks before multimodal content on assistant turns', () => {
    const body = toAnthropicMessages({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      messages: [
        {
          id: '1',
          role: 'assistant',
          content: 'x',
          timestamp: 0,
          reasoningBlocks: [{ type: 'thinking', text: 't', signature: 's' }],
          contentParts: [
            { type: 'text', text: 'see image' },
            { type: 'image_url', image_url: { url: PNG } },
          ],
        },
      ],
    } as PushStreamRequest<LlmMessage>);
    const content = firstContent(body);
    expect(content[0]).toEqual({ type: 'thinking', thinking: 't', signature: 's' });
    expect(content[1]).toEqual({ type: 'text', text: 'see image' });
    expect(content[2]).toMatchObject({ type: 'image', source: { type: 'base64' } });
  });

  it('falls back to content text when contentParts is empty', () => {
    const body = reqWith(userWithParts([]));
    expect(firstContent(body)).toEqual([{ type: 'text', text: 'text fallback' }]);
  });

  it('throws loudly on an unsupported content part type', () => {
    expect(() => reqWith(userWithParts([{ type: 'audio', audio: {} }]))).toThrow(
      /unsupported or malformed content part/,
    );
  });

  it('throws loudly on a malformed image part (missing url)', () => {
    expect(() => reqWith(userWithParts([{ type: 'image_url', image_url: {} }]))).toThrow(
      /unsupported or malformed content part/,
    );
  });

  it('throws loudly on an image URL that is neither data: nor http(s)', () => {
    // The producer flip materializes multimodal turns through the block path,
    // so an unrepresentable image now fails loudly in deriveContentBlocks.
    expect(() =>
      reqWith(userWithParts([{ type: 'image_url', image_url: { url: 'ftp://nope/x.png' } }])),
    ).toThrow(/unsupported or malformed content part/);
  });
});
