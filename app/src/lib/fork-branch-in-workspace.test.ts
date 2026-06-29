import { beforeEach, describe, expect, it, vi } from 'vitest';

const sandboxTools = vi.hoisted(() => ({
  executeSandboxToolCall: vi.fn(),
}));

vi.mock('./sandbox-tools', () => sandboxTools);

const { forkBranchInWorkspace, switchBranchInWorkspace, switchMergedBaseInWorkspace } =
  await import('./fork-branch-in-workspace');

describe('forkBranchInWorkspace', () => {
  beforeEach(() => {
    sandboxTools.executeSandboxToolCall.mockReset();
  });

  it('flags the no-sandbox case so callers can fall back to a plain write', async () => {
    const result = await forkBranchInWorkspace(null, 'feature/warm');

    expect(result).toEqual({
      ok: false,
      noSandbox: true,
      errorMessage: 'No active sandbox — start one before creating a branch.',
    });
    expect(sandboxTools.executeSandboxToolCall).not.toHaveBeenCalled();
  });
});

describe('switchBranchInWorkspace', () => {
  beforeEach(() => {
    sandboxTools.executeSandboxToolCall.mockReset();
  });

  it('requires an active sandbox', async () => {
    const result = await switchBranchInWorkspace(null, 'feature/warm');

    expect(result).toEqual({
      ok: false,
      noSandbox: true,
      errorMessage: 'No active sandbox — start one before switching branches.',
    });
    expect(sandboxTools.executeSandboxToolCall).not.toHaveBeenCalled();
  });

  it('routes through sandbox_switch_branch and returns the branchSwitch payload', async () => {
    const branchSwitch = {
      name: 'feature/warm',
      kind: 'switched' as const,
      previous: 'main',
      source: 'sandbox_switch_branch' as const,
    };
    sandboxTools.executeSandboxToolCall.mockResolvedValue({
      text: '[Tool Result — sandbox_switch_branch]\nSwitched from main to feature/warm.',
      branchSwitch,
    });

    const result = await switchBranchInWorkspace('sb-1', 'feature/warm');

    expect(sandboxTools.executeSandboxToolCall).toHaveBeenCalledWith(
      { tool: 'sandbox_switch_branch', args: { branch: 'feature/warm' } },
      'sb-1',
    );
    expect(result).toEqual({
      ok: true,
      branchSwitch,
      raw: {
        text: '[Tool Result — sandbox_switch_branch]\nSwitched from main to feature/warm.',
        branchSwitch,
      },
    });
  });

  it('prefers structured error text when the switch fails', async () => {
    sandboxTools.executeSandboxToolCall.mockResolvedValue({
      text: '[Tool Error — sandbox_switch_branch]\ncheckout conflict',
      structuredError: {
        type: 'GIT_CONFLICT',
        retryable: false,
        message: 'Branch switch conflict',
        detail: 'src/app.ts would be overwritten',
      },
    });

    const result = await switchBranchInWorkspace('sb-1', 'feature/warm');

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBe('Branch switch conflict — src/app.ts would be overwritten');
  });
});

