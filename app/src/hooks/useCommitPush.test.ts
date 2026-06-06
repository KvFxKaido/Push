import { beforeEach, describe, expect, it, vi } from 'vitest';

const sandboxClient = vi.hoisted(() => ({
  getSandboxDiff: vi.fn(),
  execInSandbox: vi.fn(),
  readFromSandbox: vi.fn(),
  writeToSandbox: vi.fn(),
}));
const auditor = vi.hoisted(() => ({ runAuditor: vi.fn() }));
const fileCtx = vi.hoisted(() => ({ fetchAuditorFileContexts: vi.fn() }));
const orchestrator = vi.hoisted(() => ({ getActiveProvider: vi.fn() }));
const diffUtils = vi.hoisted(() => ({ parseDiffStats: vi.fn() }));

vi.mock('@/lib/sandbox-client', () => sandboxClient);
vi.mock('@/lib/auditor-agent', () => auditor);
vi.mock('@/lib/auditor-file-context', () => fileCtx);
vi.mock('@/lib/orchestrator', () => orchestrator);
vi.mock('@/lib/diff-utils', () => diffUtils);

type Cell = { value: unknown };
const reactState = vi.hoisted(() => ({
  cells: [] as Cell[],
  index: 0,
}));

vi.mock('react', () => ({
  useState: <T>(initial: T | (() => T)) => {
    const i = reactState.index++;
    if (!reactState.cells[i]) {
      const seed = typeof initial === 'function' ? (initial as () => T)() : initial;
      reactState.cells[i] = { value: seed };
    }
    const cell = reactState.cells[i];
    const setter = (v: T | ((prev: T) => T)) => {
      cell.value = typeof v === 'function' ? (v as (prev: T) => T)(cell.value as T) : v;
    };
    return [cell.value as T, setter];
  },
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useRef: <T>(initial: T) => ({ current: initial }),
  useEffect: () => {},
}));

const { useCommitPush } = await import('./useCommitPush');

function render(
  sandboxId = 'sbx-1',
  providerOverride: 'openrouter' | null = 'openrouter',
  modelOverride?: string | null,
  onSandboxExpired?: () => Promise<string | null>,
): ReturnType<typeof useCommitPush> {
  reactState.index = 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useCommitPush(sandboxId, providerOverride, modelOverride, onSandboxExpired);
}

type GitExecResult = { exitCode: number; stdout?: string; stderr?: string; error?: string };

/**
 * Dispatch `execInSandbox` by command so the pre-push secret scan's
 * `computePushedDiff` reads (rev-parse/branch/merge-base/diff) don't depend on
 * call order. `pushedDiff` is what the scan sees; `push` is the push result;
 * `override(id, cmd)` wins first (used to fail a specific sandbox/command).
 */
function dispatchGit(
  opts: {
    pushedDiff?: string;
    push?: GitExecResult;
    override?: (id: string, cmd: string) => GitExecResult | undefined;
  } = {},
) {
  sandboxClient.execInSandbox.mockImplementation(async (id: string, cmd: string) => {
    const ov = opts.override?.(id, cmd);
    if (ov) return { stdout: '', stderr: '', ...ov };
    if (cmd.includes('@{upstream}')) return { exitCode: 0, stdout: 'origin/main', stderr: '' };
    if (cmd.includes("'diff'")) return { exitCode: 0, stdout: opts.pushedDiff ?? '', stderr: '' };
    if (cmd.includes("'push'"))
      return { stdout: '', stderr: '', ...(opts.push ?? { exitCode: 0 }) };
    return { exitCode: 0, stdout: '', stderr: '' }; // add, commit, apply, etc.
  });
}

const calledWith = (substr: string): boolean =>
  sandboxClient.execInSandbox.mock.calls.some((c: unknown[]) => String(c[1]).includes(substr));

