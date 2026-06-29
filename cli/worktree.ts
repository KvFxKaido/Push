/**
 * cli/worktree.ts — opt-in git-worktree sandbox for the CLI lead.
 *
 * The CLI lead normally edits the real working tree directly (its whole point
 * is local reach — real filesystem, real shell). `push run --worktree` gives
 * that lead an isolated, OS-native `git worktree` + dedicated branch to work
 * in instead, so a risky autonomous run never touches the user's checkout. The
 * isolation mechanism is just the session `cwd`: point it at the worktree
 * directory and every tool (`read_file`, `exec`, `git_commit`, …) operates
 * there, since they all resolve against `state.cwd`.
 *
 * This is CLI-local on purpose — the web/Modal surfaces isolate via containers
 * (`SandboxProvider`), so there is no second consumer to promote this into
 * `lib/` (see CLAUDE.md "promote to lib the moment a second surface needs it").
 * Git plumbing runs through `makeLocalGitExec` so it shares the CLI's escaped,
 * timeout-aware exec path rather than re-spawning git ad hoc.
 *
 * Lifecycle (shared decision in `lib/git/worktree-disposal.ts`): on teardown a
 * worktree is removed only when it is clean AND nothing is unpushed — no
 * session commits, or every commit already on `origin/<branch>`. A clean,
 * fully-pushed branch is reclaimable (recoverable from the remote); only
 * uncommitted changes or unpushed commits keep it, with the path reported, so
 * unpushed work is never silently destroyed. Reads that fail are treated as
 * "has work" (fail-safe toward keeping), never as "safe to delete".
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { makeLocalGitExec } from './git-backend.js';
import type { GitExec } from '../lib/git/backend.js';
import { decideWorktreeDisposal } from '../lib/git/worktree-disposal.js';

// Worktree git ops (add/remove/list/status) can touch a lot of refs on a big
// repo; give them headroom over the 5s default the typed reads use.
const WORKTREE_GIT_TIMEOUT_MS = 30_000;

/** Thrown on a worktree setup failure the caller should surface verbatim. */
export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeError';
  }
}

/**
 * A live worktree the session is rooted in. Persisted on `SessionState.worktree`
 * so a resumed session knows where it lives and can be torn down later.
 */
export interface WorktreeHandle {
  /** Absolute path to the worktree directory (the session's `cwd`). */
  path: string;
  /** Branch checked out in the worktree (created by `addWorktree`). */
  branch: string;
  /**
   * SHA the branch was created from. Resolved at creation time (not kept as a
   * symbolic ref) so the "commits beyond base" disposability check is stable
   * even if the source branch later moves.
   */
  baseSha: string;
  /** The main repository root the worktree is attached to. */
  repoRoot: string;
}

function gitExecAt(cwd: string): GitExec {
  return makeLocalGitExec(cwd, WORKTREE_GIT_TIMEOUT_MS);
}

/**
 * Resolve the main git toplevel for `cwd`, or null when `cwd` isn't inside a
 * git repo. Distinct from `cli/repo-commands.ts:resolveRepoRoot`, which walks
 * for command-discovery markers; this is the plain `git rev-parse` toplevel.
 */
export async function resolveGitRoot(cwd: string): Promise<string | null> {
  const res = await gitExecAt(cwd)(['rev-parse', '--show-toplevel']);
  if (res.exitCode !== 0) return null;
  return res.stdout.trim() || null;
}

/** Collapse a branch name into a filesystem-safe path segment. */
export function sanitizeBranchForPath(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'sandbox';
}

/**
 * Where a worktree for `repoRoot` + `branch` lives: under `~/.push/worktrees`,
 * namespaced by a `<basename>-<hash-of-abs-path>` repo id so two repos with the
 * same basename don't collide, and never inside the repo itself (a nested
 * worktree would pollute the parent's status).
 */
export function worktreeDirFor(repoRoot: string, branch: string): string {
  const repoId = `${path.basename(repoRoot)}-${createHash('sha1')
    .update(repoRoot)
    .digest('hex')
    .slice(0, 8)}`;
  return path.join(os.homedir(), '.push', 'worktrees', repoId, sanitizeBranchForPath(branch));
}

/** Auto-generated branch name for a `--worktree` run without an explicit name. */
export function autoWorktreeBranchName(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `push/sandbox-${stamp}`;
}

export interface AddWorktreeOptions {
  /** Main repo root (from `resolveGitRoot`). */
  repoRoot: string;
  /** Branch to create + check out in the worktree. */
  branch: string;
  /** Ref to branch from; defaults to current HEAD. */
  baseRef?: string;
  /** Override the worktree directory (tests). Defaults to `worktreeDirFor`. */
  dir?: string;
}

