/**
 * Integration tests for `/api/library/*` v2a handlers.
 *
 * Drives the handlers against an in-memory KV mock so each route's
 * happy path, validation envelope, NOT_CONFIGURED fail-closed, cascade
 * delete, itemCount maintenance, and one-shot v1→v2a migration are
 * pinned.
 */

import { describe, expect, it } from 'vitest';
import type { KVNamespace } from '@cloudflare/workers-types';

import {
  handleCollectionsCreate,
  handleCollectionsDelete,
  handleCollectionsGet,
  handleCollectionsList,
  handleCollectionsUpdate,
  handleItemsCreate,
  handleItemsDelete,
  handleItemsUpdate,
} from './worker-chat-library';

interface MockKvEntry {
  value: string;
  metadata?: unknown;
}

class MockKvNamespace {
  readonly store = new Map<string, MockKvEntry>();
  pageSize: number | null = null;

  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }
  async put(key: string, value: string, options?: { metadata?: unknown }): Promise<void> {
    this.store.set(key, { value, metadata: options?.metadata });
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list<TMeta = unknown>(options?: { prefix?: string; cursor?: string }) {
    const prefix = options?.prefix ?? '';
    const matching: Array<{ name: string; metadata: TMeta }> = [];
    for (const [name, entry] of this.store) {
      if (!name.startsWith(prefix)) continue;
      matching.push({ name, metadata: entry.metadata as TMeta });
    }
    if (this.pageSize === null || matching.length <= this.pageSize) {
      return { keys: matching, list_complete: true as const };
    }
    const start = options?.cursor ? Number.parseInt(options.cursor, 10) || 0 : 0;
    const end = start + this.pageSize;
    const page = matching.slice(start, end);
    const list_complete = end >= matching.length;
    return list_complete
      ? { keys: page, list_complete: true as const }
      : { keys: page, list_complete: false as const, cursor: String(end) };
  }
}

function makeRequest(body: unknown): Request {
  return new Request('https://push.test/api/library/x', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const VALID_DOC = {
  type: 'document' as const,
  filename: 'pz-timeline.md',
  mimeType: 'text/markdown',
  sizeBytes: 4096,
  content: '# Project ZERO Timeline\n\nLong content...',
};

async function createLibrary(env: { CHAT_LIBRARY: KVNamespace }, name: string): Promise<string> {
  const res = await handleCollectionsCreate(makeRequest({ name }), env);
  const json = (await res.json()) as Record<string, unknown>;
  const collection = json.collection as Record<string, unknown>;
  return collection.id as string;
}

// ---------------------------------------------------------------------------
// Collections CRUD
// ---------------------------------------------------------------------------

describe('handleCollectionsCreate', () => {
  it('creates a library with a name and returns the collection + meta', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };

    const res = await handleCollectionsCreate(
      makeRequest({ name: 'Project ZERO', instructions: 'Stay terse.' }),
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    const collection = json.collection as Record<string, unknown>;
    expect(collection.name).toBe('Project ZERO');
    expect(collection.instructions).toBe('Stay terse.');
    expect(collection.itemCount).toBe(0);
    expect(typeof collection.id).toBe('string');
    expect(collection.createdAt).toBe(collection.updatedAt);
  });

  it('rejects missing name with INVALID_NAME', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const res = await handleCollectionsCreate(makeRequest({}), env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).code).toBe('INVALID_NAME');
  });

  it('rejects an overlong name with NAME_TOO_LONG', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const res = await handleCollectionsCreate(makeRequest({ name: 'x'.repeat(201) }), env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).code).toBe('NAME_TOO_LONG');
  });

  it('rejects overlong instructions with INSTRUCTIONS_TOO_LONG', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const res = await handleCollectionsCreate(
      makeRequest({ name: 'PZ', instructions: 'x'.repeat(2001) }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).code).toBe('INSTRUCTIONS_TOO_LONG');
  });

  it('returns NOT_CONFIGURED when CHAT_LIBRARY is unbound', async () => {
    const res = await handleCollectionsCreate(makeRequest({ name: 'X' }), {});
    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>).code).toBe('NOT_CONFIGURED');
  });

  it('compares the trimmed name against the cap (whitespace-padded names are OK)', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    // 200 leading spaces + 5-char name = 205 raw chars, 5 trimmed. Must succeed.
    const padded = `${' '.repeat(200)}ZERO!`;
    const res = await handleCollectionsCreate(makeRequest({ name: padded }), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect((json.collection as Record<string, unknown>).name).toBe('ZERO!');
  });
});

