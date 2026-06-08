/**
 * settings-store.ts — the single client-side backend for unified web settings.
 *
 * The web app's non-secret preferences live in a server-authoritative document
 * keyed by GitHub identity (`GET/PUT /api/settings`, see
 * app/src/worker/settings-config.ts). This module is the shared resolver every
 * settings hook reads through, so the read / write / merge logic isn't
 * re-implemented per hook (runbook MVP step 2):
 *
 *   - **First paint / offline:** a synchronous in-memory cache, hydrated from a
 *     single localStorage mirror (`push:settings:v1`) at import time. Hooks read
 *     it synchronously in their `useState` initializer exactly as they read
 *     localStorage before — no first-paint regression.
 *   - **Server reconcile:** `loadSettingsFromServer()` runs once at boot. The
 *     server is authoritative (it has merged every device's writes), so its
 *     `values` are adopted — except keys with un-synced local edits, which are
 *     preserved so an offline write isn't clobbered on reconnect.
 *   - **Write-through:** `setSetting` updates the cache + mirror immediately and
 *     debounces a `PUT` of just the changed keys. The server shallow-merges
 *     them (last-write-wins per key).
 *
 * Each hook still owns its own canonical key + value shape; the cross-cutting
 * concern (cache, transport, merge, subscription) lives here once.
 */

import { resolveApiUrl } from './api-url';
import { safeStorageGet, safeStorageSet } from './safe-storage';

/** Canonical settings keys. One source of truth for the names hooks read. */
export const SETTINGS_KEYS = {
  appearanceChatMode: 'appearance.chatMode',
  appearanceByRepo: 'appearance.byRepo',
  appearanceDaemon: 'appearance.daemon',
  protectMainDefault: 'prefs.protectMain.default',
  protectMainByRepo: 'prefs.protectMain.byRepo',
  showToolActivity: 'prefs.showToolActivity',
  lastUsedModels: 'chat.lastUsedModels',
  reviewerAdvisoryProvider: 'reviewer.advisory.provider',
  reviewerAdvisoryModelByProvider: 'reviewer.advisory.modelByProvider',
  userProfile: 'profile',
} as const;

const MIRROR_KEY = 'push:settings:v1';
const SETTINGS_PATH = '/api/settings';
/** Coalesce a burst of writes into one PUT. */
const FLUSH_DEBOUNCE_MS = 400;

interface SettingsDoc {
  updatedAt: number;
  values: Record<string, unknown>;
}

function emptyDoc(): SettingsDoc {
  return { updatedAt: 0, values: {} };
}

function isSettingsDoc(value: unknown): value is SettingsDoc {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Record<string, unknown>;
  return (
    typeof doc.updatedAt === 'number' &&
    Number.isFinite(doc.updatedAt) &&
    !!doc.values &&
    typeof doc.values === 'object' &&
    !Array.isArray(doc.values)
  );
}

function hydrateFromMirror(): SettingsDoc {
  const raw = safeStorageGet(MIRROR_KEY);
  if (!raw) return emptyDoc();
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isSettingsDoc(parsed) ? parsed : emptyDoc();
  } catch {
    return emptyDoc();
  }
}

// Synchronous so the first React render reads real values, not defaults.
let cache: SettingsDoc = hydrateFromMirror();

// Keys written locally but not yet acknowledged by the server. Preserved across
// a reconcile so an offline edit survives the next load.
const dirty = new Set<string>();
const subscribers = new Map<string, Set<() => void>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let loadStarted = false;

function log(level: 'info' | 'warn', event: string, ctx: Record<string, unknown> = {}): void {
  // Mirrors the worker's structured-log shape; cheap and only on notable paths.
  console.log(JSON.stringify({ level, event, ...ctx }));
}

function persistMirror(): void {
  safeStorageSet(MIRROR_KEY, JSON.stringify(cache));
}

function notify(keys: Iterable<string>): void {
  for (const key of keys) {
    const subs = subscribers.get(key);
    if (subs) for (const cb of subs) cb();
  }
}

/** Synchronous read from the in-memory cache. `undefined` when unset. */
export function getSetting<T = unknown>(key: string): T | undefined {
  return cache.values[key] as T | undefined;
}

/**
 * Optimistically update a setting: cache + mirror immediately, then a debounced
 * `PUT` of the changed key. Subscribers for `key` are notified synchronously.
 */
export function setSetting(key: string, value: unknown): void {
  cache = {
    updatedAt: Math.max(Date.now(), cache.updatedAt + 1),
    values: { ...cache.values, [key]: value },
  };
  dirty.add(key);
  persistMirror();
  notify([key]);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (typeof window === 'undefined') return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushDirty();
  }, FLUSH_DEBOUNCE_MS);
}

/**
 * PUT the currently-dirty keys. On success they leave the dirty set; on failure
 * they stay so the next write or load retries them — an offline edit is never
 * silently dropped.
 */
async function flushDirty(): Promise<void> {
  if (typeof window === 'undefined' || dirty.size === 0) return;
  const sent = [...dirty];
  const values: Record<string, unknown> = {};
  for (const key of sent) values[key] = cache.values[key];
  try {
    const res = await fetch(resolveApiUrl(SETTINGS_PATH), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values }),
    });
    if (!res.ok) {
      log('warn', 'settings_flush_failed', { status: res.status, keys: sent.length });
      return;
    }
    for (const key of sent) dirty.delete(key);
  } catch (err) {
    log('warn', 'settings_flush_error', {
      message: err instanceof Error ? err.message : String(err),
      keys: sent.length,
    });
  }
}

/**
 * Reconcile the cache with the server once at boot. Flushes pending local
 * writes first (so the server has them before we adopt its view), then adopts
 * the authoritative document — preserving any key still dirty after the flush
 * (e.g. offline) so it isn't clobbered.
 */
export async function loadSettingsFromServer(): Promise<void> {
  if (typeof window === 'undefined' || loadStarted) return;
  loadStarted = true;
  await flushDirty();
  try {
    const res = await fetch(resolveApiUrl(SETTINGS_PATH), {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      log('warn', 'settings_load_failed', { status: res.status });
      return;
    }
    const doc = (await res.json()) as unknown;
    if (!isSettingsDoc(doc)) {
      log('warn', 'settings_load_invalid_shape', {});
      return;
    }
    const overlay: Record<string, unknown> = {};
    for (const key of dirty) overlay[key] = cache.values[key];
    const changed = new Set<string>([...Object.keys(cache.values), ...Object.keys(doc.values)]);
    cache = { updatedAt: doc.updatedAt, values: { ...doc.values, ...overlay } };
    persistMirror();
    notify(changed);
  } catch (err) {
    log('warn', 'settings_load_error', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Subscribe to changes for a single key. Returns an unsubscribe function. */
export function subscribeSetting(key: string, cb: () => void): () => void {
  let subs = subscribers.get(key);
  if (!subs) {
    subs = new Set();
    subscribers.set(key, subs);
  }
  subs.add(cb);
  return () => {
    subs?.delete(cb);
    if (subs && subs.size === 0) subscribers.delete(key);
  };
}

/** Test-only: reset module state between cases. */
export function __resetSettingsStoreForTests(): void {
  cache = emptyDoc();
  dirty.clear();
  subscribers.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  loadStarted = false;
}
