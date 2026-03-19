import { describe, expect, it } from 'vitest';

import {
  filterPushSupportedZenGoModels,
  isPushSupportedZenGoModel,
  shouldAutoFetchProviderModels,
} from './model-catalog-utils';

describe('shouldAutoFetchProviderModels', () => {
  it('auto-fetches only when the provider is idle, empty, and error-free', () => {
    expect(shouldAutoFetchProviderModels({
      hasKey: true,
      modelCount: 0,
      loading: false,
      error: null,
    })).toBe(true);

    expect(shouldAutoFetchProviderModels({
      hasKey: true,
      modelCount: 0,
      loading: false,
      error: 'Request failed',
    })).toBe(false);
  });
});

describe('Zen Go support filtering', () => {
  it('filters out Go models that require the unsupported messages transport', () => {
    expect(filterPushSupportedZenGoModels([
      'glm-5',
      'kimi-k2.5',
      'minimax-m2.5',
      'minimax-m2.7',
    ])).toEqual(['glm-5', 'kimi-k2.5']);
  });

  it('flags only the unsupported Go models as incompatible', () => {
    expect(isPushSupportedZenGoModel('glm-5')).toBe(true);
    expect(isPushSupportedZenGoModel('kimi-k2.5')).toBe(true);
    expect(isPushSupportedZenGoModel('minimax-m2.5')).toBe(false);
    expect(isPushSupportedZenGoModel('minimax-m2.7')).toBe(false);
  });
});
