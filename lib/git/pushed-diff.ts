/**
 * lib/git/pushed-diff.ts — compute the patch series a push will send.
 *
 * The pre-push gates (secret scan + Auditor) must inspect what `git push` will
 * actually upload — the commits on the pushed ref the remote doesn't have yet —
 * not a working-tree preview (capped, and blind to already-committed-but-unpushed
 * history). Crucially this is the per-commit PATCH SERIES (`git log -p`), not the
 * net tree diff: a secret added in one commit and removed in a later one is
 * invisible to `git diff base..HEAD` but is still uploaded with the earlier
 * commit, so the gates must see every commit's patch. Resolved *uncapped*
 * through a typed read source; sandbox/CLI adapt that from `GitExec`, while
 * native adapts it from JGit plugin methods.
 *
 * Base resolution mirrors the push destination (`git push <remote> <ref>`):
 *   1. `refs/remotes/<remote>/<destination-branch>` — the branch the push updates;
 *   2. the merge-base with the default branch's remote-tracking ref — a brand-new
 *      branch (the auto-branch-on-commit case): everything since it forked;
 *   3. no baseline at all (a fresh/empty remote, e.g. `promote_to_github`'s first
 *      push): scan the ref's WHOLE history — every commit is new. This makes "no
 *      baseline" fail *safe* (scan everything) instead of fail-open.
 *
 * Base refs are resolved through the FULLY-QUALIFIED `refs/remotes/<remote>/...`
 * name, never the bare `<remote>/<branch>` shorthand. git and JGit both resolve
 * `refs/heads/` before `refs/remotes/`, so a local branch literally named
 * `origin/<x>` (which ref validation permits) would otherwise shadow the real
 * remote-tracking ref and collapse the audited base onto an attacker-chosen
 * commit — a narrowed diff that ships unaudited commits past the gates.
 *
 * Step 2 prefers the caller-supplied `defaultBranch`'s remote-tracking ref over
 * `<remote>/HEAD`: JGit clones do not create `refs/remotes/<remote>/HEAD`, so
 * relying on it silently drops the native new-branch flow into the step-3
 * whole-history scan (a multi-MB `logPatch` on-device — OOM/ANR, and false
 * secret/Auditor blocks on pre-existing history).
 *
 * Returns `null` only when the read itself fails (e.g. no commits / invalid ref)
 * — the caller (the gate) then fails *open* with a structured log, because that's
 * infra trouble, not a detected secret, and must not brick every push.
 */

import type { GitExec } from './backend.js';
import { resolvePushDestinationFromSource } from './push-destination.js';
import { pushedDiffSourceFromGitExec, type PushedDiffSource } from './pushed-diff-source.js';

export interface PushedDiffOptions {
  ref?: string;
  remote?: string;
  /**
   * Session default branch (short name, e.g. `main`). Used as the fork-point
   * base for a new branch with no remote counterpart, in place of the
   * `<remote>/HEAD` symref that JGit clones don't create.
   */
  defaultBranch?: string;
}

export async function computePushedDiffFromSource(
  source: PushedDiffSource,
  opts?: PushedDiffOptions,
): Promise<string | null> {
  const remote = opts?.remote?.trim() || 'origin';
  const defaultBranch = opts?.defaultBranch?.trim();
  const target = await resolvePushDestinationFromSource(source, opts);
  if (!target.sourceRef) return '';

  // 1. refs/remotes/<remote>/<destination-branch> for the branch this push
  // updates. Fully qualified so a local `refs/heads/<remote>/<branch>` decoy
  // cannot shadow the remote-tracking ref (see the header note).
  let base: string | null = null;
  if (target.branch) {
    const remoteRef = `refs/remotes/${remote}/${target.branch}`;
    if (await source.verifyRef(remoteRef)) base = remoteRef;
  }

  // 2. fork point for a new branch with no remote counterpart. Prefer the known
  // default branch's remote-tracking ref (present in every JGit clone) over
  // <remote>/HEAD (which JGit clones omit), falling back to HEAD for callers
  // that don't supply defaultBranch.
  if (!base) {
    const forkRefs = [
      defaultBranch ? `refs/remotes/${remote}/${defaultBranch}` : null,
      `refs/remotes/${remote}/HEAD`,
    ].filter((ref): ref is string => ref !== null);
    for (const forkRef of forkRefs) {
      if (await source.verifyRef(forkRef)) {
        base = await source.mergeBase(forkRef, target.sourceRef);
        if (base) break;
      }
    }
  }

  // Emit the per-commit PATCH SERIES the push uploads (`git log -p`), NOT the net
  // tree diff (`git diff base..ref`). A secret added in one commit and removed in
  // a later one leaves no trace in the net tree, yet the push still uploads the
  // earlier commit (and its blob); `git log -p` surfaces every commit's patch so
  // the secret-scan and Auditor gates see intermediate states too. Push only ever
  // appends linear commits (`git merge` is blocked; merges are GitHub-PR-only),
  // so there are no local merge commits to need a combined (`--cc`) diff.
  // (Codex P1: audit pushed commit history, not only the final tree.)
  //
  // When no remote baseline resolves (step 1-3 all missed: fresh/empty remote),
  // every commit reachable from the ref is new — scan the whole history (`ref`
  // with no range).
  const range = base ? `${base}..${target.sourceRef}` : target.sourceRef;
  return source.logPatch(range);
}

export function computePushedDiff(exec: GitExec, opts?: PushedDiffOptions): Promise<string | null> {
  return computePushedDiffFromSource(pushedDiffSourceFromGitExec(exec), opts);
}
