/**
 * Freshness transitions for typed context memory records.
 */

import type { MemoryRecord, MemoryScope } from './runtime-contract';
import { getDefaultMemoryStore, type ContextMemoryStore } from './context-memory-store';

function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/^\/workspace\//i, '')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .toLowerCase();
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function matchesScope(record: MemoryRecord, scope: Pick<MemoryScope, 'repoFullName' | 'branch' | 'chatId'>): boolean {
  if (record.scope.repoFullName !== scope.repoFullName) return false;
  if (scope.branch && record.scope.branch && record.scope.branch !== scope.branch) return false;
  if (scope.chatId && record.scope.chatId && record.scope.chatId !== scope.chatId) return false;
  return true;
}

async function setFreshness(
  store: ContextMemoryStore,
  record: MemoryRecord,
  freshness: MemoryRecord['freshness'],
  reason: string,
  timestamp: number,
): Promise<boolean> {
  if (record.freshness === freshness) return false;
  await store.update(record.id, {
    freshness,
    invalidatedAt: timestamp,
    invalidationReason: reason,
  });
  return true;
}

function collectDescendantIds(records: MemoryRecord[], seedIds: Set<string>): Set<string> {
  const descendantIds = new Set<string>();
  const queue = [...seedIds];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    for (const record of records) {
      if (descendantIds.has(record.id) || seedIds.has(record.id)) continue;
      if (!record.derivedFrom?.includes(currentId)) continue;
      descendantIds.add(record.id);
      queue.push(record.id);
    }
  }

  return descendantIds;
}

export interface InvalidateMemoryForChangedFilesInput {
  scope: Pick<MemoryScope, 'repoFullName' | 'branch' | 'chatId'>;
  changedPaths: string[];
  reason?: string;
  store?: ContextMemoryStore;
  timestamp?: number;
}

export async function invalidateMemoryForChangedFiles(
  input: InvalidateMemoryForChangedFilesInput,
): Promise<number> {
  const normalizedPaths = new Set(
    input.changedPaths
      .map(normalizePath)
      .filter(Boolean),
  );
  if (normalizedPaths.size === 0) return 0;

  const store = input.store ?? getDefaultMemoryStore();
  const timestamp = input.timestamp ?? Date.now();
  const scopedRecords = await store.list((record) => matchesScope(record, input.scope));

  const directlyAffectedIds = new Set<string>();
  for (const record of scopedRecords) {
    if (record.freshness === 'expired') continue;
    const relatedFiles = record.relatedFiles ?? [];
    if (relatedFiles.some((path) => normalizedPaths.has(normalizePath(path)))) {
      directlyAffectedIds.add(record.id);
    }
  }

  if (directlyAffectedIds.size === 0) return 0;

  const descendantIds = collectDescendantIds(scopedRecords, directlyAffectedIds);
  const allAffectedIds = new Set([...directlyAffectedIds, ...descendantIds]);
  const reason = input.reason ?? `Files changed: ${[...normalizedPaths].slice(0, 3).join(', ')}`;

  let changedCount = 0;
  for (const record of scopedRecords) {
    if (!allAffectedIds.has(record.id)) continue;
    if (await setFreshness(store, record, 'stale', reason, timestamp)) {
      changedCount++;
    }
  }

  return changedCount;
}

export interface ExpireBranchScopedMemoryInput {
  repoFullName: string;
  branch: string;
  store?: ContextMemoryStore;
  timestamp?: number;
}

export async function expireBranchScopedMemory(
  input: ExpireBranchScopedMemoryInput,
): Promise<number> {
  const store = input.store ?? getDefaultMemoryStore();
  const timestamp = input.timestamp ?? Date.now();
  const branchScopedRecords = await store.list((record) =>
    record.scope.repoFullName === input.repoFullName
    && record.scope.branch === input.branch,
  );

  let changedCount = 0;
  for (const record of branchScopedRecords) {
    if (await setFreshness(store, record, 'expired', `Branch changed away from ${input.branch}`, timestamp)) {
      changedCount++;
    }
  }

  return changedCount;
}

export interface SupersedeVerificationMemoryInput {
  scope: Pick<MemoryScope, 'repoFullName' | 'branch' | 'chatId'>;
  checkId: string;
  command?: string;
  store?: ContextMemoryStore;
  timestamp?: number;
}

export async function supersedeVerificationMemory(
  input: SupersedeVerificationMemoryInput,
): Promise<number> {
  const store = input.store ?? getDefaultMemoryStore();
  const timestamp = input.timestamp ?? Date.now();
  const normalizedCommand = input.command ? normalizeCommand(input.command) : null;
  const checkTag = `check:${input.checkId}`;
  const commandTag = normalizedCommand ? `command:${normalizedCommand}` : null;
  const candidates = await store.list((record) =>
    record.kind === 'verification_result'
    && matchesScope(record, input.scope)
    && record.freshness !== 'expired',
  );

  let changedCount = 0;
  for (const record of candidates) {
    const tags = new Set(record.tags ?? []);
    const matchesCheck = tags.has(checkTag) || record.source.label === `Verification: ${input.checkId}`;
    const matchesCommand = commandTag ? tags.has(commandTag) : false;
    if (!matchesCheck && !matchesCommand) continue;
    if (await setFreshness(store, record, 'stale', `Superseded by newer verification for ${input.checkId}`, timestamp)) {
      changedCount++;
    }
  }

  return changedCount;
}
