import { describe, expect, it } from 'vitest';
import { PUSH_STREAM_WIRE_CONTRACT } from '@push/lib/provider-wire';
import {
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
});
