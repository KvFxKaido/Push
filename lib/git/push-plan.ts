/**
 * lib/git/push-plan.ts — a ref-only, side-effect-free preview of what the next
 * `git push` would do, plus the force-with-lease value that pins it.
 *
 * Inspired by `entireio/git-sync`'s `plan` step: before the mutation, do a cheap
 * ref-only round-trip and classify the move (create / fast-forward / force /
 * skip) so the destructive case is a *named, blockable* condition instead of an
 * opaque downstream rejection. Push only ever fast-forwards a single branch (it
 * never passes `--force`, and `git merge`/rebase are policy-blocked), so a
 * diverged remote is a real reconcile-via-PR situation the agent must be told
 * about, not retried into.
 *
 * Two distinct things live here, sharing one remote-tip read:
 *   1. **Classification** (`PushPlan.move.kind`) — drives the prepare-time force
 *      guard and the review-card summary.
 *   2. **The lease** (`PushPlan.leasedRemoteSha`) — origin's LIVE tip for the
 *      pushed branch, read via `ls-remote` (NOT the possibly-stale local
 *      `origin/<branch>` mirror that `computePushedDiff` bases its diff on).
 *      Pinning it at audit time and re-reading it at approval closes the window
 *      where the remote advances between review and push: the audited diff was
 *      computed against one base, and shipping it onto a moved remote either
 *      gets rejected by git (non-fast-forward) or — worse — would need a
 *      reconcile whose result was never audited. `git-sync` calls this
 *      `--force-with-lease`; here it's the staleness sibling of the existing
 *      `auditedRemoteUrl` pin.
 *
 * Read-only and deterministic: every call is a `rev-parse` / `ls-remote` /
 * `merge-base` / `rev-list`, no writes, no `mutates` hint. Resolved through the
 * same `GitExec` port the backend uses, so it works on every surface.
 */

import type { GitExec } from './backend.js';
import { resolvePushDestinationFromSource } from './push-destination.js';
import { pushedDiffSourceFromGitExec, type PushedDiffSource } from './pushed-diff-source.js';

/**
 * Git's all-zero object id — the conventional "this ref does not exist" sentinel
 * (push certificates, the update hook's `<oldvalue>`). Used to encode a `create`
 * lease (no remote branch yet) as a concrete pinnable string, so "audited a
 * create" is distinguishable from "no lease was pinned" at the approval check.
 */
export const ZERO_OID = '0000000000000000000000000000000000000000';

export type RefMoveKind =
  /** No branch on origin yet — the push creates it. */
  | 'create'
  /** Origin's tip is an ancestor of the local tip — a clean fast-forward. */
  | 'fast-forward'
  /** Local has diverged from origin — would require a force-push (PROVEN). */
  | 'force'
  /** Origin is already at the local tip — nothing to push. */
  | 'skip'
  /**
   * Ancestry couldn't be determined: origin was unreadable (network), or its
   * tip isn't present locally (stale mirror — fetch to compare). Deliberately
   * NOT treated as a force: git's own non-fast-forward rejection remains the
   * backstop, so this must not block a legitimate push on an unread remote.
   */
  | 'unknown';

export interface RefMove {
  /** Branch short name the push updates, or null when it can't be resolved. */
  branch: string | null;
  kind: RefMoveKind;
  /** Local tip being pushed (HEAD or the resolved ref), or null on read error. */
  localSha: string | null;
  /** Origin's live tip for `branch` (the lease), or null when absent/unread. */
  remoteSha: string | null;
  /** Commits the local tip has beyond origin, or null when not computable. */
  ahead: number | null;
  /** Commits origin has beyond the local tip, or null when not computable. */
  behind: number | null;
  /** Human-readable explanation, mirroring git-sync's per-ref `reason`. */
  reason: string;
}

