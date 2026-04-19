/**
 * Snapshot index — pointer-only KV store for the Modal Sandbox Snapshots design.
 *
 * See docs/decisions/Modal Sandbox Snapshots Design.md §6 for the keying,
 * TTL, and eviction policy. The actual snapshot bytes live as Modal Images;
 * this index is a thin pointer layer used by the resume path and the daily
 * eviction cron.
 *
 * Key shape: `snapshot:<repoFullName>:<branch>` (URL-encoded segments).
 *
 * Per-user keying is deferred until the worker has a stable per-user identity
 * to attach (today's owner token is per-sandbox, not per-user). When that
 * lands, extend the key to `snapshot:<userKey>:<repoFullName>:<branch>` and
 * bump `INDEX_SCHEMA_VERSION`.
 */

import type { KVNamespace, KVNamespaceListResult } from '@cloudflare/workers-types';

export const INDEX_SCHEMA_VERSION = 1;
const KEY_PREFIX = 'snapshot:';
/** Default TTL: 7 days since last access (Modal Snapshots Design §6). */
export const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface SnapshotIndexEntry {
  v: typeof INDEX_SCHEMA_VERSION;
  imageId: string;
  restoreToken: string;
  repoFullName: string;
  branch: string;
  createdAt: number;
  lastAccessedAt: number;
  sizeBytes?: number;
}

export interface PutSnapshotInput {
  repoFullName: string;
  branch: string;
  imageId: string;
  restoreToken: string;
  sizeBytes?: number;
  /** Override the TTL for this entry. Defaults to DEFAULT_TTL_SECONDS. */
  ttlSeconds?: number;
}

export function buildSnapshotKey(repoFullName: string, branch: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(repoFullName)}:${encodeURIComponent(branch)}`;
}

export async function putSnapshot(
  kv: KVNamespace,
  input: PutSnapshotInput,
  now: number = Date.now(),
): Promise<SnapshotIndexEntry> {
  const entry: SnapshotIndexEntry = {
    v: INDEX_SCHEMA_VERSION,
    imageId: input.imageId,
    restoreToken: input.restoreToken,
    repoFullName: input.repoFullName,
    branch: input.branch,
    createdAt: now,
    lastAccessedAt: now,
    sizeBytes: input.sizeBytes,
  };
  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  await kv.put(buildSnapshotKey(input.repoFullName, input.branch), JSON.stringify(entry), {
    expirationTtl: ttl,
  });
  return entry;
}

export async function getSnapshot(
  kv: KVNamespace,
  repoFullName: string,
  branch: string,
): Promise<SnapshotIndexEntry | null> {
  const raw = await kv.get(buildSnapshotKey(repoFullName, branch));
  if (!raw) return null;
  return parseEntry(raw);
}

/**
 * Mark a snapshot as freshly accessed. Resets the KV TTL so the entry survives
 * another `ttlSeconds` of inactivity. Returns the updated entry, or null if
 * the entry no longer exists (race with eviction).
 */
export async function touchSnapshot(
  kv: KVNamespace,
  repoFullName: string,
  branch: string,
  now: number = Date.now(),
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<SnapshotIndexEntry | null> {
  const existing = await getSnapshot(kv, repoFullName, branch);
  if (!existing) return null;
  const updated: SnapshotIndexEntry = { ...existing, lastAccessedAt: now };
  await kv.put(buildSnapshotKey(repoFullName, branch), JSON.stringify(updated), {
    expirationTtl: ttlSeconds,
  });
  return updated;
}

export async function deleteSnapshot(
  kv: KVNamespace,
  repoFullName: string,
  branch: string,
): Promise<void> {
  await kv.delete(buildSnapshotKey(repoFullName, branch));
}

/**
 * List all snapshot index entries. Walks the KV `list()` cursor to completion;
 * intended for the daily eviction cron and admin tooling, not hot paths.
 */
export async function listSnapshots(kv: KVNamespace): Promise<SnapshotIndexEntry[]> {
  const entries: SnapshotIndexEntry[] = [];
  let cursor: string | undefined;
  while (true) {
    const page: KVNamespaceListResult<unknown> = await kv.list({ prefix: KEY_PREFIX, cursor });
    for (const key of page.keys) {
      const raw = await kv.get(key.name);
      if (!raw) continue;
      const entry = parseEntry(raw);
      if (entry) entries.push(entry);
    }
    if (page.list_complete) break;
    cursor = page.cursor;
    if (!cursor) break;
  }
  return entries;
}

function parseEntry(raw: string): SnapshotIndexEntry | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SnapshotIndexEntry>;
    if (
      parsed.v !== INDEX_SCHEMA_VERSION ||
      typeof parsed.imageId !== 'string' ||
      typeof parsed.restoreToken !== 'string' ||
      typeof parsed.repoFullName !== 'string' ||
      typeof parsed.branch !== 'string' ||
      typeof parsed.createdAt !== 'number' ||
      typeof parsed.lastAccessedAt !== 'number'
    ) {
      return null;
    }
    return parsed as SnapshotIndexEntry;
  } catch {
    return null;
  }
}
