/**
 * Shared builders + reducer for live workspace-state events
 * (`workspace.state_snapshot` / `workspace.state_delta`).
 *
 * This module is surface-agnostic on purpose. The web shell wires it through
 * `useWorkspaceSandboxController.ts` (which already owns sandbox lifecycle and
 * the desync guard) as the first adapter; the CLI daemon can emit the same
 * vocabulary later without importing any React-shaped assumptions. Keep every
 * function here pure or closure-local — no DOM, no hook state, no `window`.
 *
 * The event shapes live in `lib/runtime-contract.ts` (`WorkspaceState`,
 * `WorkspaceStateDeltaOp`, and the two `RunEventInput` union members). The
 * strict wire validators live in `lib/protocol-schema.ts`. This module is the
 * behavior: how a producer turns two states into a minimal delta, and how a
 * consumer folds snapshots + deltas into a current view while dropping any
 * delta whose base it can't prove.
 *
 * Structured logs go to `console.error`, not `console.log`: this module also
 * runs on the CLI, where stdout is reserved for user output / `--json`
 * payloads (see `lib/git/repo-lock.ts`, `lib/context-memory.ts`). Shape is the
 * canonical `{ level, event, ...ctx }` one-line-per-branch form. Event names
 * pair semantically: `..._snapshot_adopted` ↔ `..._delta_applied` ↔
 * `..._delta_dropped` (the loud path AND the three silent-drop paths).
 */

import type { GitStatusEntry, GitStatusInfo } from './git/status.js';
import type {
  WorkspaceDirtyFile,
  WorkspaceDirtyStatus,
  WorkspaceState,
  WorkspaceStateDeltaOp,
} from './runtime-contract.js';

// ---------------------------------------------------------------------------
// Event shapes (structural mirrors of the RunEventInput union members)
// ---------------------------------------------------------------------------

export interface WorkspaceStateSnapshotEvent {
  type: 'workspace.state_snapshot';
  workspaceId: string;
  rev: number;
  state: WorkspaceState;
}

export interface WorkspaceStateDeltaEvent {
  type: 'workspace.state_delta';
  workspaceId: string;
  rev: number;
  baseRev: number;
  ops: WorkspaceStateDeltaOp[];
}

export type WorkspaceStateEvent = WorkspaceStateSnapshotEvent | WorkspaceStateDeltaEvent;

// ---------------------------------------------------------------------------
// Pure state helpers
// ---------------------------------------------------------------------------

function cloneState(state: WorkspaceState): WorkspaceState {
  return {
    activeBranch: state.activeBranch,
    headSha: state.headSha,
    ahead: state.ahead,
    behind: state.behind,
    dirtyFiles: state.dirtyFiles.map((f) => ({ ...f })),
    protectMain: state.protectMain,
    sandboxReady: state.sandboxReady,
  };
}

function dirtyFileEqual(a: WorkspaceDirtyFile, b: WorkspaceDirtyFile): boolean {
  return a.path === b.path && a.status === b.status;
}

/**
 * Compute the minimal ordered op-list that turns `prev` into `next`. Returns an
 * empty array when the two states are equivalent (the producer then emits
 * nothing). Branch + head move together as `set_branch` when the branch
 * changes, so a consumer never sees a head that briefly belongs to the wrong
 * branch.
 */
export function diffWorkspaceState(
  prev: WorkspaceState,
  next: WorkspaceState,
): WorkspaceStateDeltaOp[] {
  const ops: WorkspaceStateDeltaOp[] = [];

  if (prev.activeBranch !== next.activeBranch) {
    ops.push({ op: 'set_branch', activeBranch: next.activeBranch, headSha: next.headSha });
  } else if (prev.headSha !== next.headSha) {
    ops.push({ op: 'set_head', headSha: next.headSha });
  }

  if (prev.ahead !== next.ahead || prev.behind !== next.behind) {
    const tracking: Extract<WorkspaceStateDeltaOp, { op: 'set_tracking' }> = { op: 'set_tracking' };
    if (next.ahead !== undefined) tracking.ahead = next.ahead;
    if (next.behind !== undefined) tracking.behind = next.behind;
    ops.push(tracking);
  }

  ops.push(...diffDirtyFiles(prev.dirtyFiles, next.dirtyFiles));

  if (prev.protectMain !== next.protectMain) {
    ops.push({ op: 'set_protect_main', protectMain: next.protectMain });
  }
  if (prev.sandboxReady !== next.sandboxReady) {
    ops.push({ op: 'set_sandbox_ready', sandboxReady: next.sandboxReady });
  }

  return ops;
}

