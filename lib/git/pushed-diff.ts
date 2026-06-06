/**
 * lib/git/pushed-diff.ts — compute the diff of the commits a push will send.
 *
 * The pre-push secret scan must inspect what `git push` will actually upload —
 * the commits on the pushed ref that the remote doesn't have yet — not a
 * working-tree preview (which is capped, and misses already-committed-but-
 * unpushed secrets in branch history). This resolves that *uncapped* diff
 * through the same `GitExec` port the backend uses, so it works on every
 * surface.
 *
 * Base resolution, most-specific first:
 *   1. the ref's upstream (`@{upstream}`) — the normal tracked-branch case;
 *   2. `origin/<branch>` — an existing remote branch with no local upstream set;
 *   3. the merge-base with `origin/HEAD` — a brand-new branch (the
 *      auto-branch-on-commit case): everything since it forked from the default.
 *   4. the empty tree — a remote with no baseline at all (a fresh/empty repo,
 *      e.g. `promote_to_github`'s first push): every commit on HEAD is new, so
 *      scan the whole tree rather than skip. This makes "no baseline" fail
 *      *safe* (scan everything) instead of fail-open.
 *
 * Returns `null` only when the diff read itself fails (e.g. no commits / invalid
 * ref) — the caller (the gate) then fails *open* with a structured log, because
 * that's infra trouble, not a detected secret, and must not brick every push.
 */

import type { GitExec } from './backend.js';

// Git's canonical empty-tree object (stable for SHA-1 repos). `git diff
// <empty-tree>..HEAD` yields the full tree as additions — used when the remote
// has no baseline to diff against.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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

  // 4. no remote baseline at all → diff the full tree against the empty tree.
  if (!base) base = EMPTY_TREE_SHA;

  const res = await exec(['diff', '--no-color', `${base}..${ref}`]);
  if (res.exitCode !== 0) return null;
  return res.stdout;
}
