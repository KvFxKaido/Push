import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSettingsStoreForTests,
  getSetting,
  loadSettingsFromServer,
  setSetting,
  subscribeSetting,
} from './settings-store';

function storageMock() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
  };
}

beforeEach(() => {
  // No DOM in the node test env; stub a window with localStorage so the store's
  // mirror + fetch paths run instead of early-returning. No Capacitor → relative
  // /api/settings URL.
  vi.stubGlobal('window', { localStorage: storageMock() });
  __resetSettingsStoreForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('settings-store: cache + subscription', () => {
  it('returns undefined for an unset key', () => {
    expect(getSetting('nope')).toBeUndefined();
  });

  it('setSetting updates the cache and notifies subscribers for that key', () => {
    const cb = vi.fn();
    const unsub = subscribeSetting('k', cb);
    setSetting('k', { a: 1 });
    expect(getSetting('k')).toEqual({ a: 1 });
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    setSetting('k', { a: 2 });
    expect(cb).toHaveBeenCalledTimes(1); // no longer subscribed
  });

  it('does not notify subscribers of unrelated keys', () => {
    const cb = vi.fn();
    subscribeSetting('other', cb);
    setSetting('k', 1);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('settings-store: write-through', () => {
  it('debounces a single PUT of the changed keys', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ updatedAt: 1, values: {} }) });
    vi.stubGlobal('fetch', fetchMock);

    setSetting('a', 1);
    setSetting('b', 2);
    expect(fetchMock).not.toHaveBeenCalled(); // debounced

    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/settings');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ values: { a: 1, b: 2 } });
  });
});

describe('settings-store: server reconcile', () => {
  it('adopts server values for keys with no un-synced local edit', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      // flushDirty PUT, then the GET
      .mockResolvedValueOnce({ ok: true, json: async () => ({ updatedAt: 5, values: {} }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ updatedAt: 10, values: { k: 'serverK', extra: 'e' } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    setSetting('k', 'localK');
    await loadSettingsFromServer();

    // flush succeeded → k no longer dirty → server value wins
    expect(getSetting('k')).toBe('serverK');
    expect(getSetting('extra')).toBe('e');
  });

  it('preserves an offline (un-flushed) local edit across reconcile', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      // flushDirty PUT fails → key stays dirty
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ updatedAt: 10, values: { k: 'serverK', extra: 'e' } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    setSetting('k', 'localK');
    await loadSettingsFromServer();

    expect(getSetting('k')).toBe('localK'); // dirty overlay preserved
    expect(getSetting('extra')).toBe('e'); // server-only key still adopted
  });

  it('leaves the cache in place when the load fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetchMock);
    setSetting('k', 'localK');
    await loadSettingsFromServer();
    expect(getSetting('k')).toBe('localK');
  });
});
