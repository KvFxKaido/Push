/**
 * Typed-memory helpers extracted from `useAgentDelegation.ts` as Phase 1 of the
 * Big Four useAgentDelegation extraction track (see
 * `docs/decisions/useAgentDelegation Coupling Recon.md`). Pure / best-effort-async
 * utilities that the hook's role-workflow seams (Sequential Explorer, Sequential
 * Coder, both Auditors, Task-Graph executors) all reach for when assembling
 * memory scopes, retrieving knownContext lines, and threading best-effort memory
 * writes through without crashing the delegation on a memory backend hiccup.
 */

import { buildRetrievedMemoryKnownContext } from '@/lib/context-memory';
import type { MemoryQuery, MemoryScope } from '@/types';

const MAX_RETRIEVED_MEMORY_RECORDS = 6;

/**
 * Build a memory scope for the active delegation. Returns null in scratch
 * mode (no repo) — memory records require a repo for scoping and retrieval.
 */
export function buildMemoryScope(
  chatId: string,
  repoFullName: string | null,
  branch: string | null | undefined,
  extras: Partial<MemoryScope> = {},
): MemoryScope | null {
  if (!repoFullName) return null;
  return {
    repoFullName,
    chatId,
    ...(branch ? { branch } : {}),
    ...extras,
  };
}

export function formatMemoryError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function logContextMemoryWarning(action: string, error: unknown): void {
  console.warn(
    `[context-memory] ${action} failed; continuing without persisted memory.`,
    formatMemoryError(error),
  );
}

export async function runContextMemoryBestEffort(
  action: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    logContextMemoryWarning(action, error);
  }
}

/**
 * Retrieve typed memory and return a compact knownContext line or null.
 * Callers splice the returned string into the delegation's `knownContext`.
 */
export async function retrieveMemoryKnownContextLine(
  scope: MemoryScope | null,
  role: MemoryQuery['role'],
  taskText: string,
  fileHints?: string[],
  extras: Partial<MemoryQuery> = {},
): Promise<string | null> {
  if (!scope) return null;
  try {
    const query: MemoryQuery = {
      repoFullName: scope.repoFullName,
      branch: scope.branch,
      chatId: scope.chatId,
      role,
      taskText,
      fileHints,
      maxRecords: MAX_RETRIEVED_MEMORY_RECORDS,
      ...extras,
    };
    const { line } = await buildRetrievedMemoryKnownContext(query);
    return line;
  } catch (error) {
    logContextMemoryWarning(`retrieving ${role} context`, error);
    return null;
  }
}

/** Merge a retrieved-memory line into an existing knownContext array. */
export function withMemoryContext(
  base: string[] | undefined,
  line: string | null,
): string[] | undefined {
  if (!line) return base;
  if (!base || base.length === 0) return [line];
  return [...base, line];
}
