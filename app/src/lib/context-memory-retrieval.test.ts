import { describe, expect, it } from 'vitest';
import type { MemoryQuery, MemoryRecord, MemoryScope } from '@/types';
import { createInMemoryStore } from './context-memory-store';
import { retrieveRecords, scoreRecord } from './context-memory-retrieval';

function makeRecord(
  id: string,
  overrides: {
    scope?: Partial<MemoryScope>;
    createdAt?: number;
    kind?: MemoryRecord['kind'];
    freshness?: MemoryRecord['freshness'];
    summary?: string;
    relatedFiles?: string[];
    relatedSymbols?: string[];
    embedding?: number[];
    embeddingModel?: string;
  } = {},
): MemoryRecord {
  return {
    id,
    kind: overrides.kind ?? 'finding',
    summary: overrides.summary ?? `record ${id}`,
    scope: {
      repoFullName: 'owner/repo',
      branch: 'feature/auth',
      chatId: 'chat-1',
      role: 'explorer',
      ...overrides.scope,
    },
    source: {
      kind: 'explorer',
      label: 'test',
      createdAt: overrides.createdAt ?? Date.now(),
    },
    freshness: overrides.freshness ?? 'fresh',
    relatedFiles: overrides.relatedFiles,
    relatedSymbols: overrides.relatedSymbols,
    embedding: overrides.embedding,
    embeddingModel: overrides.embeddingModel,
  };
}

function makeQuery(overrides: Partial<MemoryQuery> = {}): MemoryQuery {
  return {
    repoFullName: 'owner/repo',
    branch: 'feature/auth',
    chatId: 'chat-1',
    role: 'coder',
    taskText: 'implement auth',
    maxRecords: 10,
    ...overrides,
  };
}

describe('scoreRecord', () => {
  it('excludes records from other repos', () => {
    const record = makeRecord('r1', { scope: { repoFullName: 'other/repo' } });
    expect(scoreRecord(record, makeQuery())).toBeNull();
  });

  it('excludes expired records', () => {
    const record = makeRecord('r1', { freshness: 'expired' });
    expect(scoreRecord(record, makeQuery())).toBeNull();
  });

  it('excludes stale records by default but includes them when opted in', () => {
    const record = makeRecord('r1', { freshness: 'stale', relatedFiles: ['app/src/auth.ts'] });
    const query = makeQuery({ fileHints: ['app/src/auth.ts'] });
    expect(scoreRecord(record, query)).toBeNull();
    const scored = scoreRecord(record, { ...query, includeStale: true });
    expect(scored).not.toBeNull();
    expect(scored!.breakdown.freshness).toBeLessThan(0);
  });

  it('awards branch, task lineage, file and symbol overlap, and role family weights', () => {
    const record = makeRecord('r1', {
      scope: {
        branch: 'feature/auth',
        taskGraphId: 'g1',
        taskId: 't1',
        role: 'coder',
      },
      relatedFiles: ['app/src/auth.ts', 'app/src/middleware.ts'],
      relatedSymbols: ['useAuth'],
    });
    const query = makeQuery({
      role: 'coder',
      branch: 'feature/auth',
      taskGraphId: 'g1',
      taskId: 't1',
      fileHints: ['app/src/auth.ts'],
      symbolHints: ['useAuth'],
    });
    const scored = scoreRecord(record, query)!;
    expect(scored.breakdown.branch).toBeGreaterThan(0);
    expect(scored.breakdown.taskLineage).toBeGreaterThan(0);
    expect(scored.breakdown.taskText).toBeGreaterThan(0);
    expect(scored.breakdown.fileOverlap).toBeGreaterThan(0);
    expect(scored.breakdown.symbolOverlap).toBeGreaterThan(0);
    expect(scored.breakdown.roleFamily).toBeGreaterThan(0);
    expect(scored.score).toBeGreaterThan(0);
  });

  it('decays recency as the record ages', () => {
    const now = 1_000_000_000;
    const fresh = makeRecord('fresh', {
      createdAt: now - 60_000,
      relatedFiles: ['app/src/auth.ts'],
    });
    const old = makeRecord('old', {
      createdAt: now - 48 * 60 * 60 * 1000,
      relatedFiles: ['app/src/auth.ts'],
    });
    const query = makeQuery({ fileHints: ['app/src/auth.ts'] });
    const scoredFresh = scoreRecord(fresh, query, now)!;
    const scoredOld = scoreRecord(old, query, now)!;
    expect(scoredFresh.breakdown.recency).toBeGreaterThan(scoredOld.breakdown.recency);
    expect(scoredOld.breakdown.recency).toBe(0);
  });

  it('normalizes path casing, ./ prefix, and /workspace prefix when computing file overlap', () => {
    const record = makeRecord('r1', {
      relatedFiles: ['/workspace/App/Src/Auth.ts'],
    });
    const query = makeQuery({ fileHints: ['app/src/auth.ts'] });
    const scored = scoreRecord(record, query)!;
    expect(scored.breakdown.fileOverlap).toBeGreaterThan(0);
  });

  it('excludes records from other chats when both sides are chat-scoped', () => {
    const record = makeRecord('r1', {
      scope: { chatId: 'chat-2' },
      relatedFiles: ['app/src/auth.ts'],
    });
    expect(scoreRecord(record, makeQuery({ fileHints: ['app/src/auth.ts'] }))).toBeNull();
  });

  it('excludes records from other branches when both sides are branch-scoped', () => {
    const record = makeRecord('r1', {
      scope: { branch: 'feature/payments' },
      relatedFiles: ['app/src/auth.ts'],
    });
    expect(scoreRecord(record, makeQuery({ fileHints: ['app/src/auth.ts'] }))).toBeNull();
  });

  it('drops generic same-branch memory when there is no specific task, file, symbol, or lineage match', () => {
    const record = makeRecord('r1', {
      scope: { role: 'coder' },
      createdAt: 1_000_000_000 - 60_000,
    });
    expect(scoreRecord(record, makeQuery(), 1_000_000_000)).toBeNull();
  });
});

