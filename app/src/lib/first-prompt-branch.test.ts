import { describe, expect, it, vi } from 'vitest';
import {
  type FirstPromptBranchInput,
  maybeBranchOnFirstPrompt,
  shouldBranchOnFirstPrompt,
} from './first-prompt-branch';
import type { BranchForkMigrationContext } from './branch-fork-migration';

const base: FirstPromptBranchInput = {
  enabled: true,
  isFirstMessage: true,
  promptText: 'Add a feature',
  repoFullName: 'owner/repo',
  sandboxId: 'sb-1',
  currentBranch: 'main',
  defaultBranch: 'main',
};

describe('shouldBranchOnFirstPrompt', () => {
  it('is true on the happy path', () => {
    expect(shouldBranchOnFirstPrompt(base)).toBe(true);
  });

  it('is false when disabled, not first, no repo, no sandbox, or off the default branch', () => {
    expect(shouldBranchOnFirstPrompt({ ...base, enabled: false })).toBe(false);
    expect(shouldBranchOnFirstPrompt({ ...base, isFirstMessage: false })).toBe(false);
    expect(shouldBranchOnFirstPrompt({ ...base, repoFullName: null })).toBe(false);
    expect(shouldBranchOnFirstPrompt({ ...base, sandboxId: null })).toBe(false);
    expect(shouldBranchOnFirstPrompt({ ...base, currentBranch: 'feat/x' })).toBe(false);
  });

  it('treats a missing currentBranch as being on the default branch', () => {
    expect(shouldBranchOnFirstPrompt({ ...base, currentBranch: undefined })).toBe(true);
  });
});

describe('maybeBranchOnFirstPrompt', () => {
  const ctx = {} as BranchForkMigrationContext;

  it('no-ops without forking when ineligible', async () => {
    const fork = vi.fn();
    const apply = vi.fn();
    const result = await maybeBranchOnFirstPrompt({ ...base, enabled: false }, ctx, {
      fork,
      apply,
    });
    expect(result).toEqual({ branched: false });
    expect(fork).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('forks a prompt-derived branch and migrates the chat on success', async () => {
    const branchSwitch = { name: 'owner-repo/add-a-feature', kind: 'forked' as const };
    const fork = vi.fn().mockResolvedValue({ ok: true, branchSwitch });
    const apply = vi.fn();
    const result = await maybeBranchOnFirstPrompt(base, ctx, { fork, apply });
    expect(fork).toHaveBeenCalledWith('sb-1', expect.stringContaining('add-a-feature'));
    expect(apply).toHaveBeenCalledWith(branchSwitch, ctx);
    expect(result.branched).toBe(true);
    expect(result.name).toContain('add-a-feature');
  });

  it('reports the error and does not migrate when the fork fails', async () => {
    const fork = vi.fn().mockResolvedValue({ ok: false, errorMessage: 'no sandbox' });
    const apply = vi.fn();
    const result = await maybeBranchOnFirstPrompt(base, ctx, { fork, apply });
    expect(apply).not.toHaveBeenCalled();
    expect(result).toMatchObject({ branched: false, error: 'no sandbox' });
    expect(fork).toHaveBeenCalledTimes(1); // non-collision error → no retry
  });

  it('retries with a numeric suffix on a name collision', async () => {
    const branchSwitch = { name: 'owner-repo/fix-login-2', kind: 'forked' as const };
    const fork = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, errorMessage: 'a branch named X already exists' })
      .mockResolvedValueOnce({ ok: true, branchSwitch });
    const apply = vi.fn();
    const result = await maybeBranchOnFirstPrompt({ ...base, promptText: 'Fix login' }, ctx, {
      fork,
      apply,
    });
    expect(fork).toHaveBeenCalledTimes(2);
    expect(fork.mock.calls[1][1]).toMatch(/-2$/); // second attempt is suffixed
    expect(apply).toHaveBeenCalledWith(branchSwitch, ctx);
    expect(result.branched).toBe(true);
  });
});
