import type { MemoryRecord } from '@/types';
import type { ContextMemoryStore } from '@push/lib/context-memory-store';
import { STORE, put, putMany, get, getAll, del, clear, count } from './app-db';

export * from '@push/lib/context-memory-store';

/**
 * IndexedDB-backed storage for typed MemoryRecords in the web app.
 */
export function createIndexedDbStore(): ContextMemoryStore {
  return {
    async write(record: MemoryRecord) {
      await put(STORE.memoryRecords, record);
    },
    async writeMany(records: MemoryRecord[]) {
      await putMany(STORE.memoryRecords, records);
    },
    async get(id: string) {
      return get<MemoryRecord>(STORE.memoryRecords, id);
    },
    async list(predicate?: (record: MemoryRecord) => boolean) {
      const all = await getAll<MemoryRecord>(STORE.memoryRecords);
      if (!predicate) return all;
      return all.filter(predicate);
    },
    async update(id: string, patch: Partial<MemoryRecord>) {
      const existing = await this.get(id);
      if (!existing) return undefined;
      const merged = { ...existing, ...patch };
      await put(STORE.memoryRecords, merged);
      return merged;
    },
    async remove(id: string) {
      await del(STORE.memoryRecords, id);
    },
    async clear() {
      await clear(STORE.memoryRecords);
    },
    async size() {
      return count(STORE.memoryRecords);
    },
  };
}
