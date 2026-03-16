import { describe, expect, it } from 'vitest';
import {
  buildParallelDelegationMergePlan,
  parseParallelDelegationStatus,
} from './parallel-delegation-merge';

describe('parseParallelDelegationStatus', () => {
  it('parses writes, deletes, and untracked files into workspace paths', () => {
    const parsed = parseParallelDelegationStatus([
      ' M src/app.ts',
      'A  src/new.ts',
      'D  src/old.ts',
      '?? notes/todo.md',
    ].join('\n'));

    expect(parsed.unsupported).toHaveLength(0);
    expect(parsed.changes).toEqual([
      expect.objectContaining({ path: '/workspace/src/app.ts', kind: 'write', status: ' M' }),
      expect.objectContaining({ path: '/workspace/src/new.ts', kind: 'write', status: 'A ' }),
      expect.objectContaining({ path: '/workspace/src/old.ts', kind: 'delete', status: 'D ' }),
      expect.objectContaining({ path: '/workspace/notes/todo.md', kind: 'write', status: '??' }),
    ]);
  });

  it('flags rename and conflict statuses as unsupported', () => {
    const parsed = parseParallelDelegationStatus([
      'R  src/old.ts -> src/new.ts',
      'UU src/conflicted.ts',
    ].join('\n'));

    expect(parsed.changes).toHaveLength(0);
    expect(parsed.unsupported).toEqual([
      expect.objectContaining({ path: '/workspace/src/new.ts', reason: 'rename_or_copy' }),
      expect.objectContaining({ path: '/workspace/src/conflicted.ts', reason: 'merge_conflict' }),
    ]);
  });
});

describe('buildParallelDelegationMergePlan', () => {
  it('allows disjoint file sets', () => {
    const plan = buildParallelDelegationMergePlan([
      {
        workerIndex: 0,
        changes: [{ path: '/workspace/a.ts', kind: 'write', status: ' M', raw: ' M a.ts' }],
        unsupported: [],
      },
      {
        workerIndex: 1,
        changes: [{ path: '/workspace/b.ts', kind: 'delete', status: 'D ', raw: 'D  b.ts' }],
        unsupported: [],
      },
    ]);

    expect(plan.mergeable).toBe(true);
    expect(plan.conflicts).toEqual([]);
    expect(plan.unsupported).toEqual([]);
    expect(plan.writes).toEqual([{ workerIndex: 0, path: '/workspace/a.ts' }]);
    expect(plan.deletes).toEqual([{ workerIndex: 1, path: '/workspace/b.ts' }]);
  });

  it('rejects overlapping file paths', () => {
    const plan = buildParallelDelegationMergePlan([
      {
        workerIndex: 0,
        changes: [{ path: '/workspace/shared.ts', kind: 'write', status: ' M', raw: ' M shared.ts' }],
        unsupported: [],
      },
      {
        workerIndex: 1,
        changes: [{ path: '/workspace/shared.ts', kind: 'write', status: ' M', raw: ' M shared.ts' }],
        unsupported: [],
      },
    ]);

    expect(plan.mergeable).toBe(false);
    expect(plan.conflicts).toEqual(['/workspace/shared.ts']);
  });

  it('rejects unsupported worker changes', () => {
    const plan = buildParallelDelegationMergePlan([
      {
        workerIndex: 0,
        changes: [],
        unsupported: [{ path: '/workspace/new.ts', status: 'R ', raw: 'R  a -> b', reason: 'rename_or_copy' }],
      },
    ]);

    expect(plan.mergeable).toBe(false);
    expect(plan.unsupported).toEqual(['Task 1: /workspace/new.ts (rename_or_copy)']);
  });
});
