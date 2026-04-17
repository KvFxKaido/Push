import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each test gets a fresh IDBFactory so schema upgrades are exercised and
// state does not leak between cases. `vi.resetModules()` forces `app-db`
// to re-evaluate and reset its internal `dbPromise` cache each test.
async function loadFreshModule() {
  vi.resetModules();
  return import('./app-db');
}

beforeEach(async () => {
  // Fresh in-memory IDB per test.
  const { IDBFactory } = await import('fake-indexeddb');
  vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Conversation = {
  id: string;
  repoFullName: string;
  lastMessageAt: number;
  branch: string;
  messages: Array<{ role: string; content: string }>;
};

function makeConversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    repoFullName: 'octo/push',
    lastMessageAt: 1_000,
    branch: 'main',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  };
}

describe('app-db — schema & round-trip', () => {
  it('creates every declared object store on first open', async () => {
    const { STORE, withStore } = await loadFreshModule();
    // Touch each store; withStore will throw if any is missing.
    for (const name of Object.values(STORE)) {
      await withStore(name, 'readonly', (store) => store.count());
    }
  });

  it('round-trips a conversation: put → get → getAll', async () => {
    const { STORE, put, get, getAll } = await loadFreshModule();
    const conv = makeConversation('c-1');
    const key = await put(STORE.conversations, conv);
    expect(key).toBe('c-1');

    const fetched = await get<Conversation>(STORE.conversations, 'c-1');
    expect(fetched).toEqual(conv);

    const all = await getAll<Conversation>(STORE.conversations);
    expect(all).toEqual([conv]);
  });

  it('put overwrites an existing record with the same id', async () => {
    const { STORE, put, get } = await loadFreshModule();
    await put(STORE.conversations, makeConversation('c-1', { branch: 'main' }));
    await put(STORE.conversations, makeConversation('c-1', { branch: 'feature' }));

    const fetched = await get<Conversation>(STORE.conversations, 'c-1');
    expect(fetched?.branch).toBe('feature');
  });

  it('get returns undefined for a missing key', async () => {
    const { STORE, get } = await loadFreshModule();
    const result = await get<Conversation>(STORE.conversations, 'nope');
    expect(result).toBeUndefined();
  });

  it('del removes a record', async () => {
    const { STORE, put, del, get } = await loadFreshModule();
    await put(STORE.conversations, makeConversation('c-1'));
    await del(STORE.conversations, 'c-1');
    expect(await get<Conversation>(STORE.conversations, 'c-1')).toBeUndefined();
  });

  it('clear empties a store', async () => {
    const { STORE, putMany, clear, count } = await loadFreshModule();
    await putMany(STORE.conversations, [makeConversation('a'), makeConversation('b')]);
    expect(await count(STORE.conversations)).toBe(2);
    await clear(STORE.conversations);
    expect(await count(STORE.conversations)).toBe(0);
  });

  it('count reflects the number of records', async () => {
    const { STORE, put, count } = await loadFreshModule();
    expect(await count(STORE.conversations)).toBe(0);
    await put(STORE.conversations, makeConversation('a'));
    await put(STORE.conversations, makeConversation('b'));
    expect(await count(STORE.conversations)).toBe(2);
  });
});