beforeEach(() => {
  Object.values(sandboxClient).forEach((m) => m.mockReset());
  sandboxClient.writeToSandbox.mockResolvedValue({ ok: true });
  auditor.runAuditor.mockReset();
  fileCtx.fetchAuditorFileContexts.mockReset().mockResolvedValue([]);
  orchestrator.getActiveProvider.mockReset();
  diffUtils.parseDiffStats.mockReset();
  reactState.cells = [];
  reactState.index = 0;
});

describe('useCommitPush — initial state', () => {
  it('starts in idle with empty diff/verdict', () => {
    const hook = render();
    expect(hook.phase).toBe('idle');
    expect(hook.diff).toBeNull();
    expect(hook.auditVerdict).toBeNull();
    expect(hook.error).toBeNull();
    expect(hook.commitMessage).toBe('');
  });

  it('setCommitMessage updates the commitMessage field', () => {
    const hook = render();
    hook.setCommitMessage('my commit');
    expect((reactState.cells[0].value as { commitMessage: string }).commitMessage).toBe(
      'my commit',
    );
  });

  it('reset clears all fields back to idle', () => {
    const hook = render();
    hook.setCommitMessage('msg');
    hook.reset();
    expect(reactState.cells[0].value).toEqual({
      phase: 'idle',
      diff: null,
      auditVerdict: null,
      error: null,
      commitMessage: '',
    });
  });
});

describe('useCommitPush.fetchDiff (stage)', () => {
  it('moves to reviewing with a parsed diff when changes exist', async () => {
    sandboxClient.getSandboxDiff.mockResolvedValue({
      diff: 'diff --git a/x b/x',
      truncated: false,
    });
    diffUtils.parseDiffStats.mockReturnValue({
      filesChanged: 1,
      additions: 5,
      deletions: 2,
      fileNames: ['x'],
    });

    const hook = render();
    await hook.fetchDiff();
    const state = reactState.cells[0].value as {
      phase: string;
      diff: { additions: number; deletions: number };
    };
    expect(state.phase).toBe('reviewing');
    expect(state.diff).toMatchObject({ additions: 5, deletions: 2 });
  });

  it('falls into the error phase when the diff is empty', async () => {
    sandboxClient.getSandboxDiff.mockResolvedValue({ diff: '', truncated: false });
    const hook = render();
    await hook.fetchDiff();
    expect((reactState.cells[0].value as { phase: string; error: string }).phase).toBe('error');
    expect((reactState.cells[0].value as { phase: string; error: string }).error).toContain(
      'Nothing to commit',
    );
  });

  it('surfaces thrown errors from the sandbox client', async () => {
    sandboxClient.getSandboxDiff.mockRejectedValue(new Error('net down'));
    const hook = render();
    await hook.fetchDiff();
    expect((reactState.cells[0].value as { phase: string; error: string }).phase).toBe('error');
    expect((reactState.cells[0].value as { phase: string; error: string }).error).toBe('net down');
  });
});

