/**
 * Normalize a model-supplied branch argument to a plain local branch name.
 *
 * Models routinely copy branch names out of `git branch -a` / `git branch -r`
 * output, which spells remote branches as `remotes/origin/x` or `origin/x` —
 * neither of which is a switchable branch name, and the `remotes/…` form makes
 * the shallow-clone fetch fallback ask the remote for a ref literally named
 * `remotes/origin/x` ("couldn't find remote ref"). Push's remote is fixed at
 * `origin`, and a LOCAL branch named `origin/x` is already refused at creation
 * (see `isRemoteTrackingShadowBranchName`), so stripping these prefixes can't
 * collide with a legitimate name. One prefix only — no loop-until-stable, so a
 * pathological `origin/origin/x` still surfaces rather than silently rewriting.
 */
const REMOTE_BRANCH_PREFIXES = [
  'refs/remotes/origin/',
  'remotes/origin/',
  'refs/heads/',
  'origin/',
];

export function normalizeBranchInput(raw: string): string {
  const trimmed = raw.trim();
  for (const prefix of REMOTE_BRANCH_PREFIXES) {
    if (trimmed.length > prefix.length && trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return trimmed;
}