describe('app-db — batch operations', () => {
  it('putMany persists every record in one transaction', async () => {
    const { STORE, putMany, getAll } = await loadFreshModule();
    const convs = [makeConversation('a'), makeConversation('b'), makeConversation('c')];
    await putMany(STORE.conversations, convs);

    const stored = await getAll<Conversation>(STORE.conversations);
    expect(stored).toHaveLength(3);
    expect(stored.map((c) => c.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('putMany short-circuits on an empty array without opening a transaction', async () => {
    const { STORE, putMany, count } = await loadFreshModule();
    await expect(putMany(STORE.conversations, [])).resolves.toBeUndefined();
    expect(await count(STORE.conversations)).toBe(0);
  });

  it('deleteMany removes every listed key', async () => {
    const { STORE, putMany, deleteMany, getAll } = await loadFreshModule();
    await putMany(STORE.conversations, [
      makeConversation('a'),
      makeConversation('b'),
      makeConversation('c'),
    ]);
    await deleteMany(STORE.conversations, ['a', 'c']);

    const remaining = await getAll<Conversation>(STORE.conversations);
    expect(remaining.map((c) => c.id)).toEqual(['b']);
  });

  it('deleteMany short-circuits on an empty key list', async () => {
    const { STORE, put, deleteMany, count } = await loadFreshModule();
    await put(STORE.conversations, makeConversation('a'));
    await expect(deleteMany(STORE.conversations, [])).resolves.toBeUndefined();
    expect(await count(STORE.conversations)).toBe(1);
  });
});

describe('app-db — indices & auto-increment', () => {
  it('conversations expose repoFullName / branch / lastMessageAt indices', async () => {
    const { STORE, put, withStore } = await loadFreshModule();
    await put(STORE.conversations, makeConversation('a', { repoFullName: 'o/r1', branch: 'main' }));
    await put(STORE.conversations, makeConversation('b', { repoFullName: 'o/r2', branch: 'dev' }));

    const byRepo = await withStore<Conversation[]>(STORE.conversations, 'readonly', (store) =>
      store.index('repoFullName').getAll('o/r1'),
    );
    expect(byRepo.map((c) => c.id)).toEqual(['a']);

    const byBranch = await withStore<Conversation[]>(STORE.conversations, 'readonly', (store) =>
      store.index('branch').getAll('dev'),
    );
    expect(byBranch.map((c) => c.id)).toEqual(['b']);
  });

  it('usageLog auto-increments the numeric id', async () => {
    const { STORE, put, getAll } = await loadFreshModule();
    const k1 = await put(STORE.usageLog, { timestamp: 1, cost: 0.01 });
    const k2 = await put(STORE.usageLog, { timestamp: 2, cost: 0.02 });
    expect(typeof k1).toBe('number');
    expect(typeof k2).toBe('number');
    expect(k2).toBeGreaterThan(k1 as number);

    const rows = await getAll<{ id: number; timestamp: number }>(STORE.usageLog);
    expect(rows.map((r) => r.timestamp).sort()).toEqual([1, 2]);
  });

  it('memoryRecords index nested scope.repoFullName', async () => {
    const { STORE, put, withStore } = await loadFreshModule();
    await put(STORE.memoryRecords, {
      id: 'm-1',
      kind: 'fact',
      scope: { repoFullName: 'o/r1', chatId: 'c-1', branch: 'main' },
    });
    await put(STORE.memoryRecords, {
      id: 'm-2',
      kind: 'fact',
      scope: { repoFullName: 'o/r2', chatId: 'c-2', branch: 'main' },
    });

    const hits = await withStore<Array<{ id: string }>>(STORE.memoryRecords, 'readonly', (store) =>
      store.index('repoFullName').getAll('o/r1'),
    );
    expect(hits.map((r) => r.id)).toEqual(['m-1']);
  });
});

describe('app-db — error propagation', () => {
  it('rejects when indexedDB.open fails', async () => {
    // Force open() to synthesise an error event.
    const errorFactory = {
      open() {
        const req = {
          error: new Error('boom'),
          onerror: null as null | (() => void),
          onsuccess: null as null | (() => void),
          onupgradeneeded: null as null | (() => void),
          result: {} as IDBDatabase,
        };
        queueMicrotask(() => req.onerror?.());
        return req as unknown as IDBOpenDBRequest;
      },
    };
    vi.stubGlobal('indexedDB', errorFactory);
    vi.resetModules();
    const { STORE, get } = await import('./app-db');
    await expect(get(STORE.conversations, 'x')).rejects.toThrow('boom');
  });

  it('rejects a withStore call against an unknown store', async () => {
    const { withStore } = await loadFreshModule();
    await expect(
      withStore('does-not-exist', 'readonly', (store) => store.count()),
    ).rejects.toThrow();
  });
});
