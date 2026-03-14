/**
 * Usage log persistence backed by IndexedDB.
 *
 * Replaces the `push_usage_log` localStorage key (1000-entry JSON array)
 * with an auto-increment IndexedDB object store indexed by timestamp.
 */

import { STORE, getAll, put, clear as clearStore } from './app-db';
import { safeStorageGet, safeStorageRemove } from './safe-storage';
import type { UsageEntry } from '@/hooks/useUsageTracking';

const LEGACY_KEY = 'push_usage_log';
const MAX_ENTRIES = 1000;

export async function loadUsageEntries(): Promise<UsageEntry[]> {
  try {
    const records = await getAll<UsageEntry & { id?: number }>(STORE.usageLog);
    if (records.length > 0) return records;
  } catch {
    // IndexedDB read failed — fall through to localStorage
  }

  // Legacy fallback
  try {
    const raw = safeStorageGet(LEGACY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries = parsed.filter(
      (e: unknown): e is UsageEntry =>
        typeof e === 'object' && e !== null &&
        typeof (e as UsageEntry).timestamp === 'number' &&
        typeof (e as UsageEntry).model === 'string',
    );
    // Migrate to IndexedDB
    if (entries.length > 0) {
      void migrateUsageEntries(entries);
    }
    return entries;
  } catch {
    return [];
  }
}

async function migrateUsageEntries(entries: UsageEntry[]): Promise<void> {
  try {
    const db = await import('./app-db');
    await db.putMany(STORE.usageLog, entries);
    safeStorageRemove(LEGACY_KEY);
    console.log(`[UsageStore] Migrated ${entries.length} entries to IndexedDB`);
  } catch {
    // Best-effort
  }
}

export async function appendUsageEntry(entry: UsageEntry): Promise<void> {
  try {
    await put(STORE.usageLog, entry);
    // Trim old entries if over limit
    const all = await getAll<UsageEntry & { id?: number }>(STORE.usageLog);
    if (all.length > MAX_ENTRIES) {
      const sorted = all.sort((a, b) => a.timestamp - b.timestamp);
      const toRemove = sorted.slice(0, all.length - MAX_ENTRIES);
      const { del } = await import('./app-db');
      for (const entry of toRemove) {
        if (entry.id != null) await del(STORE.usageLog, entry.id);
      }
    }
  } catch {
    // Best-effort
  }
}

export async function clearUsageEntries(): Promise<void> {
  try {
    await clearStore(STORE.usageLog);
  } catch {
    // Best-effort
  }
  safeStorageRemove(LEGACY_KEY);
}
