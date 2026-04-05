/**
 * context-memory-store.ts
 *
 * In-memory storage for typed `MemoryRecord`s.
 *
 * Phase 1/2 scope: pure in-memory. Records live for the life of the page
 * session. The store shape is deliberately compatible with later IndexedDB
 * persistence — writes and reads go through a narrow async-friendly API so
 * callers don't need to change when a durable backend slots in.
 *
 * Scoping: records are keyed by their own `id`, and lookups filter by
 * repo/branch/chat. We keep a flat list rather than a nested structure so
 * retrieval can scan with arbitrary predicates without bookkeeping bugs.
 */

import type { MemoryRecord } from '@/types';

export interface ContextMemoryStore {
  write(record: MemoryRecord): void;
  writeMany(records: MemoryRecord[]): void;
  get(id: string): MemoryRecord | undefined;
  /** Return records that match a predicate. Returns a shallow copy array. */
  list(predicate?: (record: MemoryRecord) => boolean): MemoryRecord[];
  /** Update an existing record in place. No-op if `id` is unknown. */
  update(id: string, patch: Partial<MemoryRecord>): MemoryRecord | undefined;
  /** Remove a single record by id. */
  remove(id: string): void;
  /** Remove all records. */
  clear(): void;
  /** Current record count. */
  size(): number;
}

/**
 * Create an isolated in-memory store. Tests use this directly; production
 * code goes through `getDefaultMemoryStore()` below.
 */
export function createInMemoryStore(): ContextMemoryStore {
  const records = new Map<string, MemoryRecord>();

  return {
    write(record) {
      records.set(record.id, record);
    },
    writeMany(batch) {
      for (const record of batch) {
        records.set(record.id, record);
      }
    },
    get(id) {
      return records.get(id);
    },
    list(predicate) {
      const result: MemoryRecord[] = [];
      for (const record of records.values()) {
        if (!predicate || predicate(record)) result.push(record);
      }
      return result;
    },
    update(id, patch) {
      const existing = records.get(id);
      if (!existing) return undefined;
      const merged = { ...existing, ...patch };
      records.set(id, merged);
      return merged;
    },
    remove(id) {
      records.delete(id);
    },
    clear() {
      records.clear();
    },
    size() {
      return records.size;
    },
  };
}

let defaultStore: ContextMemoryStore | null = null;

/**
 * Process-wide default store. Used by the write/read helpers in
 * `context-memory.ts`. Tests can swap it via `setDefaultMemoryStore()`.
 */
export function getDefaultMemoryStore(): ContextMemoryStore {
  if (!defaultStore) {
    defaultStore = createInMemoryStore();
  }
  return defaultStore;
}

/** Used by tests to inject a fresh store. */
export function setDefaultMemoryStore(store: ContextMemoryStore | null): void {
  defaultStore = store;
}