function diffDirtyFiles(
  prev: WorkspaceDirtyFile[],
  next: WorkspaceDirtyFile[],
): WorkspaceStateDeltaOp[] {
  // Whole-list churn (branch switch, discard-all) collapses to one clear +
  // re-adds rather than a scatter of removes; cheaper to reason about and
  // strictly smaller once more than half the list turned over.
  const prevByPath = new Map(prev.map((f) => [f.path, f]));
  const nextByPath = new Map(next.map((f) => [f.path, f]));

  const removed = prev.filter((f) => !nextByPath.has(f.path));
  const changed = next.filter((f) => {
    const before = prevByPath.get(f.path);
    return !before || !dirtyFileEqual(before, f);
  });

  if (next.length === 0 && prev.length > 0) {
    return [{ op: 'dirty_clear' }];
  }

  const ops: WorkspaceStateDeltaOp[] = [];
  for (const f of removed) ops.push({ op: 'dirty_remove', path: f.path });
  for (const f of changed) ops.push({ op: 'dirty_add', file: { ...f } });
  return ops;
}

/**
 * Fold an op-list onto a state, returning a new state (input untouched).
 * Unknown ops are skipped — strict-mode wire validation is the gate that keeps
 * them off the stream in the first place; here we stay total so a
 * forward-compatible additive op from a newer emitter degrades to a no-op
 * rather than throwing inside a consumer's render path.
 */
