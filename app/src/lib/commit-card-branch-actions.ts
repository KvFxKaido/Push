import { countGitStatusEntries, type BranchSwitchProbe } from '@/lib/branch-switch-probe';
import type { SwitchBranchInWorkspaceResult } from '@/lib/fork-branch-in-workspace';

type SandboxDiffProbe = (sandboxId: string) => Promise<{ git_status?: string }>;

interface CommitSwitchDefaultActionArgs {
  targetBranch: string;
  sandboxId: string | null;
  getSandboxDiff: SandboxDiffProbe;
  switchBranchFromUI: (branch: string) => Promise<SwitchBranchInWorkspaceResult>;
  openConfirm: (branch: string, probe: BranchSwitchProbe) => void;
  onSwitchError?: (message: string) => void;
}

export async function runCommitSwitchDefaultAction({
  targetBranch,
  sandboxId,
  getSandboxDiff,
  switchBranchFromUI,
  openConfirm,
  onSwitchError,
}: CommitSwitchDefaultActionArgs): Promise<void> {
  if (!sandboxId) {
    openConfirm(targetBranch, {
      branch: targetBranch,
      loading: false,
      dirty: true,
      changedFiles: 0,
      unknown: true,
      noSandbox: true,
    });
    return;
  }

  try {
    const diffResult = await getSandboxDiff(sandboxId);
    const status = diffResult.git_status;
    const unknown = typeof status !== 'string';
    const changedFiles = countGitStatusEntries(status);
    if (!unknown && changedFiles === 0) {
      const result = await switchBranchFromUI(targetBranch);
      if (!result.ok) {
        onSwitchError?.(result.errorMessage || 'Failed to switch branches.');
      }
      return;
    }

    openConfirm(targetBranch, {
      branch: targetBranch,
      loading: false,
      dirty: true,
      changedFiles,
      unknown,
      noSandbox: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to inspect sandbox changes.';
    openConfirm(targetBranch, {
      branch: targetBranch,
      loading: false,
      dirty: true,
      changedFiles: 0,
      unknown: true,
      noSandbox: false,
      errorMessage: message,
    });
  }
}