describe('retrieveRecords', () => {
  it('ranks branch + file overlap matches above generic recency', async () => {
    const store = createInMemoryStore();
    const now = 2_000_000_000;

    // Fresh but unrelated: no branch match, no file overlap
    store.write(
      makeRecord('recent-unrelated', {
        scope: { branch: 'other-branch' },
        createdAt: now - 60_000,
      }),
    );
    // Older but branch + file match
    store.write(
      makeRecord('targeted', {
        createdAt: now - 30 * 60 * 1000,
        relatedFiles: ['app/src/auth.ts'],
      }),
    );

    const result = await retrieveRecords(store, makeQuery({ fileHints: ['app/src/auth.ts'] }), now);

    expect(result.records[0].record.id).toBe('targeted');
  });

  it('uses task-text overlap when file hints are unavailable', async () => {
    const store = createInMemoryStore();
    const now = 2_000_000_000;

    store.write(
      makeRecord('auth-relevant', {
        summary: 'auth retry flow fixed with better session recovery',
        createdAt: now - 10 * 60 * 1000,
        scope: { role: 'coder' },
      }),
    );
    store.write(
      makeRecord('unrelated', {
        summary: 'date formatting cleanup in reporting screen',
        createdAt: now - 60_000,
        scope: { role: 'coder' },
      }),
    );

    const result = await retrieveRecords(
      store,
      makeQuery({ taskText: 'fix auth retry flow' }),
      now,
    );

    expect(result.records.map((r) => r.record.id)).toEqual(['auth-relevant']);
    expect(result.records[0].breakdown.taskText).toBeGreaterThan(0);
  });

  it('respects maxRecords cap', async () => {
    const store = createInMemoryStore();
    for (let i = 0; i < 10; i++) {
      store.write(
        makeRecord(`r${i}`, {
          relatedFiles: ['app/src/auth.ts'],
        }),
      );
    }
    const result = await retrieveRecords(
      store,
      makeQuery({ fileHints: ['app/src/auth.ts'], maxRecords: 3 }),
    );
    expect(result.records).toHaveLength(3);
    expect(result.candidateCount).toBe(10);
  });

  it('excludes records from other repos entirely', async () => {
    const store = createInMemoryStore();
    store.write(
      makeRecord('other', {
        scope: { repoFullName: 'other/repo' },
        relatedFiles: ['app/src/auth.ts'],
      }),
    );
    const result = await retrieveRecords(store, makeQuery({ fileHints: ['app/src/auth.ts'] }));
    expect(result.records).toHaveLength(0);
    expect(result.candidateCount).toBe(0);
  });

  it('drops stale records by default and counts them', async () => {
    const store = createInMemoryStore();
    store.write(makeRecord('fresh-one', { relatedFiles: ['app/src/auth.ts'] }));
    store.write(
      makeRecord('stale-one', {
        freshness: 'stale',
        relatedFiles: ['app/src/auth.ts'],
      }),
    );
    store.write(
      makeRecord('expired-one', {
        freshness: 'expired',
        relatedFiles: ['app/src/auth.ts'],
      }),
    );
    const result = await retrieveRecords(store, makeQuery({ fileHints: ['app/src/auth.ts'] }));
    expect(result.records.map((r) => r.record.id)).toEqual(['fresh-one']);
    expect(result.staleDropped).toBe(1);
    expect(result.expiredExcluded).toBe(1);
  });

  it('isolates results to the current chat and branch', async () => {
    const store = createInMemoryStore();
    store.write(
      makeRecord('same-chat-same-branch', {
        relatedFiles: ['app/src/auth.ts'],
      }),
    );
    store.write(
      makeRecord('other-chat', {
        scope: { chatId: 'chat-2' },
        relatedFiles: ['app/src/auth.ts'],
      }),
    );
    store.write(
      makeRecord('other-branch', {
        scope: { branch: 'feature/payments' },
        relatedFiles: ['app/src/auth.ts'],
      }),
    );

    const result = await retrieveRecords(store, makeQuery({ fileHints: ['app/src/auth.ts'] }));

    expect(result.records.map((r) => r.record.id)).toEqual(['same-chat-same-branch']);
    expect(result.candidateCount).toBe(1);
  });

  it('deterministically breaks ties by newer first then by id', async () => {
    const store = createInMemoryStore();
    const now = 3_000_000_000;
    store.write(
      makeRecord('alpha', {
        createdAt: now - 1000,
        relatedFiles: ['app/src/auth.ts'],
      }),
    );
    store.write(
      makeRecord('beta', {
        createdAt: now - 1000,
        relatedFiles: ['app/src/auth.ts'],
      }),
    );
    store.write(
      makeRecord('gamma', {
        createdAt: now - 500,
        relatedFiles: ['app/src/auth.ts'],
      }),
    );
    const result = await retrieveRecords(store, makeQuery({ fileHints: ['app/src/auth.ts'] }), now);
    // gamma is newest, then alpha/beta tied on score+age → id order
    expect(result.records.map((r) => r.record.id)).toEqual(['gamma', 'alpha', 'beta']);
  });
});

