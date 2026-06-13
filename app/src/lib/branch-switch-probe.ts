export interface BranchSwitchProbe {
  branch: string;
  loading: boolean;
  dirty: boolean;
  changedFiles: number;
  unknown: boolean;
  noSandbox: boolean;
  errorMessage?: string;
}

export function countGitStatusEntries(gitStatus: string | undefined): number {
  if (typeof gitStatus !== 'string') return 0;
  return gitStatus
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean).length;
}
