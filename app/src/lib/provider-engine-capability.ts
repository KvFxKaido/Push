/**
 * provider-engine-capability.ts — client cache of "can the durable engine
 * dispatch this provider server-side?".
 *
 * Engine-routed turns (inline delegation default / background mode) run in the
 * CoderJob DO, where provider calls authenticate ONLY via Worker-side
 * credentials — in-app Settings keys are browser-held and never reach the DO.
 * The Worker reports per-provider capability booleans
 * (`/api/providers/engine-capabilities`, see
 * `worker-provider-capabilities.ts`); `resolveSendEngineTrigger` folds this
 * into engine eligibility so turns on a non-capable provider fall back to the
 * foreground loop instead of starting a job that 401s in 0 seconds.
 *
 * Read model: synchronous from an in-memory map seeded from localStorage, with
 * a background refresh kicked on first read (and re-kicked hourly). Unknown —
 * first-ever session, probe failed — resolves OPTIMISTICALLY to `true`: that
 * preserves the pre-probe routing exactly, and the job's own keyMissingError
 * still surfaces, so a probe outage can never silently disable the engine
 * route. The map self-corrects on the next successful fetch.
 */

import type { AIProviderType } from '@push/lib/provider-contract';
import { safeStorageGet, safeStorageSet } from './safe-storage';

const STORAGE_KEY = 'push:provider-engine-capabilities';
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

type CapabilityMap = Partial<Record<AIProviderType, boolean>>;

let cache: CapabilityMap | null = null;
let lastFetchStartedAt = 0;
let inflight: Promise<void> | null = null;

function loadFromStorage(): CapabilityMap | null {
  const raw = safeStorageGet(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const map: CapabilityMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') map[key as AIProviderType] = value;
    }
    return map;
  } catch {
    return null;
  }
}

async function fetchCapabilities(): Promise<void> {
  const res = await fetch('/api/providers/engine-capabilities', { method: 'GET' });
  if (!res.ok) {
    throw new Error(`engine-capabilities probe returned ${res.status}`);
  }
  const body = (await res.json()) as { providers?: Record<string, unknown> };
  if (!body.providers || typeof body.providers !== 'object') {
    throw new Error('engine-capabilities probe returned an unexpected shape');
  }
  const map: CapabilityMap = {};
  for (const [key, value] of Object.entries(body.providers)) {
    if (typeof value === 'boolean') map[key as AIProviderType] = value;
  }
  cache = map;
  safeStorageSet(STORAGE_KEY, JSON.stringify(map));
}

/**
 * Kick a background refresh if one isn't running and the last one is stale.
 * Errors are logged (not swallowed silently — PR self-review fire-and-forget
 * rule) and leave the previous map in place.
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

/**
 * Synchronous capability read for routing decisions. `true` when unknown —
 * see the module header for why optimistic is the safe default here.
 */
export function isProviderEngineCapable(provider: AIProviderType): boolean {
  if (cache === null) cache = loadFromStorage() ?? {};
  refreshEngineCapabilities();
  return cache[provider] ?? true;
}

/** Test seam: reset module state between cases. */
export function __resetEngineCapabilityCacheForTests(): void {
  cache = null;
  lastFetchStartedAt = 0;
  inflight = null;
}
