/**
 * Normalize a model-supplied branch argument to a plain local branch name.
 *
 * Models routinely copy branch names out of `git branch -a` / `git branch -r`
 * output, which spells remote branches as `remotes/origin/x` or `origin/x` —
 * neither of which is a switchable branch name, and the `remotes/…` form makes
 * the shallow-clone fetch fallback ask the remote for a ref literally named
 * `remotes/origin/x` ("couldn't find remote ref"). Push's remote is fixed at
 * `origin`, and both surfaces refuse to CREATE a local branch named `origin/x`
 * (see {@link isRemoteTrackingShadowBranchName}) — but the CLI opens arbitrary
 * repos that may already contain one, so its switch handler checks for an
 * exact local match BEFORE stripping (the #1570 review finding). One prefix
 * only — no loop-until-stable, so a pathological `origin/origin/x` still
 * surfaces rather than silently rewriting.
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

/**
 * A LOCAL branch name under the `origin/` prefix (Push's fixed remote) shadows
 * the remote-tracking namespace: git and JGit both resolve `refs/heads/` before
 * `refs/remotes/`, so a local `refs/heads/origin/x` intercepts lookups of the
 * real `refs/remotes/origin/x` — and it collides with the `origin/x` input
 * spelling {@link normalizeBranchInput} exists to accept. Such a name has no
 * legitimate use; refuse to CREATE it on every surface (this guards branch
 * NAMES only — a start-point ref like `from: origin/main` is a valid,
 * unaffected use). Promoted from the web-only guard when the CLI became the
 * second surface needing it.
 */
export function isRemoteTrackingShadowBranchName(name: string): boolean {
  return name.startsWith('origin/');
}
