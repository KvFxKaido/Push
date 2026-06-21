/**
 * lib/git/pushed-diff.ts — compute the patch series a push will send.
 *
 * The pre-push gates (secret scan + Auditor) must inspect what `git push` will
 * actually upload — the commits on the pushed ref the remote doesn't have yet —
 * not a working-tree preview (capped, and blind to already-committed-but-unpushed
 * history). Crucially this is the per-commit PATCH SERIES (`git log -p`), not the
 * net tree diff: a secret added in one commit and removed in a later one is
 * invisible to `git diff base..HEAD` but is still uploaded with the earlier
 * commit, so the gates must see every commit's patch. Resolved *uncapped* through
 * the same `GitExec` port the backend uses, so it works on every surface.
 *
 * Base resolution mirrors the push destination (`git push <remote> <ref>`):
 *   1. `<remote>/<destination-branch>` — the branch the push updates;
 *   2. the merge-base with `<remote>/HEAD` — a brand-new branch (the
 *      auto-branch-on-commit case): everything since it forked from the default;
 *   3. no baseline at all (a fresh/empty remote, e.g. `promote_to_github`'s first
 *      push): scan the ref's WHOLE history — every commit is new. This makes "no
 *      baseline" fail *safe* (scan everything) instead of fail-open.
 *
 * Returns `null` only when the read itself fails (e.g. no commits / invalid ref)
 * — the caller (the gate) then fails *open* with a structured log, because that's
 * infra trouble, not a detected secret, and must not brick every push.
 */

import type { GitExec } from './backend.js';
import { resolvePushDestination } from './push-destination.js';

export interface PushedDiffOptions {
  ref?: string;
  remote?: string;
}

async function ok(exec: GitExec, args: string[]): Promise<string | null> {
  const res = await exec(args);
  if (res.exitCode !== 0) return null;
  const out = res.stdout.trim();
  return out || null;
}

export async function computePushedDiff(
  exec: GitExec,
  opts?: PushedDiffOptions,
): Promise<string | null> {
  const remote = opts?.remote?.trim() || 'origin';
  const target = await resolvePushDestination(exec, opts);
  if (!target.sourceRef) return '';

  // 1. <remote>/<destination-branch> for the branch this push updates.
  let base: string | null = null;
  if (target.branch) {
    const remoteRef = `${remote}/${target.branch}`;
    if (await ok(exec, ['rev-parse', '--verify', '--quiet', remoteRef])) base = remoteRef;
  }

  // 2. fork point from <remote>/HEAD (a new branch with no remote counterpart).
  if (!base) {
    const remoteHead = `${remote}/HEAD`;
    if (await ok(exec, ['rev-parse', '--verify', '--quiet', remoteHead])) {
      base = await ok(exec, ['merge-base', remoteHead, target.sourceRef]);
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
  const range = base ? [`${base}..${target.sourceRef}`] : [target.sourceRef];
  const res = await exec(['log', '-p', '--no-color', ...range]);
  if (res.exitCode !== 0) return null;
  return res.stdout;
}
