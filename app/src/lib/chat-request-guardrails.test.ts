import { describe, expect, it } from 'vitest';
import { PUSH_STREAM_WIRE_CONTRACT, toPushStreamWire } from '@push/lib/provider-wire';
import { toGeminiGenerateContent } from '@push/lib/gemini-bridge';
import {
  parseDualAcceptRequest,
  validateAndNormalizeChatRequest,
  validateAndNormalizeWireRequest,
} from './chat-request-guardrails';

describe('validateAndNormalizeChatRequest', () => {
  it('forces stream mode and clamps oversized output token requests', () => {
    const result = validateAndNormalizeChatRequest(
      JSON.stringify({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        max_tokens: 99_999,
      }),
      { routeLabel: 'OpenRouter', maxOutputTokens: 8192 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.parsed.stream).toBe(true);
    expect(result.value.parsed.max_tokens).toBe(8192);
    expect(result.value.adjustments).toEqual(['forced_stream', 'max_tokens_clamped']);
  });

  it('rejects invalid message payloads', () => {
    const result = validateAndNormalizeChatRequest(
      JSON.stringify({
        model: 'big-pickle',
        messages: [{ role: 'wizard', content: 'hi' }],
      }),
      { routeLabel: 'Zen', maxOutputTokens: 8192 },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('invalid role');
  });

  describe('native tool-call round-trip (Ollama / OpenRouter raw-forward)', () => {
    const POLICY = { routeLabel: 'Ollama', maxOutputTokens: 8192 };

    it('preserves assistant tool_calls and the tool result tool_call_id', () => {
      const result = validateAndNormalizeChatRequest(
        JSON.stringify({
          model: 'gpt-oss:120b',
          messages: [
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'toolu_1',
                  type: 'function',
                  function: { name: 'sandbox_read_file', arguments: '{"path":"a.ts"}' },
                },
              ],
            },
            { role: 'tool', tool_call_id: 'toolu_1', content: 'file body' },
          ],
        }),
        POLICY,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const [assistant, tool] = result.value.parsed.messages ?? [];
      expect(assistant).toEqual({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: { name: 'sandbox_read_file', arguments: '{"path":"a.ts"}' },
          },
        ],
      });
      expect(tool).toEqual({ role: 'tool', tool_call_id: 'toolu_1', content: 'file body' });
    });

    it("preserves Gemini's thoughtSignature on assistant tool_calls", () => {
      const result = validateAndNormalizeChatRequest(
        JSON.stringify({
          model: 'gemini-3-flash-preview',
          messages: [
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'toolu_1',
                  type: 'function',
                  function: { name: 'sandbox_read_file', arguments: '{"path":"a.ts"}' },
                  thoughtSignature: 'sig-abc',
                },
              ],
            },
          ],
        }),
        POLICY,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.value.parsed.messages ?? [])[0]).toEqual({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: { name: 'sandbox_read_file', arguments: '{"path":"a.ts"}' },
            thoughtSignature: 'sig-abc',
          },
        ],
      });
    });

    it('rejects malformed tool_calls instead of silently dropping them', () => {
      const result = validateAndNormalizeChatRequest(
        JSON.stringify({
          model: 'gpt-oss:120b',
          messages: [
            {
              role: 'assistant',
              content: null,
              // `function.arguments` must be a string (OpenAI wire shape).
              tool_calls: [{ id: 'x', type: 'function', function: { name: 'f', arguments: {} } }],
            },
          ],
        }),
        POLICY,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('invalid "tool_calls"');
    });

    it('ignores tool_calls on non-assistant roles and tool_call_id off tool turns', () => {
      const result = validateAndNormalizeChatRequest(
        JSON.stringify({
          model: 'gpt-oss:120b',
          messages: [
            {
              role: 'user',
              content: 'hi',
              tool_calls: [{ id: 'x', type: 'function', function: { name: 'f', arguments: '{}' } }],
              tool_call_id: 'nope',
            },
          ],
        }),
        POLICY,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.value.parsed.messages ?? [])[0]).toEqual({ role: 'user', content: 'hi' });
    });
  });

  describe('reasoning_blocks normalization', () => {
    it('keeps well-formed signed thinking blocks on `parsed` for the bridge to consume', () => {
      const result = validateAndNormalizeChatRequest(
        JSON.stringify({
          model: 'minimax-m2.7',
          messages: [
            {
              role: 'assistant',
              content: 'ok',
              reasoning_blocks: [{ type: 'thinking', text: 't', signature: 's' }],
            },
          ],
        }),
        { routeLabel: 'Zen', maxOutputTokens: 8192 },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const msg = result.value.parsed.messages?.[0] as { reasoning_blocks?: unknown };
      expect(msg.reasoning_blocks).toEqual([{ type: 'thinking', text: 't', signature: 's' }]);
    });

    it('strips reasoning_blocks from `bodyText` so non-Anthropic transports never see the sidecar', () => {
      // The Anthropic bridge consumes from `parsed`; non-Anthropic
      // transports forward `bodyText` verbatim. Stripping at the
      // validator means strict OpenAI-compatible upstreams (Azure,
      // OpenAI Chat, legacy Vertex) never see the unknown field.
      const result = validateAndNormalizeChatRequest(
        JSON.stringify({
          model: 'minimax-m2.7',
          messages: [
            {
              role: 'assistant',
              content: 'ok',
              reasoning_blocks: [{ type: 'thinking', text: 't', signature: 's' }],
            },
          ],
        }),
        { routeLabel: 'Zen', maxOutputTokens: 8192 },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.bodyText).not.toContain('reasoning_blocks');
    });

    it('drops the field on user messages (only assistant turns may carry signed reasoning)', () => {
      const result = validateAndNormalizeChatRequest(
        JSON.stringify({
          model: 'minimax-m2.7',
          messages: [
            {
              role: 'user',
              content: 'hi',
              reasoning_blocks: [{ type: 'thinking', text: 't', signature: 's' }],
            },
          ],
        }),
        { routeLabel: 'Zen', maxOutputTokens: 8192 },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const msg = result.value.parsed.messages?.[0] as { reasoning_blocks?: unknown };
      expect(msg.reasoning_blocks).toBeUndefined();
    });

    it('drops a thinking block whose `text` exceeds the per-block size cap', () => {
      const oversized = 'x'.repeat(512_001);
      const result = validateAndNormalizeChatRequest(
        JSON.stringify({
          model: 'minimax-m2.7',
          messages: [
            {
              role: 'assistant',
              content: 'ok',
              reasoning_blocks: [{ type: 'thinking', text: oversized, signature: 's' }],
            },
          ],
        }),
        { routeLabel: 'Zen', maxOutputTokens: 8192 },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const msg = result.value.parsed.messages?.[0] as { reasoning_blocks?: unknown };
      expect(msg.reasoning_blocks).toBeUndefined();
    });

    it('drops malformed reasoning_blocks (no signature) without rejecting the whole request', () => {
      const result = validateAndNormalizeChatRequest(
        JSON.stringify({
          model: 'minimax-m2.7',
          messages: [
            {
              role: 'assistant',
              content: 'ok',
              reasoning_blocks: [{ type: 'thinking', text: 't' }],
            },
          ],
        }),
        { routeLabel: 'Zen', maxOutputTokens: 8192 },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const msg = result.value.parsed.messages?.[0] as { reasoning_blocks?: unknown };
      expect(msg.reasoning_blocks).toBeUndefined();
    });
  });

  describe('reasoning_content normalization', () => {
    it('keeps assistant reasoning_content verbatim on parsed and bodyText', () => {
      const reasoning = 'line one\n  line two with spaces  ';
      const result = validateAndNormalizeChatRequest(
        JSON.stringify({
          model: 'deepseek-v4-pro',
          messages: [
            {
              role: 'assistant',
              content: 'ok',
              reasoning_content: reasoning,
            },
          ],
        }),
        { routeLabel: 'Zen Go', maxOutputTokens: 8192 },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const msg = result.value.parsed.messages?.[0] as { reasoning_content?: unknown };
      expect(msg.reasoning_content).toBe(reasoning);
      expect(JSON.parse(result.value.bodyText).messages[0].reasoning_content).toBe(reasoning);
    });

    it('drops reasoning_content on non-assistant or malformed messages', () => {
      const result = validateAndNormalizeChatRequest(
        JSON.stringify({
          model: 'deepseek-v4-pro',
          messages: [
            { role: 'user', content: 'hi', reasoning_content: 'not allowed' },
            { role: 'assistant', content: 'ok', reasoning_content: 123 },
          ],
        }),
        { routeLabel: 'Zen Go', maxOutputTokens: 8192 },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.parsed.messages?.[0]).not.toHaveProperty('reasoning_content');
      expect(result.value.parsed.messages?.[1]).not.toHaveProperty('reasoning_content');
    });
  });

  // The orchestrator attaches `cache_control: { type: 'ephemeral' }` markers
  // to system + up to 3 rolling-tail messages (Hermes `system_and_3` strategy
  // for Anthropic prompt caching). Before 2026-05-16 the guardrails layer
  // rebuilt content parts without copying `cache_control`, silently stripping
  // every marker on the way upstream — making the entire caching strategy a
  // no-op for production web requests. These tests pin the new preserve-on-
  // recognized-shape, drop-on-malformed semantics.
  describe('cache_control preservation', () => {
    it('preserves `{ type: ephemeral }` on text content parts through bodyText', () => {
      const result = validateAndNormalizeChatRequest(
        JSON.stringify({
          model: 'claude-3-5-sonnet',
          messages: [
            {
              role: 'system',
              content: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
            },
            {
              role: 'user',
              content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
            },
          ],
        }),
        { routeLabel: 'OpenRouter', maxOutputTokens: 8192 },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Both `parsed` (consumed by the bridge) and `bodyText` (forwarded to
      // non-Anthropic upstreams) must carry the marker.
      const parsedSys = result.value.parsed.messages?.[0]?.content as Array<{
        type: string;
        cache_control?: { type: string };
      }>;
      expect(parsedSys[0].cache_control).toEqual({ type: 'ephemeral' });

      const bodyParsed = JSON.parse(result.value.bodyText);
      expect(bodyParsed.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
      expect(bodyParsed.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('preserves cache_control on image_url parts (Anthropic accepts caching on images)', () => {
      const result = validateAndNormalizeChatRequest(
        JSON.stringify({
          model: 'claude-3-5-sonnet',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: 'data:image/png;base64,AAA' },
                  cache_control: { type: 'ephemeral' },
                },
              ],
            },
          ],
        }),
        { routeLabel: 'OpenRouter', maxOutputTokens: 8192 },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const bodyParsed = JSON.parse(result.value.bodyText);
      expect(bodyParsed.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('drops cache_control with an unknown type (fail-closed)', () => {
      // A future Anthropic shape like `{ type: 'persistent' }` should fail
      // closed: drop the unknown marker so the request still succeeds (just
      // without caching at that breakpoint) rather than letting an arbitrary
      // attribute through unchecked.
      const result = validateAndNormalizeChatRequest(
        JSON.stringify({
          model: 'claude-3-5-sonnet',
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'hi', cache_control: { type: 'unknown' } }],
            },
          ],
        }),
        { routeLabel: 'OpenRouter', maxOutputTokens: 8192 },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const bodyParsed = JSON.parse(result.value.bodyText);
      expect(bodyParsed.messages[0].content[0].cache_control).toBeUndefined();
    });

    it('drops cache_control with a non-object value', () => {
      const result = validateAndNormalizeChatRequest(
        JSON.stringify({
          model: 'claude-3-5-sonnet',
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'hi', cache_control: 'ephemeral' }],
            },
          ],
        }),
        { routeLabel: 'OpenRouter', maxOutputTokens: 8192 },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const bodyParsed = JSON.parse(result.value.bodyText);
      expect(bodyParsed.messages[0].content[0].cache_control).toBeUndefined();
    });

    it('omits cache_control entirely when the source has none (no spurious field)', () => {
      const result = validateAndNormalizeChatRequest(
        JSON.stringify({
          model: 'claude-3-5-sonnet',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        }),
        { routeLabel: 'OpenRouter', maxOutputTokens: 8192 },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const bodyParsed = JSON.parse(result.value.bodyText);
      expect('cache_control' in bodyParsed.messages[0].content[0]).toBe(false);
    });
  });

  describe('stream_options.include_usage', () => {
    const base = { model: 'minimax-m2.7', messages: [{ role: 'user', content: 'hi' }] };

    it('defaults include_usage on so upstreams emit the trailing usage chunk', () => {
      const result = validateAndNormalizeChatRequest(JSON.stringify(base), {
        routeLabel: 'Zen',
        maxOutputTokens: 8192,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(JSON.parse(result.value.bodyText).stream_options).toEqual({ include_usage: true });
    });

    it('respects an explicit client include_usage:false', () => {
      const result = validateAndNormalizeChatRequest(
        JSON.stringify({ ...base, stream_options: { include_usage: false } }),
        { routeLabel: 'Zen', maxOutputTokens: 8192 },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(JSON.parse(result.value.bodyText).stream_options.include_usage).toBe(false);
    });

    it('preserves other client stream_options fields while defaulting include_usage', () => {
      const result = validateAndNormalizeChatRequest(
        JSON.stringify({ ...base, stream_options: { continuous_usage_stats: true } }),
        { routeLabel: 'Zen', maxOutputTokens: 8192 },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(JSON.parse(result.value.bodyText).stream_options).toEqual({
        include_usage: true,
        continuous_usage_stats: true,
      });
    });
  });
});

describe('validateAndNormalizeWireRequest', () => {
  const POLICY = { routeLabel: 'Anthropic', maxOutputTokens: 12_288 };
  const body = (extra: Record<string, unknown>) =>
    JSON.stringify({ contract: PUSH_STREAM_WIRE_CONTRACT, model: 'claude-sonnet-4-6', ...extra });

  it('normalizes a valid neutral request into a PushStreamRequest', () => {
    const result = validateAndNormalizeWireRequest(
      body({
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
        maxTokens: 4096,
        temperature: 0.3,
        anthropicWebSearch: true,
        cacheBreakpointIndices: [1],
      }),
      POLICY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const req = result.value.request;
    expect(req.provider).toBe('anthropic');
    expect(req.model).toBe('claude-sonnet-4-6');
    expect(req.maxTokens).toBe(4096);
    expect(req.temperature).toBe(0.3);
    expect(req.anthropicWebSearch).toBe(true);
    expect(req.cacheBreakpointIndices).toEqual([1]);
    expect(req.messages).toEqual([
      { id: 'wire-0', role: 'user', content: 'hello', timestamp: 0 },
      { id: 'wire-1', role: 'assistant', content: 'hi there', timestamp: 0 },
    ]);
  });

  it('normalizes multimodal array content onto contentParts (content stays the text fallback)', () => {
    const result = validateAndNormalizeWireRequest(
      body({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ],
          },
        ],
      }),
      POLICY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const msg = result.value.request.messages[0];
    expect(msg.content).toBe('');
    expect(msg.contentParts).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ]);
  });

  it('preserves Gemini thoughtSignature on a tool_use content block (round-2 replay)', () => {
    // The browser materializes the stored tool_use sidecar into a wire
    // contentBlock carrying `thoughtSignature`; the worker re-parses it here
    // before `toGeminiGenerateContent`. Dropping it makes Gemini 3.x 400 on the
    // replay turn ("Function call is missing a thought_signature"). This is the
    // wire hop the producer/serializer unit tests bypass.
    const result = validateAndNormalizeWireRequest(
      body({
        messages: [
          { role: 'user', content: 'read it' },
          {
            role: 'assistant',
            content: '',
            contentBlocks: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'sandbox_read_file',
                input: { path: 'a.ts' },
                thoughtSignature: 'AgQKAsig==',
              },
            ],
          },
          {
            role: 'user',
            content: '',
            contentBlocks: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents' }],
          },
        ],
      }),
      POLICY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.request.messages[1].contentBlocks?.[0]).toEqual({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'sandbox_read_file',
      input: { path: 'a.ts' },
      thoughtSignature: 'AgQKAsig==',
    });
  });

  it('round-trips thoughtSignature end-to-end into the Gemini functionCall (the live failure)', () => {
    // The exact path that 400'd in production: the worker validates the replay
    // request, then serializes it for Gemini. Both halves must keep the signature.
    const result = validateAndNormalizeWireRequest(
      body({
        model: 'gemini-3.5-flash',
        messages: [
          { role: 'user', content: 'read it' },
          {
            role: 'assistant',
            content: '',
            contentBlocks: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'sandbox_read_file',
                input: { path: 'a.ts' },
                thoughtSignature: 'AgQKAsig==',
              },
            ],
          },
          {
            role: 'user',
            content: '',
            contentBlocks: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents' }],
          },
        ],
      }),
      POLICY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const geminiBody = toGeminiGenerateContent(result.value.request);
    const contents = geminiBody.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    const fnParts =
      contents.find(
        (c) => c.role === 'model' && c.parts.some((p) => Object.hasOwn(p, 'functionCall')),
      )?.parts ?? [];
    expect(fnParts[0]).toMatchObject({
      functionCall: { name: 'sandbox_read_file', args: { path: 'a.ts' } },
      thoughtSignature: 'AgQKAsig==',
    });
  });

  it('clamps maxTokens to the policy ceiling and records the adjustment', () => {
    const result = validateAndNormalizeWireRequest(
      body({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 999_999 }),
      POLICY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.request.maxTokens).toBe(12_288);
    expect(result.value.adjustments).toContain('maxTokens_clamped');
  });

  it('keeps signed reasoning blocks on assistant turns (round-tripped to Anthropic)', () => {
    const result = validateAndNormalizeWireRequest(
      body({
        messages: [
          { role: 'user', content: 'why?' },
          {
            role: 'assistant',
            content: 'because',
            reasoningBlocks: [{ type: 'thinking', text: 't', signature: 's' }],
          },
        ],
      }),
      POLICY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.request.messages[1].reasoningBlocks).toEqual([
      { type: 'thinking', text: 't', signature: 's' },
    ]);
  });

  it('rejects an unrecognized contract', () => {
    const result = validateAndNormalizeWireRequest(
      JSON.stringify({ contract: 'push.stream.v0', model: 'm', messages: [] }),
      POLICY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/unrecognized contract/);
  });

  it('rejects a missing model, empty messages, bad role, non-number temperature, and bad breakpoints', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ model: '', messages: [{ role: 'user', content: 'x' }] }, /missing "model"/],
      [{ messages: [] }, /non-empty "messages"/],
      [{ messages: [{ role: 'tool', content: 'x' }] }, /invalid role/],
      [
        { messages: [{ role: 'user', content: 'x' }], temperature: 'hot' },
        /"temperature" must be a number/,
      ],
      [
        { messages: [{ role: 'user', content: 'x' }], cacheBreakpointIndices: [-1] },
        /"cacheBreakpointIndices" must be an array of non-negative integers/,
      ],
      [
        { messages: [{ role: 'user', content: [{ type: 'audio' }] }] },
        /unsupported content part type/,
      ],
    ];
    for (const [extra, pattern] of cases) {
      const result = validateAndNormalizeWireRequest(body(extra), POLICY);
      expect(result.ok, JSON.stringify(extra)).toBe(false);
      if (result.ok) continue;
      expect(result.status).toBe(400);
      expect(result.error).toMatch(pattern);
    }
  });

  it('rejects a malformed JSON body', () => {
    const result = validateAndNormalizeWireRequest('{not json', POLICY);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/invalid JSON body/);
  });

  it('stamps the route-authoritative provider from policy (not always anthropic)', () => {
    // The endpoint commits to an upstream + key, so the route wins over any body
    // `provider`. A Google route must stamp 'google', not the legacy 'anthropic'.
    const googleResult = validateAndNormalizeWireRequest(
      JSON.stringify({
        contract: PUSH_STREAM_WIRE_CONTRACT,
        // A mismatched body provider must NOT override the route.
        provider: 'anthropic',
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      { routeLabel: 'Google Gemini', maxOutputTokens: 12_288, provider: 'google' },
    );
    expect(googleResult.ok).toBe(true);
    if (!googleResult.ok) return;
    expect(googleResult.value.request.provider).toBe('google');

    // Default stays 'anthropic' when the policy doesn't pin a provider.
    const defaultResult = validateAndNormalizeWireRequest(
      body({ messages: [{ role: 'user', content: 'hi' }] }),
      POLICY,
    );
    expect(defaultResult.ok).toBe(true);
    if (!defaultResult.ok) return;
    expect(defaultResult.value.request.provider).toBe('anthropic');
  });

  it('preserves cache_control (snake_case) on text + image content parts', () => {
    const result = validateAndNormalizeWireRequest(
      body({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } },
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
        ],
      }),
      POLICY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parts = result.value.request.messages[0].contentParts;
    // The field must be `cache_control` (what LlmContentPart / toAnthropicMessages
    // read), NOT camelCase — otherwise the breakpoint is silently dropped.
    expect(parts?.[0]).toEqual({ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } });
    expect(parts?.[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
      cache_control: { type: 'ephemeral' },
    });
  });
});

