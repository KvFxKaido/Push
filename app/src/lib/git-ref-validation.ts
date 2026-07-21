const VALID_GIT_REF = /^[A-Za-z0-9._/-]+$/;

export const GIT_REF_VALIDATION_DETAIL =
  'Branch refs may contain letters, digits, ".", "_", "/", "-" and may not start with "-", may not start or end with "/", and may not contain "..".';

export function isInvalidGitRef(ref: string): boolean {
  return (
    !VALID_GIT_REF.test(ref) ||
    ref.startsWith('-') ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.includes('..')
  );
}

// Promoted to lib when the CLI became the second surface refusing shadow
// names (#1570 review follow-up); re-exported to keep this module's API
// stable. Pushed-diff base resolution also fully-qualifies its refs, so a
// pre-existing shadow branch can't narrow an audited diff.
export { isRemoteTrackingShadowBranchName } from '@push/lib/git/branch-input';
