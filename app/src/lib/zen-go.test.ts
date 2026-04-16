import { describe, expect, it } from 'vitest';

import { getZenGoTransport, ZEN_GO_MODELS } from './zen-go';

describe('zen-go', () => {
  it('includes all documented Go models in the static selector list', () => {
    expect(ZEN_GO_MODELS).toEqual([
      'glm-5.1',
      'kimi-k2.5',
      'glm-5',
      'mimo-v2-pro',
      'mimo-v2-omni',
      'qwen3.6-plus',
      'minimax-m2.7',
      'minimax-m2.5',
      'qwen3.5-plus',
    ]);
  });

  it('routes MiniMax models through the Anthropic-style messages transport', () => {
    expect(getZenGoTransport('glm-5')).toBe('openai');
    expect(getZenGoTransport('glm-5.1')).toBe('openai');
    expect(getZenGoTransport('kimi-k2.5')).toBe('openai');
    expect(getZenGoTransport('mimo-v2-pro')).toBe('openai');
    expect(getZenGoTransport('mimo-v2-omni')).toBe('openai');
    expect(getZenGoTransport('qwen3.6-plus')).toBe('openai');
    expect(getZenGoTransport('qwen3.5-plus')).toBe('openai');
    expect(getZenGoTransport('minimax-m2.7')).toBe('anthropic');
    expect(getZenGoTransport('minimax-m2.5')).toBe('anthropic');
  });

  it('fails open to the default OpenAI-compatible transport for unknown ids', () => {
    expect(getZenGoTransport('future-model')).toBe('openai');
  });
});
