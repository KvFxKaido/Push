import { countGitStatusEntries, type BranchSwitchProbe } from '@/lib/branch-switch-probe';
import type { SwitchBranchInWorkspaceResult } from '@/lib/fork-branch-in-workspace';

type SandboxDiffProbe = (sandboxId: string) => Promise<{ git_status?: string }>;

/**
 * Keep the commit-card "New branch from here" label honest.
 *
 * `BranchForkSheet` forks from the sandbox's current HEAD (a deliberate
 * invariant). The chip stamps the branch the commit landed on, but if the user
 * switched away before opening the sheet, HEAD no longer matches — so surfacing
 * the stamped branch as the fork source would claim a branch the fork won't use.
 * Only return the stamped branch when HEAD is still on it; otherwise return null
 * so the sheet falls back to labeling the actual current branch.
 */
export function resolveCommitForkFromBranch(
  stampedBranch: string | undefined,
  currentHead: string | undefined,
): string | null {
  return stampedBranch && currentHead && stampedBranch === currentHead ? stampedBranch : null;
}

interface CommitSwitchConfirmActionArgs {
  branch: string;
  sandboxId: string | null;
  /** Cold-switch primitive (the hub's `onSwitchBranch`): updates the tracked
   *  branch without a running sandbox so the next start opens it. */
  setCurrentBranch: (branch: string) => void;
  switchBranchFromUI: (branch: string) => Promise<SwitchBranchInWorkspaceResult>;
  onError: (message: string) => void;
  onDone: () => void;
}

/**
 * Confirm handler for the commit-card "Switch to default" dialog.
 *
 * No sandbox → cold switch: update the tracked branch (mirrors the hub's
 * `confirmBranchSwitch` fallback to `cleanSwitchBranch`) so the next sandbox
 * start opens it — exactly what the no-sandbox confirm copy promises. Without
 * this the path dead-ends on `switchBranchInWorkspace(null, ...)`'s "No active
 * sandbox" error. With a sandbox → warm switch through the governed helper.
 */
export async function runCommitSwitchConfirmAction({
  branch,
  sandboxId,
  setCurrentBranch,
  switchBranchFromUI,
  onError,
  onDone,
}: CommitSwitchConfirmActionArgs): Promise<void> {
  if (!sandboxId) {
    setCurrentBranch(branch);
    onDone();
    return;
  }

  const result = await switchBranchFromUI(branch);
  if (!result.ok) {
    onError(result.errorMessage || 'Failed to switch branches.');
    return;
  }
  onDone();
}

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