describe('handleCollectionsList', () => {
  it('returns collections (metadata only) sorted by updatedAt desc', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    await createLibrary(env, 'Alpha');
    await new Promise((r) => setTimeout(r, 2));
    await createLibrary(env, 'Beta');

    const res = await handleCollectionsList(makeRequest({}), env);
    const json = (await res.json()) as Record<string, unknown>;
    const collections = json.collections as Array<Record<string, unknown>>;
    expect(collections.length).toBe(2);
    expect(collections[0].name).toBe('Beta');
    expect(collections[1].name).toBe('Alpha');
    // Meta exposes hasInstructions, not the raw text.
    expect(collections[0].hasInstructions).toBe(false);
    expect(Object.keys(collections[0])).not.toContain('instructions');
  });

  it('paginates across KV cursors', async () => {
    const kv = new MockKvNamespace();
    kv.pageSize = 2;
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    for (let i = 0; i < 5; i++) {
      await createLibrary(env, `lib-${i}`);
      await new Promise((r) => setTimeout(r, 2));
    }

    const res = await handleCollectionsList(makeRequest({}), env);
    const json = (await res.json()) as Record<string, unknown>;
    const collections = json.collections as Array<Record<string, unknown>>;
    expect(collections.length).toBe(5);
  });
});

describe('handleCollectionsGet', () => {
  it('returns the collection + item metadata (no content) by default', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const libId = await createLibrary(env, 'PZ');
    await handleItemsCreate(makeRequest({ libraryId: libId, attachment: VALID_DOC }), env);

    const res = await handleCollectionsGet(makeRequest({ id: libId }), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const collection = json.collection as Record<string, unknown>;
    const items = json.items as Array<Record<string, unknown>>;
    expect(collection.id).toBe(libId);
    expect(items.length).toBe(1);
    // Metadata shape — no content blob.
    expect(Object.keys(items[0])).not.toContain('content');
  });

  it('returns full item content when includeContent is true', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const libId = await createLibrary(env, 'PZ');
    await handleItemsCreate(makeRequest({ libraryId: libId, attachment: VALID_DOC }), env);

    const res = await handleCollectionsGet(makeRequest({ id: libId, includeContent: true }), env);
    const json = (await res.json()) as Record<string, unknown>;
    const items = json.items as Array<Record<string, unknown>>;
    expect(items[0].content).toBe(VALID_DOC.content);
  });

  it('returns 404 for an unknown library id', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const res = await handleCollectionsGet(makeRequest({ id: 'nope' }), env);
    expect(res.status).toBe(404);
  });
});

describe('handleCollectionsUpdate', () => {
  it('renames the library and bumps updatedAt', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const libId = await createLibrary(env, 'Old');
    await new Promise((r) => setTimeout(r, 2));

    const res = await handleCollectionsUpdate(makeRequest({ id: libId, name: 'New' }), env);
    const json = (await res.json()) as Record<string, unknown>;
    const collection = json.collection as Record<string, unknown>;
    expect(collection.name).toBe('New');
    expect(collection.updatedAt).toBeGreaterThan(collection.createdAt as number);
  });

  it('clears instructions when null is passed', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const createRes = await handleCollectionsCreate(
      makeRequest({ name: 'PZ', instructions: 'present' }),
      env,
    );
    const libId = ((await createRes.json()) as { collection: { id: string } }).collection.id;

    const res = await handleCollectionsUpdate(makeRequest({ id: libId, instructions: null }), env);
    const json = (await res.json()) as Record<string, unknown>;
    expect((json.collection as Record<string, unknown>).instructions).toBeUndefined();
  });

  it('returns 404 for unknown id', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const res = await handleCollectionsUpdate(makeRequest({ id: 'nope', name: 'x' }), env);
    expect(res.status).toBe(404);
  });
});

