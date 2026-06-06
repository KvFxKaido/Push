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
 *
 * Returns `null` when no base can be resolved or the diff read fails — the
 * caller (the gate) then fails *open* with a structured log, because an inability
 * to scope the diff is infra trouble, not a detected secret, and must not brick
 * every push.
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

  if (!base) return null;

  const res = await exec(['diff', '--no-color', `${base}..${ref}`]);
  if (res.exitCode !== 0) return null;
  return res.stdout;
}
