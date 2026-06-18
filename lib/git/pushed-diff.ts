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
 * Base resolution, most-specific first:
 *   1. the ref's upstream (`@{upstream}`) — the normal tracked-branch case;
 *   2. `origin/<branch>` — an existing remote branch with no local upstream set;
 *   3. the merge-base with `origin/HEAD` — a brand-new branch (the
 *      auto-branch-on-commit case): everything since it forked from the default.
 *   4. no baseline at all (a fresh/empty remote, e.g. `promote_to_github`'s first
 *      push): scan the ref's WHOLE history — every commit is new. This makes "no
 *      baseline" fail *safe* (scan everything) instead of fail-open.
 *
 * Returns `null` only when the read itself fails (e.g. no commits / invalid ref)
 * — the caller (the gate) then fails *open* with a structured log, because that's
 * infra trouble, not a detected secret, and must not brick every push.
 */

import type { GitExec } from './backend.js';

async function ok(exec: GitExec, args: string[]): Promise<string | null> {
  const res = await exec(args);
  if (res.exitCode !== 0) return null;
  const out = res.stdout.trim();
  return out || null;
}

export async function computePushedDiff(
  exec: GitExec,
  opts?: { ref?: string },
): Promise<string | null> {
  const ref = opts?.ref?.trim() || 'HEAD';

  // 1. upstream of the ref being pushed
  let base = await ok(exec, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    `${ref}@{upstream}`,
  ]);

  // 2. origin/<branch> for the ref's branch name
  if (!base) {
    const branch = ref === 'HEAD' ? await ok(exec, ['branch', '--show-current']) : ref;
    if (branch) {
      const remoteRef = `origin/${branch}`;
      if (await ok(exec, ['rev-parse', '--verify', '--quiet', remoteRef])) base = remoteRef;
    }
  }

  // 3. fork point from origin/HEAD (a new branch with no remote counterpart)
  if (!base) {
    if (await ok(exec, ['rev-parse', '--verify', '--quiet', 'origin/HEAD'])) {
      base = await ok(exec, ['merge-base', 'origin/HEAD', ref]);
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
  const range = base ? [`${base}..${ref}`] : [ref];
  const res = await exec(['log', '-p', '--no-color', ...range]);
  if (res.exitCode !== 0) return null;
  return res.stdout;
}