describe('validateAndNormalizeWireRequest — replayAssistantTurns', () => {
  const POLICY = { routeLabel: 'Anthropic', maxOutputTokens: 12_288 };
  const body = (extra: Record<string, unknown>) =>
    JSON.stringify({
      contract: PUSH_STREAM_WIRE_CONTRACT,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      ...extra,
    });

  it('carries an opaque array-of-content-block-arrays onto the request', () => {
    const turns = [
      [
        { type: 'text', text: 'Searching' },
        { type: 'server_tool_use', id: 'su_01', name: 'web_search', input: {} },
      ],
    ];
    const result = validateAndNormalizeWireRequest(body({ replayAssistantTurns: turns }), POLICY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Passthrough verbatim — the validator never inspects block contents.
    expect(result.value.request.replayAssistantTurns).toEqual(turns);
  });

  it('omits the field when absent', () => {
    const result = validateAndNormalizeWireRequest(body({}), POLICY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.request.replayAssistantTurns).toBeUndefined();
  });

  it.each([
    ['not an array', { replayAssistantTurns: 'nope' }],
    ['array of non-arrays', { replayAssistantTurns: [{ type: 'text' }] }],
    ['array of arrays of non-objects', { replayAssistantTurns: [['text']] }],
  ])('rejects a malformed replayAssistantTurns (%s)', (_label, extra) => {
    const result = validateAndNormalizeWireRequest(body(extra), POLICY);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/"replayAssistantTurns" must be an array of content-block arrays/);
  });
});