export interface PushPlan {
  move: RefMove;
  /**
   * The force-with-lease value: origin's live tip for the pushed branch when the
   * plan was computed (`ZERO_OID` for a create). Meaningful only when
   * `leaseEstablished` — otherwise the remote couldn't be read and no lease can
   * be pinned. Callers pin this at audit time and compare it to a fresh read at
   * approval; a mismatch means the remote moved.
   */
  leasedRemoteSha: string | null;
  /** True only when origin's tip was actually read (so the lease is pinnable). */
  leaseEstablished: boolean;
  /** True only when divergence is PROVEN (origin tip is not an ancestor). */
  requiresForce: boolean;
}

export interface RemoteHeadRead {
  /** False means the remote could not be read; true with sha null means absent branch. */
  ok: boolean;
  sha: string | null;
}

export interface RevListCounts {
  behind: number;
  ahead: number;
}

export interface PushPlanSource extends PushedDiffSource {
  /** Live remote branch tip, not the local remote-tracking mirror. */
  lsRemoteHead(remote: string, branch: string): Promise<RemoteHeadRead>;
  /** True when `ancestor` is reachable from `descendant`; null when unreadable. */
  isAncestor?(ancestor: string, descendant: string): Promise<boolean | null>;
  /** Best-effort ahead/behind counts for `<left>...<right>`. */
  revListLeftRightCount?(range: string): Promise<RevListCounts | null>;
}

type LogLevel = 'info' | 'warn' | 'error';
type LogFn = (level: LogLevel, event: string, ctx: Record<string, unknown>) => void;

const defaultLog: LogFn = (level, event, ctx) => {
  console.log(JSON.stringify({ level, event, ...ctx }));
};

/** Run an arg vector, returning trimmed stdout on exit 0, else null. */
async function read(exec: GitExec, args: string[]): Promise<string | null> {
  const res = await exec(args);
  if (res.exitCode !== 0) return null;
  return res.stdout.trim() || null;
}

export function pushPlanSourceFromGitExec(exec: GitExec): PushPlanSource {
  return {
    ...pushedDiffSourceFromGitExec(exec),
    async lsRemoteHead(remote, branch) {
      const res = await exec(['ls-remote', remote, `refs/heads/${branch}`]);
      if (res.exitCode !== 0) return { ok: false, sha: null };
      const firstLine = res.stdout.trim().split('\n')[0]?.trim() ?? '';
      return { ok: true, sha: firstLine ? firstLine.split(/\s+/)[0] || null : null };
    },
    async isAncestor(ancestor, descendant) {
      const res = await exec(['merge-base', '--is-ancestor', ancestor, descendant]);
      if (res.exitCode === 0) return true;
      if (res.exitCode === 1) return false;
      return null;
    },
    async revListLeftRightCount(range) {
      const counts = await read(exec, ['rev-list', '--left-right', '--count', range]);
      if (!counts) return null;
      const [behind, ahead] = counts.split(/\s+/).map((n) => Number.parseInt(n, 10));
      return Number.isFinite(behind) && Number.isFinite(ahead) ? { behind, ahead } : null;
    },
  };
}

/**
 * Compute the push plan for `ref` (default HEAD) against `remote` (default
 * origin). Pure preview — see the file header for the lease/classification split.
 * Emits one structured log line keyed to the resolved `kind` so ops can tell a
 * create from a fast-forward from a blocked divergence (CLAUDE.md: symmetric
 * logs on every observably-distinct branch).
 */
export async function computePushPlan(
  exec: GitExec,
  opts?: { ref?: string; remote?: string; log?: LogFn },
): Promise<PushPlan> {
  return computePushPlanFromSource(pushPlanSourceFromGitExec(exec), opts);
}

