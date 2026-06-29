import { afterEach, describe, expect, it, vi } from 'vitest';
import { restoreResumeBranchIfNeeded, shouldRestoreResumeBranch } from './resume-branch-restore';

describe('shouldRestoreResumeBranch', () => {
  it('skips same-branch same-repo resumes', () => {
    expect(
      shouldRestoreResumeBranch({
        repoFullName: 'push/repo',
        activeRepoFullName: 'push/repo',
        savedBranch: 'feature/work',
        currentBranch: 'feature/work',
      }),
    ).toBe(false);
  });

  it('restores same-repo resumes when the saved branch differs', () => {
    expect(
      shouldRestoreResumeBranch({
        repoFullName: 'push/repo',
        activeRepoFullName: 'push/repo',
        savedBranch: 'feature/work',
        currentBranch: 'main',
      }),
    ).toBe(true);
  });

  it('treats legacy no-branch chats as no specific branch', () => {
    expect(
      shouldRestoreResumeBranch({
        repoFullName: 'push/repo',
        activeRepoFullName: 'push/repo',
        savedBranch: undefined,
        currentBranch: 'main',
      }),
    ).toBe(false);
  });

  it('leaves cross-repo resumes to the normal repo-selection path', () => {
    expect(
      shouldRestoreResumeBranch({
        repoFullName: 'push/other',
        activeRepoFullName: 'push/repo',
        savedBranch: 'feature/work',
        currentBranch: 'main',
      }),
    ).toBe(false);
  });
});

describe('restoreResumeBranchIfNeeded', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: 'same-branch same-repo resume',
      repoFullName: 'push/repo',
      activeRepoFullName: 'push/repo',
      savedBranch: 'feature/work',
      currentBranch: 'feature/work',
    },
    {
      name: 'legacy no-branch resume',
      repoFullName: 'push/repo',
      activeRepoFullName: 'push/repo',
      savedBranch: undefined,
      currentBranch: 'main',
    },
    {
      name: 'cross-repo resume',
      repoFullName: 'push/other',
      activeRepoFullName: 'push/repo',
      savedBranch: 'feature/work',
      currentBranch: 'main',
    },
  ])('keeps current branch for $name', async (input) => {
    const switchBranchFromUI = vi.fn(async () => ({ ok: true as const }));

    const result = await restoreResumeBranchIfNeeded({
      chatId: 'chat-1',
      ...input,
      surface: 'drawer',
      switchBranchFromUI,
    });

    expect(result).toBe('skipped');
    expect(switchBranchFromUI).not.toHaveBeenCalled();
  });

  it('warm-switches to the saved branch for a different-branch same-repo resume', async () => {
    const switchBranchFromUI = vi.fn(async () => ({ ok: true as const }));

    const result = await restoreResumeBranchIfNeeded({
      chatId: 'chat-1',
      repoFullName: 'push/repo',
      activeRepoFullName: 'push/repo',
      savedBranch: 'feature/work',
      currentBranch: 'main',
      surface: 'drawer',
      switchBranchFromUI,
    });

    expect(result).toBe('switched');
    expect(switchBranchFromUI).toHaveBeenCalledWith('feature/work');
  });

  it('keeps current branch and logs a structured fallback when warm switch fails', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await restoreResumeBranchIfNeeded({
      chatId: 'chat-1',
      repoFullName: 'push/repo',
      activeRepoFullName: 'push/repo',
      savedBranch: 'feature/work',
      currentBranch: 'main',
      surface: 'launcher',
      switchBranchFromUI: vi.fn(async () => ({
        ok: false as const,
        errorMessage: 'Working tree has local changes.',
      })),
    });

    expect(result).toBe('failed');
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'warn',
        event: 'resume_branch_restore_fallback',
        surface: 'launcher',
        chatId: 'chat-1',
        repoFullName: 'push/repo',
        currentBranch: 'main',
        targetBranch: 'feature/work',
        reason: 'Working tree has local changes.',
      }),
    );
  });
});
