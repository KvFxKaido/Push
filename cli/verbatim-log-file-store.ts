/**
 * File-backed `VerbatimLog` for the Push daemon (LCM Phase 3).
 *
 * Persists the append-only verbatim store as JSONL on disk so the full original
 * text behind a `MemoryRecord.verbatimRef` survives pushd restarts and is
 * grep-able for debugging. Conforms to the `VerbatimLog` interface in
 * `lib/verbatim-log.ts`, so callers swap the in-memory log for this one via
 * `setDefaultVerbatimLog()` with no other change.
 *
 * This is the durable twin of `cli/context-memory-file-store.ts` and shares its
 * path-safety, serialize-chain, and atomic-rewrite patterns — but it is
 * **append-only by contract**: there is no `update`/`remove` of historical
 * entries. The only mutation is `pruneOlderThan`, which drops whole aged-out
 * entries via tempfile+rename. That is the whole point of a lossless log: once
 * written, an entry's bytes are never edited.
 *
 * File layout (separate tree from typed memory so the two never interleave):
 *
 *   <baseDir>/<repoFullName>/<branch>.verbatim.jsonl
 *   <baseDir>/<repoFullName>/__no_branch.verbatim.jsonl
 *
 * Content addressing: `append` keys on `verbatimBaseRef(text)` and is
 * collision-safe — it scans the scope file for an exact text match (dedup) and,
 * on a genuine base-ref collision with *different* text, probes a disambiguated
 * ref, mirroring the in-memory backend. A hash collision therefore never
 * returns the wrong bytes.
 *
 * Concurrency: all operations serialize through a single promise chain, exactly
 * like the typed file store. pushd is single-process, so this is sufficient
 * without file-level locking.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type {
  VerbatimAppendInput,
  VerbatimEntry,
  VerbatimLog,
  VerbatimScope,
} from '../lib/verbatim-log.ts';
import { verbatimBaseRef } from '../lib/verbatim-log.ts';
// Reuse the typed store's path-safety check — one canonical copy, so the two
// on-disk stores can never drift on the directory-traversal guard.
import { assertSafePathSegment } from './context-memory-file-store.ts';

/**
 * Canonical base dir for verbatim JSONL files on the CLI. Separate from the
 * typed-memory dir (`~/.push/memory`) so verbatim bulk never mixes with the
 * small typed records. `PUSH_VERBATIM_DIR` overrides the default, matching the
 * `PUSH_MEMORY_DIR` / `PUSH_SESSION_DIR` env-var pattern.
 */
export function getVerbatimLogBaseDir(): string {
  if (process.env.PUSH_VERBATIM_DIR) return process.env.PUSH_VERBATIM_DIR;
  return path.join(os.homedir(), '.push', 'verbatim');
}

const NO_BRANCH_KEY = '__no_branch';
const JSONL_EXT = '.verbatim.jsonl';

export interface CreateFileVerbatimLogOptions {
  baseDir: string;
}

function fileFor(baseDir: string, scope: VerbatimScope): string {
  const branchKey = scope.branch ?? NO_BRANCH_KEY;
  assertSafePathSegment(scope.repoFullName, 'repoFullName');
  assertSafePathSegment(branchKey, 'branch');

  const resolvedBase = path.resolve(baseDir);
  const resolvedFile = path.resolve(resolvedBase, scope.repoFullName, `${branchKey}${JSONL_EXT}`);
  if (resolvedFile !== resolvedBase && !resolvedFile.startsWith(`${resolvedBase}${path.sep}`)) {
    throw new Error(
      `Resolved verbatim file path escapes baseDir: ${JSON.stringify(resolvedFile)} not under ${JSON.stringify(resolvedBase)}`,
    );
  }
  return resolvedFile;
}

async function readFileIfExists(filepath: string): Promise<string | null> {
  try {
    return await fs.readFile(filepath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function parseEntries(text: string): VerbatimEntry[] {
  const out: VerbatimEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as VerbatimEntry);
    } catch {
      // Skip malformed lines (a crashed append could leave a partial line) —
      // dropping it is safer than failing the whole read.
    }
  }
  return out;
}

