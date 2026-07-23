import { describe, expect, it } from 'vitest';
import { aiGatewaySkipCacheHeaders, isAiGatewayUrl } from './ai-gateway';

describe('isAiGatewayUrl', () => {
  it('detects provider-native gateway routes', () => {
    expect(
      isAiGatewayUrl('https://gateway.ai.cloudflare.com/v1/acct/push-gate/openai/chat/completions'),
    ).toBe(true);
  });

  it('rejects direct provider hosts and lookalikes', () => {
    expect(isAiGatewayUrl('https://api.openai.com/v1/chat/completions')).toBe(false);
    expect(isAiGatewayUrl('https://gateway.ai.cloudflare.com.evil.example/v1/x')).toBe(false);
    expect(isAiGatewayUrl('https://openrouter.ai/api/v1/chat/completions')).toBe(false);
  });

  it('returns false for unparseable URLs instead of throwing', () => {
    expect(isAiGatewayUrl('')).toBe(false);
    expect(isAiGatewayUrl('not a url')).toBe(false);
  });
});

describe('aiGatewaySkipCacheHeaders', () => {
  it('emits the cache bypass only on gateway routes', () => {
    expect(
      aiGatewaySkipCacheHeaders('https://gateway.ai.cloudflare.com/v1/acct/push-gate/zen/v1/chat'),
    ).toEqual({ 'cf-aig-skip-cache': 'true' });
    expect(aiGatewaySkipCacheHeaders('https://api.z.ai/api/paas/v4/chat/completions')).toEqual({});
  });
});