export async function computePushPlanFromSource(
  source: PushPlanSource,
  opts?: { ref?: string; remote?: string; log?: LogFn },
): Promise<PushPlan> {
  const log = opts?.log ?? defaultLog;
  const remote = opts?.remote ?? 'origin';
  const ref = opts?.ref?.trim() || 'HEAD';

  const target = await resolvePushDestinationFromSource(source, { ref });
  const branch = target.branch;
  const localSha = target.sourceRef ? await source.verifyRef(target.sourceRef) : null;

  // Live remote tip via ls-remote (NOT the local origin/<branch> mirror). Exit 0
  // with empty output means the branch truly doesn't exist on origin (a create);
  // a non-zero exit means the remote couldn't be read (network/auth) — distinct
  // states the lease must not conflate.
  let remoteSha: string | null = null;
  let remoteReadOk = false;
  if (branch) {
    const remoteHead = await source.lsRemoteHead(remote, branch);
    remoteReadOk = remoteHead.ok;
    remoteSha = remoteHead.sha;
  }

  let kind: RefMoveKind;
  let requiresForce = false;
  let reason: string;

  if (!branch) {
    kind = 'unknown';
    reason = 'could not resolve the branch to push';
  } else if (!remoteReadOk) {
    kind = 'unknown';
    reason = 'could not read origin; git will reject a non-fast-forward at push';
  } else if (remoteSha === null) {
    kind = 'create';
    reason = `branch "${branch}" does not exist on ${remote} yet`;
  } else if (localSha && remoteSha === localSha) {
    kind = 'skip';
    reason = `${remote}/${branch} is already at this commit`;
  } else {
    // Ancestry: is origin's tip reachable from the local tip? exit 0 = ancestor
    // (fast-forward), exit 1 = not an ancestor (proven divergence → force), any
    // other exit = origin's object isn't present locally (stale mirror) so we
    // can't classify — stay `unknown` rather than misreport a force.
    const anc = target.sourceRef
      ? await resolveAncestry(source, remoteSha, target.sourceRef)
      : null;
    if (anc === true) {
      kind = 'fast-forward';
      reason = `fast-forward over ${remote}/${branch}`;
    } else if (anc === false) {
      kind = 'force';
      requiresForce = true;
      reason = `local "${branch}" has diverged from ${remote}/${branch} (would require a force-push)`;
    } else {
      kind = 'unknown';
      reason = `${remote}/${branch} tip is not present locally; fetch to compare`;
    }
  }

  // Best-effort ahead/behind; only meaningful when both tips are local objects.
  let ahead: number | null = null;
  let behind: number | null = null;
  if (
    source.revListLeftRightCount &&
    target.sourceRef &&
    localSha &&
    remoteSha &&
    remoteSha !== localSha
  ) {
    const counts = await source.revListLeftRightCount(`${remoteSha}...${target.sourceRef}`);
    if (counts) {
      behind = counts.behind;
      ahead = counts.ahead;
    }
  }

  const move: RefMove = { branch, kind, localSha, remoteSha, ahead, behind, reason };
  const plan: PushPlan = {
    move,
    // A create pins ZERO_OID so "audited a create" stays distinguishable from an
    // absent pin at the approval check.
    leasedRemoteSha: remoteReadOk ? (remoteSha ?? ZERO_OID) : null,
    leaseEstablished: remoteReadOk,
    requiresForce,
  };

  log(requiresForce ? 'warn' : 'info', `push_plan_${kind}`, {
    branch,
    ahead,
    behind,
    leaseEstablished: plan.leaseEstablished,
  });

  return plan;
}

async function resolveAncestry(
  source: PushPlanSource,
  ancestor: string,
  descendant: string,
): Promise<boolean | null> {
  if (source.isAncestor) return source.isAncestor(ancestor, descendant);
  // Fallback for sources without a native `--is-ancestor` (JGit): compare the
  // merge-base to the ancestor. A null merge-base is ambiguous here — it means
  // EITHER genuinely-unrelated histories OR a transient read failure (the
  // native source maps a thrown bridge/JGit error to null) — and this branch is
  // only reached when the ancestor tip is already present locally, so a normal
  // divergence would still have a common base. Return `unknown` (not `force`):
  // per this file's doctrine an unproven state must not block, and git's own
  // non-fast-forward rejection remains the backstop. Treating null as a proven
  // force would surface a spurious "diverged — open a PR" block on a flaky
  // bridge.
  const resolvedAncestor = await source.verifyRef(ancestor);
  if (!resolvedAncestor) return null;
  const base = await source.mergeBase(ancestor, descendant);
  if (!base) return null;
  return base === resolvedAncestor || base === ancestor;
}
