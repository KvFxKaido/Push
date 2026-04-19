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
 * Storage: the entry lives entirely in the KV `metadata` field (the value is
 * empty). This keeps `list()` to a single round-trip — no per-key GETs needed
 * to drive the cron or admin tooling. KV caps metadata at 1024 bytes per key,
 * which is well above our entry size (~250 bytes).
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
  await kv.put(buildSnapshotKey(input.repoFullName, input.branch), '', {
    metadata: entry,
    expirationTtl: ttl,
  });
  return entry;
}

export async function getSnapshot(
  kv: KVNamespace,
  repoFullName: string,
  branch: string,
): Promise<SnapshotIndexEntry | null> {
  const result = await kv.getWithMetadata<SnapshotIndexEntry>(
    buildSnapshotKey(repoFullName, branch),
    { type: 'text' },
  );
  return validateEntry(result.metadata);
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
  await kv.put(buildSnapshotKey(repoFullName, branch), '', {
    metadata: updated,
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
 * List all snapshot index entries. Metadata travels with the list page, so
 * this walks the cursor to completion without a per-key GET. Intended for the
 * daily eviction cron and admin tooling; not the hot path.
 */
export async function listSnapshots(kv: KVNamespace): Promise<SnapshotIndexEntry[]> {
  const entries: SnapshotIndexEntry[] = [];
  let cursor: string | undefined;
  while (true) {
    const page: KVNamespaceListResult<SnapshotIndexEntry> = await kv.list<SnapshotIndexEntry>({
      prefix: KEY_PREFIX,
      cursor,
    });
    for (const key of page.keys) {
      const entry = validateEntry(key.metadata);
      if (entry) entries.push(entry);
    }
    if (page.list_complete) break;
    cursor = page.cursor;
    if (!cursor) break;
  }
  return entries;
}

/**
 * Best-effort recording of a hibernate/restore round-trip into the index.
 *
 * Called from the sandbox proxy after Modal returns success. Reads
 * `repo_full_name`/`branch` from the original request body and the snapshot
 * fields from the Modal response. Skips silently if the binding is absent or
 * the required fields are missing — the proxy's contract with the client is
 * unchanged either way; the index is purely advisory.
 *
 * Returns a short status string for log correlation.
 */
export async function recordSnapshotEvent(
  kv: KVNamespace | undefined,
  route: 'hibernate' | 'restore-snapshot',
  requestBody: string,
  modalResponse: unknown,
): Promise<'skipped_no_binding' | 'skipped_missing_context' | 'wrote' | 'touched' | 'noop'> {
  if (!kv) return 'skipped_no_binding';

  const ctx = parseRepoContext(requestBody);
  if (!ctx) return 'skipped_missing_context';

  if (route === 'hibernate') {
    const fields = parseHibernateResponse(modalResponse);
    if (!fields) return 'noop';
    await putSnapshot(kv, {
      repoFullName: ctx.repoFullName,
      branch: ctx.branch,
      imageId: fields.snapshotId,
      restoreToken: fields.restoreToken,
    });
    return 'wrote';
  }

  // restore-snapshot — only refresh TTL/lastAccessedAt on a Modal-reported
  // success. Modal returns HTTP 200 for `{ ok: false, error: ... }` (e.g.
  // invalid restore token), so gating on HTTP status alone would keep failed
  // entries alive and skew the eviction metrics.
  if (!isOkResponse(modalResponse)) return 'noop';
  const touched = await touchSnapshot(kv, ctx.repoFullName, ctx.branch);
  return touched ? 'touched' : 'noop';
}

function parseRepoContext(requestBody: string): { repoFullName: string; branch: string } | null {
  try {
    const parsed = JSON.parse(requestBody) as Record<string, unknown>;
    const repoFullName = parsed.repo_full_name;
    const branch = parsed.branch;
    if (typeof repoFullName !== 'string' || !repoFullName) return null;
    if (typeof branch !== 'string' || !branch) return null;
    return { repoFullName, branch };
  } catch {
    return null;
  }
}

function parseHibernateResponse(
  response: unknown,
): { snapshotId: string; restoreToken: string } | null {
  if (!isOkResponse(response)) return null;
  const r = response as Record<string, unknown>;
  const snapshotId = r.snapshot_id;
  const restoreToken = r.restore_token;
  if (typeof snapshotId !== 'string' || !snapshotId) return null;
  if (typeof restoreToken !== 'string' || !restoreToken) return null;
  return { snapshotId, restoreToken };
}

function isOkResponse(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  return (response as Record<string, unknown>).ok === true;
}

export interface SnapshotIndexMetrics {
  total: number;
  totalSizeBytes: number;
  oldestAccessedAt: number | null;
  newestAccessedAt: number | null;
}

/**
 * Walk the index and emit aggregate metrics. Intended for the daily cron.
 *
 * Real per-user LRU eviction (design §6: "Per-user cap: 10 active snapshots")
 * is deferred until the index keys carry user identity. KV's `expirationTtl`
 * already enforces the 7-day TTL for free, so today the cron's job is purely
 * observability — it gives us a feed of index size + age distribution that
 * the eviction policy can be tuned against once user identity lands.
 *
 * Aggregates inline while walking the KV list cursor — never materializes the
 * full entry set in memory, so it stays safe against an unbounded index.
 */
export async function summarizeSnapshotIndex(kv: KVNamespace): Promise<SnapshotIndexMetrics> {
  let total = 0;
  let totalSizeBytes = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  let cursor: string | undefined;
  while (true) {
    const page: KVNamespaceListResult<SnapshotIndexEntry> = await kv.list<SnapshotIndexEntry>({
      prefix: KEY_PREFIX,
      cursor,
    });
    for (const key of page.keys) {
      const entry = validateEntry(key.metadata);
      if (!entry) continue;
      total += 1;
      totalSizeBytes += entry.sizeBytes ?? 0;
      if (oldest === null || entry.lastAccessedAt < oldest) oldest = entry.lastAccessedAt;
      if (newest === null || entry.lastAccessedAt > newest) newest = entry.lastAccessedAt;
    }
    if (page.list_complete) break;
    cursor = page.cursor;
    if (!cursor) break;
  }
  return { total, totalSizeBytes, oldestAccessedAt: oldest, newestAccessedAt: newest };
}

function validateEntry(raw: unknown): SnapshotIndexEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = raw as Partial<SnapshotIndexEntry>;
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
}