/**
 * Create `branch` from `baseRef` and check it out in a fresh worktree. Returns
 * the handle to root the session at. Throws `WorktreeError` on any failure
 * (bad base ref, branch already exists, dir collision) — setup must fail loudly
 * so the run never silently falls back to editing the real tree.
 */
export async function addWorktree(opts: AddWorktreeOptions): Promise<WorktreeHandle> {
  const exec = gitExecAt(opts.repoRoot);
  const baseRef = opts.baseRef?.trim() || 'HEAD';

  const baseShaRes = await exec(['rev-parse', baseRef]);
  if (baseShaRes.exitCode !== 0) {
    throw new WorktreeError(
      `Cannot resolve base ref "${baseRef}": ${baseShaRes.stderr.trim() || 'unknown error'}`,
    );
  }
  const baseSha = baseShaRes.stdout.trim();

  const dir = opts.dir ?? worktreeDirFor(opts.repoRoot, opts.branch);
  await fs.mkdir(path.dirname(dir), { recursive: true });

  const res = await exec(['worktree', 'add', '-b', opts.branch, dir, baseRef]);
  if (res.exitCode !== 0) {
    throw new WorktreeError(
      `git worktree add failed: ${res.stderr.trim() || res.stdout.trim() || 'unknown error'}`,
    );
  }
  return { path: dir, branch: opts.branch, baseSha, repoRoot: opts.repoRoot };
}

export interface WorktreeState {
  /** Uncommitted or untracked changes are present in the worktree. */
  dirty: boolean;
  /** Commits on the branch beyond its base SHA. */
  commitsAhead: number;
  /**
   * Commits on HEAD not present on the branch's remote ref (`origin/<branch>`),
   * or `null` when the branch has no remote ref yet (never pushed). Lets
   * teardown reclaim a clean branch whose work is already on the remote instead
   * of keeping it forever just because it has commits beyond base.
   */
  unpushedCommits: number | null;
}

/**
 * Inspect a worktree's work state. On a read failure every signal is biased
 * toward "has work" (`dirty: true` / `commitsAhead: 1` / `unpushedCommits: 1`)
 * so an unreadable worktree is kept, never deleted on uncertainty.
 */
export async function worktreeState(handle: WorktreeHandle): Promise<WorktreeState> {
  const exec = gitExecAt(handle.path);

  const status = await exec(['status', '--porcelain']);
  const dirty = status.exitCode === 0 ? status.stdout.trim().length > 0 : true;

  const revlist = await exec(['rev-list', '--count', `${handle.baseSha}..HEAD`]);
  const commitsAhead = revlist.exitCode === 0 ? Number.parseInt(revlist.stdout.trim(), 10) || 0 : 1;

  // Refs are shared across a repo's worktrees, so the remote-tracking ref
  // resolves here even though the push happened from another worktree/process.
  // Use the fully-qualified `refs/remotes/origin/<branch>` rather than the
  // `origin/<branch>` shorthand: the shorthand follows git's disambiguation
  // order (refs/, refs/tags/, refs/heads/, refs/remotes/), so a tag or local
  // branch literally named `origin/<branch>` would shadow the real
  // remote-tracking ref and could make unpushed work look pushed — exactly the
  // false-positive that would let teardown delete it. A missing ref (never
  // pushed) is `null`; a read failure on an existing ref biases to "unpushed"
  // (1) so we keep rather than risk discarding unpushed commits.
  const remoteRef = `refs/remotes/origin/${handle.branch}`;
  const hasRemote = await exec(['rev-parse', '--verify', '--quiet', remoteRef]);
  let unpushedCommits: number | null;
  if (hasRemote.exitCode !== 0) {
    unpushedCommits = null;
  } else {
    const ahead = await exec(['rev-list', '--count', `${remoteRef}..HEAD`]);
    unpushedCommits = ahead.exitCode === 0 ? Number.parseInt(ahead.stdout.trim(), 10) || 0 : 1;
  }

  return { dirty, commitsAhead, unpushedCommits };
}

/** Disposable = the shared decision says the work area can be reclaimed: clean
 *  with nothing unpushed (no session commits, or every commit already on the
 *  remote). */
export async function isDisposableWorktree(handle: WorktreeHandle): Promise<boolean> {
  return decideWorktreeDisposal(await worktreeState(handle)).action === 'remove';
}

export interface RemoveWorktreeResult {
  removed: boolean;
  branchDeleted: boolean;
  reason?: string;
}

/**
 * Remove the worktree (and optionally its branch). `deleteBranch` uses `-D`
 * because the throwaway branch is typically unmerged; callers only set it for a
 * disposable (no-commits-beyond-base) branch, so nothing of value is lost.
 */
