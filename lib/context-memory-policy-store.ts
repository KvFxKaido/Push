import type { MemoryRecord } from './runtime-contract';
import type { ContextMemoryStore } from './context-memory-store';
import { normalizeRecordForPersistence } from './memory-persistence-policy';

/**
 * A decorator for ContextMemoryStore that enforces persistence and expiration policies.
 */
export function createPolicyEnforcedStore(store: ContextMemoryStore): ContextMemoryStore {
  async function normalizeOrRemove(
    record: MemoryRecord | undefined,
    now = Date.now(),
  ): Promise<MemoryRecord | undefined> {
    if (!record) return undefined;
    const normalized = normalizeRecordForPersistence(record, now);
    if (!normalized) {
      await store.remove(record.id);
      return undefined;
    }
    if (normalized !== record) {
      await store.write(normalized);
    }
    return normalized;
  }

  return {
    async write(record: MemoryRecord) {
      const normalized = normalizeRecordForPersistence(record);
      if (normalized) {
        return await store.write(normalized);
      }
    },

    async writeMany(records: MemoryRecord[]) {
      const allowed = records
        .map((record) => normalizeRecordForPersistence(record))
        .filter((record): record is MemoryRecord => Boolean(record));
      if (allowed.length > 0) {
        return await store.writeMany(allowed);
      }
    },

    async get(id: string) {
      const record = await store.get(id);
      return normalizeOrRemove(record);
    },

    async list(predicate?: (record: MemoryRecord) => boolean) {
      const all = await store.list();
      const visible: MemoryRecord[] = [];
      for (const record of all) {
        const normalized = await normalizeOrRemove(record);
        if (!normalized) continue;
        if (!predicate || predicate(normalized)) {
          visible.push(normalized);
        }
      }
      return visible;
    },

    async update(id: string, patch: Partial<MemoryRecord>) {
      const existing = await store.get(id);
      if (!existing) return undefined;
      const normalizedExisting = await normalizeOrRemove(existing);
      if (!normalizedExisting) return undefined;

      const merged = { ...normalizedExisting, ...patch };
      const normalized = normalizeRecordForPersistence(merged);
      if (!normalized) {
        await store.remove(id);
        return undefined;
      }
      await store.write(normalized);
      return normalized;
    },

    remove(id: string) {
      return store.remove(id);
    },

    clear() {
      return store.clear();
    },

    clearByRepo(repoFullName: string) {
      return store.clearByRepo(repoFullName);
    },

    clearByBranch(repoFullName: string, branch: string) {
      return store.clearByBranch(repoFullName, branch);
    },

    async pruneExpired(now = Date.now()) {
      const all = await store.list();
      const removable = all.filter((record) => normalizeRecordForPersistence(record, now) === null);
      for (const record of removable) {
        await store.remove(record.id);
      }
      return removable.length;
    },

    async size() {
      return (await this.list()).length;
    },
  };
}
