import { describe, expect, it } from 'vitest';

import { getZenGoTransport, ZEN_GO_DEFAULT_MODEL, ZEN_GO_MODELS } from './zen-go';

describe('zen-go', () => {
  it('includes all documented Go models sorted alphabetically by family', () => {
    expect([...ZEN_GO_MODELS]).toEqual(
      expect.arrayContaining([
        'deepseek-v4-flash',
        'deepseek-v4-pro',
        'glm-5',
        'glm-5.1',
        'hy3-preview',
        'kimi-k2.5',
        'kimi-k2.6',
        'mimo-v2-omni',
        'mimo-v2-pro',
        'mimo-v2.5',
        'mimo-v2.5-pro',
        'minimax-m2.5',
        'minimax-m2.7',
        'minimax-m3',
        'qwen3.5-plus',
        'qwen3.6-plus',
        'qwen3.7-max',
      ]),
    );
    expect(ZEN_GO_MODELS).toHaveLength(17);
  });

  it('exposes an explicit default model', () => {
    expect(ZEN_GO_MODELS).toContain(ZEN_GO_DEFAULT_MODEL);
  });

  it('routes models to the correct message transport', () => {
    expect(getZenGoTransport('glm-5')).toBe('openai');
    expect(getZenGoTransport('glm-5.1')).toBe('openai');
    expect(getZenGoTransport('kimi-k2.5')).toBe('openai');
    expect(getZenGoTransport('kimi-k2.6')).toBe('openai');
    expect(getZenGoTransport('mimo-v2-pro')).toBe('openai');
    expect(getZenGoTransport('mimo-v2-omni')).toBe('openai');
    expect(getZenGoTransport('qwen3.6-plus')).toBe('openai');
    expect(getZenGoTransport('qwen3.5-plus')).toBe('openai');
    expect(getZenGoTransport('minimax-m2.7')).toBe('anthropic');
    expect(getZenGoTransport('minimax-m2.5')).toBe('anthropic');
    expect(getZenGoTransport('minimax-m3')).toBe('anthropic');
    expect(getZenGoTransport('deepseek-v4-pro')).toBe('openai');
    expect(getZenGoTransport('deepseek-v4-flash')).toBe('openai');
    expect(getZenGoTransport('hy3-preview')).toBe('openai');
    expect(getZenGoTransport('mimo-v2.5-pro')).toBe('openai');
    expect(getZenGoTransport('qwen3.7-max')).toBe('openai');
  });

  it('fails open to the default OpenAI-compatible transport for unknown ids', () => {
    expect(getZenGoTransport('future-model')).toBe('openai');
  });
});
