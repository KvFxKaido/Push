import { describe, expect, it } from 'vitest';
import type { MemoryRecord, MemoryScope } from '@/types';
import { createMemoryRecord } from './context-memory';
import { createInMemoryStore } from './context-memory-store';
import {
  expireBranchScopedMemory,
  invalidateMemoryForChangedFiles,
  supersedeVerificationMemory,
} from './context-memory-invalidation';

function makeScope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    repoFullName: 'owner/repo',
    branch: 'feature/auth',
    chatId: 'chat-1',
    ...overrides,
  };
}

function makeRecord(
  id: string,
  overrides: Omit<Partial<MemoryRecord>, 'scope'> & { scope?: Partial<MemoryScope> } = {},
): MemoryRecord {
  return {
    id,
    kind: overrides.kind ?? 'finding',
    summary: overrides.summary ?? id,
    scope: {
      ...makeScope({ role: 'coder' }),
      ...overrides.scope,
    },
    source: overrides.source ?? {
      kind: 'coder',
      label: 'test',
      createdAt: Date.now(),
    },
    freshness: overrides.freshness ?? 'fresh',
    relatedFiles: overrides.relatedFiles,
    relatedSymbols: overrides.relatedSymbols,
    tags: overrides.tags,
    detail: overrides.detail,
    derivedFrom: overrides.derivedFrom,
    invalidatedAt: overrides.invalidatedAt,
    invalidationReason: overrides.invalidationReason,
  };
}

describe('invalidateMemoryForChangedFiles', () => {
  it('marks directly file-linked records stale and propagates to descendants', async () => {
    const store = createInMemoryStore();
    const parent = createMemoryRecord({
      kind: 'task_outcome',
      summary: 'Updated auth guard.',
      scope: makeScope({ role: 'coder' }),
      source: { kind: 'coder', label: 'Coder delegation' },
      relatedFiles: ['app/src/auth.ts'],
    });
    const child = createMemoryRecord({
      kind: 'verification_result',
      summary: 'typecheck: passed',
      scope: makeScope({ role: 'coder' }),
      source: { kind: 'coder', label: 'Verification: typecheck' },
      derivedFrom: [parent.id],
    });
    const unrelated = makeRecord('unrelated', {
      relatedFiles: ['app/src/payments.ts'],
    });
    const otherBranch = makeRecord('other-branch', {
      scope: { branch: 'feature/payments' },
      relatedFiles: ['app/src/auth.ts'],
    });
    store.writeMany([parent, child, unrelated, otherBranch]);

    const changed = await invalidateMemoryForChangedFiles({
      store,
      scope: makeScope(),
      changedPaths: ['/workspace/app/src/auth.ts'],
    });

    expect(changed).toBe(2);
    expect((await store.get(parent.id))?.freshness).toBe('stale');
    expect((await store.get(child.id))?.freshness).toBe('stale');
    expect((await store.get(unrelated.id))?.freshness).toBe('fresh');
    expect((await store.get(otherBranch.id))?.freshness).toBe('fresh');
  });
});

describe('expireBranchScopedMemory', () => {
  it('expires records bound to the departed branch and leaves repo-wide records alone', async () => {
    const store = createInMemoryStore();
    const branchScoped = makeRecord('branch-scoped', {
      scope: { branch: 'feature/auth' },
    });
    const repoScoped = makeRecord('repo-scoped', {
      scope: { branch: undefined, chatId: undefined },
    });
    const otherBranch = makeRecord('other-branch', {
      scope: { branch: 'feature/payments' },
    });
    store.writeMany([branchScoped, repoScoped, otherBranch]);

    const changed = await expireBranchScopedMemory({
      store,
      repoFullName: 'owner/repo',
      branch: 'feature/auth',
    });

    expect(changed).toBe(1);
    expect((await store.get(branchScoped.id))?.freshness).toBe('expired');
    expect((await store.get(repoScoped.id))?.freshness).toBe('fresh');
    expect((await store.get(otherBranch.id))?.freshness).toBe('fresh');
  });
});

describe('supersedeVerificationMemory', () => {
  it('marks prior matching verification results stale by check id or normalized command', async () => {
    const store = createInMemoryStore();
    const oldTypecheck = makeRecord('old-typecheck', {
      kind: 'verification_result',
      tags: ['pass', 'check:typecheck', 'command:npm run typecheck'],
      source: { kind: 'coder', label: 'Verification: typecheck', createdAt: Date.now() - 1000 },
    });
    const oldTest = makeRecord('old-tests', {
      kind: 'verification_result',
      tags: ['pass', 'check:tests', 'command:npm test'],
      source: { kind: 'coder', label: 'Verification: tests', createdAt: Date.now() - 1000 },
    });
    store.writeMany([oldTypecheck, oldTest]);

    const changed = await supersedeVerificationMemory({
      store,
      scope: makeScope(),
      checkId: 'typecheck',
      command: 'npm   run   typecheck',
    });

    expect(changed).toBe(1);
    expect((await store.get(oldTypecheck.id))?.freshness).toBe('stale');
    expect((await store.get(oldTest.id))?.freshness).toBe('fresh');
  });
});