async function writeJsonlAtomic(filepath: string, entries: VerbatimEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  const tmp = `${filepath}.tmp-${process.pid}-${Date.now()}`;
  const body = entries.length === 0 ? '' : `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, filepath);
}

async function appendJsonlLine(filepath: string, entry: VerbatimEntry): Promise<void> {
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  await fs.appendFile(filepath, `${JSON.stringify(entry)}\n`, 'utf8');
}

async function listAllFiles(baseDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true, recursive: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(JSONL_EXT))
      .map((entry) => {
        const parent =
          (entry as { parentPath?: string; path?: string }).parentPath ??
          (entry as { parentPath?: string; path?: string }).path ??
          baseDir;
        return path.join(parent, entry.name);
      });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export function createFileVerbatimLog(options: CreateFileVerbatimLogOptions): VerbatimLog {
  const { baseDir } = options;

  // Single-chain serializer (identical to the typed file store). Each op waits
  // for the previous one to settle before running. The returned `next` carries
  // the operation's real result *and its real rejection* — callers `await` it
  // and see failures normally (append failures are surfaced/logged by
  // `stampVerbatimDetail`; read failures degrade to capped detail in
  // `expandMemoryRecords`). The separate `tail = next.catch(() => {})` exists
  // only so one op's rejection does not poison the queue for the *next* op; it
  // does not swallow the error from the caller, which holds `next`.
  let tail: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = tail.then(() => fn());
    tail = next.catch(() => {});
    return next;
  }

  return {
    append(input: VerbatimAppendInput) {
      return serialize(async () => {
        const { scope, text, kind, label, now = Date.now() } = input;
        const file = fileFor(baseDir, scope);

        // Collision-safe identity probed across the WHOLE store, not just this
        // scope file. `read(ref)` scans every file and returns the first match,
        // so a ref must be globally unique or two scopes could persist the same
        // ref for different bytes (FNV-32 + length collisions are producible) and
        // read would recall the wrong text for one of them. Gathering all entries
        // is the same O(N) scan read/list/size already do; pushd is single-process
        // and serialized, so this stays correct without locking.
        const all: VerbatimEntry[] = [];
        for (const f of await listAllFiles(baseDir)) {
          const t = await readFileIfExists(f);
          if (t) all.push(...parseEntries(t));
        }
        const base = verbatimBaseRef(text);

        // Reuse on an exact text match anywhere (content dedup); else probe a
        // disambiguated ref so two distinct texts can never share one — globally.
        let ref = base;
        for (let probe = 1; ; probe++) {
          const hit = all.find((e) => e.ref === ref);
          if (!hit) break;
          if (hit.text === text) return hit;
          ref = `${base}_${probe + 1}`;
        }

        const entry: VerbatimEntry = {
          ref,
          scope: { ...scope },
          text,
          byteLen: text.length,
          createdAt: now,
          ...(kind ? { kind } : {}),
          ...(label ? { label } : {}),
        };
        await appendJsonlLine(file, entry);
        return entry;
      });
    },

    read(ref: string) {
      return serialize(async () => {
        for (const file of await listAllFiles(baseDir)) {
          const text = await readFileIfExists(file);
          if (!text) continue;
          for (const entry of parseEntries(text)) {
            if (entry.ref === ref) return entry;
          }
        }
        return undefined;
      });
    },

    listByScope(scope: VerbatimScope, predicate?: (entry: VerbatimEntry) => boolean) {
      return serialize(async () => {
        const out: VerbatimEntry[] = [];
        for (const file of await listAllFiles(baseDir)) {
          const text = await readFileIfExists(file);
          if (!text) continue;
          for (const entry of parseEntries(text)) {
            if (scope.repoFullName && entry.scope.repoFullName !== scope.repoFullName) continue;
            if (scope.branch && entry.scope.branch && entry.scope.branch !== scope.branch) continue;
            if (scope.chatId && entry.scope.chatId && entry.scope.chatId !== scope.chatId) continue;
            if (predicate && !predicate(entry)) continue;
            out.push(entry);
          }
        }
        out.sort((a, b) => b.createdAt - a.createdAt);
        return out;
      });
    },

    pruneOlderThan(cutoffMs: number) {
      return serialize(async () => {
        let removed = 0;
        for (const file of await listAllFiles(baseDir)) {
          const text = await readFileIfExists(file);
          if (!text) continue;
          const entries = parseEntries(text);
          const kept = entries.filter((e) => e.createdAt >= cutoffMs);
          const delta = entries.length - kept.length;
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
          count += parseEntries(text).length;
        }
        return count;
      });
    },
  };
}
