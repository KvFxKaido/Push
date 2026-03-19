import { describe, expect, it } from 'vitest';

import {
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
