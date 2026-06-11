/**
 * provider-key-sync.ts — mirror in-app provider keys to the server store.
 *
 * Saving a key in Settings writes localStorage (the foreground loop's
 * per-request source, unchanged) AND mirrors it to the identity-keyed
 * server store (`PUT /api/settings/provider-keys`, encrypted at rest — see
 * worker/user-secrets.ts). The server copy is what lets engine-routed turns
 * (CoderJob DO, adopted runs) authenticate with the key you typed on your
 * phone, where `wrangler secret put` isn't an option.
 *
 * Best-effort by design: a failed mirror never blocks the local save (the
 * foreground path still works), but it is logged loudly and the engine
 * capability map is only refreshed on success — so the routing layer's view
 * of "engine-capable" can't drift ahead of what the server actually holds.
 */

import type { AIProviderType } from '@push/lib/provider-contract';
import { isKnownProvider } from '@push/lib/provider-contract';
import { invalidateEngineCapabilities } from './provider-engine-capability';

/**
 * Storage keys follow `<provider>_api_key` for every provider the Worker
 * proxies (verified against the useApiKeyConfig call sites). Returns null
 * for non-provider keys (e.g. `tavily_api_key` — the Worker's Tavily proxy
 * is deliberately client-key-only) so callers can no-op.
 */
export function providerForStorageKey(storageKey: string): AIProviderType | null {
  if (!storageKey.endsWith('_api_key')) return null;
  const candidate = storageKey.slice(0, -'_api_key'.length);
  return isKnownProvider(candidate) ? candidate : null;
}

function logSyncFailure(op: 'put' | 'delete', provider: string, detail: string): void {
  console.warn(
    JSON.stringify({ level: 'warn', event: 'provider_key_sync_failed', op, provider, detail }),
  );
}

/**
 * Mirror a saved key to the server store. Resolves true on success. The
 * promise is intentionally awaitable (callers that want UI feedback can
 * await it), but the default call sites fire-and-log.
 */
export async function syncProviderKeyToServer(
  provider: AIProviderType,
  key: string,
): Promise<boolean> {
  try {
    const res = await fetch('/api/settings/provider-keys', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, key }),
    });
    if (!res.ok) {
      logSyncFailure('put', provider, `HTTP ${res.status}`);
      return false;
    }
    invalidateEngineCapabilities();
    return true;
  } catch (err) {
    logSyncFailure('put', provider, err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Remove the server-stored key when the local one is cleared. */
export async function deleteProviderKeyFromServer(provider: AIProviderType): Promise<boolean> {
  try {
    const res = await fetch('/api/settings/provider-keys', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider }),
    });
    if (!res.ok) {
      logSyncFailure('delete', provider, `HTTP ${res.status}`);
      return false;
    }
    invalidateEngineCapabilities();
    return true;
  } catch (err) {
    logSyncFailure('delete', provider, err instanceof Error ? err.message : String(err));
    return false;
  }
}