describe('scoreRecord — semantic similarity', () => {
  const MODEL = '@cf/baai/bge-base-en-v1.5';

  it('surfaces a record with no lexical overlap when the query embedding is similar', () => {
    // Summary shares no tokens with the query, no file/symbol/lineage match —
    // lexically this is a miss and would be dropped by the specific-match gate.
    const record = makeRecord('sem', {
      summary: 'session bearer enforcement on every relay verb',
      embedding: [1, 0, 0],
      embeddingModel: MODEL,
    });
    const baseQuery = makeQuery({ taskText: 'how does authorization gating work', fileHints: [] });

    // Without a query embedding: pure lexical, no shared tokens → null.
    expect(scoreRecord(record, baseQuery)).toBeNull();

    // With a similar query embedding: semantic clears the floor and the record
    // is retrieved on meaning alone.
    const scored = scoreRecord(record, {
      ...baseQuery,
      queryEmbedding: [1, 0, 0],
      queryEmbeddingModel: MODEL,
    });
    expect(scored).not.toBeNull();
    expect(scored!.breakdown.semantic).toBeGreaterThan(0);
  });

  it('contributes nothing below the similarity floor', () => {
    const record = makeRecord('sem', {
      summary: 'totally unrelated subject matter',
      embedding: [0, 1, 0], // orthogonal to query → cosine 0, under floor
      embeddingModel: MODEL,
    });
    const scored = scoreRecord(record, {
      ...makeQuery({ taskText: 'no shared words here', fileHints: [] }),
      queryEmbedding: [1, 0, 0],
      queryEmbeddingModel: MODEL,
    });
    // No lexical match + sub-floor semantic → dropped entirely.
    expect(scored).toBeNull();
  });

  it('ignores the semantic signal when embedding models differ', () => {
    const record = makeRecord('sem', {
      summary: 'alpha beta gamma',
      embedding: [1, 0, 0],
      embeddingModel: 'some-other-model',
    });
    const scored = scoreRecord(record, {
      ...makeQuery({ taskText: 'delta epsilon zeta', fileHints: [] }),
      queryEmbedding: [1, 0, 0],
      queryEmbeddingModel: MODEL,
    });
    // Identical vectors but mismatched models → cosine not trusted → null.
    expect(scored).toBeNull();
  });

  it('blends semantic into the total alongside lexical signals', () => {
    const record = makeRecord('sem', {
      summary: 'implement auth flow',
      relatedFiles: ['app/src/auth.ts'],
      embedding: [1, 0, 0],
      embeddingModel: MODEL,
    });
    const query = makeQuery({
      taskText: 'implement auth',
      fileHints: ['app/src/auth.ts'],
      queryEmbedding: [1, 0, 0],
      queryEmbeddingModel: MODEL,
    });
    const withSem = scoreRecord(record, query)!;
    const withoutSem = scoreRecord(record, { ...query, queryEmbedding: undefined })!;
    expect(withSem.breakdown.semantic).toBeGreaterThan(0);
    expect(withSem.breakdown.total).toBeCloseTo(
      withoutSem.breakdown.total + withSem.breakdown.semantic,
    );
  });
});