export async function removeWorktree(
  handle: WorktreeHandle,
  opts?: { force?: boolean; deleteBranch?: boolean },
): Promise<RemoveWorktreeResult> {
  const exec = gitExecAt(handle.repoRoot);
  const args = ['worktree', 'remove'];
  if (opts?.force) args.push('--force');
  args.push(handle.path);

  const res = await exec(args);
  if (res.exitCode !== 0) {
    return {
      removed: false,
      branchDeleted: false,
      reason: res.stderr.trim() || res.stdout.trim() || 'git worktree remove failed',
    };
  }

  let branchDeleted = false;
  if (opts?.deleteBranch) {
    const del = await exec(['branch', '-D', handle.branch]);
    branchDeleted = del.exitCode === 0;
  }
  return { removed: true, branchDeleted };
}

export interface TeardownOutcome {
  /** The worktree was left in place (work present, or removal failed). */
  kept: boolean;
  removed: boolean;
  branchDeleted: boolean;
  path: string;
  branch: string;
  /** Why it was kept / why removal failed, for the caller's log line. */
  reason?: string;
}

/**
 * Apply the clean-if-clean lifecycle: remove the worktree (and its branch) only
 * when it is disposable; otherwise keep it and report why. Returns a structured
 * outcome so the caller emits one symmetric log line for kept vs removed.
 */
export async function teardownWorktree(handle: WorktreeHandle): Promise<TeardownOutcome> {
  const decision = decideWorktreeDisposal(await worktreeState(handle));
  if (decision.action === 'keep') {
    return {
      kept: true,
      removed: false,
      branchDeleted: false,
      path: handle.path,
      branch: handle.branch,
      reason:
        decision.reason === 'dirty'
          ? 'has uncommitted changes'
          : 'has commits not yet pushed to the remote',
    };
  }
  // Safe to delete the local branch: removal only happens when clean and
  // nothing is unpushed, so either there are no session commits or they are all
  // recoverable from `origin/<branch>`.
  const res = await removeWorktree(handle, { deleteBranch: true });
  return {
    kept: !res.removed,
    removed: res.removed,
    branchDeleted: res.branchDeleted,
    path: handle.path,
    branch: handle.branch,
    reason: res.reason,
  };
}

/**
 * One-block human status for the `/worktree` command (REPL + TUI). Reports the
 * sandbox path/branch, its current work state, and what teardown will do — so
 * the user can see whether their session is isolated and whether exiting will
 * keep or discard the worktree. Returns a plain string the caller renders.
 */
export async function formatWorktreeStatus(state: { worktree?: WorktreeHandle }): Promise<string> {
  if (!state.worktree) {
    return 'No git-worktree sandbox active — this session works the real tree directly.';
  }
  const wt = state.worktree;
  const s = await worktreeState(wt);
  const decision = decideWorktreeDisposal(s);
  const unpushedLabel =
    s.unpushedCommits === null
      ? 'not pushed (no remote branch yet)'
      : `${s.unpushedCommits} unpushed`;
  return [
    `Worktree sandbox: ${wt.path}`,
    `Branch: ${wt.branch} (from ${wt.baseSha.slice(0, 8)})`,
    `State: ${s.dirty ? 'uncommitted changes' : 'clean'}, ${s.commitsAhead} commit(s) beyond base, ${unpushedLabel}`,
    decision.action === 'remove'
      ? 'On exit: removed automatically (nothing unpushed to keep).'
      : decision.reason === 'dirty'
        ? `On exit: kept (uncommitted changes) — commit + push, then \`git worktree remove ${wt.path}\`.`
        : `On exit: kept (unpushed commits) — push, then \`git worktree remove ${wt.path}\`.`,
  ].join('\n');
}

export interface WorktreeListEntry {
  path: string;
  head: string;
  /** Branch name (no `refs/heads/` prefix), or null when detached. */
  branch: string | null;
}

/**
 * List the repo's worktrees via `git worktree list --porcelain`. Useful for
 * surfacing/cleaning orphaned sandbox worktrees. Returns [] on any error.
 */
export async function listWorktrees(repoRoot: string): Promise<WorktreeListEntry[]> {
  const res = await gitExecAt(repoRoot)(['worktree', 'list', '--porcelain']);
  if (res.exitCode !== 0) return [];

  const entries: WorktreeListEntry[] = [];
  let current: Partial<WorktreeListEntry> | null = null;
  const flush = (): void => {
    if (current?.path) {
      entries.push({
        path: current.path,
        head: current.head ?? '',
        branch: current.branch ?? null,
      });
    }
    current = null;
  };
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length).trim() };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (current && line.startsWith('branch ')) {
      current.branch = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '');
    } else if (current && line.trim() === 'detached') {
      current.branch = null;
    }
  }
  flush();
  return entries;
}
