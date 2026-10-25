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

// Cross-process lock as a sequence of epochs in `<ledger>.lockdir/`.
//
// The holder is whoever created the highest-numbered `<n>.owner` that has no
// `<n>.released` marker and whose recorded PID is alive. Acquiring creates
// `<n+1>.owner` with an atomic no-replace primitive (`link` of a fully written
// temp file), so exactly one contender wins each epoch. Crucially, taking
// over from a dead owner is *also* "create the next epoch" — a stale lock is
// never unlinked by path. Unlink-after-check is the race that let two
// reclaimers both enter (one deleting the lock the other had just acquired),
// and any guard file reaped the same way only moves that race; no step here
// deletes a name that another live process could hold.
//
// Release writes `<n>.released` and garbage-collects epochs below `n`. A
// contender working from a stale directory listing can still create a
// below-max epoch that GC freed; it then sees a higher epoch on its
// post-create check and backs off, deleting only its own entry.
const OWNER_SUFFIX = '.owner';
const RELEASED_SUFFIX = '.released';

function lockDirFor(file: string): string {
  return `${file}.lockdir`;
}

function ownerEpochs(entries: readonly string[]): number[] {
  const epochs: number[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(OWNER_SUFFIX)) continue;
    const epoch = Number(entry.slice(0, -OWNER_SUFFIX.length));
    if (Number.isSafeInteger(epoch) && epoch >= 0) epochs.push(epoch);
  }
  return epochs;
}

// Returns the epoch a contender may try to create next, or null while a live
// owner holds the current epoch.
async function nextFreeEpoch(lockDir: string, entries: readonly string[]): Promise<number | null> {
  const epochs = ownerEpochs(entries);
  if (epochs.length === 0) return 0;
  const current = Math.max(...epochs);
  if (entries.includes(`${current}${RELEASED_SUFFIX}`)) return current + 1;
  let pid = 0;
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(lockDir, `${current}${OWNER_SUFFIX}`), 'utf8'),
    ) as { pid?: unknown };
    pid = typeof parsed.pid === 'number' ? parsed.pid : 0;
  } catch (error) {
    // GC'd between listing and read: the listing is stale, so re-list.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Owner files are linked into place fully written, so unreadable content
    // is corruption, not an in-progress write: treat the owner as dead.
  }
  if (isProcessAlive(pid)) return null;
  console.error(
    JSON.stringify({
      level: 'warn',
      event: 'task_ledger_lock_owner_dead',
      lockDir,
      epoch: current,
      pid,
    }),
  );
  return current + 1;
}

async function tryCreateEpoch(lockDir: string, epoch: number): Promise<boolean> {
  const target = path.join(lockDir, `${epoch}${OWNER_SUFFIX}`);
  const tmp = path.join(lockDir, `.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), {
    mode: 0o600,
  });
  try {
    await fs.link(tmp, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
}

async function collectEpochsBelow(lockDir: string, epoch: number): Promise<void> {
  const entries = await fs.readdir(lockDir).catch(() => [] as string[]);
  for (const entry of entries) {
    const match = /^(\d+)\.(owner|released)$/.exec(entry);
    if (!match || Number(match[1]) >= epoch) continue;
    await fs.unlink(path.join(lockDir, entry)).catch(() => undefined);
  }
}

async function acquireTaskLedgerLock(file: string): Promise<() => Promise<void>> {
  const lockDir = lockDirFor(file);
  await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  while (true) {
    const epoch = await nextFreeEpoch(lockDir, await fs.readdir(lockDir));
    if (epoch !== null && (await tryCreateEpoch(lockDir, epoch))) {
      // A stale listing can land us on a GC-freed epoch below the real
      // current one; we only hold the lock if ours is strictly the highest.
      const highest = Math.max(...ownerEpochs(await fs.readdir(lockDir)));
      if (highest === epoch) {
        return async () => {
          await fs.writeFile(path.join(lockDir, `${epoch}${RELEASED_SUFFIX}`), '', {
            flag: 'wx',
            mode: 0o600,
          });
          await collectEpochsBelow(lockDir, epoch);
        };
      }
      await fs.unlink(path.join(lockDir, `${epoch}${OWNER_SUFFIX}`)).catch(() => undefined);
    }
    if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for task ledger lock: ${lockDir}`);
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
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
