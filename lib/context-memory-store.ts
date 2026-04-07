/**
 * In-memory storage for typed `MemoryRecord`s.
 *
 * Phase 1/2 scope: pure in-memory. Records live for the life of the process
 * session. The store shape is deliberately compatible with later durable
 * backends so callers do not need to change when persistence is added.
 */

import type { MemoryRecord } from './runtime-contract';

export interface ContextMemoryStore {
  write(record: MemoryRecord): void | Promise<void>;
  writeMany(records: MemoryRecord[]): void | Promise<void>;
  get(id: string): MemoryRecord | undefined | Promise<MemoryRecord | undefined>;
  list(predicate?: (record: MemoryRecord) => boolean): MemoryRecord[] | Promise<MemoryRecord[]>;
  update(id: string, patch: Partial<MemoryRecord>): MemoryRecord | undefined | Promise<MemoryRecord | undefined>;
  remove(id: string): void | Promise<void>;
  clear(): void | Promise<void>;
  size(): number | Promise<number>;
}

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

export function getDefaultMemoryStore(): ContextMemoryStore {
  if (!defaultStore) {
    defaultStore = createInMemoryStore();
  }
  return defaultStore;
}

export function setDefaultMemoryStore(store: ContextMemoryStore | null): void {
  defaultStore = store;
}
