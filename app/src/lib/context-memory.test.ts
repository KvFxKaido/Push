import { describe, expect, it } from 'vitest';
import type {
  DelegationOutcome,
  MemoryQuery,
  MemoryRecord,
  MemoryScope,
  TaskGraphNodeState,
} from '@/types';
import {
  buildRetrievedMemoryKnownContext,
  createInMemoryStore,
  createMemoryRecord,
  getDefaultMemoryStore,
  setDefaultMemoryStore,
  writeCoderMemory,
  writeExplorerMemory,
  writeTaskGraphNodeMemory,
} from './context-memory';

function makeScope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    repoFullName: 'owner/repo',
    branch: 'feature/auth',
    chatId: 'chat-1',
    ...overrides,
  };
}

function makeCoderOutcome(overrides: Partial<DelegationOutcome> = {}): DelegationOutcome {
  return {
    agent: 'coder',
    status: 'complete',
    summary: 'Coder refactored the auth middleware.',
    evidence: [],
    checks: [
      { id: 'typecheck', passed: true, exitCode: 0, output: 'ok' },
      { id: 'tests', passed: false, exitCode: 1, output: 'failed' },
    ],
    gateVerdicts: [],
    missingRequirements: [],
    nextRequiredAction: null,
    rounds: 3,
    checkpoints: 0,
    elapsedMs: 1000,
    ...overrides,
  };
}

describe('createMemoryRecord', () => {
  it('produces a typed, scoped, attributable record with defaults', () => {
    const record = createMemoryRecord({
      kind: 'finding',
      summary: 'Auth refresh guarded in useAuth.ts',
      scope: makeScope({ role: 'explorer' }),
      source: { kind: 'explorer', label: 'Test explorer run' },
      relatedFiles: ['app/src/useAuth.ts'],
    });

    expect(record.kind).toBe('finding');
    expect(record.freshness).toBe('fresh');
    expect(record.scope.repoFullName).toBe('owner/repo');
    expect(record.scope.branch).toBe('feature/auth');
    expect(record.source.kind).toBe('explorer');
    expect(record.source.createdAt).toBeGreaterThan(0);
    expect(record.relatedFiles).toEqual(['app/src/useAuth.ts']);
  });

  it('throws when summary is empty', () => {
    expect(() =>
      createMemoryRecord({
        kind: 'fact',
        summary: '   ',
        scope: makeScope(),
        source: { kind: 'explorer', label: 'empty' },
      }),
    ).toThrow(/summary is required/);
  });

  it('truncates oversized summaries and drops empty arrays', () => {
    const longSummary = 'x'.repeat(2000);
    const record = createMemoryRecord({
      kind: 'finding',
      summary: longSummary,
      scope: makeScope(),
      source: { kind: 'explorer', label: 'long' },
      relatedFiles: [],
      relatedSymbols: [],
    });
    expect(record.summary.length).toBeLessThan(longSummary.length);
    expect(record.summary.endsWith('…')).toBe(true);
    expect(record.relatedFiles).toBeUndefined();
    expect(record.relatedSymbols).toBeUndefined();
  });
});

describe('writeExplorerMemory', () => {
  it('writes a finding record bound to the explorer role', async () => {
    const store = createInMemoryStore();
    const record = await writeExplorerMemory({
      store,
      scope: makeScope(),
      summary: 'Middleware injects session state before route guards.',
      relatedFiles: ['app/src/middleware.ts'],
      rounds: 4,
    });

    expect(record).not.toBeNull();
    expect(await store.size()).toBe(1);
    expect(record!.kind).toBe('finding');
    expect(record!.scope.role).toBe('explorer');
    expect(record!.source.label).toContain('4 rounds');
  });

  it('returns null and writes nothing when summary is blank', async () => {
    const store = createInMemoryStore();
    const record = await writeExplorerMemory({
      store,
      scope: makeScope(),
      summary: '',
    });
    expect(record).toBeNull();
    expect(await store.size()).toBe(0);
  });
});

