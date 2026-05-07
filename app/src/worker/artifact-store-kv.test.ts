/**
 * Roundtrip tests for `WebKvArtifactStore`.
 *
 * Uses an in-memory `MockKvNamespace` rather than miniflare so the
 * tests stay fast and don't pull a heavy dependency for one suite.
 * The mock implements only the subset of `KVNamespace` the store
 * actually uses (`get` / `put` / `delete` / `list`); the worker's
 * production runtime is the integration boundary.
 */

import { describe, expect, it } from 'vitest';
import type { KVNamespace } from '@cloudflare/workers-types';

import type { ArtifactRecord, ArtifactScope } from '@push/lib/artifacts/types';

import { WebKvArtifactStore } from './artifact-store-kv';

interface MockKvEntry {
  value: string;
  metadata?: unknown;
}

class MockKvNamespace {
  private readonly store = new Map<string, MockKvEntry>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }

  async put(key: string, value: string, options?: { metadata?: unknown }): Promise<void> {
    this.store.set(key, { value, metadata: options?.metadata });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list<TMeta = unknown>(options?: {
    prefix?: string;
  }): Promise<{
    keys: Array<{ name: string; metadata?: TMeta }>;
  }> {
    const prefix = options?.prefix ?? '';
    const keys = [];
    for (const [name, entry] of this.store) {
      if (!name.startsWith(prefix)) continue;
      keys.push({ name, metadata: entry.metadata as TMeta });
    }
    return { keys };
  }
}

const SCOPE: ArtifactScope = {
  repoFullName: 'acme/widgets',
  branch: 'main',
  chatId: 'chat_1',
};

function makeMermaid(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 'art_one',
    scope: SCOPE,
    author: { surface: 'web', role: 'orchestrator', createdAt: 1_700_000_000_000 },
    title: 'Auth flow',
    status: 'ready',
    updatedAt: 1_700_000_000_000,
    kind: 'mermaid',
    source: 'graph TD; A-->B',
    ...overrides,
  } as ArtifactRecord;
}

