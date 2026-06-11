/**
 * Tests for the client→server provider-key mirror: storage-key derivation
 * (only real Worker providers sync), the wire calls, and the
 * capability-cache invalidation on success but not failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./provider-engine-capability', () => ({
  invalidateEngineCapabilities: vi.fn(),
}));

import { invalidateEngineCapabilities } from './provider-engine-capability';
import {
  deleteProviderKeyFromServer,
  providerForStorageKey,
  syncProviderKeyToServer,
} from './provider-key-sync';

beforeEach(() => {
  vi.mocked(invalidateEngineCapabilities).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('providerForStorageKey', () => {
  it('maps <provider>_api_key storage keys to Worker providers', () => {
    expect(providerForStorageKey('ollama_api_key')).toBe('ollama');
    expect(providerForStorageKey('openrouter_api_key')).toBe('openrouter');
    expect(providerForStorageKey('anthropic_api_key')).toBe('anthropic');
  });

  it('returns null for non-provider and CLI-only keys', () => {
    expect(providerForStorageKey('tavily_api_key')).toBeNull();
    expect(providerForStorageKey('mistral_api_key')).toBeNull();
    expect(providerForStorageKey('zai_api_key')).toBeNull();
    expect(providerForStorageKey('ollama_model')).toBeNull();
  });
});

describe('syncProviderKeyToServer', () => {
  it('PUTs the key and invalidates the capability cache on success', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    expect(await syncProviderKeyToServer('openrouter', 'sk-or-1')).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith('/api/settings/provider-keys', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openrouter', key: 'sk-or-1' }),
    });
    expect(invalidateEngineCapabilities).toHaveBeenCalledOnce();
  });

  it('logs and returns false on HTTP failure without invalidating', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503 })),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await syncProviderKeyToServer('ollama', 'k')).toBe(false);
    expect(String(warn.mock.calls[0][0])).toContain('provider_key_sync_failed');
    expect(invalidateEngineCapabilities).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('logs and returns false on network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await syncProviderKeyToServer('ollama', 'k')).toBe(false);
    expect(invalidateEngineCapabilities).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('deleteProviderKeyFromServer', () => {
  it('DELETEs and invalidates on success', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    expect(await deleteProviderKeyFromServer('google')).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith('/api/settings/provider-keys', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google' }),
    });
    expect(invalidateEngineCapabilities).toHaveBeenCalledOnce();
  });
});
