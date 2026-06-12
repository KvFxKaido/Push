import { beforeEach, describe, expect, it, vi } from 'vitest';

const sandboxTools = vi.hoisted(() => ({
  executeSandboxToolCall: vi.fn(),
}));

vi.mock('./sandbox-tools', () => sandboxTools);

const { forkBranchInWorkspace, switchBranchInWorkspace } = await import(
  './fork-branch-in-workspace'
);

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
