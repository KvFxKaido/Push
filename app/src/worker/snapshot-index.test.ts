import { describe, expect, it, beforeEach } from 'vitest';
import type { KVNamespace } from '@cloudflare/workers-types';
import {
  buildSnapshotKey,
  DEFAULT_TTL_SECONDS,
  deleteSnapshot,
  getSnapshot,
  INDEX_SCHEMA_VERSION,
  listSnapshots,
  putSnapshot,
  recordSnapshotEvent,
  summarizeSnapshotIndex,
  touchSnapshot,
} from './snapshot-index';

interface StoredValue {
  value: string;
  expirationTtl?: number;
}

function createFakeKv(): KVNamespace {
  const store = new Map<string, StoredValue>();
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key)?.value ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      store.set(key, { value, expirationTtl: options?.expirationTtl });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(options?: { prefix?: string; cursor?: string }) {
      const prefix = options?.prefix ?? '';
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: '' };
    },
  };
  return kv as unknown as KVNamespace;
}

describe('snapshot-index', () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createFakeKv();
  });

  it('round-trips a put/get with the expected schema and TTL', async () => {
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

    const read = await getSnapshot(kv, 'kvfxkaido/push', 'main');
    expect(read).toEqual(written);
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
    expect(all.map((e) => e.imageId).sort()).toEqual(['im1', 'im2']);
  });

  it('drops entries with mismatched schema versions', async () => {
    // Simulate a stale v0 entry written by an older deployment.
    await kv.put(buildSnapshotKey('legacy/repo', 'main'), JSON.stringify({ v: 0, imageId: 'im' }));
    expect(await getSnapshot(kv, 'legacy/repo', 'main')).toBeNull();
  });

  it('default TTL matches the 7-day policy from the design doc', () => {
    expect(DEFAULT_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});

describe('recordSnapshotEvent', () => {
  it('writes an entry on a successful hibernate response', async () => {
    const kv = createFakeKv();
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
    const kv = createFakeKv();
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

  it('returns noop on restore when the entry has been evicted', async () => {
    const kv = createFakeKv();
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
    const kv = createFakeKv();
    const status = await recordSnapshotEvent(
      kv,
      'hibernate',
      JSON.stringify({ sandbox_id: 'sb-1' }),
      { ok: true, snapshot_id: 'im', restore_token: 'tok' },
    );
    expect(status).toBe('skipped_missing_context');
  });

  it('returns noop on a hibernate response that is not ok', async () => {
    const kv = createFakeKv();
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
    const kv = createFakeKv();
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
    const kv = createFakeKv();
    const metrics = await summarizeSnapshotIndex(kv);
    expect(metrics).toEqual({
      total: 0,
      totalSizeBytes: 0,
      oldestAccessedAt: null,
      newestAccessedAt: null,
    });
  });

  it('aggregates count, total size, and access-time bounds', async () => {
    const kv = createFakeKv();
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
