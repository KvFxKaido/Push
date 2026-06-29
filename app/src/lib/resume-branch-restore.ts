import type { SwitchBranchInWorkspaceResult } from './fork-branch-in-workspace';

type SwitchBranchFromUI = (branch: string) => Promise<SwitchBranchInWorkspaceResult>;

export type ResumeBranchRestoreSurface = 'drawer' | 'launcher';
export type ResumeBranchRestoreResult = 'skipped' | 'switched' | 'failed';

export interface ResumeBranchRestoreInput {
  chatId: string;
  repoFullName: string | null | undefined;
  activeRepoFullName: string | null | undefined;
  savedBranch: string | null | undefined;
  currentBranch: string | null | undefined;
  surface: ResumeBranchRestoreSurface;
  switchBranchFromUI: SwitchBranchFromUI;
}

function describeRestoreFailure(result: SwitchBranchInWorkspaceResult): string {
  if (result.errorMessage) return result.errorMessage;
  if (result.noSandbox) return 'no_sandbox';
  return 'unknown';
}

export function shouldRestoreResumeBranch({
  repoFullName,
  activeRepoFullName,
  savedBranch,
  currentBranch,
}: Pick<
  ResumeBranchRestoreInput,
  'repoFullName' | 'activeRepoFullName' | 'savedBranch' | 'currentBranch'
>): boolean {
  return Boolean(
    repoFullName &&
      activeRepoFullName &&
      repoFullName === activeRepoFullName &&
      savedBranch &&
      savedBranch !== currentBranch,
  );
}

export async function restoreResumeBranchIfNeeded({
  chatId,
  repoFullName,
  activeRepoFullName,
  savedBranch,
  currentBranch,
  surface,
  switchBranchFromUI,
}: ResumeBranchRestoreInput): Promise<ResumeBranchRestoreResult> {
  if (
    !shouldRestoreResumeBranch({ repoFullName, activeRepoFullName, savedBranch, currentBranch })
  ) {
    return 'skipped';
  }

  const result = await switchBranchFromUI(savedBranch as string);
  if (result.ok) return 'switched';

  console.log(
    JSON.stringify({
      level: 'warn',
      event: 'resume_branch_restore_fallback',
      surface,
      chatId,
      repoFullName,
      currentBranch: currentBranch ?? null,
      targetBranch: savedBranch,
      reason: describeRestoreFailure(result),
    }),
  );
  return 'failed';
}