describe('toPushStreamWire ↔ validateAndNormalizeWireRequest round-trip', () => {
  const POLICY = { routeLabel: 'Anthropic', maxOutputTokens: 12_288 };

  it('serializes to a body the validator accepts, preserving scalars + messages', () => {
    const wire = toPushStreamWire(
      [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: 'hi there',
          reasoning_blocks: [{ type: 'thinking', text: 't', signature: 's' }],
          reasoningContent: 'plain reasoning\nwith spacing',
        },
      ],
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        maxTokens: 4096,
        temperature: 0.3,
        topP: 0.9,
        anthropicWebSearch: true,
      },
    );
    expect(wire.contract).toBe(PUSH_STREAM_WIRE_CONTRACT);
    // snake_case `reasoning_blocks` was renamed to the wire's camelCase.
    expect(wire.messages[1].reasoningBlocks).toEqual([
      { type: 'thinking', text: 't', signature: 's' },
    ]);
    expect(wire.messages[1].reasoning_content).toBe('plain reasoning\nwith spacing');

    const result = validateAndNormalizeWireRequest(JSON.stringify(wire), POLICY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const req = result.value.request;
    expect(req.model).toBe('claude-sonnet-4-6');
    expect(req.maxTokens).toBe(4096);
    expect(req.temperature).toBe(0.3);
    expect(req.topP).toBe(0.9);
    expect(req.anthropicWebSearch).toBe(true);
    expect(req.messages[0]).toMatchObject({ role: 'user', content: 'hello' });
    expect(req.messages[1].reasoningBlocks).toEqual([
      { type: 'thinking', text: 't', signature: 's' },
    ]);
    expect(req.messages[1].reasoningContent).toBe('plain reasoning\nwith spacing');
  });

  it('round-trips tool contentBlocks onto LlmMessage.contentBlocks', () => {
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
      cache_control: { type: 'ephemeral' as const },
    };
    const wire = toPushStreamWire(
      [
        {
          role: 'assistant',
          content: '```json\n{"tool":"read_file","args":{"path":"README.md"}}\n```',
          contentBlocks: [toolUse],
        },
        {
          role: 'user',
          content: '[TOOL_RESULT] file body [/TOOL_RESULT]',
          contentBlocks: [toolResult],
        },
      ],
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    );

    expect(wire.messages[0].contentBlocks).toEqual([toolUse]);
    const result = validateAndNormalizeWireRequest(JSON.stringify(wire), POLICY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.request.messages[0].contentBlocks).toEqual([toolUse]);
    expect(result.value.request.messages[1].contentBlocks).toEqual([toolResult]);
  });

  it('round-trips native tools + responseFormat (the Zen Go flip carries these)', () => {
    const tool = {
      name: 'sandbox_write_file',
      description: 'Write a file',
      input_schema: {
        type: 'object' as const,
        properties: { path: { type: 'string' as const } },
        required: ['path'],
        additionalProperties: false as const,
      },
    };
    const wire = toPushStreamWire([{ role: 'user', content: 'hi' }], {
      provider: 'zen',
      model: 'glm-5.1',
      tools: [tool],
      responseFormat: { name: 'verdict', schema: { type: 'object' } },
    });
    expect(wire.tools).toEqual([tool]);
    expect(wire.responseFormat).toEqual({ name: 'verdict', schema: { type: 'object' } });

    const result = validateAndNormalizeWireRequest(JSON.stringify(wire), POLICY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.request.tools).toEqual([tool]);
    expect(result.value.request.responseFormat).toEqual({
      name: 'verdict',
      schema: { type: 'object' },
    });
  });

  it('rejects a malformed tools field', () => {
    const result = validateAndNormalizeWireRequest(
      JSON.stringify({
        contract: PUSH_STREAM_WIRE_CONTRACT,
        model: 'glm-5.1',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ description: 'Write a file' }], // missing name/input_schema
      }),
      POLICY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/tools/);
  });

  it('rejects a malformed responseFormat field', () => {
    const result = validateAndNormalizeWireRequest(
      JSON.stringify({
        contract: PUSH_STREAM_WIRE_CONTRACT,
        model: 'glm-5.1',
        messages: [{ role: 'user', content: 'hi' }],
        responseFormat: { name: 'verdict' }, // missing schema
      }),
      POLICY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/responseFormat/);
  });

  it('round-trips multimodal content-part arrays', () => {
    const wire = toPushStreamWire(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
          ],
        },
      ],
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    );
    const result = validateAndNormalizeWireRequest(JSON.stringify(wire), POLICY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.request.messages[0].contentParts).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ]);
  });

  it('omits unset optional scalars so the body stays minimal', () => {
    const wire = toPushStreamWire([{ role: 'user', content: 'hi' }], {
      model: 'claude-sonnet-4-6',
    });
    expect(wire).not.toHaveProperty('maxTokens');
    expect(wire).not.toHaveProperty('temperature');
    expect(wire).not.toHaveProperty('topP');
    expect(wire).not.toHaveProperty('provider');
    expect(wire).not.toHaveProperty('anthropicWebSearch');
    expect(wire).not.toHaveProperty('replayAssistantTurns');
  });
});