describe('writeCoderMemory', () => {
  it('emits task_outcome, file_change, and verification_result records', async () => {
    const store = createInMemoryStore();
    const records = await writeCoderMemory({
      store,
      scope: makeScope(),
      outcome: makeCoderOutcome(),
      diffPaths: ['app/src/auth.ts', 'app/src/middleware.ts'],
    });

    const kinds = records.map((r) => r.kind).sort();
    expect(kinds).toEqual([
      'file_change',
      'task_outcome',
      'verification_result',
      'verification_result',
    ]);

    const outcome = records.find((r) => r.kind === 'task_outcome')!;
    expect(outcome.scope.role).toBe('coder');

    const fileChange = records.find((r) => r.kind === 'file_change')!;
    expect(fileChange.relatedFiles).toEqual(['app/src/auth.ts', 'app/src/middleware.ts']);
    expect(fileChange.derivedFrom).toEqual([outcome.id]);

    const verifications = records.filter((r) => r.kind === 'verification_result');
    expect(verifications.some((r) => r.summary.startsWith('typecheck: passed'))).toBe(true);
    expect(verifications.some((r) => r.summary.startsWith('tests: failed'))).toBe(true);
  });

  it('skips file_change record when no diff paths are provided', async () => {
    const store = createInMemoryStore();
    await writeCoderMemory({
      store,
      scope: makeScope(),
      outcome: makeCoderOutcome({ checks: [] }),
    });
    const allRecords = await store.list();
    expect(allRecords.some((r) => r.kind === 'file_change')).toBe(false);
    expect(allRecords.some((r) => r.kind === 'task_outcome')).toBe(true);
  });

  it('supersedes older verification records and tags new ones with check and command metadata', async () => {
    const store = createInMemoryStore();
    const oldVerification = createMemoryRecord({
      kind: 'verification_result',
      summary: 'typecheck: passed',
      scope: makeScope({ role: 'coder' }),
      source: { kind: 'coder', label: 'Verification: typecheck' },
      tags: ['pass', 'check:typecheck', 'command:npm run typecheck'],
    });
    await store.write(oldVerification);

    const records = await writeCoderMemory({
      store,
      scope: makeScope(),
      outcome: makeCoderOutcome({
        checks: [{ id: 'typecheck', passed: false, exitCode: 1, output: 'boom' }],
      }),
      verificationCommandsById: { typecheck: 'npm   run   typecheck' },
    });

    const staleVerification = await store.get(oldVerification.id);
    expect(staleVerification?.freshness).toBe('stale');
    expect(staleVerification?.invalidationReason).toContain('typecheck');

    const newVerification = records.find((record) => record.kind === 'verification_result');
    expect(newVerification?.tags).toContain('check:typecheck');
    expect(newVerification?.tags).toContain('command:npm run typecheck');
  });
});

describe('writeTaskGraphNodeMemory', () => {
  it('writes a task_outcome for a completed coder node and a finding for an explorer node', async () => {
    const store = createInMemoryStore();
    const coderState: TaskGraphNodeState = {
      node: { id: 'impl-auth', agent: 'coder', task: 'Refactor auth', files: ['app/src/auth.ts'] },
      status: 'completed',
      result: 'Refactor complete.',
      delegationOutcome: makeCoderOutcome({
        evidence: [{ kind: 'diff', label: 'Workspace diff' }],
      }),
      elapsedMs: 100,
    };
    const explorerState: TaskGraphNodeState = {
      node: { id: 'explore-auth', agent: 'explorer', task: 'Trace auth' },
      status: 'completed',
      result: 'Found refresh trigger.',
      elapsedMs: 100,
    };

    await writeTaskGraphNodeMemory({
      store,
      scope: makeScope({ taskGraphId: 'g1' }),
      nodeState: coderState,
    });
    await writeTaskGraphNodeMemory({
      store,
      scope: makeScope({ taskGraphId: 'g1' }),
      nodeState: explorerState,
    });

    const records = await store.list();
    expect(records).toHaveLength(2);
    const coder = records.find((r) => r.scope.taskId === 'impl-auth')!;
    expect(coder.kind).toBe('task_outcome');
    expect(coder.scope.role).toBe('coder');
    expect(coder.scope.taskGraphId).toBe('g1');
    expect(coder.relatedFiles).toEqual(['app/src/auth.ts']);

    const explorer = records.find((r) => r.scope.taskId === 'explore-auth')!;
    expect(explorer.kind).toBe('finding');
    expect(explorer.scope.role).toBe('explorer');
  });

  it('skips nodes that did not complete', async () => {
    const store = createInMemoryStore();
    const record = await writeTaskGraphNodeMemory({
      store,
      scope: makeScope(),
      nodeState: {
        node: { id: 'x', agent: 'coder', task: 'stuff' },
        status: 'failed',
        error: 'boom',
      },
    });
    expect(record).toBeNull();
    expect(await store.size()).toBe(0);
  });
});

