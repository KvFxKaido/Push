import { describe, expect, it, vi } from 'vitest';
import {
  runCommitSwitchConfirmAction,
  runCommitSwitchDefaultAction,
} from './commit-card-branch-actions';

describe('runCommitSwitchConfirmAction', () => {
  it('cold-switches via setCurrentBranch when there is no sandbox', async () => {
    const setCurrentBranch = vi.fn();
    const switchBranchFromUI = vi.fn(async () => ({ ok: true as const }));
    const onDone = vi.fn();
    const onError = vi.fn();

    await runCommitSwitchConfirmAction({
      branch: 'main',
      sandboxId: null,
      setCurrentBranch,
      switchBranchFromUI,
      onError,
      onDone,
    });

    // No dead-end: the tracked branch updates so the next start opens it,
    // instead of switchBranchInWorkspace(null, ...) erroring.
    expect(setCurrentBranch).toHaveBeenCalledWith('main');
    expect(switchBranchFromUI).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('warm-switches through switchBranchFromUI when a sandbox is running', async () => {
    const setCurrentBranch = vi.fn();
    const switchBranchFromUI = vi.fn(async () => ({ ok: true as const }));
    const onDone = vi.fn();

    await runCommitSwitchConfirmAction({
      branch: 'main',
      sandboxId: 'sb-1',
      setCurrentBranch,
      switchBranchFromUI,
      onError: vi.fn(),
      onDone,
    });

    expect(switchBranchFromUI).toHaveBeenCalledWith('main');
    expect(setCurrentBranch).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('surfaces the error and stays open when the warm switch fails', async () => {
    const onError = vi.fn();
    const onDone = vi.fn();

    await runCommitSwitchConfirmAction({
      branch: 'main',
      sandboxId: 'sb-1',
      setCurrentBranch: vi.fn(),
      switchBranchFromUI: vi.fn(async () => ({ ok: false as const, errorMessage: 'boom' })),
      onError,
      onDone,
    });

    expect(onError).toHaveBeenCalledWith('boom');
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('runCommitSwitchDefaultAction', () => {
  it('switches directly when the post-commit probe is clean', async () => {
    const switchBranchFromUI = vi.fn(async () => ({ ok: true as const }));
    const openConfirm = vi.fn();

    await runCommitSwitchDefaultAction({
      targetBranch: 'main',
      sandboxId: 'sb-1',
      getSandboxDiff: vi.fn(async () => ({ git_status: '' })),
      switchBranchFromUI,
      openConfirm,
    });

    expect(switchBranchFromUI).toHaveBeenCalledWith('main');
    expect(openConfirm).not.toHaveBeenCalled();
  });

  it('opens the state-aware confirm instead of switching when the tree is dirty', async () => {
    const switchBranchFromUI = vi.fn(async () => ({ ok: true as const }));
    const openConfirm = vi.fn();

    await runCommitSwitchDefaultAction({
      targetBranch: 'main',
      sandboxId: 'sb-1',
      getSandboxDiff: vi.fn(async () => ({ git_status: ' M app/src/file.ts\n?? scratch.txt\n' })),
      switchBranchFromUI,
      openConfirm,
    });

    expect(switchBranchFromUI).not.toHaveBeenCalled();
    expect(openConfirm).toHaveBeenCalledWith('main', {
      branch: 'main',
      loading: false,
      dirty: true,
      changedFiles: 2,
      unknown: false,
      noSandbox: false,
    });
  });

  it('treats an unknown probe as dirty and opens the confirm', async () => {
    const switchBranchFromUI = vi.fn(async () => ({ ok: true as const }));
    const openConfirm = vi.fn();

    await runCommitSwitchDefaultAction({
      targetBranch: 'main',
      sandboxId: 'sb-1',
      getSandboxDiff: vi.fn(async () => ({})),
      switchBranchFromUI,
      openConfirm,
    });

    expect(switchBranchFromUI).not.toHaveBeenCalled();
    expect(openConfirm).toHaveBeenCalledWith('main', {
      branch: 'main',
      loading: false,
      dirty: true,
      changedFiles: 0,
      unknown: true,
      noSandbox: false,
    });
  });
});