describe('useCommitPush.commitAndPush (audit → commit → push)', () => {
  function seedReviewingState(diff = 'diff-text') {
    reactState.cells[0] = {
      value: {
        phase: 'reviewing',
        diff: { diff, filesChanged: 1, additions: 1, deletions: 0, truncated: false },
        auditVerdict: null,
        error: null,
        commitMessage: 'fix thing',
      },
    };
  }

  it('requires a non-empty commit message', async () => {
    reactState.cells[0] = {
      value: {
        phase: 'reviewing',
        diff: { diff: 'd', filesChanged: 1, additions: 1, deletions: 0, truncated: false },
        auditVerdict: null,
        error: null,
        commitMessage: '   ',
      },
    };
    const hook = render();
    await hook.commitAndPush();
    expect((reactState.cells[0].value as { phase: string; error: string }).phase).toBe('error');
    expect((reactState.cells[0].value as { phase: string; error: string }).error).toContain(
      'Commit message is required',
    );
  });

  it('refuses to proceed when the active provider is demo (no AI configured)', async () => {
    seedReviewingState();
    orchestrator.getActiveProvider.mockReturnValue('demo');
    const hook = render('sbx-1', null);
    await hook.commitAndPush();
    expect((reactState.cells[0].value as { phase: string; error: string }).phase).toBe('error');
    expect((reactState.cells[0].value as { phase: string; error: string }).error).toContain(
      'No AI provider configured',
    );
  });

  it('blocks the commit when the Auditor returns unsafe', async () => {
    seedReviewingState();
    diffUtils.parseDiffStats.mockReturnValue({ fileNames: [] });
    auditor.runAuditor.mockResolvedValue({
      verdict: 'unsafe',
      card: { summary: 'leaks a secret' },
    });
    const hook = render();
    await hook.commitAndPush();
    expect((reactState.cells[0].value as { phase: string; error: string }).phase).toBe('error');
    expect((reactState.cells[0].value as { phase: string; error: string }).error).toContain(
      'leaks a secret',
    );
    expect(sandboxClient.execInSandbox).not.toHaveBeenCalled();
  });

  it('runs git commit then git push and ends in success', async () => {
    seedReviewingState();
    diffUtils.parseDiffStats.mockReturnValue({ fileNames: [] });
    auditor.runAuditor.mockResolvedValue({
      verdict: 'safe',
      card: { summary: 'looks good' },
    });
    dispatchGit({ pushedDiff: '+const x = 1;' }); // clean diff → scan passes

    const hook = render();
    await hook.commitAndPush();

    expect(calledWith("git 'commit' '-m' 'fix thing'")).toBe(true);
    expect(calledWith("git 'push' 'origin' 'HEAD'")).toBe(true);
    expect((reactState.cells[0].value as { phase: string }).phase).toBe('success');
  });

  it('blocks the push (after commit) when the about-to-be-pushed diff carries a secret', async () => {
    seedReviewingState();
    diffUtils.parseDiffStats.mockReturnValue({ fileNames: [] });
    auditor.runAuditor.mockResolvedValue({ verdict: 'safe', card: { summary: 'looks good' } });
    // The secret lives in the *pushed* commits (what computePushedDiff returns),
    // not the in-hand preview — proving the gate scans the real push payload.
    const secretDiff = [
      '+++ b/config.ts',
      '@@ -0,0 +1 @@',
      '+const k = "AKIAIOSFODNN7EXAMPLE";',
    ].join('\n');
    dispatchGit({ pushedDiff: secretDiff });

    const hook = render();
    await hook.commitAndPush();

    const state = reactState.cells[0].value as { phase: string; error: string };
    expect(state.phase).toBe('error');
    expect(state.error).toContain('AWS access key ID');
    expect(state.error).not.toContain('AKIAIOSFODNN7EXAMPLE');
    // The commit ran, but the push is never attempted.
    expect(calledWith("git 'commit'")).toBe(true);
    expect(calledWith("git 'push'")).toBe(false);
  });

  it('reports commit failures with stderr/stdout detail', async () => {
    seedReviewingState();
    diffUtils.parseDiffStats.mockReturnValue({ fileNames: [] });
    auditor.runAuditor.mockResolvedValue({
      verdict: 'safe',
      card: { summary: '' },
    });
    sandboxClient.execInSandbox.mockResolvedValueOnce({
      exitCode: 1,
      stdout: 'nothing to commit',
      stderr: '',
    });
    const hook = render();
    await hook.commitAndPush();
    expect((reactState.cells[0].value as { phase: string; error: string }).phase).toBe('error');
    expect((reactState.cells[0].value as { phase: string; error: string }).error).toContain(
      'nothing to commit',
    );
  });

  it('reports push failures after a successful commit', async () => {
    seedReviewingState();
    diffUtils.parseDiffStats.mockReturnValue({ fileNames: [] });
    auditor.runAuditor.mockResolvedValue({
      verdict: 'safe',
      card: { summary: '' },
    });
    dispatchGit({ push: { exitCode: 1, stderr: 'rejected (non-fast-forward)' } });
    const hook = render();
    await hook.commitAndPush();
    expect((reactState.cells[0].value as { phase: string; error: string }).phase).toBe('error');
    expect((reactState.cells[0].value as { phase: string; error: string }).error).toContain(
      'Push failed',
    );
  });

  it('degrades gracefully when file-context fetch throws', async () => {
    seedReviewingState();
    diffUtils.parseDiffStats.mockReturnValue({ fileNames: ['a', 'b'] });
    fileCtx.fetchAuditorFileContexts.mockRejectedValue(new Error('fs gone'));
    auditor.runAuditor.mockResolvedValue({
      verdict: 'safe',
      card: { summary: '' },
    });
    dispatchGit();
    const hook = render();
    await hook.commitAndPush();
    // runAuditor receives an empty file-context array rather than crashing.
    const call = auditor.runAuditor.mock.calls[0];
    expect(call[5]).toEqual([]);
    expect((reactState.cells[0].value as { phase: string }).phase).toBe('success');
  });

  it('bails out with "No diff available" when state.diff is missing', async () => {
    reactState.cells[0] = {
      value: {
        phase: 'reviewing',
        diff: null,
        auditVerdict: null,
        error: null,
        commitMessage: 'msg',
      },
    };
    const hook = render();
    await hook.commitAndPush();
    expect((reactState.cells[0].value as { phase: string; error: string }).error).toContain(
      'No diff available',
    );
  });

  it('escapes single quotes in the commit message before shelling out', async () => {
    reactState.cells[0] = {
      value: {
        phase: 'reviewing',
        diff: { diff: 'd', filesChanged: 1, additions: 1, deletions: 0, truncated: false },
        auditVerdict: null,
        error: null,
        commitMessage: "it's fine",
      },
    };
    diffUtils.parseDiffStats.mockReturnValue({ fileNames: [] });
    auditor.runAuditor.mockResolvedValue({
      verdict: 'safe',
      card: { summary: '' },
    });
    dispatchGit();
    const hook = render();
    await hook.commitAndPush();
    // The backend shell-escapes the message identically when committing.
    expect(calledWith(`'it'"'"'s fine'`)).toBe(true);
  });
});

