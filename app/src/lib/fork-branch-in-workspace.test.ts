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
          command: 'test -z "$(git status --porcelain)" || { git status --short; exit 2; }',
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
});
