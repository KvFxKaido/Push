/**
 * lib/git/repo-lock.ts — per-working-copy serialization for git mutations.
 *
 * One git working copy has exactly one index and one HEAD. Two mutations
 * running against it concurrently race on `.git/index.lock` (one fails
 * outright) or, worse, interleave a staging step with someone else's commit
 * and capture the wrong tree. Today the web sandbox is effectively one-op-at-
 * a-time so the race is masked, but the `GitBackend`/`GitExec` seam
 * (`./backend.ts`) is explicitly built so a *second* executor can share a
 * surface — a native libgit2 binding for the Capacitor shell, or two
 * background coder jobs against one sandbox. The moment that lands, nothing
 * serializes them. This module is the prophylactic, mirroring the
 * `*_run_with_lock` queue every git op funnels through in ViscousPot/GitSync's
 * Rust core.
 *
 * ## Scope contract: lock the *working copy*, not the branch
 *
 * The usual durable-key rule (CLAUDE.md "scope keys CLI-first": prefer
 * `repoFullName + branch`) does NOT apply here, and keying by branch would be
 * a correctness bug. A single working copy *outlives* its branch: typed
 * `switch_branch` / `create_branch` preserve the sandbox (`skipBranchTeardownRef`),
 * so the same index is reused across branches, and a branch switch is itself a
 * mutation of that index. Two ops on different branches of the same working
 * copy still race — and a branch switch must serialize against an in-flight
 * commit. So the scope must identify the *working copy*:
 *   - Web: the repo session's sandbox instance (survives branch switches).
 *   - CLI: the absolute path of the local repo working tree.
 * Compose it through {@link gitWorkingCopyLockScope} so git locks can't
 * collide with any other keyed-lock use that lands later.
 *
 * ## Usage contract: wrap a whole logical operation, never a single exec
 *
 * Acquire the lock around the *logical* git operation as a unit — the whole
 * `backend.commit()` (its `add` + `commit`), the whole `switchBranch()` (its
 * fetch-fallback + switch). Do NOT wrap `GitExec` itself: that would
 * acquire/release per `git` invocation, leaving the gap between `add` and
 * `commit` open for another op to interleave — the exact race this guards. The
 * lock is the boundary of an indivisible sequence, not of one process spawn.
 *
 * ## Non-reentrant
 *
 * A task must not call `withRepoLock` again on the same scope from inside its
 * own callback — it would wait for itself (deadlock). Acquire once at the
 * outermost logical boundary.
 */

/** A unit of git work serialized under a scope. Must settle (resolve or reject). */
export type RepoLockTask<T> = () => Promise<T>;

interface Lane {
  /**
   * Holders + waiters currently in this lane. The lane is deleted when this
   * returns to 0 so the map can't grow unbounded across the lifetime of a
   * long-running daemon. Each entry increments on arrival and decrements in
   * its `finally`, so the lane stays alive exactly as long as someone needs it.
   */
  depth: number;
  /**
   * Tail of the promise chain. Awaiting it waits for all work queued ahead of
   * you; each arrival replaces it with its own release promise. The chain is
   * built from release-only promises that are always resolved (never rejected)
   * in a `finally`, so waiting on `tail` can't inherit a prior task's
   * rejection and can't stall on a prior task's throw.
   */
  tail: Promise<void>;
}

const lanes = new Map<string, Lane>();

/**
 * Namespace a working-copy identifier into a git-lock scope key. Keeps git
 * serialization keys from colliding with any other keyed-lock use that shares
 * a registry later. Pass the *working copy* identity (see the scope contract
 * above), e.g. a sandbox/session id on web or an absolute repo path on CLI.
 */
export function gitWorkingCopyLockScope(workingCopyId: string): string {
  return `git-working-copy:${workingCopyId}`;
}

/**
 * Number of working copies with an active or queued git op right now. Zero
 * after every lane drains (the cleanup invariant) — exposed for ops/metrics
 * and to assert no-leak in tests.
 */
export function activeRepoLockCount(): number {
  return lanes.size;
}

/**
 * Run `task` with exclusive access to `scope`, serializing it FIFO against
 * every other call sharing the same scope. Resolves/rejects with whatever
 * `task` does; the lock is released in a `finally` so a throwing task never
 * wedges the lane (the next waiter still runs, and the throwing call still
 * sees its own rejection).
 */
export async function withRepoLock<T>(scope: string, task: RepoLockTask<T>): Promise<T> {
  let lane = lanes.get(scope);
  if (!lane) {
    lane = { depth: 0, tail: Promise.resolve() };
    lanes.set(scope, lane);
  }

  // Contended iff someone else already holds or is waiting in this lane.
  const contended = lane.depth > 0;
  lane.depth++;

  // Capture the current tail (the work ahead of us) and append our own release
  // promise as the new tail — both synchronously, before any await, so FIFO
  // order is fixed by call order and can't be reordered by the scheduler.
  const ahead = lane.tail;
  let release!: () => void;
  lane.tail = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Symmetric structured logs for the only ops-relevant branch: contention.
  // The uncontended path proceeds with no wait and is intentionally silent
  // (logging every acquire would drown the signal). Emit to stderr because
  // this module also runs in the CLI, where stdout is user output / `--json`.
  // `git_repo_lock_wait` (we queued behind someone) pairs with
  // `git_repo_lock_acquired` (the wait ended) so a stalled lane is visible as
  // a wait with no matching acquire.
  const waitStart = contended ? Date.now() : 0;
  if (contended) {
    console.error(
      JSON.stringify({
        level: 'info',
        event: 'git_repo_lock_wait',
        scope,
        queueDepth: lane.depth,
      }),
    );
  }

  await ahead;

  if (contended) {
    console.error(
      JSON.stringify({
        level: 'info',
        event: 'git_repo_lock_acquired',
        scope,
        waitMs: Date.now() - waitStart,
      }),
    );
  }

  try {
    return await task();
  } finally {
    // Hand off to the next waiter, then drop our hold. When the lane drains
    // (no holders, no waiters) delete it — but only if it's still the same
    // lane object, so a fresh lane created after we drained isn't clobbered.
    release();
    lane.depth--;
    if (lane.depth === 0 && lanes.get(scope) === lane) {
      lanes.delete(scope);
    }
  }
}
