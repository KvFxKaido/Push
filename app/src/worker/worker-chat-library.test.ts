/**
 * Integration tests for the `/api/library/*` worker handlers.
 *
 * Drives the handlers against an in-memory KV mock so each route's
 * happy path, validation envelope, and NOT_CONFIGURED fail-closed
 * behavior are pinned. Mirrors the shape of worker-artifacts.test.ts.
 */

import { describe, expect, it } from 'vitest';
import type { KVNamespace } from '@cloudflare/workers-types';

import {
  handleLibraryCreate,
  handleLibraryDelete,
  handleLibraryGet,
  handleLibraryList,
  handleLibraryUpdate,
} from './worker-chat-library';

interface MockKvEntry {
  value: string;
  metadata?: unknown;
}

class MockKvNamespace {
  readonly store = new Map<string, MockKvEntry>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }
  async put(key: string, value: string, options?: { metadata?: unknown }): Promise<void> {
    this.store.set(key, { value, metadata: options?.metadata });
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list<TMeta = unknown>(options?: { prefix?: string }) {
    const prefix = options?.prefix ?? '';
    const keys = [];
    for (const [name, entry] of this.store) {
      if (!name.startsWith(prefix)) continue;
      keys.push({ name, metadata: entry.metadata as TMeta });
    }
    return { keys };
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

describe('handleLibraryCreate', () => {
  it('persists a valid document and returns item + meta', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const req = makeRequest({ attachment: VALID_DOC, label: 'PZ Timeline v3.1' });

    const res = await handleLibraryCreate(req, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    const item = json.item as Record<string, unknown>;
    expect(item.filename).toBe('pz-timeline.md');
    expect(item.label).toBe('PZ Timeline v3.1');
    expect(item.type).toBe('document');
    expect(typeof item.id).toBe('string');
    expect(typeof item.createdAt).toBe('number');
    expect(item.createdAt).toBe(item.updatedAt);
  });

  it('treats an empty/whitespace label as absent', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const res = await handleLibraryCreate(
      makeRequest({ attachment: VALID_DOC, label: '   ' }),
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const item = json.item as Record<string, unknown>;
    expect(item.label).toBeUndefined();
  });

  it('rejects an invalid attachment shape with INVALID_ATTACHMENT', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const res = await handleLibraryCreate(makeRequest({ attachment: { filename: 'x' } }), env);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('INVALID_ATTACHMENT');
  });

  it('returns NOT_CONFIGURED when CHAT_LIBRARY is unbound', async () => {
    const res = await handleLibraryCreate(makeRequest({ attachment: VALID_DOC }), {});
    expect(res.status).toBe(503);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('NOT_CONFIGURED');
  });
});

describe('handleLibraryList', () => {
  it('returns metadata only (no content), most-recent first', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };

    await handleLibraryCreate(makeRequest({ attachment: VALID_DOC, label: 'A' }), env);
    // Force a different createdAt by waiting a tick.
    await new Promise((r) => setTimeout(r, 2));
    await handleLibraryCreate(
      makeRequest({ attachment: { ...VALID_DOC, filename: 'b.md' }, label: 'B' }),
      env,
    );

    const res = await handleLibraryList(makeRequest({}), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const items = json.items as Array<Record<string, unknown>>;
    expect(items.length).toBe(2);
    expect(items[0].label).toBe('B');
    expect(items[1].label).toBe('A');
    // Meta must not include `content` (the big base64 blob).
    expect(Object.keys(items[0])).not.toContain('content');
  });

  it('returns an empty list when KV is empty', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const res = await handleLibraryList(makeRequest({}), env);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.items).toEqual([]);
  });
});

describe('handleLibraryGet', () => {
  it('returns the full item including content', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const createRes = await handleLibraryCreate(
      makeRequest({ attachment: VALID_DOC, label: 'PZ' }),
      env,
    );
    const created = (await createRes.json()) as Record<string, unknown>;
    const id = (created.item as Record<string, unknown>).id as string;

    const res = await handleLibraryGet(makeRequest({ id }), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const item = json.item as Record<string, unknown>;
    expect(item.content).toBe(VALID_DOC.content);
    expect(item.filename).toBe(VALID_DOC.filename);
  });

  it('returns 404 NOT_FOUND for an unknown id', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const res = await handleLibraryGet(makeRequest({ id: 'does-not-exist' }), env);
    expect(res.status).toBe(404);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('NOT_FOUND');
  });

  it('rejects missing id with INVALID_ID', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const res = await handleLibraryGet(makeRequest({}), env);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('INVALID_ID');
  });
});

describe('handleLibraryUpdate', () => {
  it('updates the label and bumps updatedAt', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const createRes = await handleLibraryCreate(
      makeRequest({ attachment: VALID_DOC, label: 'Old' }),
      env,
    );
    const created = (await createRes.json()) as Record<string, unknown>;
    const item = created.item as Record<string, unknown>;
    const id = item.id as string;
    const originalUpdatedAt = item.updatedAt as number;

    await new Promise((r) => setTimeout(r, 2));
    const res = await handleLibraryUpdate(makeRequest({ id, label: 'New label' }), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const updated = json.item as Record<string, unknown>;
    expect(updated.label).toBe('New label');
    expect(updated.updatedAt).toBeGreaterThan(originalUpdatedAt);
    // Content and filename are preserved.
    expect(updated.content).toBe(VALID_DOC.content);
    expect(updated.filename).toBe(VALID_DOC.filename);
  });

  it('clears the label when null is passed', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const createRes = await handleLibraryCreate(
      makeRequest({ attachment: VALID_DOC, label: 'Original' }),
      env,
    );
    const id = ((await createRes.json()) as Record<string, unknown>).item as Record<
      string,
      unknown
    >;
    const res = await handleLibraryUpdate(makeRequest({ id: id.id, label: null }), env);
    const json = (await res.json()) as Record<string, unknown>;
    expect((json.item as Record<string, unknown>).label).toBeUndefined();
  });

  it('returns 404 for unknown id', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const res = await handleLibraryUpdate(makeRequest({ id: 'nope', label: 'x' }), env);
    expect(res.status).toBe(404);
  });
});

describe('handleLibraryDelete', () => {
  it('hard-deletes the item and removes it from list', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const createRes = await handleLibraryCreate(makeRequest({ attachment: VALID_DOC }), env);
    const created = (await createRes.json()) as Record<string, unknown>;
    const id = (created.item as Record<string, unknown>).id as string;

    const delRes = await handleLibraryDelete(makeRequest({ id }), env);
    expect(delRes.status).toBe(200);

    const listRes = await handleLibraryList(makeRequest({}), env);
    const listJson = (await listRes.json()) as Record<string, unknown>;
    expect(listJson.items).toEqual([]);

    const getRes = await handleLibraryGet(makeRequest({ id }), env);
    expect(getRes.status).toBe(404);
  });

  it('is idempotent — deleting an unknown id still returns ok', async () => {
    const kv = new MockKvNamespace();
    const env = { CHAT_LIBRARY: kv as unknown as KVNamespace };
    const res = await handleLibraryDelete(makeRequest({ id: 'phantom' }), env);
    expect(res.status).toBe(200);
  });
});
