/**
 * context-memory-invalidation.ts
 *
 * Freshness transitions for typed context memory records.
 *
 * Phase 3 scope:
 * - mark file-derived memory stale when matching files change
 * - mark transitive descendants stale through `derivedFrom`
 * - expire branch-scoped memory when leaving a branch
 * - stale older verification records when superseded by a newer result
 */

import type { MemoryRecord, MemoryScope } from '@/types';
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

function setFreshness(
  store: ContextMemoryStore,
  record: MemoryRecord,
  freshness: MemoryRecord['freshness'],
  reason: string,
  timestamp: number,
): boolean {
  if (record.freshness === freshness) return false;
  store.update(record.id, {
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

export function invalidateMemoryForChangedFiles(
  input: InvalidateMemoryForChangedFilesInput,
): number {
  const normalizedPaths = new Set(
    input.changedPaths
      .map(normalizePath)
      .filter(Boolean),
  );
  if (normalizedPaths.size === 0) return 0;

  const store = input.store ?? getDefaultMemoryStore();
  const timestamp = input.timestamp ?? Date.now();
  const scopedRecords = store.list((record) => matchesScope(record, input.scope));

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
    if (setFreshness(store, record, 'stale', reason, timestamp)) {
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

export function expireBranchScopedMemory(
  input: ExpireBranchScopedMemoryInput,
): number {
  const store = input.store ?? getDefaultMemoryStore();
  const timestamp = input.timestamp ?? Date.now();
  const branchScopedRecords = store.list((record) =>
    record.scope.repoFullName === input.repoFullName
    && record.scope.branch === input.branch,
  );

  let changedCount = 0;
  for (const record of branchScopedRecords) {
    if (setFreshness(store, record, 'expired', `Branch changed away from ${input.branch}`, timestamp)) {
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

export function supersedeVerificationMemory(
  input: SupersedeVerificationMemoryInput,
): number {
  const store = input.store ?? getDefaultMemoryStore();
  const timestamp = input.timestamp ?? Date.now();
  const normalizedCommand = input.command ? normalizeCommand(input.command) : null;
  const checkTag = `check:${input.checkId}`;
  const commandTag = normalizedCommand ? `command:${normalizedCommand}` : null;
  const candidates = store.list((record) =>
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
    if (setFreshness(store, record, 'stale', `Superseded by newer verification for ${input.checkId}`, timestamp)) {
      changedCount++;
    }
  }

  return changedCount;
}