describe('buildRetrievedMemoryKnownContext', () => {
  it('returns sectioned retrieved-memory blocks after writes', async () => {
    const store = createInMemoryStore();
    setDefaultMemoryStore(store);
    try {
      await writeExplorerMemory({
        store,
        scope: makeScope(),
        summary: 'Middleware injects session state before route guards.',
        relatedFiles: ['app/src/middleware.ts'],
      });
      await writeCoderMemory({
        store,
        scope: makeScope(),
        outcome: makeCoderOutcome(),
        diffPaths: ['app/src/middleware.ts'],
      });

      const query: MemoryQuery = {
        repoFullName: 'owner/repo',
        branch: 'feature/auth',
        chatId: 'chat-1',
        role: 'coder',
        taskText: 'harden session guard and rerun typecheck',
        fileHints: ['app/src/middleware.ts'],
        maxRecords: 5,
      };
      const { line, result, packResult } = await buildRetrievedMemoryKnownContext(query);

      expect(line).not.toBeNull();
      expect(line!).toContain('[RETRIEVED_FACTS]');
      expect(line!).toContain('[RETRIEVED_TASK_MEMORY]');
      expect(line!).toContain('[RETRIEVED_VERIFICATION]');
      expect(result.records.length).toBeGreaterThan(0);
      expect(result.records.every((r) => r.score > 0)).toBe(true);
      expect(packResult.sections.facts.recordCount).toBeGreaterThan(0);
      expect(packResult.sections.taskMemory.recordCount).toBeGreaterThan(0);
      expect(packResult.sections.verification.recordCount).toBeGreaterThan(0);
      expect(packResult.charsUsed).toBe(line!.length);
    } finally {
      setDefaultMemoryStore(null);
    }
  });

  it('includes stale records in the bounded stale section by default', async () => {
    const store = createInMemoryStore();
    const staleRecord = createMemoryRecord({
      kind: 'finding',
      summary: 'Old auth middleware note',
      scope: makeScope({ role: 'explorer' }),
      source: { kind: 'explorer', label: 'stale note' },
      freshness: 'stale',
      relatedFiles: ['app/src/middleware.ts'],
    });
    await store.write(staleRecord);

    const { line, result, packResult } = await buildRetrievedMemoryKnownContext(
      {
        repoFullName: 'owner/repo',
        branch: 'feature/auth',
        chatId: 'chat-1',
        role: 'coder',
        taskText: 'inspect middleware guard',
        fileHints: ['app/src/middleware.ts'],
        maxRecords: 5,
      },
      { store },
    );

    expect(result.records).toHaveLength(1);
    expect(result.records[0].record.freshness).toBe('stale');
    expect(line).toContain('[STALE_CONTEXT]');
    expect(packResult.sections.stale.recordCount).toBe(1);
    expect(packResult.sections.facts.recordCount).toBe(0);
  });

  it('returns null line when nothing matches', async () => {
    const store = createInMemoryStore();
    const { line, result } = await buildRetrievedMemoryKnownContext(
      {
        repoFullName: 'owner/repo',
        role: 'coder',
        taskText: 'whatever',
        maxRecords: 5,
      },
      { store },
    );
    expect(line).toBeNull();
    expect(result.records).toHaveLength(0);
  });

  it('uses the default store when no store override is given', () => {
    const store = createInMemoryStore();
    setDefaultMemoryStore(store);
    try {
      expect(getDefaultMemoryStore()).toBe(store);
    } finally {
      setDefaultMemoryStore(null);
    }
  });
});

describe('store scoping', () => {
  it('supports filtering records by scope via predicate', async () => {
    const store = createInMemoryStore();
    const recordA: MemoryRecord = createMemoryRecord({
      kind: 'fact',
      summary: 'A',
      scope: makeScope({ branch: 'branch-a' }),
      source: { kind: 'explorer', label: 'x' },
    });
    const recordB: MemoryRecord = createMemoryRecord({
      kind: 'fact',
      summary: 'B',
      scope: makeScope({ branch: 'branch-b' }),
      source: { kind: 'explorer', label: 'x' },
    });
    await store.writeMany([recordA, recordB]);

    const branchA = await store.list((r) => r.scope.branch === 'branch-a');
    expect(branchA).toHaveLength(1);
    expect(branchA[0].summary).toBe('A');
  });
});
