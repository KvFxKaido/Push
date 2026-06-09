import { describe, expect, it } from 'vitest';

import type { OpenAIChatRequest, OpenAIContentPart, OpenAIMessage } from './openai-chat-types.ts';
import type { LlmMessage, PushStreamRequest } from './provider-contract.ts';
import { MAX_ROLLING_CACHE_BREAKPOINTS } from './context-transformer.ts';
import {
  anthropicEventStream,
  anthropicModelEnforcesSamplingExclusivity,
  anthropicModelRejectsSamplingParams,
  buildAnthropicMessagesRequest,
  createAnthropicTranslatedStream,
  toAnthropicMessages,
} from './openai-anthropic-bridge.ts';
import { openAISSEPump } from './openai-sse-pump.ts';
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

describe('buildAnthropicMessagesRequest', () => {
  it('strips temperature/top_p for Opus 4.7+, and drops top_p when both set on Claude 4+', () => {
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
// PushStreamEvents. Pinned byte-for-byte (at the event level) against the
// legacy createAnthropicTranslatedStream -> openAISSEPump round-trip that the
// CLI used before, and that the web Worker still uses for its response wire.
// ---------------------------------------------------------------------------

async function collectEvents(stream: AsyncIterable<PushStreamEvent>): Promise<PushStreamEvent[]> {
  const out: PushStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

/** The legacy path: translate Anthropic SSE -> OpenAI SSE, then pump it. */
function legacyEvents(lines: string[]): Promise<PushStreamEvent[]> {
  const translated = createAnthropicTranslatedStream(createEventStreamResponse(lines), 'claude-x');
  return collectEvents(openAISSEPump({ body: translated }));
}

describe('anthropicEventStream — drift vs translate->pump', () => {
  const corpus: Array<{ name: string; lines: string[] }> = [
    {
      name: 'text deltas + end_turn + usage',
      lines: [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","usage":{"input_tokens":11,"output_tokens":5}}}',
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
    },
    {
      name: 'redacted_thinking block',
      lines: [
        'data: {"type":"message_start","message":{}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"enc-payload-xyz"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      ],
    },
    {
      name: 'signature-less thinking is dropped',
      lines: [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"orphan"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      ],
    },
    {
      name: 'max_tokens -> length',
      lines: [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"cut"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
      ],
    },
    {
      name: 'tool_use -> tool_calls',
      lines: [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"calling"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
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
    },
    {
      name: 'clean close without message_stop',
      lines: [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"trailing"}}',
      ],
    },
    {
      name: 'upstream [DONE] sentinel',
      lines: [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}',
        'data: [DONE]',
      ],
    },
  ];

  for (const { name, lines } of corpus) {
    it(`matches the legacy round-trip: ${name}`, async () => {
      const direct = await collectEvents(anthropicEventStream(createEventStreamResponse(lines)));
      const legacy = await legacyEvents(lines);
      expect(direct).toEqual(legacy);
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
    expect(() =>
      reqWith(userWithParts([{ type: 'image_url', image_url: { url: 'ftp://nope/x.png' } }])),
    ).toThrow(/cannot represent image/);
  });
});
