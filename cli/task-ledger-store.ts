/**
 * CLI file adapter for the shared task ledger.
 *
 * The scope is repo + branch, never sessionId, so a fresh CLI process or
 * daemon session resumes the same external task position. The schema and
 * validation stay in lib/task-ledger.ts; this module owns Node filesystem I/O.
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createTaskLedgerSnapshot,
  normalizeTaskLedgerScope,
  normalizeTaskLedgerSteps,
  taskLedgerScopeKey,
  type TaskLedgerScope,
  type TaskLedgerSnapshot,
  type TaskLedgerStep,
} from '../lib/task-ledger.ts';
import { renameWithRetry } from './fs-atomic.ts';

export function getTaskLedgerStoreRoot(): string {
  return process.env.PUSH_TASK_LEDGER_DIR || path.join(os.homedir(), '.push', 'task-ledgers');
}

export function taskLedgerFilePath(scope: TaskLedgerScope): string {
  const digest = createHash('sha256').update(taskLedgerScopeKey(scope)).digest('hex');
  return path.join(getTaskLedgerStoreRoot(), `${digest}.json`);
}

export async function loadTaskLedger(scope: TaskLedgerScope): Promise<TaskLedgerSnapshot> {
  const normalizedScope = normalizeTaskLedgerScope(scope);
  const file = taskLedgerFilePath(normalizedScope);
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<TaskLedgerSnapshot>;
    return createTaskLedgerSnapshot(
      normalizedScope,
      normalizeTaskLedgerSteps(parsed.steps),
      typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : 0,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return createTaskLedgerSnapshot(normalizedScope, [], 0);
    }
    throw error;
  }
}

export async function saveTaskLedger(
  scope: TaskLedgerScope,
  steps: readonly TaskLedgerStep[],
): Promise<TaskLedgerSnapshot> {
  const snapshot = createTaskLedgerSnapshot(scope, steps);
  const root = getTaskLedgerStoreRoot();
  const file = taskLedgerFilePath(snapshot.scope);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  await fs.writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await renameWithRetry(tmp, file);
  return snapshot;
}

export async function clearTaskLedger(scope: TaskLedgerScope): Promise<TaskLedgerSnapshot> {
  return saveTaskLedger(scope, []);
}
