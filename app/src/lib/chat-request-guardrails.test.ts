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
});
