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

const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

export interface SaveTaskLedgerOptions {
  expectedRevision?: number;
}

export class TaskLedgerRevisionConflictError extends Error {
  readonly code = 'TASK_LEDGER_REVISION_CONFLICT';

  constructor(
    readonly expectedRevision: number,
    readonly current: TaskLedgerSnapshot,
  ) {
    super(
      `Task ledger changed concurrently (expected revision ${expectedRevision}, found ${current.revision})`,
    );
    this.name = 'TaskLedgerRevisionConflictError';
  }
}

export function getTaskLedgerStoreRoot(): string {
  return process.env.PUSH_TASK_LEDGER_DIR || path.join(os.homedir(), '.push', 'task-ledgers');
}

export function taskLedgerFilePath(scope: TaskLedgerScope): string {
  const digest = createHash('sha256').update(taskLedgerScopeKey(scope)).digest('hex');
  return path.join(getTaskLedgerStoreRoot(), `${digest}.json`);
}

function emptySnapshot(scope: TaskLedgerScope): TaskLedgerSnapshot {
  return createTaskLedgerSnapshot(scope, [], 0, 0);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function removeAbandonedLock(lockFile: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(lockFile, 'utf8');
    const parsed = JSON.parse(raw) as { pid?: unknown };
    const pid = typeof parsed.pid === 'number' ? parsed.pid : 0;
    if (isProcessAlive(pid)) return false;
    await fs.unlink(lockFile);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    // A just-created lock can briefly be empty before its owner writes the
    // metadata. Only reap an unreadable lock after it is demonstrably stale.
    try {
      const stat = await fs.stat(lockFile);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.unlink(lockFile);
        return true;
      }
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return true;
    }
    return false;
  }
}

async function acquireTaskLedgerLock(file: string): Promise<() => Promise<void>> {
  const lockFile = `${file}.lock`;
  const startedAt = Date.now();
  while (true) {
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(lockFile, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await removeAbandonedLock(lockFile)) continue;
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for task ledger lock: ${lockFile}`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      return async () => {
        await handle.close();
        await fs.unlink(lockFile).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.unlink(lockFile).catch(() => undefined);
      throw error;
    }
  }
}

async function quarantineCorruptLedger(
  file: string,
  scope: TaskLedgerScope,
  error: unknown,
): Promise<void> {
  const quarantineFile = `${file}.corrupt-${Date.now()}-${randomBytes(4).toString('hex')}`;
  let quarantined = false;
  try {
    await fs.rename(file, quarantineFile);
    quarantined = true;
  } catch (renameError) {
    if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') {
      await fs.unlink(file).catch(() => undefined);
    }
  }
  console.error(
    JSON.stringify({
      level: 'warn',
      event: 'task_ledger_corrupt_recovered',
      scope,
      file,
      quarantineFile: quarantined ? quarantineFile : undefined,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

async function readTaskLedgerFile(
  normalizedScope: TaskLedgerScope,
  file: string,
): Promise<TaskLedgerSnapshot> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySnapshot(normalizedScope);
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<TaskLedgerSnapshot> | null;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.steps)) {
      throw new Error('Task ledger file is not a valid snapshot object');
    }
    return createTaskLedgerSnapshot(
      normalizedScope,
      normalizeTaskLedgerSteps(parsed.steps),
      typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : 0,
      typeof parsed.revision === 'number' && Number.isSafeInteger(parsed.revision)
        ? parsed.revision
        : 0,
    );
  } catch (error) {
    await quarantineCorruptLedger(file, normalizedScope, error);
    return emptySnapshot(normalizedScope);
  }
}

export async function loadTaskLedger(scope: TaskLedgerScope): Promise<TaskLedgerSnapshot> {
  const normalizedScope = normalizeTaskLedgerScope(scope);
  return readTaskLedgerFile(normalizedScope, taskLedgerFilePath(normalizedScope));
}

export async function saveTaskLedger(
  scope: TaskLedgerScope,
  steps: readonly TaskLedgerStep[],
  options: SaveTaskLedgerOptions = {},
): Promise<TaskLedgerSnapshot> {
  const normalizedScope = normalizeTaskLedgerScope(scope);
  const root = getTaskLedgerStoreRoot();
  const file = taskLedgerFilePath(normalizedScope);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  const release = await acquireTaskLedgerLock(file);
  try {
    const current = await readTaskLedgerFile(normalizedScope, file);
    if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
      throw new TaskLedgerRevisionConflictError(options.expectedRevision, current);
    }
    const snapshot = createTaskLedgerSnapshot(
      normalizedScope,
      steps,
      Date.now(),
      current.revision + 1,
    );
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await renameWithRetry(tmp, file);
    } finally {
      await fs.unlink(tmp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    return snapshot;
  } finally {
    await release();
  }
}

export async function clearTaskLedger(
  scope: TaskLedgerScope,
  options?: SaveTaskLedgerOptions,
): Promise<TaskLedgerSnapshot> {
  return saveTaskLedger(scope, [], options);
}