describe('switchMergedBaseInWorkspace', () => {
  beforeEach(() => {
    sandboxTools.executeSandboxToolCall.mockReset();
  });

  it('requires an active sandbox', async () => {
    const result = await switchMergedBaseInWorkspace(null, 'main');

    expect(result).toEqual({
      ok: false,
      noSandbox: true,
      errorMessage: 'No active sandbox — start one before switching branches.',
    });
    expect(sandboxTools.executeSandboxToolCall).not.toHaveBeenCalled();
  });

  it('switches to the base branch and fast-forwards it from origin', async () => {
    sandboxTools.executeSandboxToolCall
      .mockResolvedValueOnce({
        text: '[Tool Result — sandbox_exec]\nExit code: 0',
        card: {
          type: 'sandbox' as const,
          data: {
            command: 'test -z "$(git status --porcelain)"',
            stdout: '',
            stderr: '',
            exitCode: 0,
            truncated: false,
          },
        },
      })
      .mockResolvedValueOnce({
        text: '[Tool Result — sandbox_switch_branch]\nSwitched from feature/merged to develop.',
        branchSwitch: {
          name: 'develop',
          kind: 'switched' as const,
          previous: 'feature/merged',
          source: 'sandbox_switch_branch' as const,
        },
      })
      .mockResolvedValueOnce({
        text: '[Tool Result — sandbox_exec]\nAlready up to date.',
      });

    const result = await switchMergedBaseInWorkspace('sb-1', 'develop', {
      from: 'feature/merged',
      prNumber: 42,
      source: 'merge_detected',
    });

    expect(sandboxTools.executeSandboxToolCall).toHaveBeenNthCalledWith(
      1,
      {
        tool: 'sandbox_exec',
        args: {
          command:
            'status=$(git status --porcelain) || exit 3; ' +
            '[ -z "$status" ] || { printf \'%s\\n\' "$status"; exit 2; }',
        },
      },
      'sb-1',
    );
    expect(sandboxTools.executeSandboxToolCall).toHaveBeenNthCalledWith(
      2,
      { tool: 'sandbox_switch_branch', args: { branch: 'develop' } },
      'sb-1',
    );
    expect(sandboxTools.executeSandboxToolCall).toHaveBeenNthCalledWith(
      3,
      {
        tool: 'sandbox_exec',
        args: {
          command: "git fetch origin 'develop' && git pull --ff-only origin 'develop'",
          allowDirectGit: true,
        },
      },
      'sb-1',
    );
    expect(result).toEqual({
      ok: true,
      branchSwitch: {
        name: 'develop',
        kind: 'merged',
        from: 'feature/merged',
        prNumber: 42,
        source: 'merge_detected',
      },
      raw: {
        text: '[Tool Result — sandbox_exec]\nAlready up to date.',
      },
    });
  });

  it('blocks the merge follow before switching when the workspace is dirty', async () => {
    sandboxTools.executeSandboxToolCall.mockResolvedValueOnce({
      text: '[Tool Result — sandbox_exec]\nExit code: 2\nStdout:\n M src/app.ts',
      card: {
        type: 'sandbox' as const,
        data: {
          command: 'test -z "$(git status --porcelain)"',
          stdout: ' M src/app.ts\n?? scratch.md\n',
          stderr: '',
          exitCode: 2,
          truncated: false,
        },
      },
    });

    const result = await switchMergedBaseInWorkspace('sb-1', 'main');

    expect(sandboxTools.executeSandboxToolCall).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: false,
      errorMessage: 'Workspace has uncommitted changes: M src/app.ts; ?? scratch.md',
      raw: {
        text: '[Tool Result — sandbox_exec]\nExit code: 2\nStdout:\n M src/app.ts',
        card: {
          type: 'sandbox',
          data: {
            command: 'test -z "$(git status --porcelain)"',
            stdout: ' M src/app.ts\n?? scratch.md\n',
            stderr: '',
            exitCode: 2,
            truncated: false,
          },
        },
      },
    });
  });

  it('fails closed when git status itself errors (exit 3), not masked as clean', async () => {
    // A `git status` failure (corrupt repo / index lock) exits 3 with empty
    // stdout — the probe must treat that as a failure and NOT proceed to switch,
    // and must NOT mislabel it as a dirty tree (dirty-status extraction is
    // gated on exit 2).
    sandboxTools.executeSandboxToolCall.mockResolvedValueOnce({
      text: '[Tool Result — sandbox_exec]\nfatal: not a git repository',
      card: {
        type: 'sandbox' as const,
        data: {
          command: 'status=$(git status --porcelain) || exit 3; ...',
          stdout: '',
          stderr: 'fatal: not a git repository',
          exitCode: 3,
          truncated: false,
        },
      },
    });

    const result = await switchMergedBaseInWorkspace('sb-1', 'main');

    expect(sandboxTools.executeSandboxToolCall).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    // Not the dirty-tree message — the generic tool-error path.
    expect(result.errorMessage).not.toMatch(/uncommitted changes/);
  });

  it('rejects unsafe branch refs before shelling out', async () => {
    const result = await switchMergedBaseInWorkspace('sb-1', 'feature/foo;rm');

    expect(result).toEqual({
      ok: false,
      errorMessage: 'Invalid branch name "feature/foo;rm".',
    });
    expect(sandboxTools.executeSandboxToolCall).not.toHaveBeenCalled();
  });

  it('surfaces FF-only failures while reporting the completed base switch', async () => {
    sandboxTools.executeSandboxToolCall
      .mockResolvedValueOnce({
        text: '[Tool Result — sandbox_exec]\nExit code: 0',
        card: {
          type: 'sandbox' as const,
          data: {
            command: 'test -z "$(git status --porcelain)"',
            stdout: '',
            stderr: '',
            exitCode: 0,
            truncated: false,
          },
        },
      })
      .mockResolvedValueOnce({
        text: '[Tool Result — sandbox_switch_branch]\nSwitched to main.',
        branchSwitch: { name: 'main', kind: 'switched' as const },
      })
      .mockResolvedValueOnce({
        text: '[Tool Error — sandbox_exec]\nNot possible to fast-forward',
        structuredError: {
          type: 'GIT_CONFLICT',
          retryable: false,
          message: 'Fast-forward failed',
          detail: 'origin/main diverged',
        },
      });

    const result = await switchMergedBaseInWorkspace('sb-1', 'main');

    expect(result.ok).toBe(false);
    expect(result.branchSwitch).toEqual({
      name: 'main',
      kind: 'merged',
      source: 'ui-merge',
    });
    expect(result.errorMessage).toBe('Fast-forward failed — origin/main diverged');
  });

  it('treats non-zero FF-only exits as failures even when sandbox_exec returns a normal result', async () => {
    const ffRaw = {
      text: [
        '[Tool Result — sandbox_exec]',
        'Exit code: 1',
        'Stdout:',
        'Your branch and origin/main have diverged.',
        'Stderr:',
        'fatal: Not possible to fast-forward, aborting.',
      ].join('\n'),
      card: {
        type: 'sandbox' as const,
        data: {
          command: "git fetch origin 'main' && git pull --ff-only origin 'main'",
          stdout: 'Your branch and origin/main have diverged.\n',
          stderr: 'fatal: Not possible to fast-forward, aborting.\n',
          exitCode: 1,
          truncated: false,
        },
      },
    };
    sandboxTools.executeSandboxToolCall
      .mockResolvedValueOnce({
        text: '[Tool Result — sandbox_exec]\nExit code: 0',
        card: {
          type: 'sandbox' as const,
          data: {
            command: 'test -z "$(git status --porcelain)"',
            stdout: '',
            stderr: '',
            exitCode: 0,
            truncated: false,
          },
        },
      })
      .mockResolvedValueOnce({
        text: '[Tool Result — sandbox_switch_branch]\nSwitched to main.',
        branchSwitch: { name: 'main', kind: 'switched' as const },
      })
      .mockResolvedValueOnce(ffRaw);

    const result = await switchMergedBaseInWorkspace('sb-1', 'main', {
      from: 'feature/merged',
      prNumber: 42,
      source: 'merge_pr',
    });

    expect(result.ok).toBe(false);
    expect(result.branchSwitch).toEqual({
      name: 'main',
      kind: 'merged',
      from: 'feature/merged',
      prNumber: 42,
      source: 'merge_pr',
    });
    expect(result.errorMessage).toContain('Exit code: 1');
    expect(result.errorMessage).toContain('Not possible to fast-forward');
    expect(result.raw).toBe(ffRaw);
  });
});
