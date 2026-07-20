import { describe, expect, it, beforeEach } from 'vitest';
import type { KVNamespace, R2Bucket } from '@cloudflare/workers-types';
import {
  buildSnapshotKey,
  DEFAULT_TTL_SECONDS,
  deleteSnapshot,
  getSnapshot,
  INDEX_SCHEMA_VERSION,
  listSnapshots,
  putSnapshot,
  reapOrphanedSnapshots,
  recordSnapshotEvent,
  summarizeSnapshotIndex,
  touchSnapshot,
} from './snapshot-index';

interface StoredValue {
  value: string;
  metadata?: unknown;
  expirationTtl?: number;
}

function createFakeKv(): { kv: KVNamespace; store: Map<string, StoredValue> } {
  const store = new Map<string, StoredValue>();
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key)?.value ?? null;
    },
    async getWithMetadata(key: string) {
      const entry = store.get(key);
      if (!entry) return { value: null, metadata: null };
      return { value: entry.value, metadata: entry.metadata ?? null };
    },
    async put(
      key: string,
      value: string,
      options?: { metadata?: unknown; expirationTtl?: number },
    ): Promise<void> {
      store.set(key, {
        value,
        metadata: options?.metadata,
        expirationTtl: options?.expirationTtl,
      });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(options?: { prefix?: string; cursor?: string }) {
      const prefix = options?.prefix ?? '';
      const keys = Array.from(store.entries())
        .filter(([k]) => k.startsWith(prefix))
        .map(([name, entry]) => ({ name, metadata: entry.metadata }));
      return { keys, list_complete: true, cursor: '' };
    },
  };
  return { kv: kv as unknown as KVNamespace, store };
}

