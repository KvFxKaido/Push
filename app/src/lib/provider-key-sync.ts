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

import { providerForApiKeyStorageKey, type RealProviderId } from '@push/lib/provider-definition';
import { invalidateEngineCapabilities } from './provider-engine-capability';

/**
 * Storage keys come from the provider registry for every provider the Worker
 * proxies with a user-entered API key. Returns null for non-provider keys
 * (e.g. `tavily_api_key` — the Worker's Tavily proxy is deliberately
 * client-key-only) so callers can no-op.
 */
export function providerForStorageKey(storageKey: string): RealProviderId | null {
  return providerForApiKeyStorageKey(storageKey);
}

function logSyncFailure(op: 'put' | 'delete', provider: string, detail: string): void {
  console.warn(
    JSON.stringify({ level: 'warn', event: 'provider_key_sync_failed', op, provider, detail }),
  );
}

// Sync ops are serialized through one chain: the call sites are
// fire-and-forget, so without ordering a rapid save→clear could land PUT
// after DELETE and leave the server holding a key the user removed
// (push-agent review, PR #890). Ops are rare; one global chain is enough.
let opChain: Promise<unknown> = Promise.resolve();
function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const next = opChain.then(op, op);
  opChain = next.then(
    () => {},
    () => {},
  );
  return next;
}

/**
 * Mirror a saved key to the server store. Resolves true on success. The
 * promise is intentionally awaitable (callers that want UI feedback can
 * await it), but the default call sites fire-and-log.
 */
export function syncProviderKeyToServer(provider: RealProviderId, key: string): Promise<boolean> {
  return enqueue(async () => {
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
  });
}

/** Remove the server-stored key when the local one is cleared. */
export function deleteProviderKeyFromServer(provider: RealProviderId): Promise<boolean> {
  return enqueue(async () => {
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
  });
}
