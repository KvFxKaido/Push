import { describe, expect, it, vi } from 'vitest';
import { runCommitSwitchDefaultAction } from './commit-card-branch-actions';

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
