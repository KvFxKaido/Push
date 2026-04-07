import type { MemoryRecord } from './runtime-contract';
import type { ContextMemoryStore } from './context-memory-store';
import { shouldPersist, isExpired } from './memory-persistence-policy';

/**
 * A decorator for ContextMemoryStore that enforces persistence and expiration policies.
 */
export function createPolicyEnforcedStore(store: ContextMemoryStore): ContextMemoryStore {
  return {
    async write(record: MemoryRecord) {
      if (shouldPersist(record)) {
        return await store.write(record);
      }
    },

    async writeMany(records: MemoryRecord[]) {
      const allowed = records.filter(shouldPersist);
      if (allowed.length > 0) {
        return await store.writeMany(allowed);
      }
    },

    async get(id: string) {
      const record = await store.get(id);
      if (record && isExpired(record)) {
        // Lazy cleanup could happen here, or we just hide it
        return undefined;
      }
      return record;
    },

    async list(predicate?: (record: MemoryRecord) => boolean) {
      const all = await store.list((record) => {
        if (isExpired(record)) return false;
        return !predicate || predicate(record);
      });
      return all;
    },

    async update(id: string, patch: Partial<MemoryRecord>) {
      const updated = await store.update(id, patch);
      if (updated && isExpired(updated)) {
        await store.remove(id);
        return undefined;
      }
      return updated;
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
      const expired = await store.list((record) => isExpired(record, now));
      for (const record of expired) {
        await store.remove(record.id);
      }
      return expired.length;
    },

    size() {
      // This might be slightly inaccurate if there are expired records
      // but it's computationally cheaper than a full list + filter
      return store.size();
    },
  };
}