describe('useCommitPush.commitAndPush — sandbox-expiry recovery', () => {
  function seedReviewingState(diff = 'diff --git a/x b/x') {
    reactState.cells[0] = {
      value: {
        phase: 'reviewing',
        diff: { diff, filesChanged: 1, additions: 1, deletions: 0, truncated: false },
        auditVerdict: null,
        error: null,
        commitMessage: 'fix thing',
      },
    };
  }

  it('recovers when commit fails with sandbox-not-found and replays diff in the new sandbox', async () => {
    seedReviewingState();
    diffUtils.parseDiffStats.mockReturnValue({ fileNames: [] });
    auditor.runAuditor.mockResolvedValue({
      verdict: 'safe',
      card: { summary: 'looks good' },
    });

    // The original sandbox is dead: its first git call (add) reports expired.
    // The recovered sandbox (sbx-2) succeeds for everything, incl. the scan.
    dispatchGit({
      override: (id) =>
        id === 'sbx-1' ? { exitCode: -1, error: 'Sandbox not found or expired' } : undefined,
    });

    const onSandboxExpired = vi.fn().mockResolvedValue('sbx-2');
    const hook = render('sbx-1', 'openrouter', undefined, onSandboxExpired);
    await hook.commitAndPush();

    expect(onSandboxExpired).toHaveBeenCalledOnce();
    expect(sandboxClient.writeToSandbox).toHaveBeenCalledWith(
      'sbx-2',
      '/workspace/.git/push-recovery.patch',
      'diff --git a/x b/x',
    );
    const calls = sandboxClient.execInSandbox.mock.calls;
    const onSbx2 = (substr: string) =>
      calls.some((c: unknown[]) => c[0] === 'sbx-2' && String(c[1]).includes(substr));
    expect(onSbx2('git apply')).toBe(true);
    expect(onSbx2("git 'commit' '-m' 'fix thing'")).toBe(true);
    expect(onSbx2("git 'push' 'origin' 'HEAD'")).toBe(true);
    expect((reactState.cells[0].value as { phase: string }).phase).toBe('success');
  });

  it('recovers when push fails with sandbox-terminated and re-runs commit + push', async () => {
    seedReviewingState();
    diffUtils.parseDiffStats.mockReturnValue({ fileNames: [] });
    auditor.runAuditor.mockResolvedValue({ verdict: 'safe', card: { summary: '' } });

    // Original sandbox commits fine but its push reports the container is gone;
    // the recovered sandbox (sbx-2) succeeds end-to-end (incl. the pre-push scan).
    dispatchGit({
      override: (id, cmd) =>
        id === 'sbx-1' && cmd.includes("'push'")
          ? { exitCode: -1, stderr: 'Sandbox has been terminated' }
          : undefined,
    });

    const onSandboxExpired = vi.fn().mockResolvedValue('sbx-2');
    const hook = render('sbx-1', 'openrouter', undefined, onSandboxExpired);
    await hook.commitAndPush();

    expect(onSandboxExpired).toHaveBeenCalledOnce();
    expect((reactState.cells[0].value as { phase: string }).phase).toBe('success');
  });

  it('errors out when sandbox dies and no recovery callback is provided', async () => {
    seedReviewingState();
    diffUtils.parseDiffStats.mockReturnValue({ fileNames: [] });
    auditor.runAuditor.mockResolvedValue({ verdict: 'safe', card: { summary: '' } });

    sandboxClient.execInSandbox.mockResolvedValueOnce({
      exitCode: -1,
      stdout: '',
      stderr: '',
      error: 'Sandbox not found or expired',
    });

    const hook = render();
    await hook.commitAndPush();

    expect((reactState.cells[0].value as { phase: string; error: string }).phase).toBe('error');
    expect((reactState.cells[0].value as { phase: string; error: string }).error).toContain(
      'Sandbox expired',
    );
  });

  it('errors out when recovery callback returns null', async () => {
    seedReviewingState();
    diffUtils.parseDiffStats.mockReturnValue({ fileNames: [] });
    auditor.runAuditor.mockResolvedValue({ verdict: 'safe', card: { summary: '' } });

    sandboxClient.execInSandbox.mockResolvedValueOnce({
      exitCode: -1,
      stdout: '',
      stderr: '',
      error: 'Sandbox not found or expired',
    });

    const onSandboxExpired = vi.fn().mockResolvedValue(null);
    const hook = render('sbx-1', 'openrouter', undefined, onSandboxExpired);
    await hook.commitAndPush();

    expect(onSandboxExpired).toHaveBeenCalledOnce();
    expect((reactState.cells[0].value as { phase: string; error: string }).phase).toBe('error');
    expect((reactState.cells[0].value as { phase: string; error: string }).error).toContain(
      'could not be recovered',
    );
  });

  it('does not retry recovery if the new sandbox also dies during commit', async () => {
    seedReviewingState();
    diffUtils.parseDiffStats.mockReturnValue({ fileNames: [] });
    auditor.runAuditor.mockResolvedValue({ verdict: 'safe', card: { summary: '' } });

    sandboxClient.execInSandbox
      // 1: original commit → expired
      .mockResolvedValueOnce({
        exitCode: -1,
        stdout: '',
        stderr: '',
        error: 'Sandbox not found or expired',
      })
      // 2: git apply in new sandbox succeeds
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      // 3: commit in new sandbox → expired again
      .mockResolvedValueOnce({
        exitCode: -1,
        stdout: '',
        stderr: 'Sandbox is no longer running',
      });

    const onSandboxExpired = vi.fn().mockResolvedValue('sbx-2');
    const hook = render('sbx-1', 'openrouter', undefined, onSandboxExpired);
    await hook.commitAndPush();

    expect(onSandboxExpired).toHaveBeenCalledOnce();
    expect((reactState.cells[0].value as { phase: string; error: string }).phase).toBe('error');
  });

  it('refuses recovery when the captured diff was truncated', async () => {
    reactState.cells[0] = {
      value: {
        phase: 'reviewing',
        diff: {
          diff: 'diff --git a/x b/x',
          filesChanged: 1,
          additions: 1,
          deletions: 0,
          truncated: true,
        },
        auditVerdict: null,
        error: null,
        commitMessage: 'fix thing',
      },
    };
    diffUtils.parseDiffStats.mockReturnValue({ fileNames: [] });
    auditor.runAuditor.mockResolvedValue({ verdict: 'safe', card: { summary: '' } });

    sandboxClient.execInSandbox.mockResolvedValueOnce({
      exitCode: -1,
      stdout: '',
      stderr: '',
      error: 'Sandbox not found or expired',
    });

    const onSandboxExpired = vi.fn().mockResolvedValue('sbx-2');
    const hook = render('sbx-1', 'openrouter', undefined, onSandboxExpired);
    await hook.commitAndPush();

    expect(onSandboxExpired).not.toHaveBeenCalled();
    expect(sandboxClient.writeToSandbox).not.toHaveBeenCalled();
    expect((reactState.cells[0].value as { phase: string; error: string }).phase).toBe('error');
    expect((reactState.cells[0].value as { phase: string; error: string }).error).toContain(
      'truncated',
    );
  });

  it('refuses recovery when the captured diff contains binary changes', async () => {
    reactState.cells[0] = {
      value: {
        phase: 'reviewing',
        diff: {
          diff: 'diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n',
          filesChanged: 1,
          additions: 0,
          deletions: 0,
          truncated: false,
        },
        auditVerdict: null,
        error: null,
        commitMessage: 'add image',
      },
    };
    diffUtils.parseDiffStats.mockReturnValue({ fileNames: [] });
    auditor.runAuditor.mockResolvedValue({ verdict: 'safe', card: { summary: '' } });

    sandboxClient.execInSandbox.mockResolvedValueOnce({
      exitCode: -1,
      stdout: '',
      stderr: '',
      error: 'Sandbox not found or expired',
    });

    const onSandboxExpired = vi.fn().mockResolvedValue('sbx-2');
    const hook = render('sbx-1', 'openrouter', undefined, onSandboxExpired);
    await hook.commitAndPush();

    expect(onSandboxExpired).not.toHaveBeenCalled();
    expect((reactState.cells[0].value as { phase: string; error: string }).phase).toBe('error');
    expect((reactState.cells[0].value as { phase: string; error: string }).error).toContain(
      'binary',
    );
  });

  it('surfaces git apply failure when the saved diff cannot be replayed', async () => {
    seedReviewingState();
    diffUtils.parseDiffStats.mockReturnValue({ fileNames: [] });
    auditor.runAuditor.mockResolvedValue({ verdict: 'safe', card: { summary: '' } });

    sandboxClient.execInSandbox
      // 1: original commit → expired
      .mockResolvedValueOnce({
        exitCode: -1,
        stdout: '',
        stderr: '',
        error: 'Sandbox not found or expired',
      })
      // 2: git apply in new sandbox fails (diff conflicts with fresh clone)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'error: patch failed',
      });

    const onSandboxExpired = vi.fn().mockResolvedValue('sbx-2');
    const hook = render('sbx-1', 'openrouter', undefined, onSandboxExpired);
    await hook.commitAndPush();

    expect((reactState.cells[0].value as { phase: string; error: string }).phase).toBe('error');
    expect((reactState.cells[0].value as { phase: string; error: string }).error).toContain(
      'Failed to apply diff',
    );
  });
});