export function applyWorkspaceDelta(
  state: WorkspaceState,
  ops: WorkspaceStateDeltaOp[],
): WorkspaceState {
  const next = cloneState(state);
  for (const op of ops) {
    switch (op.op) {
      case 'set_branch':
        next.activeBranch = op.activeBranch;
        next.headSha = op.headSha;
        break;
      case 'set_head':
        next.headSha = op.headSha;
        break;
      case 'set_tracking':
        next.ahead = op.ahead;
        next.behind = op.behind;
        break;
      case 'dirty_add': {
        const idx = next.dirtyFiles.findIndex((f) => f.path === op.file.path);
        if (idx >= 0) next.dirtyFiles[idx] = { ...op.file };
        else next.dirtyFiles.push({ ...op.file });
        break;
      }
      case 'dirty_remove':
        next.dirtyFiles = next.dirtyFiles.filter((f) => f.path !== op.path);
        break;
      case 'dirty_clear':
        next.dirtyFiles = [];
        break;
      case 'set_protect_main':
        next.protectMain = op.protectMain;
        break;
      case 'set_sandbox_ready':
        next.sandboxReady = op.sandboxReady;
        break;
      default:
        break;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Git status → WorkspaceState mapping
// ---------------------------------------------------------------------------
//
// Shared by every producer surface: the web adapter
// (`useWorkspaceSandboxController`) and, later, the CLI daemon emitter both
// turn a `GitStatusInfo` read into the same `WorkspaceState`. Keeping the
// mapping here (not in the React hook) is what lets the CLI reuse it verbatim.

/**
 * Map one porcelain status entry to a `WorkspaceDirtyStatus`. Reads the two
 * porcelain columns (`x` = index/staged, `y` = worktree); conflict markers and
 * untracked take precedence over the ordinary add/delete/rename/modify codes.
 */
export function dirtyStatusFromEntry(entry: GitStatusEntry): WorkspaceDirtyStatus {
  const { x, y } = entry;
  if (x === '?' || y === '?') return 'untracked';
  if (x === 'U' || y === 'U' || (x === 'D' && y === 'D') || (x === 'A' && y === 'A')) {
    return 'conflicted';
  }
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  return 'modified';
}

/**
 * Build a `WorkspaceState` from a `GitStatusInfo` read plus the ambient bits
 * the status call doesn't carry (`headSha`, and the `protectMain` /
 * `sandboxReady` guards the shell owns). One `dirtyFiles` entry per porcelain
 * entry — no cross-array dedup, because `entries` is already one-per-file.
 *
 * `ahead`/`behind` are omitted when there is no upstream: per `GitInfo`'s own
 * contract they are meaningless without one (a never-pushed branch reports
 * everything "ahead" of a nonexistent origin), so surfacing them would be a
 * lie, not a zero.
 */
export function gitStatusInfoToWorkspaceState(
  info: GitStatusInfo,
  opts: { headSha: string; protectMain: boolean; sandboxReady: boolean },
): WorkspaceState {
  const state: WorkspaceState = {
    // Detached HEAD can report an empty branch label; keep the field non-empty.
    activeBranch: info.branch || 'HEAD',
    headSha: opts.headSha,
    dirtyFiles: info.entries.map((entry) => ({
      path: entry.path,
      status: dirtyStatusFromEntry(entry),
    })),
    protectMain: opts.protectMain,
    sandboxReady: opts.sandboxReady,
  };
  if (info.hasUpstream) {
    state.ahead = info.ahead;
    state.behind = info.behind;
  }
  return state;
}

// ---------------------------------------------------------------------------
// Producer — turns successive states into snapshot/delta events
// ---------------------------------------------------------------------------

export interface WorkspaceStateProducer {
  /** Force a full snapshot at the current state and bump `rev`. Call on
   *  sandbox start, resume, and whenever the client's rev can't be proven. */
  snapshot(): WorkspaceStateSnapshotEvent;
  /** Emit the minimal delta from the last emitted state to `next`. Returns
   *  null when nothing changed (no event should be sent). */
  update(next: WorkspaceState): WorkspaceStateDeltaEvent | null;
  /** Start a brand-new timeline (new sandbox / repo). Resets rev to 0 and
   *  returns the opening snapshot. */
  reset(workspaceId: string, state: WorkspaceState): WorkspaceStateSnapshotEvent;
}

/**
 * Create a stateful producer for one workspace timeline. Framework-agnostic:
 * a plain closure, safe to hold in a React ref, a daemon session object, or a
 * test. `rev` is scoped to `workspaceId` — `reset` starts a new identity at 0.
 */
export function createWorkspaceStateProducer(
  workspaceId: string,
  initial: WorkspaceState,
): WorkspaceStateProducer {
  let currentWorkspaceId = workspaceId;
  let rev = 0;
  let last = cloneState(initial);

  return {
    snapshot() {
      return {
        type: 'workspace.state_snapshot',
        workspaceId: currentWorkspaceId,
        rev,
        state: cloneState(last),
      };
    },
    update(next) {
      const ops = diffWorkspaceState(last, next);
      if (ops.length === 0) return null;
      const baseRev = rev;
      rev += 1;
      last = cloneState(next);
      return { type: 'workspace.state_delta', workspaceId: currentWorkspaceId, rev, baseRev, ops };
    },
    reset(nextWorkspaceId, state) {
      currentWorkspaceId = nextWorkspaceId;
      rev = 0;
      last = cloneState(state);
      return {
        type: 'workspace.state_snapshot',
        workspaceId: currentWorkspaceId,
        rev,
        state: cloneState(last),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Consumer — folds events into a current view, dropping unprovable deltas
// ---------------------------------------------------------------------------

export interface WorkspaceStateView {
  workspaceId: string;
  rev: number;
  state: WorkspaceState;
}

export type WorkspaceReduceOutcome =
  | 'snapshot_adopted'
  | 'delta_applied'
  | 'delta_dropped_no_base'
  | 'delta_dropped_identity'
  | 'delta_dropped_gap';

export interface WorkspaceReduceResult {
  view: WorkspaceStateView | null;
  outcome: WorkspaceReduceOutcome;
}

function logReduce(level: 'info' | 'warn', event: string, ctx: Record<string, unknown>): void {
  // console.error, not console.log — this module runs on the CLI where stdout
  // is reserved for user output. See the file header.
  console.error(JSON.stringify({ level, event, ...ctx }));
}

/**
 * Fold one workspace-state event onto the current view. Snapshots are adopted
 * unconditionally (ground truth). A delta applies only when it can prove its
 * base — same `workspaceId` AND `view.rev === delta.baseRev`; otherwise the
 * current view is returned unchanged and a structured drop is logged. The
 * caller should treat any `delta_dropped_*` outcome as "await the next
 * snapshot" and, if it controls the producer, request a resync.
 */
export function reduceWorkspaceStateEvent(
  view: WorkspaceStateView | null,
  event: WorkspaceStateEvent,
): WorkspaceReduceResult {
  if (event.type === 'workspace.state_snapshot') {
    const next: WorkspaceStateView = {
      workspaceId: event.workspaceId,
      rev: event.rev,
      state: cloneState(event.state),
    };
    logReduce('info', 'workspace_state_snapshot_adopted', {
      workspaceId: event.workspaceId,
      rev: event.rev,
      dirtyCount: event.state.dirtyFiles.length,
    });
    return { view: next, outcome: 'snapshot_adopted' };
  }

  // Delta path — every drop reason is a distinct, logged branch.
  if (!view) {
    logReduce('warn', 'workspace_state_delta_dropped', {
      reason: 'no_base_snapshot',
      workspaceId: event.workspaceId,
      baseRev: event.baseRev,
      rev: event.rev,
    });
    return { view, outcome: 'delta_dropped_no_base' };
  }
  if (view.workspaceId !== event.workspaceId) {
    logReduce('warn', 'workspace_state_delta_dropped', {
      reason: 'identity_mismatch',
      viewWorkspaceId: view.workspaceId,
      eventWorkspaceId: event.workspaceId,
      baseRev: event.baseRev,
    });
    return { view, outcome: 'delta_dropped_identity' };
  }
  if (view.rev !== event.baseRev) {
    logReduce('warn', 'workspace_state_delta_dropped', {
      reason: 'rev_gap',
      workspaceId: event.workspaceId,
      viewRev: view.rev,
      baseRev: event.baseRev,
      rev: event.rev,
    });
    return { view, outcome: 'delta_dropped_gap' };
  }

  const next: WorkspaceStateView = {
    workspaceId: view.workspaceId,
    rev: event.rev,
    state: applyWorkspaceDelta(view.state, event.ops),
  };
  logReduce('info', 'workspace_state_delta_applied', {
    workspaceId: event.workspaceId,
    rev: event.rev,
    ops: event.ops.length,
  });
  return { view: next, outcome: 'delta_applied' };
}