describe('validateAndNormalizeWireRequest — googleSearchGrounding', () => {
  const POLICY = { routeLabel: 'Google Gemini', maxOutputTokens: 12_288 };
  it('accepts a boolean googleSearchGrounding and carries it onto the request', () => {
    const result = validateAndNormalizeWireRequest(
      JSON.stringify({
        contract: PUSH_STREAM_WIRE_CONTRACT,
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
        googleSearchGrounding: true,
      }),
      POLICY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.request.googleSearchGrounding).toBe(true);
  });

  it('rejects a non-boolean googleSearchGrounding', () => {
    const result = validateAndNormalizeWireRequest(
      JSON.stringify({
        contract: PUSH_STREAM_WIRE_CONTRACT,
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
        googleSearchGrounding: 'yes',
      }),
      POLICY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/"googleSearchGrounding" must be a boolean/);
  });
});

describe('parseDualAcceptRequest', () => {
  const POLICY = { routeLabel: 'Anthropic', maxOutputTokens: 12_288 };

  it('routes a contract-bearing body to the neutral validator', () => {
    const r = parseDualAcceptRequest(
      JSON.stringify({
        contract: PUSH_STREAM_WIRE_CONTRACT,
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      POLICY,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contractKind).toBe('neutral');
    if (r.contractKind !== 'neutral') return;
    expect(r.request.model).toBe('claude-sonnet-4-6');
  });

  it('routes a body with no contract field to the legacy validator', () => {
    const r = parseDualAcceptRequest(
      JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
      POLICY,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contractKind).toBe('legacy');
    if (r.contractKind !== 'legacy') return;
    expect(r.parsed.model).toBe('claude-sonnet-4-6');
  });

  it('surfaces the wire validator 400 for an unknown contract (not a legacy downgrade)', () => {
    const r = parseDualAcceptRequest(
      JSON.stringify({
        contract: 'push.stream.v2',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      POLICY,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/unrecognized contract/);
  });

  it('falls back to the legacy validator 400 on malformed JSON', () => {
    const r = parseDualAcceptRequest('{not json', POLICY);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/invalid JSON body/);
  });
});