describe('snapshot-index', () => {
  let kv: KVNamespace;
  let store: Map<string, StoredValue>;

  beforeEach(() => {
    const fake = createFakeKv();
    kv = fake.kv;
    store = fake.store;
  });

  it('round-trips a put/get and persists the 7-day TTL on the KV write', async () => {
    const now = 1_700_000_000_000;
    const written = await putSnapshot(
      kv,
      {
        repoFullName: 'kvfxkaido/push',
        branch: 'main',
        imageId: 'im-abc',
        restoreToken: 'tok-1',
        sizeBytes: 12345,
      },
      now,
    );

    expect(written).toMatchObject({
      v: INDEX_SCHEMA_VERSION,
      imageId: 'im-abc',
      restoreToken: 'tok-1',
      repoFullName: 'kvfxkaido/push',
      branch: 'main',
      createdAt: now,
      lastAccessedAt: now,
      sizeBytes: 12345,
    });
    const stored = store.get(buildSnapshotKey('kvfxkaido/push', 'main'));
    expect(stored?.expirationTtl).toBe(DEFAULT_TTL_SECONDS);

    const read = await getSnapshot(kv, 'kvfxkaido/push', 'main');
    expect(read).toEqual(written);
  });

  it('persists the entry in KV metadata so list() avoids per-key GETs', async () => {
    await putSnapshot(kv, {
      repoFullName: 'a/b',
      branch: 'main',
      imageId: 'im',
      restoreToken: 't',
    });
    const stored = store.get(buildSnapshotKey('a/b', 'main'));
    expect(stored?.value).toBe('');
    expect(stored?.metadata).toMatchObject({ v: INDEX_SCHEMA_VERSION, imageId: 'im' });
  });

  it('round-trips a first-party backup handle without an imageId', async () => {
    const written = await putSnapshot(kv, {
      repoFullName: 'a/b',
      branch: 'feature/backup',
      backupHandle: { id: 'backup-1', dir: '/workspace' },
      restoreToken: 'tok',
    });

    expect(written).toMatchObject({
      v: INDEX_SCHEMA_VERSION,
      backupHandle: { id: 'backup-1', dir: '/workspace' },
      imageId: undefined,
    });
    await expect(getSnapshot(kv, 'a/b', 'feature/backup')).resolves.toEqual(written);
  });

  it('encodes special characters in repo and branch into the key', () => {
    const key = buildSnapshotKey('owner/repo with space', 'feat/foo bar');
    expect(key).toBe('snapshot:owner%2Frepo%20with%20space:feat%2Ffoo%20bar');
  });

  it('returns null for an absent snapshot', async () => {
    expect(await getSnapshot(kv, 'nope/nope', 'main')).toBeNull();
  });

  it('touchSnapshot updates lastAccessedAt and preserves createdAt', async () => {
    const created = 1_700_000_000_000;
    await putSnapshot(
      kv,
      { repoFullName: 'a/b', branch: 'main', imageId: 'im', restoreToken: 't' },
      created,
    );
    const accessed = created + 60_000;
    const touched = await touchSnapshot(kv, 'a/b', 'main', accessed);
    expect(touched).not.toBeNull();
    expect(touched?.createdAt).toBe(created);
    expect(touched?.lastAccessedAt).toBe(accessed);
  });

  it('touchSnapshot refreshes the KV TTL', async () => {
    await putSnapshot(
      kv,
      { repoFullName: 'a/b', branch: 'main', imageId: 'im', restoreToken: 't' },
      1_000,
    );
    // Simulate TTL decay by clearing the stored value's TTL.
    const key = buildSnapshotKey('a/b', 'main');
    const entry = store.get(key);
    if (entry) store.set(key, { ...entry, expirationTtl: undefined });
    await touchSnapshot(kv, 'a/b', 'main', 2_000);
    expect(store.get(key)?.expirationTtl).toBe(DEFAULT_TTL_SECONDS);
  });

  it('touchSnapshot returns null when the entry is gone (race with eviction)', async () => {
    const result = await touchSnapshot(kv, 'ghost/repo', 'main');
    expect(result).toBeNull();
  });

  it('deleteSnapshot removes the entry', async () => {
    await putSnapshot(kv, {
      repoFullName: 'a/b',
      branch: 'main',
      imageId: 'im',
      restoreToken: 't',
    });
    await deleteSnapshot(kv, 'a/b', 'main');
    expect(await getSnapshot(kv, 'a/b', 'main')).toBeNull();
  });

  it('listSnapshots returns all entries under the snapshot prefix', async () => {
    await putSnapshot(kv, {
      repoFullName: 'a/b',
      branch: 'main',
      imageId: 'im1',
      restoreToken: 't1',
    });
    await putSnapshot(kv, {
      repoFullName: 'a/b',
      branch: 'feat',
      imageId: 'im2',
      restoreToken: 't2',
    });
    const all = await listSnapshots(kv);
    expect(all.map((e) => e.imageId ?? '').sort()).toEqual(['im1', 'im2']);
  });

  it('drops entries with mismatched schema versions', async () => {
    // Simulate a stale v0 entry written by an older deployment.
    store.set(buildSnapshotKey('legacy/repo', 'main'), {
      value: '',
      metadata: { v: 0, imageId: 'im' },
    });
    expect(await getSnapshot(kv, 'legacy/repo', 'main')).toBeNull();
  });

  it('default TTL matches the 7-day policy from the design doc', () => {
    expect(DEFAULT_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});

describe('recordSnapshotEvent', () => {
  it('writes an entry on a successful hibernate response', async () => {
    const { kv } = createFakeKv();
    const status = await recordSnapshotEvent(
      kv,
      'hibernate',
      JSON.stringify({ sandbox_id: 'sb-1', repo_full_name: 'a/b', branch: 'main' }),
      { ok: true, snapshot_id: 'im-1', restore_token: 'tok-1' },
    );
    expect(status).toBe('wrote');
    const entry = await getSnapshot(kv, 'a/b', 'main');
    expect(entry?.imageId).toBe('im-1');
    expect(entry?.restoreToken).toBe('tok-1');
  });

  it('touches an existing entry on a successful restore response', async () => {
    const { kv } = createFakeKv();
    await putSnapshot(
      kv,
      { repoFullName: 'a/b', branch: 'main', imageId: 'im-1', restoreToken: 'tok' },
      1_000,
    );
    const status = await recordSnapshotEvent(
      kv,
      'restore-snapshot',
      JSON.stringify({
        snapshot_id: 'im-1',
        restore_token: 'tok',
        repo_full_name: 'a/b',
        branch: 'main',
      }),
      { ok: true, sandbox_id: 'sb-2', owner_token: 'ot' },
    );
    expect(status).toBe('touched');
    const entry = await getSnapshot(kv, 'a/b', 'main');
    expect(entry?.createdAt).toBe(1_000);
    expect(entry?.lastAccessedAt).toBeGreaterThan(1_000);
  });

  it('returns noop and leaves lastAccessedAt untouched on a failed restore response', async () => {
    // Modal returns HTTP 200 for `{ ok: false, error }` (e.g. invalid restore
    // token). Touching in that case would refresh the TTL on a stale entry
    // and skew the cron metrics.
    const { kv } = createFakeKv();
    await putSnapshot(
      kv,
      { repoFullName: 'a/b', branch: 'main', imageId: 'im', restoreToken: 'tok' },
      1_000,
    );
    const status = await recordSnapshotEvent(
      kv,
      'restore-snapshot',
      JSON.stringify({ repo_full_name: 'a/b', branch: 'main' }),
      { ok: false, error: 'Invalid restore token' },
    );
    expect(status).toBe('noop');
    const entry = await getSnapshot(kv, 'a/b', 'main');
    expect(entry?.lastAccessedAt).toBe(1_000);
  });

  it('returns noop on restore when the entry has been evicted', async () => {
    const { kv } = createFakeKv();
    const status = await recordSnapshotEvent(
      kv,
      'restore-snapshot',
      JSON.stringify({ repo_full_name: 'gone/repo', branch: 'main' }),
      { ok: true, sandbox_id: 'sb-2', owner_token: 'ot' },
    );
    expect(status).toBe('noop');
  });

  it('skips when the binding is absent', async () => {
    const status = await recordSnapshotEvent(
      undefined,
      'hibernate',
      JSON.stringify({ repo_full_name: 'a/b', branch: 'main' }),
      { ok: true, snapshot_id: 'im', restore_token: 'tok' },
    );
    expect(status).toBe('skipped_no_binding');
  });

  it('skips when the request body lacks repo/branch context', async () => {
    const { kv } = createFakeKv();
    const status = await recordSnapshotEvent(
      kv,
      'hibernate',
      JSON.stringify({ sandbox_id: 'sb-1' }),
      { ok: true, snapshot_id: 'im', restore_token: 'tok' },
    );
    expect(status).toBe('skipped_missing_context');
  });

  it('returns noop on a hibernate response that is not ok', async () => {
    const { kv } = createFakeKv();
    const status = await recordSnapshotEvent(
      kv,
      'hibernate',
      JSON.stringify({ repo_full_name: 'a/b', branch: 'main' }),
      { ok: false, error: 'boom' },
    );
    expect(status).toBe('noop');
    expect(await getSnapshot(kv, 'a/b', 'main')).toBeNull();
  });

  it('tolerates an invalid JSON request body', async () => {
    const { kv } = createFakeKv();
    const status = await recordSnapshotEvent(kv, 'hibernate', 'not json', {
      ok: true,
      snapshot_id: 'im',
      restore_token: 'tok',
    });
    expect(status).toBe('skipped_missing_context');
  });
});

describe('summarizeSnapshotIndex', () => {
  it('returns zeros for an empty index', async () => {
    const { kv } = createFakeKv();
    const metrics = await summarizeSnapshotIndex(kv);
    expect(metrics).toEqual({
      total: 0,
      totalSizeBytes: 0,
      oldestAccessedAt: null,
      newestAccessedAt: null,
    });
  });

  it('aggregates count, total size, and access-time bounds', async () => {
    const { kv } = createFakeKv();
    await putSnapshot(
      kv,
      {
        repoFullName: 'a/b',
        branch: 'main',
        imageId: 'im1',
        restoreToken: 't',
        sizeBytes: 1000,
      },
      1_000,
    );
    await putSnapshot(
      kv,
      {
        repoFullName: 'a/b',
        branch: 'feat',
        imageId: 'im2',
        restoreToken: 't',
        sizeBytes: 2000,
      },
      5_000,
    );
    const metrics = await summarizeSnapshotIndex(kv);
    expect(metrics).toEqual({
      total: 2,
      totalSizeBytes: 3000,
      oldestAccessedAt: 1_000,
      newestAccessedAt: 5_000,
    });
  });
});

interface FakeR2Object {
  key: string;
  uploaded: Date;
  size: number;
}

function createFakeR2(
  objects: FakeR2Object[],
  pageSize = objects.length || 1,
): { r2: R2Bucket; deleted: string[]; store: Map<string, FakeR2Object> } {
  const store = new Map(objects.map((o) => [o.key, o] as const));
  const deleted: string[] = [];
  const r2 = {
    async list(options?: { prefix?: string; cursor?: string }) {
      const prefix = options?.prefix ?? '';
      const all = [...store.values()].filter((o) => o.key.startsWith(prefix));
      const start = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;
      const page = all.slice(start, start + pageSize);
      const nextStart = start + pageSize;
      const truncated = nextStart < all.length;
      return truncated
        ? { objects: page, truncated: true, cursor: String(nextStart) }
        : { objects: page, truncated: false };
    },
    async delete(keys: string | string[]) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) {
        store.delete(k);
        deleted.push(k);
      }
    },
  };
  return { r2: r2 as unknown as R2Bucket, deleted, store };
}

describe('reapOrphanedSnapshots', () => {
  const NOW = 1_700_000_000_000;
  const OLD = new Date(NOW - 10 * 24 * 60 * 60 * 1000); // 10 days — past the 7-day grace
  const RECENT = new Date(NOW - 60 * 1000); // 1 minute

  it('reaps unreferenced objects past the grace period, keeps referenced and recent ones', async () => {
    const { kv } = createFakeKv();
    await putSnapshot(
      kv,
      { repoFullName: 'o/r', branch: 'main', imageId: 'cf-snapshots/live', restoreToken: 't' },
      NOW,
    );
    const { r2, deleted, store } = createFakeR2([
      { key: 'cf-snapshots/live', uploaded: OLD, size: 100 }, // referenced → keep
      { key: 'cf-snapshots/orphan-old', uploaded: OLD, size: 200 }, // orphan + old → reap
      { key: 'cf-snapshots/orphan-new', uploaded: RECENT, size: 50 }, // orphan but recent → keep
    ]);

    const result = await reapOrphanedSnapshots(kv, r2, 'cf-snapshots/', NOW);

    expect(result).toEqual({ scanned: 3, reaped: 1, reapedBytes: 200, capped: false });
    expect(deleted).toEqual(['cf-snapshots/orphan-old']);
    expect(store.has('cf-snapshots/live')).toBe(true);
    expect(store.has('cf-snapshots/orphan-new')).toBe(true);
    expect(store.has('cf-snapshots/orphan-old')).toBe(false);
  });

  it('keeps everything when all objects are still referenced', async () => {
    const { kv } = createFakeKv();
    await putSnapshot(
      kv,
      { repoFullName: 'o/r', branch: 'main', imageId: 'cf-snapshots/a', restoreToken: 't' },
      NOW,
    );
    const { r2, deleted } = createFakeR2([{ key: 'cf-snapshots/a', uploaded: OLD, size: 1 }]);

    const result = await reapOrphanedSnapshots(kv, r2, 'cf-snapshots/', NOW);

    expect(result.reaped).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('walks R2 list pagination', async () => {
    const { kv } = createFakeKv(); // empty index → every object is orphaned
    const objects = Array.from({ length: 5 }, (_, i) => ({
      key: `cf-snapshots/o${i}`,
      uploaded: OLD,
      size: 10,
    }));
    const { r2, deleted } = createFakeR2(objects, 2); // 2 per page → 3 pages

    const result = await reapOrphanedSnapshots(kv, r2, 'cf-snapshots/', NOW);

    expect(result).toEqual({ scanned: 5, reaped: 5, reapedBytes: 50, capped: false });
    expect(deleted.sort()).toEqual([
      'cf-snapshots/o0',
      'cf-snapshots/o1',
      'cf-snapshots/o2',
      'cf-snapshots/o3',
      'cf-snapshots/o4',
    ]);
  });

  it('caps reaping per run and signals a remaining backlog', async () => {
    const { kv } = createFakeKv(); // empty index → all 5 orphaned
    const objects = Array.from({ length: 5 }, (_, i) => ({
      key: `cf-snapshots/o${i}`,
      uploaded: OLD,
      size: 10,
    }));
    const { r2, deleted } = createFakeR2(objects, 2); // 2 per page

    const result = await reapOrphanedSnapshots(kv, r2, 'cf-snapshots/', NOW, undefined, 3);

    expect(result.capped).toBe(true);
    expect(result.reaped).toBe(3);
    expect(deleted.length).toBe(3);
  });
});
