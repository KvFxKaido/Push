import { beforeEach, describe, expect, it, vi } from 'vitest';

const sandboxClient = vi.hoisted(() => ({
  getSandboxDiff: vi.fn(),
  execInSandbox: vi.fn(),
  readFromSandbox: vi.fn(),
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
}));

const { useCommitPush } = await import('./useCommitPush');

function render(
  sandboxId = 'sbx-1',
  providerOverride: 'openai' | null = 'openai',
  modelOverride?: string | null,
): ReturnType<typeof useCommitPush> {
  reactState.index = 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useCommitPush(sandboxId, providerOverride, modelOverride);
}

beforeEach(() => {
  Object.values(sandboxClient).forEach((m) => m.mockReset());
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
    sandboxClient.execInSandbox
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    const hook = render();
    await hook.commitAndPush();

    const [commitCall, pushCall] = sandboxClient.execInSandbox.mock.calls;
    expect(commitCall[1]).toContain("git commit -m 'fix thing'");
    expect(pushCall[1]).toContain('git push origin HEAD');
    expect((reactState.cells[0].value as { phase: string }).phase).toBe('success');
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
    sandboxClient.execInSandbox
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'rejected (non-fast-forward)',
      });
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
    sandboxClient.execInSandbox
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
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
    sandboxClient.execInSandbox
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const hook = render();
    await hook.commitAndPush();
    expect(sandboxClient.execInSandbox.mock.calls[0][1]).toContain(`'it'"'"'s fine'`);
  });
});
