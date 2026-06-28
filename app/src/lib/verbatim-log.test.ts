import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerbatimEntry, VerbatimLog, VerbatimScope } from '@push/lib/verbatim-log';
import { verbatimScopedRef } from '@push/lib/verbatim-log';

// Each `freshLog()` resets modules so `app-db` re-evaluates with a null
// `dbPromise` and opens against the current global IDBFactory — the same
// pattern app-db.test.ts uses to keep the cached connection from pointing at a
// stale factory. The factory itself is stubbed once per test (beforeEach), so
// two `freshLog()` calls inside one test reopen the *same* persisted DB, which
// is how the durability case simulates a reload.
async function freshLog(): Promise<VerbatimLog> {
  vi.resetModules();
  const mod = await import('./verbatim-log');
  return mod.createIndexedDbVerbatimLog();
}

beforeEach(async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const scope: VerbatimScope = { repoFullName: 'owner/repo', branch: 'main', chatId: 'c1' };

describe('createIndexedDbVerbatimLog', () => {
  it('round-trips an appended entry and resolves its ref', async () => {
    const log = await freshLog();
    const entry = await log.append({ scope, text: 'hello world', kind: 'tool_output', now: 1000 });

    expect(entry.text).toBe('hello world');
    expect(entry.byteLen).toBe('hello world'.length);
    expect(entry.kind).toBe('tool_output');
    expect(entry.scope).toEqual(scope);
    expect(await log.read(entry.ref)).toEqual(entry);
    expect(await log.size()).toBe(1);
  });

  it('is idempotent on identical (scope, text) — same ref, no duplicate', async () => {
    const log = await freshLog();
    const a = await log.append({ scope, text: 'same', now: 1000 });
    const b = await log.append({ scope, text: 'same', now: 2000 });

    expect(b.ref).toBe(a.ref);
    expect(b.createdAt).toBe(a.createdAt); // returned the original, not a re-stamp
    expect(await log.size()).toBe(1);
  });

  it('gives identical text in different scopes distinct, resolvable refs', async () => {
    const log = await freshLog();
    const other: VerbatimScope = { ...scope, chatId: 'c2' };
    const a = await log.append({ scope, text: 'dup', now: 1000 });
    const b = await log.append({ scope: other, text: 'dup', now: 1000 });

    expect(a.ref).not.toBe(b.ref);
    expect((await log.read(a.ref))?.scope.chatId).toBe('c1');
    expect((await log.read(b.ref))?.scope.chatId).toBe('c2');
    expect(await log.size()).toBe(2);
  });

  it('returns undefined for an unknown ref', async () => {
    const log = await freshLog();
    expect(await log.read('vb_deadbeef_0')).toBeUndefined();
  });

  it('listByScope soft-matches and returns newest-first', async () => {
    const log = await freshLog();
    await log.append({ scope, text: 'older', now: 1000 });
    await log.append({ scope, text: 'newer', now: 2000 });

    const all = await log.listByScope({ repoFullName: 'owner/repo' });
    expect(all.map((e) => e.text)).toEqual(['newer', 'older']); // newest-first

    // A query naming a *different* branch excludes; the matching branch includes.
    expect(await log.listByScope({ repoFullName: 'owner/repo', branch: 'other' })).toHaveLength(0);
    expect(await log.listByScope({ repoFullName: 'owner/repo', branch: 'main' })).toHaveLength(2);
  });

  it('applies the listByScope predicate', async () => {
    const log = await freshLog();
    await log.append({ scope, text: 'a', kind: 'tool_output', now: 1000 });
    await log.append({ scope, text: 'b', kind: 'memory_detail', now: 2000 });

    const filtered = await log.listByScope(scope, (e) => e.kind === 'memory_detail');
    expect(filtered.map((e) => e.text)).toEqual(['b']);
  });

  it('pruneOlderThan removes entries strictly older than the cutoff', async () => {
    const log = await freshLog();
    const old = await log.append({ scope, text: 'old', now: 1000 });
    await log.append({ scope, text: 'fresh', now: 5000 });

    const removed = await log.pruneOlderThan(3000);
    expect(removed).toBe(1);
    expect(await log.read(old.ref)).toBeUndefined();
    expect(await log.size()).toBe(1);
  });

  it('persists across a reopen (the durability the in-memory backend lacked)', async () => {
    const writer = await freshLog();
    const entry = await writer.append({ scope, text: 'survive the reload', now: 1000 });

    // Fresh module + connection, same underlying IDBFactory = a simulated reload.
    const reader = await freshLog();
    expect(await reader.read(entry.ref)).toEqual(entry);
    expect(await reader.size()).toBe(1);
  });

  it('disambiguates to a _2 ref on a genuine ref collision', async () => {
    // The probe branch (`ref = `${base}_${probe + 1}``) is unreachable via normal
    // appends — it needs two distinct texts hashing to one scoped ref. Force it
    // by pre-seeding a *different* text at the exact ref the collider would mint.
    // Same resetModules cycle as the adapter so app-db is the one instance.
    vi.resetModules();
    const logMod = await import('./verbatim-log');
    const { STORE, put } = await import('./app-db');
    const log = logMod.createIndexedDbVerbatimLog();

    const colliderText = 'collider';
    const base = verbatimScopedRef(scope, colliderText);
    const seeded: VerbatimEntry = {
      ref: base,
      scope,
      text: 'pre-seeded different text',
      byteLen: 'pre-seeded different text'.length,
      createdAt: 500,
    };
    await put(STORE.verbatim, seeded);

    const entry = await log.append({ scope, text: colliderText, now: 1000 });
    expect(entry.ref).toBe(`${base}_2`);
    expect((await log.read(base))?.text).toBe('pre-seeded different text');
    expect((await log.read(`${base}_2`))?.text).toBe(colliderText);
    expect(await log.size()).toBe(2);
  });
});