describe('WebKvArtifactStore', () => {
  it('roundtrips put → get under the chat-scoped key', async () => {
    const kv = new MockKvNamespace();
    const store = new WebKvArtifactStore(kv as unknown as KVNamespace);
    const record = makeMermaid();

    await store.put(record);
    const loaded = await store.get(SCOPE, 'art_one');

    expect(loaded).toEqual(record);
  });

  it('returns null for a missing artifact', async () => {
    const kv = new MockKvNamespace();
    const store = new WebKvArtifactStore(kv as unknown as KVNamespace);
    expect(await store.get(SCOPE, 'art_missing')).toBeNull();
  });

  it('throws on a corrupt KV value rather than swallowing it', async () => {
    const kv = new MockKvNamespace();
    const store = new WebKvArtifactStore(kv as unknown as KVNamespace);
    await kv.put('artifact:acme%2Fwidgets:main:chat_1:art_corrupt', '{ not json');
    await expect(store.get(SCOPE, 'art_corrupt')).rejects.toThrow(/Corrupt artifact/);
  });

  it('lists artifacts under the chat scope, newest-first', async () => {
    const kv = new MockKvNamespace();
    const store = new WebKvArtifactStore(kv as unknown as KVNamespace);

    await store.put(makeMermaid({ id: 'art_a', updatedAt: 1000 } as Partial<ArtifactRecord>));
    await store.put(makeMermaid({ id: 'art_b', updatedAt: 3000 } as Partial<ArtifactRecord>));
    await store.put(makeMermaid({ id: 'art_c', updatedAt: 2000 } as Partial<ArtifactRecord>));

    const list = await store.list({ scope: SCOPE });
    expect(list.map((r) => r.id)).toEqual(['art_b', 'art_c', 'art_a']);
  });

  it('respects a kind filter on list', async () => {
    const kv = new MockKvNamespace();
    const store = new WebKvArtifactStore(kv as unknown as KVNamespace);

    await store.put(makeMermaid({ id: 'art_mermaid' }));
    await store.put({
      id: 'art_html',
      scope: SCOPE,
      author: { surface: 'web', role: 'orchestrator', createdAt: 1000 },
      title: 'page',
      status: 'ready',
      updatedAt: 2000,
      kind: 'static-html',
      files: [{ path: '/index.html', content: '<h1>hi</h1>' }],
    });

    const onlyHtml = await store.list({ scope: SCOPE, kind: 'static-html' });
    expect(onlyHtml.map((r) => r.id)).toEqual(['art_html']);
  });

  it('respects the limit on list', async () => {
    const kv = new MockKvNamespace();
    const store = new WebKvArtifactStore(kv as unknown as KVNamespace);
    for (let i = 0; i < 5; i++) {
      await store.put(
        makeMermaid({ id: `art_${i}`, updatedAt: 1000 + i } as Partial<ArtifactRecord>),
      );
    }
    const list = await store.list({ scope: SCOPE, limit: 2 });
    expect(list).toHaveLength(2);
  });

  it('returns an empty list when the prefix matches nothing', async () => {
    const kv = new MockKvNamespace();
    const store = new WebKvArtifactStore(kv as unknown as KVNamespace);
    const list = await store.list({
      scope: { repoFullName: 'unknown/repo', branch: null },
    });
    expect(list).toEqual([]);
  });

  it('separates chat-scoped and branch-scoped artifacts (no cross-scope leakage)', async () => {
    const kv = new MockKvNamespace();
    const store = new WebKvArtifactStore(kv as unknown as KVNamespace);

    const branchScope: ArtifactScope = { repoFullName: 'acme/widgets', branch: 'feat/x' };
    const chatRecord = makeMermaid({ id: 'art_chat' });
    const branchRecord = { ...makeMermaid({ id: 'art_branch' }), scope: branchScope };

    await store.put(chatRecord);
    await store.put(branchRecord);

    const chatList = await store.list({ scope: SCOPE });
    const branchList = await store.list({ scope: branchScope });

    expect(chatList.map((r) => r.id)).toEqual(['art_chat']);
    expect(branchList.map((r) => r.id)).toEqual(['art_branch']);
  });

  it('idempotent delete on a missing artifact', async () => {
    const kv = new MockKvNamespace();
    const store = new WebKvArtifactStore(kv as unknown as KVNamespace);
    await expect(store.delete(SCOPE, 'art_missing')).resolves.toBeUndefined();
  });

  it('delete removes a previously put artifact', async () => {
    const kv = new MockKvNamespace();
    const store = new WebKvArtifactStore(kv as unknown as KVNamespace);
    await store.put(makeMermaid());
    await store.delete(SCOPE, 'art_one');
    expect(await store.get(SCOPE, 'art_one')).toBeNull();
  });

  it('rejects path-traversal-shaped artifact ids on get/put/delete', async () => {
    const kv = new MockKvNamespace();
    const store = new WebKvArtifactStore(kv as unknown as KVNamespace);
    const malicious = ['../other/art', 'foo/bar', '..', '.', ''];
    for (const id of malicious) {
      await expect(store.get(SCOPE, id)).rejects.toThrow(/Invalid artifact id/);
      await expect(store.delete(SCOPE, id)).rejects.toThrow(/Invalid artifact id/);
    }
    const evilRecord = { ...makeMermaid(), id: '../escape' };
    await expect(store.put(evilRecord)).rejects.toThrow(/Invalid artifact id/);
  });

  it('writes list-friendly metadata on put for cheap pre-fetch filtering', async () => {
    const kv = new MockKvNamespace();
    const store = new WebKvArtifactStore(kv as unknown as KVNamespace);
    const record = makeMermaid();
    await store.put(record);
    const listing = await kv.list<{ updatedAt: number; kind: string; title: string }>({
      prefix: 'artifact:',
    });
    expect(listing.keys[0].metadata).toEqual({
      updatedAt: record.updatedAt,
      kind: 'mermaid',
      title: 'Auth flow',
    });
  });
});
