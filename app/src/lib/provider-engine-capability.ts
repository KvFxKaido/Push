/**
 * provider-engine-capability.ts — client cache of "can the durable engine
 * dispatch this provider server-side?" plus WHERE each provider's credential
 * resolves from.
 *
 * Engine-routed turns (inline delegation default / background mode) run in the
 * CoderJob DO, where provider calls authenticate ONLY via Worker-side
 * credentials — in-app Settings keys are browser-held and never reach the DO.
 * The Worker reports per-provider capability booleans plus credential
 * provenance (`/api/providers/engine-capabilities`, see
 * `worker-provider-capabilities.ts`); `resolveSendEngineTrigger` folds the
 * booleans into engine eligibility so turns on a non-capable provider fall
 * back to the foreground loop instead of starting a job that 401s in 0
 * seconds. Settings consumes the provenance map (`sources` / `gatewayActive`)
 * to render the truth about where keys live — gateway BYOK, Worker secret,
 * user key — instead of inferring unlock state from localStorage.
 *
 * Read model: synchronous from an in-memory snapshot seeded from localStorage,
 * with a background refresh kicked on first read (and re-kicked hourly).
 * Unknown — first-ever session, probe failed — resolves OPTIMISTICALLY to
 * `true`: that preserves the pre-probe routing exactly, and the job's own
 * keyMissingError still surfaces, so a probe outage can never silently disable
 * the engine route. The snapshot self-corrects on the next successful fetch.
 * Subscribers (React via useSyncExternalStore) are notified on every snapshot
 * change.
 */

import type { AIProviderType } from '@push/lib/provider-contract';
import { safeStorageGet, safeStorageSet } from './safe-storage';

// v2: the v1 key held a bare boolean map; the snapshot now carries provenance
// too. New key rather than a migration — the v1 value is an hour-stale cache
// of a free request, so re-fetching loses nothing.
const STORAGE_KEY = 'push:provider-engine-capabilities:v2';
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/** Mirrors ProviderCredentialSource in worker-provider-capabilities.ts. */
export type ProviderCredentialSource = 'gateway-byok' | 'binding' | 'worker-secret' | 'user-key';

export interface ProviderCapabilitySnapshot {
  providers: Partial<Record<AIProviderType, boolean>>;
  sources: Partial<Record<AIProviderType, ProviderCredentialSource | null>>;
  gatewayActive: boolean;
  /** False until the first successful probe (this session or from storage). */
  probed: boolean;
}

const EMPTY_SNAPSHOT: ProviderCapabilitySnapshot = {
  providers: {},
  sources: {},
  gatewayActive: false,
  probed: false,
};

let snapshot: ProviderCapabilitySnapshot | null = null;
let lastFetchStartedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

const SOURCE_VALUES: readonly ProviderCredentialSource[] = [
  'gateway-byok',
  'binding',
  'worker-secret',
  'user-key',
];

function parseSnapshot(raw: unknown): ProviderCapabilitySnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!obj.providers || typeof obj.providers !== 'object') return null;
  const providers: ProviderCapabilitySnapshot['providers'] = {};
  for (const [key, value] of Object.entries(obj.providers)) {
    if (typeof value === 'boolean') providers[key as AIProviderType] = value;
  }
  const sources: ProviderCapabilitySnapshot['sources'] = {};
  if (obj.sources && typeof obj.sources === 'object') {
    for (const [key, value] of Object.entries(obj.sources)) {
      if (value === null || SOURCE_VALUES.includes(value as ProviderCredentialSource)) {
        sources[key as AIProviderType] = value as ProviderCredentialSource | null;
      }
    }
  }
  return {
    providers,
    sources,
    gatewayActive: obj.gatewayActive === true,
    probed: true,
  };
}

function loadFromStorage(): ProviderCapabilitySnapshot | null {
  const raw = safeStorageGet(STORAGE_KEY);
  if (!raw) return null;
  try {
    return parseSnapshot(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

async function fetchCapabilities(): Promise<void> {
  const res = await fetch('/api/providers/engine-capabilities', { method: 'GET' });
  if (!res.ok) {
    throw new Error(`engine-capabilities probe returned ${res.status}`);
  }
  const parsed = parseSnapshot((await res.json()) as unknown);
  if (!parsed) {
    throw new Error('engine-capabilities probe returned an unexpected shape');
  }
  snapshot = parsed;
  safeStorageSet(
    STORAGE_KEY,
    JSON.stringify({
      providers: parsed.providers,
      sources: parsed.sources,
      gatewayActive: parsed.gatewayActive,
    }),
  );
  notify();
}

/**
 * Kick a background refresh if one isn't running and the last one is stale.
 * Errors are logged (not swallowed silently — PR self-review fire-and-forget
 * rule) and leave the previous snapshot in place.
 */
export function refreshEngineCapabilities(): void {
  if (typeof fetch !== 'function') return;
  const now = Date.now();
  if (inflight || now - lastFetchStartedAt < REFRESH_INTERVAL_MS) return;
  lastFetchStartedAt = now;
  inflight = fetchCapabilities()
    .catch((err) => {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'engine_capabilities_probe_failed',
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    })
    .finally(() => {
      inflight = null;
    });
}

function ensureSnapshot(): ProviderCapabilitySnapshot {
  if (snapshot === null) snapshot = loadFromStorage() ?? EMPTY_SNAPSHOT;
  refreshEngineCapabilities();
  return snapshot;
}

/**
 * Synchronous capability read for routing decisions. `true` when unknown —
 * see the module header for why optimistic is the safe default here.
 */
export function isProviderEngineCapable(provider: AIProviderType): boolean {
  return ensureSnapshot().providers[provider] ?? true;
}

/**
 * Full snapshot read (capability + credential provenance + gateway status),
 * for Settings. Kicks the same background refresh as the boolean read.
 */
export function getProviderCapabilitySnapshot(): ProviderCapabilitySnapshot {
  return ensureSnapshot();
}

/** Subscribe to snapshot changes (React: useSyncExternalStore). */
export function subscribeProviderCapabilities(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Force a refetch on the next opportunity — called after a provider key is
 * saved/removed (locally or to the server store), since that flips the
 * server's per-identity capability answer immediately.
 */
export function invalidateEngineCapabilities(): void {
  lastFetchStartedAt = 0;
  refreshEngineCapabilities();
}

/** Test seam: reset module state between cases. */
export function __resetEngineCapabilityCacheForTests(): void {
  snapshot = null;
  lastFetchStartedAt = 0;
  inflight = null;
  listeners.clear();
}
