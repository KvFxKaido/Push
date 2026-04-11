import { describe, it, expect } from 'vitest';
import { createInMemoryStore } from './context-memory-store';
import { createPolicyEnforcedStore } from './context-memory-policy-store';
import { PERSISTED_DETAIL_MAX_CHARS } from './memory-persistence-policy';
import type { MemoryRecord } from './runtime-contract';

describe('PolicyEnforcedStore', () => {
  const repo = 'owner/repo';
  const branch = 'main';

  const createRecord = (id: string, kind: any, createdAt: number, b = branch): MemoryRecord => ({
    id,
    kind,
    summary: 'test',
    scope: { repoFullName: repo, branch: b },
    source: { kind: 'explorer', label: 'test', createdAt },
    freshness: 'fresh',
  });

  it('should filter out records that should not persist', async () => {
    const inner = createInMemoryStore();
    const store = createPolicyEnforcedStore(inner);

    const now = Date.now();
    const persistent = createRecord('1', 'finding', now);
    const nonPersistent = createRecord('2', 'file_change', now);

    await store.write(persistent);
    await store.write(nonPersistent);

    expect(await store.size()).toBe(1);
    const listed = await store.list();
    expect(listed.find((r) => r.id === '1')).toBeDefined();
    expect(listed.find((r) => r.id === '2')).toBeUndefined();
    expect(await inner.get('2')).toBeUndefined();
  });

  it('should hide expired records', async () => {
    const inner = createInMemoryStore();
    const store = createPolicyEnforcedStore(inner);

    const oldTime = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago
    const expired = createRecord('expired', 'finding', oldTime);

    await inner.write(expired);
    expect(await store.get('expired')).toBeUndefined();
    expect(await store.list()).toHaveLength(0);
  });

  it('should prune expired records from the underlying store', async () => {
    const inner = createInMemoryStore();
    const store = createPolicyEnforcedStore(inner);

    const oldTime = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    await inner.writeMany([
      createRecord('expired', 'finding', oldTime),
      createRecord('fresh', 'finding', now),
    ]);

    expect(await store.pruneExpired(now)).toBe(1);
    expect(await inner.get('expired')).toBeUndefined();
    expect(await inner.get('fresh')).toBeDefined();
  });

  it('should clear records by repo and branch', async () => {
    const inner = createInMemoryStore();
    const store = createPolicyEnforcedStore(inner);

    await store.writeMany([
      createRecord('r1-b1', 'finding', Date.now(), 'b1'),
      createRecord('r1-b2', 'finding', Date.now(), 'b2'),
    ]);

    await store.clearByBranch(repo, 'b1');
    const remaining = await store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('r1-b2');

    await store.clearByRepo(repo);
    expect(await store.size()).toBe(0);
  });

  it('should purge legacy non-persistent records during reads', async () => {
    const inner = createInMemoryStore();
    const store = createPolicyEnforcedStore(inner);

    await inner.write(createRecord('legacy-file-change', 'file_change', Date.now()));

    expect(await store.get('legacy-file-change')).toBeUndefined();
    expect(await inner.get('legacy-file-change')).toBeUndefined();
  });

  it('should truncate persisted detail payloads', async () => {
    const inner = createInMemoryStore();
    const store = createPolicyEnforcedStore(inner);
    const longDetail = 'x'.repeat(PERSISTED_DETAIL_MAX_CHARS + 250);

    await store.write({
      ...createRecord('finding-with-detail', 'finding', Date.now()),
      detail: longDetail,
    });

    const persisted = await inner.get('finding-with-detail');
    expect(persisted?.detail?.length).toBeLessThanOrEqual(PERSISTED_DETAIL_MAX_CHARS);
    expect(persisted?.detail?.endsWith('…')).toBe(true);
  });
});
