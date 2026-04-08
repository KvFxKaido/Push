import type { MemoryRecord, MemoryRecordKind } from './runtime-contract';

export interface PersistencePolicy {
  persist: boolean;
  ttlDays?: number;
  truncateDetail?: boolean;
}

export const PERSISTED_DETAIL_MAX_CHARS = 800;

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

function truncatePersistedDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const trimmed = detail.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= PERSISTED_DETAIL_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, Math.max(0, PERSISTED_DETAIL_MAX_CHARS - 1)).trimEnd()}…`;
}

export function normalizeRecordForPersistence(
  record: MemoryRecord,
  now = Date.now(),
): MemoryRecord | null {
  const policy = getRecordPolicy(record.kind);
  if (!policy.persist || isExpired(record, now)) return null;

  let changed = false;
  let nextDetail = record.detail;
  if (policy.truncateDetail) {
    const truncatedDetail = truncatePersistedDetail(record.detail);
    if (truncatedDetail !== record.detail) {
      nextDetail = truncatedDetail;
      changed = true;
    }
  }

  if (!changed) return record;
  return {
    ...record,
    detail: nextDetail,
  };
}
