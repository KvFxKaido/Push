/**
 * File-backed `ContextMemoryStore` for the Push daemon.
 *
 * Persists typed `MemoryRecord`s as JSONL files on disk so memory
 * survives pushd restarts and is grep-able for debugging. Conforms to
 * the `ContextMemoryStore` interface in `lib/context-memory-store.ts`
 * so callers can swap the in-memory store for this one via
 * `setDefaultMemoryStore()` without any other changes.
 *
 * File layout:
 *
 *   <baseDir>/<repoFullName>/<branch>.jsonl       — branch-scoped records
 *   <baseDir>/<repoFullName>/__no_branch.jsonl    — records with no branch
 *
 * `repoFullName` is passed through verbatim and creates nested
 * directories when it contains `/` (e.g., `owner/repo/main.jsonl`).
 * Operators can `ls .push/memory` to see which repos have memory and
 * `cat <file>` to inspect records.
 *
 * Concurrency: all operations serialize through a single promise
 * chain to prevent interleaved appends and read-then-write races
 * during update/remove. pushd is single-process, so this is
 * sufficient without file-level locking.
 *
 * Durability: mutating operations that rewrite a file (update, remove,
 * pruneExpired) write to a tempfile and rename, so a crash mid-write
 * leaves the old file intact. Appends (write, writeMany) rely on the
 * OS's append atomicity for small writes — good enough for the
 * expected record size (a few hundred bytes per JSONL line).
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { ContextMemoryStore } from '../lib/context-memory-store.ts';
import type { MemoryRecord } from '../lib/runtime-contract.ts';
import { isExpired } from '../lib/memory-persistence-policy.ts';

/**
 * Canonical base dir for typed-memory JSONL files on the CLI. Both
 * the daemon (`cli/pushd.ts:main`) and the headless delegation path
 * (`cli/delegation-entry.ts:runDelegatedHeadless`) call this so the
 * two surfaces share a single on-disk store — a `./push run
 * --delegate` invocation writes memory that a later pushd session
 * (or another `--delegate` run) can retrieve.
 *
 * `PUSH_MEMORY_DIR` overrides the default `~/.push/memory`, matching
 * the `PUSH_CONFIG_PATH` / `PUSH_SESSION_DIR` env-var pattern used
 * elsewhere in cli.
 */
export function getMemoryStoreBaseDir(): string {
  if (process.env.PUSH_MEMORY_DIR) return process.env.PUSH_MEMORY_DIR;
  return path.join(os.homedir(), '.push', 'memory');
}

// Reserved filename stem for records whose scope has no `branch` set.
// Branch names cannot contain NUL, but `__no_branch` is a distinctive
// name that will not collide with any real branch produced by git.
const NO_BRANCH_KEY = '__no_branch';
const JSONL_EXT = '.jsonl';

export interface CreateFileMemoryStoreOptions {
  baseDir: string;
}

/**
 * Reject path components that could escape baseDir. `repoFullName`
 * comes from `git remote get-url origin` parsed via
 * `parseGitRemoteUrl` — and an SSH-shorthand remote like
 * `git@example.com:../evil.git` parses to `../evil`, which would
 * `path.join(baseDir, '../evil', ...)` to escape baseDir entirely.
 * `branch` is git-controlled and harder to attack, but the same
 * sanitization shape applies cheaply. Codex + Copilot P2 reviews on
 * PR #333.
 */
function assertSafePathSegment(value: string, fieldName: string): void {
  if (!value) {
    throw new Error(`${fieldName} must not be empty`);
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error(`${fieldName} must be a relative path: ${JSON.stringify(value)}`);
  }
  // Split on either separator so a Windows-style backslash injected
  // through a path-shaped string can't sneak past the segment check.
  for (const segment of value.split(/[\\/]+/)) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error(
        `${fieldName} must not contain empty, "." or ".." segments: ${JSON.stringify(value)}`,
      );
    }
  }
}

function fileFor(baseDir: string, repoFullName: string, branch?: string): string {
  const branchKey = branch ?? NO_BRANCH_KEY;
  assertSafePathSegment(repoFullName, 'repoFullName');
  assertSafePathSegment(branchKey, 'branch');

  // Belt-and-braces: even after segment validation, resolve the full
  // path and verify it stays under baseDir. Catches edge cases the
  // segment check could miss (e.g., baseDir itself containing
  // symlinks that the OS resolves into a parent directory).
  const resolvedBase = path.resolve(baseDir);
  const resolvedFile = path.resolve(resolvedBase, repoFullName, `${branchKey}${JSONL_EXT}`);
  if (resolvedFile !== resolvedBase && !resolvedFile.startsWith(`${resolvedBase}${path.sep}`)) {
    throw new Error(
      `Resolved memory file path escapes baseDir: ${JSON.stringify(resolvedFile)} not under ${JSON.stringify(resolvedBase)}`,
    );
  }
  return resolvedFile;
}

function scopeFile(baseDir: string, record: MemoryRecord): string {
  return fileFor(baseDir, record.scope.repoFullName, record.scope.branch);
}

async function readFileIfExists(filepath: string): Promise<string | null> {
  try {
    return await fs.readFile(filepath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function parseJsonlRecords(text: string): MemoryRecord[] {
  const out: MemoryRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as MemoryRecord);
    } catch {
      // Skip malformed lines. A crashed write could leave a partial
      // line; dropping it is safer than failing the whole read.
    }
  }
  return out;
}

