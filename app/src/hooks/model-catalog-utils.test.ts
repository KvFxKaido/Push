import { afterEach, describe, expect, it, vi } from 'vitest';

import { scheduleAutoFetch, shouldAutoFetchProviderModels } from './model-catalog-utils';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shouldAutoFetchProviderModels', () => {
  it('auto-fetches only when the provider is idle, empty, and error-free', () => {
    expect(
      shouldAutoFetchProviderModels({
        hasKey: true,
        modelCount: 0,
        loading: false,
        error: null,
      }),
    ).toBe(true);

    expect(
      shouldAutoFetchProviderModels({
        hasKey: true,
        modelCount: 0,
        loading: false,
        error: 'Request failed',
      }),
    ).toBe(false);
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
