import { describe, expect, it } from 'vitest';
import { createGitGuardPreHook, createProtectMainPreHook } from './default-pre-hooks.ts';
import type { ApprovalMode } from './approval-gates.ts';
import type { ToolHookContext } from './tool-hooks.ts';

const emptyContext: ToolHookContext = {
  sandboxId: null,
  allowedRepo: 'owner/repo',
};

describe('createGitGuardPreHook', () => {
  const withMode = (mode: ApprovalMode) => createGitGuardPreHook({ modeProvider: () => mode });

  it('passes through commands with no git mutation', async () => {
    const entry = withMode('supervised');
    const result = await entry.hook('sandbox_exec', { command: 'npm test' }, emptyContext);
    expect(result.decision).toBe('passthrough');
  });

  it('denies git push with GIT_GUARD_BLOCKED', async () => {
    const entry = withMode('supervised');
    const result = await entry.hook(
      'sandbox_exec',
      { command: 'git push origin main' },
      emptyContext,
    );
    expect(result.decision).toBe('deny');
    expect(result.errorType).toBe('GIT_GUARD_BLOCKED');
    expect(result.reason).toContain('git push');
  });

  it('denies git checkout -b regardless of approval mode (state-sync issue)', async () => {
    const entry = withMode('full-auto');
    const result = await entry.hook(
      'sandbox_exec',
      { command: 'git checkout -b feature/foo' },
      emptyContext,
    );
    expect(result.decision).toBe('deny');
    expect(result.errorType).toBe('GIT_GUARD_BLOCKED');
    expect(result.reason).toContain('sandbox_create_branch');
  });

  it('denies plain `git switch <branch>` with sandbox_switch_branch guidance', async () => {
    const entry = withMode('supervised');
    const result = await entry.hook(
      'sandbox_exec',
      { command: 'git switch develop' },
      emptyContext,
    );
    expect(result.decision).toBe('deny');
    expect(result.errorType).toBe('GIT_GUARD_BLOCKED');
    expect(result.reason).toContain('sandbox_switch_branch');
  });

  it('allows direct git in full-auto for non-branch ops', async () => {
    const entry = withMode('full-auto');
    const result = await entry.hook(
      'sandbox_exec',
      { command: 'git commit -m "fix"' },
      emptyContext,
    );
    expect(result.decision).toBe('passthrough');
  });

  it('respects allowDirectGit: true for commit/push/merge/rebase only', async () => {
    const entry = withMode('supervised');
    const allowed = await entry.hook(
      'sandbox_exec',
      { command: 'git push origin main', allowDirectGit: true },
      emptyContext,
    );
    expect(allowed.decision).toBe('passthrough');

    const stillBlocked = await entry.hook(
      'sandbox_exec',
      { command: 'git checkout -b feature/foo', allowDirectGit: true },
      emptyContext,
    );
    expect(stillBlocked.decision).toBe('deny');
  });
});

describe('createProtectMainPreHook', () => {
  const baseContext: ToolHookContext = {
    sandboxId: 'sb-1',
    allowedRepo: 'owner/repo',
    isMainProtected: true,
    defaultBranch: 'main',
    getCurrentBranch: async () => 'main',
  };

  it('denies sandbox_prepare_commit on main', async () => {
    const entry = createProtectMainPreHook();
    const result = await entry.hook('sandbox_prepare_commit', {}, baseContext);
    expect(result.decision).toBe('deny');
    expect(result.errorType).toBe('PROTECT_MAIN_BLOCKED');
  });

  it('denies CLI git_commit on default branch with sandboxId: null (CLI context)', async () => {
    // Regression pin: CLI's `executeToolCall` builds the hook context with
    // `sandboxId: null` because the daemon's workspace is the local
    // working tree. The hook must still fire when only `isMainProtected`
    // and `getCurrentBranch` are present.
    const entry = createProtectMainPreHook();
    const result = await entry.hook(
      'git_commit',
      { message: 'fix' },
      { ...baseContext, sandboxId: null },
    );
    expect(result.decision).toBe('deny');
    expect(result.errorType).toBe('PROTECT_MAIN_BLOCKED');
  });

  it('passes through when isMainProtected is false', async () => {
    const entry = createProtectMainPreHook();
    const result = await entry.hook(
      'sandbox_prepare_commit',
      {},
      { ...baseContext, isMainProtected: false },
    );
    expect(result.decision).toBe('passthrough');
  });

  it('passes through when current branch is not main/default', async () => {
    const entry = createProtectMainPreHook();
    const result = await entry.hook(
      'sandbox_prepare_commit',
      {},
      { ...baseContext, getCurrentBranch: async () => 'feature/foo' },
    );
    expect(result.decision).toBe('passthrough');
  });

  it('fails safe — denies when current branch can not be read', async () => {
    const entry = createProtectMainPreHook();
    const result = await entry.hook(
      'sandbox_prepare_commit',
      {},
      { ...baseContext, getCurrentBranch: async () => null },
    );
    expect(result.decision).toBe('deny');
  });

  it('honors a non-default default-branch name like `master`', async () => {
    const entry = createProtectMainPreHook();
    const result = await entry.hook(
      'sandbox_push',
      {},
      {
        ...baseContext,
        defaultBranch: 'master',
        getCurrentBranch: async () => 'master',
      },
    );
    expect(result.decision).toBe('deny');
  });
});
