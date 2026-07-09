/**
 * Tests for the client engine-capability cache: optimistic-true when unknown,
 * storage seeding, background refresh population, and probe-failure
 * resilience (a dead probe must never disable the engine route).
 *
 * Mocks `./safe-storage` because the app test suite runs in the `node`
 * environment with no real localStorage (same pattern as
 * `delegation-mode-settings.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.mock('./safe-storage', () => ({
  safeStorageGet: vi.fn((key: string) => storage.get(key) ?? null),
  safeStorageSet: vi.fn((key: string, value: string) => {
    storage.set(key, value);
    return true;
  }),
}));

import {
  __resetEngineCapabilityCacheForTests,
  getProviderCapabilitySnapshot,
  isProviderEngineCapable,
  refreshEngineCapabilities,
  subscribeProviderCapabilities,
} from './provider-engine-capability';

const STORAGE_KEY = 'push:provider-engine-capabilities:v2';

function mockFetchOnce(body: unknown, ok = true): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function flushInflight(): Promise<void> {
  // The refresh is fire-and-logged; a few microtask hops let json() settle.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  storage.clear();
  __resetEngineCapabilityCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isProviderEngineCapable (client cache)', () => {
  it('is optimistically true when nothing is cached', () => {
    mockFetchOnce({ providers: {} });
    expect(isProviderEngineCapable('openrouter')).toBe(true);
  });

  it('seeds from storage before any fetch resolves', () => {
    storage.set(STORAGE_KEY, JSON.stringify({ providers: { openrouter: false, ollama: true } }));
    mockFetchOnce({ providers: {} });
    expect(isProviderEngineCapable('openrouter')).toBe(false);
    expect(isProviderEngineCapable('ollama')).toBe(true);
  });

  it('adopts the probe result and persists it', async () => {
    const fetchFn = mockFetchOnce({ providers: { openrouter: false, zen: true } });
    expect(isProviderEngineCapable('openrouter')).toBe(true); // kick refresh
    await flushInflight();
    expect(fetchFn).toHaveBeenCalledWith('/api/providers/engine-capabilities', { method: 'GET' });
    expect(isProviderEngineCapable('openrouter')).toBe(false);
    expect(isProviderEngineCapable('zen')).toBe(true);
    expect(JSON.parse(storage.get(STORAGE_KEY) ?? '{}')).toMatchObject({
      providers: { openrouter: false, zen: true },
    });
  });

  it('keeps the previous map and logs when the probe fails', async () => {
    storage.set(STORAGE_KEY, JSON.stringify({ providers: { openrouter: false } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetchOnce({}, false);
    refreshEngineCapabilities();
    await flushInflight();
    expect(isProviderEngineCapable('openrouter')).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('engine_capabilities_probe_failed');
  });

  it('does not refetch within the refresh interval', async () => {
    const fetchFn = mockFetchOnce({ providers: {} });
    isProviderEngineCapable('ollama');
    await flushInflight();
    isProviderEngineCapable('ollama');
    await flushInflight();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale v1 (flat boolean map) storage value', () => {
    // v1 lived under a different key; a hand-migrated flat map under the v2
    // key must not parse (no `providers` field) — optimistic default applies.
    storage.set(STORAGE_KEY, JSON.stringify({ openrouter: false }));
    mockFetchOnce({ providers: {} });
    expect(isProviderEngineCapable('openrouter')).toBe(true);
  });
});

describe('getProviderCapabilitySnapshot', () => {
  it('exposes sources and gatewayActive from the probe, and notifies subscribers', async () => {
    mockFetchOnce({
      providers: { anthropic: true, zen: false },
      sources: { anthropic: 'gateway-byok', zen: null },
      gatewayActive: true,
    });
    const seen: boolean[] = [];
    const unsubscribe = subscribeProviderCapabilities(() => {
      seen.push(getProviderCapabilitySnapshot().gatewayActive);
    });
    expect(getProviderCapabilitySnapshot().probed).toBe(false); // kicks refresh
    await flushInflight();
    const snap = getProviderCapabilitySnapshot();
    expect(snap.probed).toBe(true);
    expect(snap.gatewayActive).toBe(true);
    expect(snap.sources.anthropic).toBe('gateway-byok');
    expect(snap.sources.zen).toBeNull();
    expect(seen).toEqual([true]);
    unsubscribe();
  });

  it('drops unknown source enum values instead of trusting them', async () => {
    mockFetchOnce({
      providers: { anthropic: true },
      sources: { anthropic: 'quantum-vault' },
      gatewayActive: false,
    });
    getProviderCapabilitySnapshot();
    await flushInflight();
    expect(getProviderCapabilitySnapshot().sources.anthropic).toBeUndefined();
  });
});