describe('handleCollectionsDelete', () => {
  it('cascades — deletes the library and all of its items', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const libA = await createLibrary(env, 'A');
    const libB = await createLibrary(env, 'B');
    await handleItemsCreate(makeRequest({ libraryId: libA, attachment: VALID_DOC }), env);
    await handleItemsCreate(makeRequest({ libraryId: libA, attachment: VALID_DOC }), env);
    await handleItemsCreate(makeRequest({ libraryId: libB, attachment: VALID_DOC }), env);

    const res = await handleCollectionsDelete(makeRequest({ id: libA }), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).deletedItems).toBe(2);

    // Library A and its items gone.
    const getRes = await handleCollectionsGet(makeRequest({ id: libA }), env);
    expect(getRes.status).toBe(404);

    // Library B intact.
    const listRes = await handleCollectionsList(makeRequest({}), env);
    const listJson = (await listRes.json()) as Record<string, unknown>;
    const collections = listJson.collections as Array<Record<string, unknown>>;
    expect(collections.length).toBe(1);
    expect(collections[0].id).toBe(libB);
    expect(collections[0].itemCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Items CRUD
// ---------------------------------------------------------------------------

describe('handleItemsCreate', () => {
  it('persists an item under its library and bumps the library itemCount', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const libId = await createLibrary(env, 'PZ');

    const res = await handleItemsCreate(
      makeRequest({ libraryId: libId, attachment: VALID_DOC, label: 'PZ Timeline v3.1' }),
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const item = json.item as Record<string, unknown>;
    expect(item.libraryId).toBe(libId);
    expect(item.label).toBe('PZ Timeline v3.1');
    const collection = json.collection as Record<string, unknown>;
    expect(collection.itemCount).toBe(1);
  });

  it('rejects when libraryId is missing', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const res = await handleItemsCreate(makeRequest({ attachment: VALID_DOC }), env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).code).toBe('INVALID_LIBRARY_ID');
  });

  it('rejects when the owning library does not exist (404 LIBRARY_NOT_FOUND)', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const res = await handleItemsCreate(
      makeRequest({ libraryId: 'phantom', attachment: VALID_DOC }),
      env,
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as Record<string, unknown>).code).toBe('LIBRARY_NOT_FOUND');
  });

  it('rejects oversized content with CONTENT_TOO_LARGE 413', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const libId = await createLibrary(env, 'PZ');
    const huge = 'x'.repeat(2 * 1024 * 1024 + 1);
    const res = await handleItemsCreate(
      makeRequest({ libraryId: libId, attachment: { ...VALID_DOC, content: huge } }),
      env,
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as Record<string, unknown>).code).toBe('CONTENT_TOO_LARGE');
  });

  it('rejects an oversized body with BODY_TOO_LARGE 413 before JSON parse', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const libId = await createLibrary(env, 'PZ');
    const enormous = 'x'.repeat(3 * 1024 * 1024 + 100);
    const res = await handleItemsCreate(
      makeRequest({ libraryId: libId, attachment: { ...VALID_DOC, content: enormous } }),
      env,
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as Record<string, unknown>).code).toBe('BODY_TOO_LARGE');
  });

  it('rejects a long label with LABEL_TOO_LONG', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const libId = await createLibrary(env, 'PZ');
    const res = await handleItemsCreate(
      makeRequest({ libraryId: libId, attachment: VALID_DOC, label: 'a'.repeat(201) }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).code).toBe('LABEL_TOO_LONG');
  });
});

