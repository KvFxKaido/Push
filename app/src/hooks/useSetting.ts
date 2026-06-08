import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { getSetting, setSetting, subscribeSetting } from '@/lib/settings-store';

/**
 * Read/write a single unified setting with first-paint-safe reads and live
 * updates. Backed by the shared settings store: the value comes synchronously
 * from the in-memory cache (hydrated from the localStorage mirror) and re-renders
 * when a server reconcile or another hook changes the same key.
 *
 * `coerce` validates/normalizes the raw stored JSON (defending against a
 * malformed server doc); the raw cached value is what `useSyncExternalStore`
 * snapshots, so coercion runs in a memo and never destabilizes the snapshot.
 * `legacyFallback` reads a pre-migration localStorage value once, so a user's
 * existing preference survives the first load and is persisted to the doc on
 * first write.
 */
export function useSetting<T>(
  key: string,
  fallback: T,
  options?: {
    coerce?: (raw: unknown) => T | undefined;
    legacyFallback?: () => T | undefined;
  },
): [T, (next: T) => void] {
  const raw = useSyncExternalStore(
    (cb) => subscribeSetting(key, cb),
    () => getSetting(key),
    () => undefined,
  );

  const coerce = options?.coerce;
  const legacyFallback = options?.legacyFallback;
  const value = useMemo(() => {
    if (raw !== undefined) {
      const c = coerce ? coerce(raw) : (raw as T);
      if (c !== undefined) return c;
    }
    const legacy = legacyFallback?.();
    return legacy !== undefined ? legacy : fallback;
  }, [raw, coerce, legacyFallback, fallback]);

  const set = useCallback((next: T) => setSetting(key, next), [key]);

  return [value, set];
}
