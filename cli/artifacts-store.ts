/**
 * CLI flat-JSON artifact store.
 *
 * Layout: `~/.push/artifacts/<safe-scope-key>/<artifact-id>.json`. One
 * file per artifact, no index. `list()` reads the directory, parses
 * each file, and sorts in memory — fine at the v1 scale where
 * cardinality is "a few dozen artifacts per branch." If listing
 * pressure shows up later, the swap target is SQLite at this same
 * boundary.
 *
 * Path-safety: `buildScopeKeys` joins components with `:`, which is
 * reserved on Windows. The store substitutes `:` → `__` in the
 * directory name only — the in-memory `scope` and any external store
 * (KV / D1 / CF Artifacts) keep the canonical `:` form.
 *
 * Override the root with `PUSH_ARTIFACTS_DIR` to keep CLI tests
 * isolated. Mirrors `PUSH_SESSION_DIR` in `cli/session-store.ts`.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildScopeKeys } from '../lib/artifacts/scope.ts';
import type { ArtifactRecord, ArtifactScope } from '../lib/artifacts/types.ts';
import type { ArtifactStore, ListArtifactsQuery } from '../lib/artifacts/store.ts';

function rootDir(): string {
  return process.env.PUSH_ARTIFACTS_DIR || path.join(os.homedir(), '.push', 'artifacts');
}

/**
 * Reject artifact ids that could escape the scope directory when
 * interpolated into `path.join`. Production ids are UUIDs from
 * `crypto.randomUUID()`, but `get`/`delete` will accept ids from URLs
 * or tool args once dispatch lands — a model-supplied
 * `../other-scope/art` would otherwise read or unlink a sibling
 * artifact. Allowed: ASCII alphanumerics, `-`, `_`. Length capped at
 * 128 to bound the input surface.
 */
const SAFE_ARTIFACT_ID = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeArtifactId(id: string): void {
  if (!SAFE_ARTIFACT_ID.test(id)) {
    throw new Error(
      `Invalid artifact id ${JSON.stringify(id)}: must match ${SAFE_ARTIFACT_ID.source}.`,
    );
  }
}

/**
 * Filesystem-safe directory name for a scope. The chat key is the
 * narrowest match; CLI callers without `chatId` fall through to the
 * branch key. Colons are swapped for `__` so the directory works on
 * Windows.
 */
function scopeDirName(scope: ArtifactScope): string {
  const keys = buildScopeKeys(scope);
  const raw = keys.chat ?? keys.branch;
  return raw.replaceAll(':', '__');
}

function scopeDirPath(scope: ArtifactScope): string {
  return path.join(rootDir(), scopeDirName(scope));
}

function recordFilePath(scope: ArtifactScope, id: string): string {
  assertSafeArtifactId(id);
  return path.join(scopeDirPath(scope), `${id}.json`);
}

async function readArtifactFile(filePath: string): Promise<ArtifactRecord | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as ArtifactRecord;
    return parsed;
  } catch (err) {
    // Treat missing files as "not found" rather than errors. JSON
    // parse failures bubble up — a corrupt file is real and shouldn't
    // be silently swallowed by `list()`.
    if (isFsNotFound(err)) return null;
    if (err instanceof SyntaxError) {
      throw new Error(`Corrupt artifact file at ${filePath}: ${err.message}`);
    }
    throw err;
  }
}

function isFsNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

function matchesKindFilter(
  record: ArtifactRecord,
  kindFilter: ListArtifactsQuery['kind'],
): boolean {
  if (!kindFilter) return true;
  const allowed = Array.isArray(kindFilter) ? kindFilter : [kindFilter];
  return allowed.includes(record.kind);
}

export class CliFlatJsonArtifactStore implements ArtifactStore {
  async get(scope: ArtifactScope, id: string): Promise<ArtifactRecord | null> {
    return readArtifactFile(recordFilePath(scope, id));
  }

  async list(query: ListArtifactsQuery): Promise<ArtifactRecord[]> {
    const dir = scopeDirPath(query.scope);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if (isFsNotFound(err)) return [];
      throw err;
    }

    const records: ArtifactRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const record = await readArtifactFile(path.join(dir, entry));
      if (!record) continue;
      if (!matchesKindFilter(record, query.kind)) continue;
      records.push(record);
    }

    records.sort((a, b) => b.updatedAt - a.updatedAt);
    if (query.limit !== undefined && query.limit >= 0) {
      return records.slice(0, query.limit);
    }
    return records;
  }

  async put(record: ArtifactRecord): Promise<void> {
    assertSafeArtifactId(record.id);
    const dir = scopeDirPath(record.scope);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${record.id}.json`);
    // Pretty-print so files are readable when users poke at them
    // directly. Cardinality is low enough that the size cost is fine.
    await fs.writeFile(filePath, JSON.stringify(record, null, 2), 'utf8');
  }

  async delete(scope: ArtifactScope, id: string): Promise<void> {
    try {
      await fs.unlink(recordFilePath(scope, id));
    } catch (err) {
      if (isFsNotFound(err)) return;
      throw err;
    }
  }
}
