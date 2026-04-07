import type { MemoryRecord, MemoryRecordKind } from './runtime-contract';

export interface PersistencePolicy {
  persist: boolean;
  ttlDays?: number;
  truncateDetail?: boolean;
}

export const MEMORY_PERSISTENCE_POLICY: Record<MemoryRecordKind, PersistencePolicy> = {
  finding: { persist: true, ttlDays: 30, truncateDetail: true },
  fact: { persist: true, ttlDays: 30, truncateDetail: true },
  decision: { persist: true, ttlDays: 30, truncateDetail: true },
  task_outcome: { persist: true, ttlDays: 7, truncateDetail: true },
  verification_result: { persist: true, ttlDays: 3, truncateDetail: true },
  file_change: { persist: false },
  symbol_trace: { persist: true, ttlDays: 14, truncateDetail: true },
  dependency_trace: { persist: true, ttlDays: 14, truncateDetail: true },
};

export function getRecordPolicy(kind: MemoryRecordKind): PersistencePolicy {
  return MEMORY_PERSISTENCE_POLICY[kind] || { persist: false };
}

export function isExpired(record: MemoryRecord, now = Date.now()): boolean {
  const policy = getRecordPolicy(record.kind);
  if (!policy.ttlDays) return false;

  const ttlMs = policy.ttlDays * 24 * 60 * 60 * 1000;
  return now - record.source.createdAt > ttlMs;
}

export function shouldPersist(record: MemoryRecord): boolean {
  const policy = getRecordPolicy(record.kind);
  return policy.persist && !isExpired(record);
}
