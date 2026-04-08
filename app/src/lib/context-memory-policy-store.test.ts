import { describe, expect, it } from 'vitest';
import { createPolicyEnforcedStore } from '@push/lib/context-memory-policy-store';
import { PERSISTED_DETAIL_MAX_CHARS } from '@push/lib/memory-persistence-policy';
import type { MemoryRecord } from '@/types';
import { createInMemoryStore } from './context-memory-store';

function createRecord(
  id: string,
  kind: MemoryRecord['kind'],
  createdAt: number,
): MemoryRecord {
  return {
    id,
    kind,
    summary: 'test',
    scope: { repoFullName: 'owner/repo', branch: 'main', chatId: 'chat-1' },
    source: { kind: 'explorer', label: 'test', createdAt },
    freshness: 'fresh',
  };
}

describe('context memory persistence policy', () => {
  it('drops non-persistent records on write and reports a visible size', async () => {
    const inner = createInMemoryStore();
    const store = createPolicyEnforcedStore(inner);

    await store.write(createRecord('finding', 'finding', Date.now()));
    await store.write(createRecord('file-change', 'file_change', Date.now()));

    expect(await store.size()).toBe(1);
    expect(await inner.get('finding')).toBeDefined();
    expect(await inner.get('file-change')).toBeUndefined();
  });

  it('purges legacy non-persistent records when they are read back', async () => {
    const inner = createInMemoryStore();
    const store = createPolicyEnforcedStore(inner);

    await inner.write(createRecord('legacy-file-change', 'file_change', Date.now()));

    expect(await store.list()).toEqual([]);
    expect(await inner.get('legacy-file-change')).toBeUndefined();
  });

  it('truncates persisted detail payloads before storing them', async () => {
    const inner = createInMemoryStore();
    const store = createPolicyEnforcedStore(inner);
    const longDetail = 'x'.repeat(PERSISTED_DETAIL_MAX_CHARS + 200);

    await store.write({
      ...createRecord('finding-with-detail', 'finding', Date.now()),
      detail: longDetail,
    });

    const persisted = await inner.get('finding-with-detail');
    expect(persisted?.detail?.length).toBeLessThanOrEqual(PERSISTED_DETAIL_MAX_CHARS);
    expect(persisted?.detail?.endsWith('…')).toBe(true);
  });
});
