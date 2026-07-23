/**
 * Shared task-position ledger.
 *
 * The web historically called this the model todo list. #1547 promotes that
 * same artifact into the cross-surface task ledger: a branch-scoped checklist
 * that survives chat/run boundaries, can be re-injected after compaction, and
 * gives drift diagnostics an external statement of the lead's current step.
 *
 * Storage stays shell-local. This module owns only the durable scope, schema,
 * normalization, formatting helpers, and mutation-intent hint shared by Web
 * and CLI.
 */

export const TASK_LEDGER_VERSION = 1 as const;
export const MAX_TASK_LEDGER_ITEMS = 30;
export const MAX_TASK_LEDGER_CONTENT_LENGTH = 500;

export type TaskLedgerStepStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskLedgerStep {
  id: string;
  /** Imperative form: "Fix the auth bug". */
  content: string;
  /** Present-continuous form shown while the item is active. */
  activeForm: string;
  status: TaskLedgerStepStatus;
}

export interface TaskLedgerScope {
  repoFullName: string;
  branch: string;
}

export interface TaskLedgerSnapshot {
  version: typeof TASK_LEDGER_VERSION;
  scope: TaskLedgerScope;
  steps: TaskLedgerStep[];
  /** Monotonic storage revision used by adapters that support CAS writes. */
  revision: number;
  updatedAt: number;
}

/**
 * Normalize a workspace identity into the durable ledger scope. Repository
 * names are case-insensitive; branch names are not. Detached/gitless workspaces
 * retain explicit fallback labels instead of collapsing onto a session id.
 */
export function normalizeTaskLedgerScope(input: {
  repoFullName?: string | null;
  branch?: string | null;
}): TaskLedgerScope {
  const repoFullName = input.repoFullName?.trim().toLowerCase() || 'unknown';
  const branch = input.branch?.trim() || 'detached';
  return { repoFullName, branch };
}

/** Stable, human-inspectable key. Storage adapters may hash it for filenames. */
export function taskLedgerScopeKey(scope: TaskLedgerScope): string {
  const normalized = normalizeTaskLedgerScope(scope);
  return `${normalized.repoFullName}\n${normalized.branch}`;
}

/**
 * Validate and clamp an untrusted persisted checklist. The first in-progress
 * step wins and later active steps are demoted, preserving the one-current-step
 * invariant even when an older client or hand-edited store drifted.
 */
export function normalizeTaskLedgerSteps(data: unknown): TaskLedgerStep[] {
  if (!Array.isArray(data)) return [];

  const cleaned: TaskLedgerStep[] = [];
  const seenIds = new Set<string>();
  let inProgressKept = false;

  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== 'string' ||
      typeof record.content !== 'string' ||
      typeof record.activeForm !== 'string'
    ) {
      continue;
    }

    const rawId = record.id.trim();
    const content = record.content.trim().slice(0, MAX_TASK_LEDGER_CONTENT_LENGTH);
    const activeForm = record.activeForm.trim().slice(0, MAX_TASK_LEDGER_CONTENT_LENGTH);
    if (!rawId || !content || !activeForm) continue;

    let status: TaskLedgerStepStatus =
      record.status === 'in_progress' || record.status === 'completed' ? record.status : 'pending';
    if (status === 'in_progress') {
      if (inProgressKept) status = 'pending';
      else inProgressKept = true;
    }

    let id = rawId.slice(0, 96);
    let suffix = 1;
    while (seenIds.has(id)) id = `${rawId.slice(0, 88)}-${suffix++}`;
    seenIds.add(id);
    cleaned.push({ id, content, activeForm, status });
    if (cleaned.length >= MAX_TASK_LEDGER_ITEMS) break;
  }

  return cleaned;
}

export function createTaskLedgerSnapshot(
  scope: TaskLedgerScope,
  steps: readonly TaskLedgerStep[],
  updatedAt = Date.now(),
  revision = 0,
): TaskLedgerSnapshot {
  return {
    version: TASK_LEDGER_VERSION,
    scope: normalizeTaskLedgerScope(scope),
    steps: normalizeTaskLedgerSteps(steps),
    revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
    updatedAt,
  };
}

export function taskLedgerCounts(steps: readonly TaskLedgerStep[]): {
  completed: number;
  inProgress: number;
  pending: number;
} {
  let completed = 0;
  let inProgress = 0;
  let pending = 0;
  for (const step of steps) {
    if (step.status === 'completed') completed += 1;
    else if (step.status === 'in_progress') inProgress += 1;
    else pending += 1;
  }
  return { completed, inProgress, pending };
}

/**
 * Conservative hint for the no-mutation drift signal. Read/review/explain
 * requests stay out; tasks with an explicit change verb opt in.
 */
export function taskLikelyRequiresMutation(task: string): boolean {
  return /\b(?:add|address|build|change|close|create|delete|edit|fix|implement|migrate|modify|move|pick\s+up|refactor|remove|rename|replace|resolve|restore|ship|update|wire|work\s+on|write)\b/i.test(
    task,
  );
}
