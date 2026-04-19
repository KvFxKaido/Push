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
