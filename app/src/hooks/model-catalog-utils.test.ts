import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canAccessProviderModelCatalog,
  MODELS_RETRY_MAX_ATTEMPTS,
  nextModelsRetryDelayMs,
  scheduleAutoFetch,
  shouldAutoFetchProviderModels,
} from './model-catalog-utils';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('canAccessProviderModelCatalog', () => {
  it('allows every catalog when a browser-local key is available', () => {
    expect(
      canAccessProviderModelCatalog({
        provider: 'openrouter',
        hasLocalKey: true,
        credentialSource: null,
      }),
    ).toBe(true);
  });

  it.each(['gateway-byok', 'worker-secret', 'binding'] as const)(
    'allows private catalogs with a %s credential',
    (credentialSource) => {
      expect(
        canAccessProviderModelCatalog({
          provider: 'fireworks',
          hasLocalKey: false,
          credentialSource,
        }),
      ).toBe(true);
    },
  );

  it('allows keyless catalogs with an account-stored key', () => {
    expect(
      canAccessProviderModelCatalog({
        provider: 'huggingface',
        hasLocalKey: false,
        credentialSource: 'user-key',
      }),
    ).toBe(true);
  });

  it('keeps private catalogs inaccessible when only an account-stored key exists', () => {
    expect(
      canAccessProviderModelCatalog({
        provider: 'deepseek',
        hasLocalKey: false,
        credentialSource: 'user-key',
      }),
    ).toBe(false);
  });

  it('does not fetch catalogs for unconfigured providers', () => {
    expect(
      canAccessProviderModelCatalog({
        provider: 'ollama',
        hasLocalKey: false,
        credentialSource: null,
      }),
    ).toBe(false);
  });
});

describe('shouldAutoFetchProviderModels', () => {
  it('auto-fetches only when the provider is idle, empty, and error-free', () => {
    expect(
      shouldAutoFetchProviderModels({
        canFetch: true,
        modelCount: 0,
        loading: false,
        error: null,
      }),
    ).toBe(true);

    expect(
      shouldAutoFetchProviderModels({
        canFetch: true,
        modelCount: 0,
        loading: false,
        error: 'Request failed',
      }),
    ).toBe(false);
  });
});

describe('nextModelsRetryDelayMs', () => {
  it('returns exponential backoff delays then null once attempts are exhausted', () => {
    expect(nextModelsRetryDelayMs(0)).toBe(3000);
    expect(nextModelsRetryDelayMs(1)).toBe(6000);
    expect(nextModelsRetryDelayMs(2)).toBe(12000);
    // default max is 3 retries → attempt index 3 is exhausted
    expect(nextModelsRetryDelayMs(MODELS_RETRY_MAX_ATTEMPTS)).toBeNull();
    expect(nextModelsRetryDelayMs(3)).toBeNull();
  });

  it('clamps to the cap and honors overrides', () => {
    expect(nextModelsRetryDelayMs(0, { baseMs: 1000, capMs: 5000, maxAttempts: 5 })).toBe(1000);
    expect(nextModelsRetryDelayMs(3, { baseMs: 1000, capMs: 5000, maxAttempts: 5 })).toBe(5000); // 8000 clamped
    expect(nextModelsRetryDelayMs(5, { maxAttempts: 5 })).toBeNull();
  });

  it('treats negative attempts as exhausted (no retry)', () => {
    expect(nextModelsRetryDelayMs(-1)).toBeNull();
  });
});

describe('scheduleAutoFetch', () => {
  it('runs immediately for the active provider', () => {
    const fn = vi.fn();

    const cleanup = scheduleAutoFetch(true, true, fn);

    expect(cleanup).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses requestIdleCallback when available and cancels the scheduled work on cleanup', () => {
    const fn = vi.fn();
    const cancelIdleCallback = vi.fn();
    const requestIdleCallback = vi.fn((cb: () => void) => {
      void cb;
      return 17;
    });

    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);

    const cleanup = scheduleAutoFetch(true, false, fn);

    expect(fn).not.toHaveBeenCalled();
    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    const scheduled = requestIdleCallback.mock.calls[0]?.[0] as (() => void) | undefined;
    expect(scheduled).toBeTypeOf('function');
    scheduled?.();
    expect(fn).toHaveBeenCalledTimes(1);

    cleanup?.();
    expect(cancelIdleCallback).toHaveBeenCalledWith(17);
  });

  it('falls back to window.setTimeout when requestIdleCallback is unavailable', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout, clearTimeout });

    const fn = vi.fn();

    scheduleAutoFetch(true, false, fn);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
