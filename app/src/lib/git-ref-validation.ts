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

/**
 * A LOCAL branch name under the `origin/` prefix (Push's fixed remote) shadows
 * the remote-tracking namespace: git and JGit both resolve `refs/heads/` before
 * `refs/remotes/`, so a local `refs/heads/origin/x` intercepts lookups of the
 * real `refs/remotes/origin/x`. Pushed-diff base resolution now fully-qualifies
 * its refs so this can't narrow an audited diff, but such a name still has no
 * legitimate use — refuse to CREATE it (this guards branch NAMES only; a
 * start-point ref like `from: origin/main` is a valid, unaffected use).
 */
export function isRemoteTrackingShadowBranchName(name: string): boolean {
  return name.startsWith('origin/');
}
