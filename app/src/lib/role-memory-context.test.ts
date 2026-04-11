import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockBuildRetrievedMemoryKnownContext } = vi.hoisted(() => ({
  mockBuildRetrievedMemoryKnownContext: vi.fn(),
}));

vi.mock('@/lib/context-memory', () => ({
  buildRetrievedMemoryKnownContext: (...args: unknown[]) =>
    mockBuildRetrievedMemoryKnownContext(...args),
}));

import {
  buildAuditorEvaluationMemoryBlock,
  buildAuditorRuntimeContext,
  buildReviewerRuntimeContext,
} from './role-memory-context';

function makeAddedFileDiff(path: string, addedContent: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    `+${addedContent}`,
    '',
  ].join('\n');
}

describe('role-memory-context', () => {
  beforeEach(() => {
    mockBuildRetrievedMemoryKnownContext.mockReset();
    mockBuildRetrievedMemoryKnownContext.mockResolvedValue({
      line: '[RETRIEVED_FACTS]\n- [finding | explorer] Prior note\n[/RETRIEVED_FACTS]',
      result: { records: [], candidateCount: 0, expiredExcluded: 0, staleDropped: 0 },
      packResult: { block: '', sections: {}, packed: [], dropped: [], charsUsed: 0 },
    });
  });

  it('builds reviewer runtime context with retrieved memory scoped to the diff', async () => {
    const diff = [
      makeAddedFileDiff('src/auth.ts', 'const auth = true;'),
      makeAddedFileDiff('src/session.ts', 'export const session = true;'),
    ].join('');

    const context = await buildReviewerRuntimeContext(diff, {
      repoFullName: 'owner/repo',
      activeBranch: 'feature/auth',
      source: 'branch-diff',
      sourceLabel: 'Branch diff',
    });

    expect(context).toContain('## Review Run Context');
    expect(context).toContain('[RETRIEVED_FACTS]');
    expect(mockBuildRetrievedMemoryKnownContext).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: 'owner/repo',
        branch: 'feature/auth',
        role: 'reviewer',
        fileHints: ['src/auth.ts', 'src/session.ts'],
      }),
      expect.objectContaining({
        sectionBudgets: expect.any(Object),
      }),
    );
  });

  it('builds auditor runtime context with retrieved memory when repo scope exists', async () => {
    const diff = makeAddedFileDiff('src/security.ts', 'const auth = true;');

    const context = await buildAuditorRuntimeContext(diff, {
      repoFullName: 'owner/repo',
      activeBranch: 'feature/audit',
      source: 'pr-merge',
      sourceLabel: 'PR #12',
      prNumber: 12,
    });

    expect(context).toContain('## Audit Run Context');
    expect(context).toContain('[RETRIEVED_FACTS]');
    expect(mockBuildRetrievedMemoryKnownContext).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: 'owner/repo',
        branch: 'feature/audit',
        role: 'auditor',
        fileHints: ['src/security.ts'],
      }),
      expect.any(Object),
    );
  });

  it('fails open and returns base context when retrieval errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockBuildRetrievedMemoryKnownContext.mockRejectedValueOnce(new Error('db unavailable'));

    try {
      const context = await buildReviewerRuntimeContext(
        makeAddedFileDiff('src/auth.ts', 'const auth = true;'),
        {
          repoFullName: 'owner/repo',
          activeBranch: 'feature/auth',
          source: 'working-tree',
          sourceLabel: 'Working tree',
        },
      );

      expect(context).toContain('## Review Run Context');
      expect(context).not.toContain('[RETRIEVED_');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('builds evaluation memory queries from task, diff, and memory scope', async () => {
    const block = await buildAuditorEvaluationMemoryBlock(
      'finish the auth hardening pass',
      makeAddedFileDiff('src/auth.ts', 'const auth = true;'),
      {
        repoFullName: 'owner/repo',
        branch: 'feature/auth',
        chatId: 'chat-1',
        taskGraphId: 'graph-1',
      },
    );

    expect(block).toContain('[RETRIEVED_FACTS]');
    expect(mockBuildRetrievedMemoryKnownContext).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: 'owner/repo',
        branch: 'feature/auth',
        chatId: 'chat-1',
        taskGraphId: 'graph-1',
        role: 'auditor',
        taskText: expect.stringContaining('finish the auth hardening pass'),
        fileHints: ['src/auth.ts'],
      }),
      expect.any(Object),
    );
  });
});
