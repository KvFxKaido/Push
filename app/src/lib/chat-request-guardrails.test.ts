import { describe, expect, it } from 'vitest';
import { validateAndNormalizeChatRequest } from './chat-request-guardrails';

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
