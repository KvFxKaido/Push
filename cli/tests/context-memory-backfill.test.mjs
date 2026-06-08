import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { backfillEmbeddings } from '../../lib/context-memory-backfill.ts';
import { createInMemoryStore } from '../../lib/context-memory-store.ts';

function record(id, overrides = {}) {
  return {
    id,
    kind: 'finding',
    summary: `summary ${id}`,
    scope: { repoFullName: 'owner/repo', branch: 'main' },
    source: { kind: 'explorer', label: 'test', createdAt: 0 },
    freshness: 'fresh',
    ...overrides,
  };
}

function fakeProvider({ ready = true, vectorFor = () => [1, 2, 3] } = {}) {
  const calls = [];
  return {
    model: 'fake-model',
    warmup: async () => ready,
    embed: async (texts) => {
      calls.push(texts);
      return texts.map((t, i) => ({ model: 'fake-model', vector: vectorFor(t, i) }));
    },
    calls,
  };
}

describe('backfillEmbeddings', () => {
  it('embeds only records missing an embedding and leaves the rest alone', async () => {
    const store = createInMemoryStore();
    store.write(record('a')); // missing
    store.write(record('b', { embedding: [9, 9, 9], embeddingModel: 'prior' })); // already has one
    store.write(record('c')); // missing

    const provider = fakeProvider();
    const result = await backfillEmbeddings(store, provider);

    assert.deepEqual(
      {
        scanned: result.scanned,
        needed: result.needed,
        embedded: result.embedded,
        failed: result.failed,
      },
      { scanned: 3, needed: 2, embedded: 2, failed: 0 },
    );
    assert.equal(result.providerReady, true);
    // a and c got embedded with the provider's model id
    assert.deepEqual((await store.get('a')).embedding, [1, 2, 3]);
    assert.equal((await store.get('a')).embeddingModel, 'fake-model');
    assert.deepEqual((await store.get('c')).embedding, [1, 2, 3]);
    // b untouched (not re-embedded despite a different model)
    assert.deepEqual((await store.get('b')).embedding, [9, 9, 9]);
    assert.equal((await store.get('b')).embeddingModel, 'prior');
    // only the two missing records were sent to the provider
    assert.equal(provider.calls.flat().length, 2);
  });

  it('is idempotent: a second run finds nothing to do', async () => {
    const store = createInMemoryStore();
    store.write(record('a'));
    const provider = fakeProvider();
    await backfillEmbeddings(store, provider);
    const second = await backfillEmbeddings(store, provider);
    assert.equal(second.needed, 0);
    assert.equal(second.embedded, 0);
  });

  it('short-circuits when the provider is not ready (no embeds, all counted failed)', async () => {
    const store = createInMemoryStore();
    store.write(record('a'));
    store.write(record('b'));
    const provider = fakeProvider({ ready: false });
    const result = await backfillEmbeddings(store, provider);
    assert.equal(result.providerReady, false);
    assert.equal(result.embedded, 0);
    assert.equal(result.failed, 2);
    assert.equal(provider.calls.length, 0); // never called embed
    assert.equal((await store.get('a')).embedding, undefined);
  });

  it('counts records the provider could not embed as failed', async () => {
    const store = createInMemoryStore();
    store.write(record('a'));
    store.write(record('b'));
    // null vector for the first text, real for the second
    const provider = fakeProvider({ vectorFor: (_t, i) => (i === 0 ? null : [4, 5, 6]) });
    const result = await backfillEmbeddings(store, provider, { batchSize: 8 });
    assert.equal(result.embedded, 1);
    assert.equal(result.failed, 1);
  });

  it('keeps going when a batch throws — counts it failed, embeds the rest', async () => {
    const store = createInMemoryStore();
    for (const id of ['a', 'b', 'c', 'd']) store.write(record(id));
    let call = 0;
    const provider = {
      model: 'fake-model',
      warmup: async () => true,
      embed: async (texts) => {
        call++;
        if (call === 1) throw new Error('rate limited'); // first batch throws
        return texts.map(() => ({ model: 'fake-model', vector: [7, 7, 7] }));
      },
    };
    const result = await backfillEmbeddings(store, provider, { batchSize: 2 });
    // first batch (2) failed via throw, second batch (2) embedded — run did not abort
    assert.equal(result.embedded, 2);
    assert.equal(result.failed, 2);
    assert.equal(result.needed, 4);
  });

  it('reports an empty store cleanly without calling the provider', async () => {
    const store = createInMemoryStore();
    const provider = fakeProvider();
    const result = await backfillEmbeddings(store, provider);
    assert.deepEqual(
      { scanned: result.scanned, needed: result.needed, embedded: result.embedded },
      { scanned: 0, needed: 0, embedded: 0 },
    );
    assert.equal(provider.calls.length, 0);
  });

  it('honors the filter to scope which records are considered', async () => {
    const store = createInMemoryStore();
    store.write(record('a', { scope: { repoFullName: 'owner/repo', branch: 'main' } }));
    store.write(record('b', { scope: { repoFullName: 'owner/other', branch: 'main' } }));
    const provider = fakeProvider();
    const result = await backfillEmbeddings(store, provider, {
      filter: (r) => r.scope.repoFullName === 'owner/repo',
    });
    assert.equal(result.scanned, 1);
    assert.equal(result.embedded, 1);
    assert.equal((await store.get('b')).embedding, undefined);
  });
});