async function writeJsonlAtomic(filepath: string, records: MemoryRecord[]): Promise<void> {
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  const tmp = `${filepath}.tmp-${process.pid}-${Date.now()}`;
  const body = records.length === 0 ? '' : `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, filepath);
}

async function appendJsonlLines(filepath: string, records: MemoryRecord[]): Promise<void> {
  if (records.length === 0) return;
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  const body = `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
  await fs.appendFile(filepath, body, 'utf8');
}

async function listAllFiles(baseDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true, recursive: true });
    return (
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(JSONL_EXT))
        // `parentPath` is the Node 20.12+ accessor; `path` is deprecated
        // but still populated. Fall through to `baseDir` as a last
        // resort so the file list is usable even on older Node runtimes.
        .map((entry) => {
          const parent =
            (entry as { parentPath?: string; path?: string }).parentPath ??
            (entry as { parentPath?: string; path?: string }).path ??
            baseDir;
          return path.join(parent, entry.name);
        })
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export function createFileMemoryStore(options: CreateFileMemoryStoreOptions): ContextMemoryStore {
  const { baseDir } = options;

  // Single-chain serializer. Each operation waits for the previous
  // one to settle before running. `.catch(() => {})` prevents a
  // rejected promise from poisoning the queue for subsequent ops,
  // while still letting the rejection propagate to its own caller.
  let tail: Promise<unknown> = Promise.resolve();

  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = tail.then(() => fn());
    tail = next.catch(() => {});
    return next;
  }

  return {
    write(record: MemoryRecord) {
      return serialize(() => appendJsonlLines(scopeFile(baseDir, record), [record]));
    },

    writeMany(batch: MemoryRecord[]) {
      return serialize(async () => {
        // Group by destination file so one append per file suffices.
        const byFile = new Map<string, MemoryRecord[]>();
        for (const record of batch) {
          const f = scopeFile(baseDir, record);
          const list = byFile.get(f) ?? [];
          list.push(record);
          byFile.set(f, list);
        }
        for (const [f, records] of byFile) {
          await appendJsonlLines(f, records);
        }
      });
    },

    get(id: string) {
      return serialize(async () => {
        for (const file of await listAllFiles(baseDir)) {
          const text = await readFileIfExists(file);
          if (!text) continue;
          for (const record of parseJsonlRecords(text)) {
            if (record.id === id) return record;
          }
        }
        return undefined;
      });
    },

    list(predicate?: (record: MemoryRecord) => boolean) {
      return serialize(async () => {
        const out: MemoryRecord[] = [];
        for (const file of await listAllFiles(baseDir)) {
          const text = await readFileIfExists(file);
          if (!text) continue;
          for (const record of parseJsonlRecords(text)) {
            if (!predicate || predicate(record)) out.push(record);
          }
        }
        return out;
      });
    },

    update(id: string, patch: Partial<MemoryRecord>) {
      return serialize(async () => {
        for (const file of await listAllFiles(baseDir)) {
          const text = await readFileIfExists(file);
          if (!text) continue;
          const records = parseJsonlRecords(text);
          const index = records.findIndex((r) => r.id === id);
          if (index === -1) continue;
          const merged = { ...records[index], ...patch };
          records[index] = merged;
          await writeJsonlAtomic(file, records);
          return merged;
        }
        return undefined;
      });
    },

    remove(id: string) {
      return serialize(async () => {
        for (const file of await listAllFiles(baseDir)) {
          const text = await readFileIfExists(file);
          if (!text) continue;
          const records = parseJsonlRecords(text);
          const filtered = records.filter((r) => r.id !== id);
          if (filtered.length !== records.length) {
            await writeJsonlAtomic(file, filtered);
            return;
          }
        }
      });
    },

    clear() {
      return serialize(async () => {
        try {
          await fs.rm(baseDir, { recursive: true, force: true });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      });
    },

    clearByRepo(repoFullName: string) {
      return serialize(async () => {
        // Same sanitization as fileFor — `clearByRepo('../evil')`
        // would otherwise resolve to `${baseDir}/../evil` and rm a
        // sibling directory entirely.
        assertSafePathSegment(repoFullName, 'repoFullName');
        const resolvedBase = path.resolve(baseDir);
        const resolvedDir = path.resolve(resolvedBase, repoFullName);
        if (!resolvedDir.startsWith(`${resolvedBase}${path.sep}`)) {
          throw new Error(
            `Resolved repo dir escapes baseDir: ${JSON.stringify(resolvedDir)} not under ${JSON.stringify(resolvedBase)}`,
          );
        }
        try {
          await fs.rm(resolvedDir, { recursive: true, force: true });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      });
    },

    clearByBranch(repoFullName: string, branch: string) {
      return serialize(async () => {
        try {
          await fs.unlink(fileFor(baseDir, repoFullName, branch));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      });
    },

    pruneExpired(now: number = Date.now()) {
      return serialize(async () => {
        let removed = 0;
        for (const file of await listAllFiles(baseDir)) {
          const text = await readFileIfExists(file);
          if (!text) continue;
          const records = parseJsonlRecords(text);
          const kept = records.filter((r) => !isExpired(r, now));
          const delta = records.length - kept.length;
          if (delta > 0) {
            await writeJsonlAtomic(file, kept);
            removed += delta;
          }
        }
        return removed;
      });
    },

    size() {
      return serialize(async () => {
        let count = 0;
        for (const file of await listAllFiles(baseDir)) {
          const text = await readFileIfExists(file);
          if (!text) continue;
          count += parseJsonlRecords(text).length;
        }
        return count;
      });
    },
  };
}
