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

  it('blocks raw `git push` in full-auto with no consent (route to audited sandbox_push)', async () => {
    // Gate-at-Push: the Auditor gate lives at the push, so a raw push in
    // full-auto (no human, no typed gate) would ship unaudited. Force it through
    // sandbox_push even though full-auto otherwise lets direct git through.
    const entry = withMode('full-auto');
    const result = await entry.hook(
      'sandbox_exec',
      { command: 'git push origin main' },
      emptyContext,
    );
    expect(result.decision).toBe('deny');
    expect(result.errorType).toBe('GIT_GUARD_BLOCKED');
  });

  it('respects allowDirectGit: true for commit/push/rebase but not branch ops', async () => {
    const entry = withMode('supervised');
    const allowed = await entry.hook(
      'sandbox_exec',
      { command: 'git push origin main', allowDirectGit: true },
      emptyContext,
    );
    expect(allowed.decision).toBe('passthrough');

    const rebaseAllowed = await entry.hook(
      'sandbox_exec',
      { command: 'git rebase main', allowDirectGit: true },
      emptyContext,
    );
    expect(rebaseAllowed.decision).toBe('passthrough');

    const stillBlocked = await entry.hook(
      'sandbox_exec',
      { command: 'git checkout -b feature/foo', allowDirectGit: true },
      emptyContext,
    );
    expect(stillBlocked.decision).toBe('deny');
  });

  it('blocks a local `git merge` even with allowDirectGit (#985: PR-flow only)', async () => {
    // A local merge is forbidden and a push-gate evasion (its conflict-resolution
    // combined diff is omitted by the push-time `git log -p` scan), so the
    // consent hatch must not reopen it — unlike commit/push/rebase.
    const entry = withMode('supervised');
    const result = await entry.hook(
      'sandbox_exec',
      { command: 'git merge feature/x', allowDirectGit: true },
      emptyContext,
    );
    expect(result.decision).toBe('deny');
    expect(result.errorType).toBe('GIT_GUARD_BLOCKED');
    expect(result.reason).toContain('PR flow');
    expect(result.reason).not.toContain('allowDirectGit": true');
  });

  it('blocks a local `git merge` in full-auto (no consent escape)', async () => {
    const entry = withMode('full-auto');
    const result = await entry.hook(
      'sandbox_exec',
      { command: 'git merge feature/x' },
      emptyContext,
    );
    expect(result.decision).toBe('deny');
    expect(result.errorType).toBe('GIT_GUARD_BLOCKED');
  });

  it('blocks `git commit && git merge` — the merge is not masked by the escapable commit', async () => {
    // The classifier surfaces the MOST restrictive segment, so an earlier
    // allowDirectGit-eligible commit can't smuggle a forbidden merge through the
    // chain (Codex P1 on #986).
    const entry = withMode('full-auto');
    const chained = await entry.hook(
      'sandbox_exec',
      { command: 'git commit -m x && git merge feature/x', allowDirectGit: true },
      emptyContext,
    );
    expect(chained.decision).toBe('deny');
    expect(chained.errorType).toBe('GIT_GUARD_BLOCKED');
  });

  // --- Protect Main blocks the exec `git push` escape hatch (issue #977) ----
  const protectedContext = { ...emptyContext, isMainProtected: true };

  it('blocks `git push` via exec under Protect Main even with allowDirectGit', async () => {
    const entry = withMode('supervised');
    const result = await entry.hook(
      'sandbox_exec',
      { command: 'git push origin main', allowDirectGit: true },
      protectedContext,
    );
    expect(result.decision).toBe('deny');
    expect(result.errorType).toBe('PROTECT_MAIN_BLOCKED');
    expect(result.reason).toContain('sandbox_push');
  });

  it('blocks exec `git push` under Protect Main regardless of the target branch', async () => {
    // Target-agnostic: we don't predict the destination from the command string.
    const entry = withMode('supervised');
    const result = await entry.hook(
      'sandbox_exec',
      { command: 'git push origin feature/x', allowDirectGit: true },
      protectedContext,
    );
    expect(result.decision).toBe('deny');
    expect(result.errorType).toBe('PROTECT_MAIN_BLOCKED');
  });

  it('blocks exec `git push` under Protect Main in full-auto (no allowDirectGit)', async () => {
    // Full-auto otherwise lets direct git through; Protect Main overrides that.
    const entry = withMode('full-auto');
    const result = await entry.hook('sandbox_exec', { command: 'git push' }, protectedContext);
    expect(result.decision).toBe('deny');
    expect(result.errorType).toBe('PROTECT_MAIN_BLOCKED');
  });

  it('still allows exec `git push` with allowDirectGit when Protect Main is OFF', async () => {
    const entry = withMode('supervised');
    const result = await entry.hook(
      'sandbox_exec',
      { command: 'git push origin main', allowDirectGit: true },
      emptyContext, // isMainProtected falsy
    );
    expect(result.decision).toBe('passthrough');
  });

  it('does not block exec `git commit` under Protect Main (push-only scope)', async () => {
    // #977 hardens the push surface only; the commit escape hatch is unchanged
    // here (the audited commit flow has its own Auditor + Protect Main gate).
    const entry = withMode('full-auto');
    const result = await entry.hook(
      'sandbox_exec',
      { command: 'git commit -m "x"', allowDirectGit: true },
      protectedContext,
    );
    expect(result.decision).toBe('passthrough');
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

  it('denies sandbox_commit on main', async () => {
    const entry = createProtectMainPreHook();
    const result = await entry.hook('sandbox_commit', {}, baseContext);
    expect(result.decision).toBe('deny');
    expect(result.errorType).toBe('PROTECT_MAIN_BLOCKED');
  });

  it('denies prepare_push on main', async () => {
    const entry = createProtectMainPreHook();
    const result = await entry.hook('prepare_push', {}, baseContext);
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
      'sandbox_commit',
      {},
      { ...baseContext, isMainProtected: false },
    );
    expect(result.decision).toBe('passthrough');
  });

  it('passes through when current branch is not main/default', async () => {
    const entry = createProtectMainPreHook();
    const result = await entry.hook(
      'sandbox_commit',
      {},
      { ...baseContext, getCurrentBranch: async () => 'feature/foo' },
    );
    expect(result.decision).toBe('passthrough');
  });

  it('fails safe — denies when current branch can not be read', async () => {
    const entry = createProtectMainPreHook();
    const result = await entry.hook(
      'sandbox_commit',
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

  it('fails closed when a live reader returns null, ignoring a feature tracked branch (Codex P1)', async () => {
    // A live reader is the authority. If it returns null (transient/unreadable
    // HEAD) we must NOT trust a possibly-stale tracked branch — a desynced
    // session (tracked feature, HEAD actually main) could otherwise bypass the
    // gate. Blocking is safer than an unrecoverable push to main.
    const entry = createProtectMainPreHook();
    const result = await entry.hook(
      'sandbox_commit',
      {},
      { ...baseContext, getCurrentBranch: async () => null, currentBranch: 'feature/foo' },
    );
    expect(result.decision).toBe('deny');
  });

  it('fails closed when a live reader returns null, ignoring a main tracked branch too', async () => {
    // Same fail-closed path regardless of the tracked value — the tracked
    // branch is not consulted at all while a live reader is present.
    const entry = createProtectMainPreHook();
    const result = await entry.hook(
      'sandbox_commit',
      {},
      { ...baseContext, getCurrentBranch: async () => null, currentBranch: 'main' },
    );
    expect(result.decision).toBe('deny');
  });

  it('prefers the live read over a stale tracked branch (desync safety)', async () => {
    // Tracked says feature, but HEAD actually desynced onto main. Live-first
    // must win so the gate is not bypassed by stale tracked state.
    const entry = createProtectMainPreHook();
    const result = await entry.hook(
      'sandbox_commit',
      {},
      { ...baseContext, getCurrentBranch: async () => 'main', currentBranch: 'feature/foo' },
    );
    expect(result.decision).toBe('deny');
  });

  it('evaluates from the tracked branch alone when there is no live reader', async () => {
    const entry = createProtectMainPreHook();
    const passthrough = await entry.hook(
      'sandbox_commit',
      {},
      {
        ...baseContext,
        sandboxId: null,
        getCurrentBranch: undefined,
        currentBranch: 'feature/foo',
      },
    );
    expect(passthrough.decision).toBe('passthrough');

    const denied = await entry.hook(
      'sandbox_commit',
      {},
      { ...baseContext, sandboxId: null, getCurrentBranch: undefined, currentBranch: 'main' },
    );
    expect(denied.decision).toBe('deny');
  });

  it('passes through when neither a live reader nor a tracked branch is available', async () => {
    const entry = createProtectMainPreHook();
    const result = await entry.hook(
      'sandbox_commit',
      {},
      { ...baseContext, sandboxId: null, getCurrentBranch: undefined },
    );
    expect(result.decision).toBe('passthrough');
  });
});
