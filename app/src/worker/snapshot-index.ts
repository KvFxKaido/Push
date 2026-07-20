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

import type { DirectoryBackup } from '@cloudflare/sandbox';
import type { KVNamespace, KVNamespaceListResult, R2Bucket } from '@cloudflare/workers-types';

export const INDEX_SCHEMA_VERSION = 1;
const KEY_PREFIX = 'snapshot:';
/** Default TTL: 7 days since last access (Modal Snapshots Design §6). */
export const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface SnapshotIndexEntry {
  v: typeof INDEX_SCHEMA_VERSION;
  /** First-party Cloudflare Sandbox backup handle (current CF transport). */
  backupHandle?: DirectoryBackup;
  /**
   * Legacy Modal image / CF base64-R2 pointer.
   *
   * REMOVE AFTER 2026-08-01, once every pre-upgrade seven-day KV entry has
   * expired and the Cloudflare restore branches no longer need the old R2 path.
   */
  imageId?: string;
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
  backupHandle?: DirectoryBackup;
  imageId?: string;
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
  if (!input.backupHandle && !input.imageId) {
    throw new Error('Snapshot index entry requires backupHandle or imageId');
  }
  const entry: SnapshotIndexEntry = {
    v: INDEX_SCHEMA_VERSION,
    backupHandle: input.backupHandle,
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

export interface ReapResult {
  scanned: number;
  reaped: number;
  reapedBytes: number;
  /** True when the per-run `maxReap` cap was hit and orphans remain for the
   *  next run. Lets the cron log signal an in-progress backlog drain. */
  capped: boolean;
}

/**
 * Reclaim orphaned legacy R2 snapshot objects. First-party SDK archives live
 * under `backups/` and are reclaimed by the bucket lifecycle rule instead.
 *
 * An R2 object is orphaned when no live index entry references its key. This
 * happens when a snapshot is superseded but its old object wasn't deleted
 * inline (anonymous snapshots with no repo/branch, or a missed inline delete),
 * or when the index entry TTL-expired (7 days) while the object lingered.
 *
 * Only objects older than `graceMs` are reaped, so an object freshly written
 * but not yet visible in the index (write lag / race) is never deleted out from
 * under a restore. Default grace equals the index TTL: a snapshot stays
 * restorable for at least that long, matching the KV contract.
 *
 * Memory profile: holds the referenced-key set (one entry per repo/branch, so
 * bounded by the index, which itself TTLs) plus up to `maxReap` orphan keys.
 * Orphans are collected before any delete — deleting mid-pagination mutates the
 * listing we're walking and can skip objects — but collection stops at
 * `maxReap` so a one-time backlog from a prior leak can't blow the Worker's
 * memory; `capped: true` then signals the next daily run to continue draining.
 */
export async function reapOrphanedSnapshots(
  kv: KVNamespace,
  r2: R2Bucket,
  keyPrefix: string,
  now: number = Date.now(),
  graceMs: number = DEFAULT_TTL_SECONDS * 1000,
  maxReap: number = 10_000,
): Promise<ReapResult> {
  // The reaper owns only the legacy `cf-snapshots/` base64 objects. SDK
  // backup archives live under its `backups/` prefix and expire via their TTL
  // plus the bucket lifecycle rule.
  const referenced = new Set(
    (await listSnapshots(kv))
      .map((entry) => entry.imageId)
      .filter((imageId): imageId is string => typeof imageId === 'string'),
  );
  const cutoff = now - graceMs;
  let scanned = 0;
  let reapedBytes = 0;
  const orphanKeys: string[] = [];
  let capped = false;
  let cursor: string | undefined;
  do {
    const page = await r2.list({ prefix: keyPrefix, cursor });
    scanned += page.objects.length;
    for (const o of page.objects) {
      if (orphanKeys.length >= maxReap) {
        capped = true;
        break;
      }
      if (!referenced.has(o.key) && o.uploaded.getTime() < cutoff) {
        orphanKeys.push(o.key);
        reapedBytes += o.size ?? 0;
      }
    }
    cursor = !capped && page.truncated ? page.cursor : undefined;
  } while (cursor);
  // R2 bulk delete caps at 1000 keys per call.
  for (let i = 0; i < orphanKeys.length; i += 1000) {
    await r2.delete(orphanKeys.slice(i, i + 1000));
  }
  return { scanned, reaped: orphanKeys.length, reapedBytes, capped };
}

function validateEntry(raw: unknown): SnapshotIndexEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = raw as Partial<SnapshotIndexEntry>;
  if (
    parsed.v !== INDEX_SCHEMA_VERSION ||
    (!isBackupHandle(parsed.backupHandle) && typeof parsed.imageId !== 'string') ||
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

function isBackupHandle(raw: unknown): raw is DirectoryBackup {
  if (!raw || typeof raw !== 'object') return false;
  const handle = raw as Partial<DirectoryBackup>;
  return (
    typeof handle.id === 'string' &&
    handle.id.length > 0 &&
    typeof handle.dir === 'string' &&
    handle.dir.startsWith('/') &&
    (handle.localBucket === undefined || typeof handle.localBucket === 'boolean')
  );
}