describe('handleItemsUpdate', () => {
  it('renames a label and preserves content', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const libId = await createLibrary(env, 'PZ');
    const createRes = await handleItemsCreate(
      makeRequest({ libraryId: libId, attachment: VALID_DOC, label: 'old' }),
      env,
    );
    const itemId = ((await createRes.json()) as { item: { id: string } }).item.id;
    await new Promise((r) => setTimeout(r, 2));

    const res = await handleItemsUpdate(
      makeRequest({ libraryId: libId, id: itemId, label: 'new label' }),
      env,
    );
    const json = (await res.json()) as Record<string, unknown>;
    const item = json.item as Record<string, unknown>;
    expect(item.label).toBe('new label');
    expect(item.content).toBe(VALID_DOC.content);
    expect(item.updatedAt).toBeGreaterThan(item.createdAt as number);
  });
});

describe('handleItemsDelete', () => {
  it('removes the item and decrements the library itemCount', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const libId = await createLibrary(env, 'PZ');
    const createRes = await handleItemsCreate(
      makeRequest({ libraryId: libId, attachment: VALID_DOC }),
      env,
    );
    const itemId = ((await createRes.json()) as { item: { id: string } }).item.id;

    const delRes = await handleItemsDelete(makeRequest({ libraryId: libId, id: itemId }), env);
    expect(delRes.status).toBe(200);

    const getRes = await handleCollectionsGet(makeRequest({ id: libId }), env);
    const getJson = (await getRes.json()) as Record<string, unknown>;
    expect((getJson.collection as Record<string, unknown>).itemCount).toBe(0);
    expect((getJson.items as unknown[]).length).toBe(0);
  });

  it('is idempotent — second delete still returns ok and itemCount stays 0', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const libId = await createLibrary(env, 'PZ');
    const createRes = await handleItemsCreate(
      makeRequest({ libraryId: libId, attachment: VALID_DOC }),
      env,
    );
    const itemId = ((await createRes.json()) as { item: { id: string } }).item.id;
    await handleItemsDelete(makeRequest({ libraryId: libId, id: itemId }), env);
    const second = await handleItemsDelete(makeRequest({ libraryId: libId, id: itemId }), env);
    expect(second.status).toBe(200);
    const getRes = await handleCollectionsGet(makeRequest({ id: libId }), env);
    const getJson = (await getRes.json()) as Record<string, unknown>;
    expect((getJson.collection as Record<string, unknown>).itemCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// v1 → v2a migration
// ---------------------------------------------------------------------------

describe('v1 → v2a migration', () => {
  it('folds legacy library:<id> items into a Default collection on first touch', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };

    // Seed two v1-shaped items directly into KV — bypasses the v2a
    // handlers so we mimic state left by the merged v1 deploy.
    const v1Item1 = {
      id: 'v1-a',
      type: 'document',
      filename: 'a.md',
      mimeType: 'text/markdown',
      sizeBytes: 100,
      content: 'alpha',
      label: 'Alpha doc',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const v1Item2 = {
      id: 'v1-b',
      type: 'document',
      filename: 'b.md',
      mimeType: 'text/markdown',
      sizeBytes: 100,
      content: 'beta',
      createdAt: 2000,
      updatedAt: 2000,
    };
    await kv.put('library:v1-a', JSON.stringify(v1Item1));
    await kv.put('library:v1-b', JSON.stringify(v1Item2));

    // First v2a touch triggers migration.
    const listRes = await handleCollectionsList(makeRequest({}), env);
    const listJson = (await listRes.json()) as Record<string, unknown>;
    const collections = listJson.collections as Array<Record<string, unknown>>;
    expect(collections.length).toBe(1);
    expect(collections[0].name).toBe('Default');
    expect(collections[0].itemCount).toBe(2);
    const defaultId = collections[0].id as string;

    // Items now live under the new namespace, labels and content preserved.
    const getRes = await handleCollectionsGet(
      makeRequest({ id: defaultId, includeContent: true }),
      env,
    );
    const getJson = (await getRes.json()) as Record<string, unknown>;
    const items = getJson.items as Array<Record<string, unknown>>;
    expect(items.length).toBe(2);
    const aItem = items.find((i) => i.filename === 'a.md');
    expect(aItem?.content).toBe('alpha');
    expect(aItem?.label).toBe('Alpha doc');
    expect(aItem?.libraryId).toBe(defaultId);

    // Old keys are gone.
    expect(await kv.get('library:v1-a')).toBeNull();
    expect(await kv.get('library:v1-b')).toBeNull();

    // Marker is set so a second call doesn't re-run.
    expect(await kv.get('_meta:v1-migrated')).toBe('done');
  });

  it('sets the marker even when no v1 items exist (fresh install)', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    await handleCollectionsList(makeRequest({}), env);
    expect(await kv.get('_meta:v1-migrated')).toBe('done');
  });

  it('is idempotent — running again after marker is set is a no-op', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    await kv.put(
      'library:v1-a',
      JSON.stringify({
        id: 'v1-a',
        type: 'document',
        filename: 'a.md',
        mimeType: 'text/markdown',
        sizeBytes: 100,
        content: 'alpha',
        createdAt: 1000,
        updatedAt: 1000,
      }),
    );
    await handleCollectionsList(makeRequest({}), env);
    const listAfterFirst = await handleCollectionsList(makeRequest({}), env);
    const json = (await listAfterFirst.json()) as Record<string, unknown>;
    const collections = json.collections as Array<Record<string, unknown>>;
    // Still exactly one Default — second run didn't create another.
    expect(collections.length).toBe(1);
    expect(collections[0].itemCount).toBe(1);
  });

  it('uses a deterministic Default library id so concurrent races converge', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    await kv.put(
      'library:v1-x',
      JSON.stringify({
        id: 'v1-x',
        type: 'document',
        filename: 'x.md',
        mimeType: 'text/markdown',
        sizeBytes: 5,
        content: 'hello',
        createdAt: 1000,
        updatedAt: 1000,
      }),
    );
    await handleCollectionsList(makeRequest({}), env);
    // The Default record always lives at the same key, regardless of
    // how many migration races happened.
    expect(await kv.get('lib:00000000-0000-4000-8000-000000000001')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// itemCount self-heal on collections/get
// ---------------------------------------------------------------------------

describe('handleCollectionsGet self-heal', () => {
  it('reconciles a drifted Library.itemCount from the actual item list', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const libId = await createLibrary(env, 'PZ');
    await handleItemsCreate(makeRequest({ libraryId: libId, attachment: VALID_DOC }), env);
    await handleItemsCreate(makeRequest({ libraryId: libId, attachment: VALID_DOC }), env);

    // Simulate drift: overwrite the Library record with a stale count
    // (mimicking what a non-atomic concurrent mutation could produce).
    const libKey = `lib:${libId}`;
    const raw = await kv.get(libKey);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as Record<string, unknown>;
    parsed.itemCount = 99;
    await kv.put(libKey, JSON.stringify(parsed));

    const res = await handleCollectionsGet(makeRequest({ id: libId }), env);
    const json = (await res.json()) as Record<string, unknown>;
    const collection = json.collection as Record<string, unknown>;
    // Detail view shows the real count.
    expect(collection.itemCount).toBe(2);

    // And the persisted record now matches, so list rows pick up the
    // corrected badge next refresh.
    const listRes = await handleCollectionsList(makeRequest({}), env);
    const listJson = (await listRes.json()) as Record<string, unknown>;
    const collections = listJson.collections as Array<Record<string, unknown>>;
    const target = collections.find((c) => c.id === libId);
    expect(target?.itemCount).toBe(2);
  });
});
