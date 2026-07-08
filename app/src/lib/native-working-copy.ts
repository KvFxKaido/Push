/**
 * On-device working-copy registry (native/APK only).
 *
 * The mobile shell has no cloud sandbox — a repo session runs against a real
 * on-device clone. This module owns the lifecycle of those clones: it maps a
 * durable scope (`repoFullName + branch`) to a clone's on-device dir and its
 * status, so the git seam (`git-session.ts`) can resolve the native backend once
 * a clone is ready, and the workspace controller can trigger the clone on
 * session start.
 *
 * Why a module-level registry (not React state): the clone must survive a
 * controller remount (navigating Home → back into the workspace) exactly the way
 * the warm cloud sandbox does. The registry is process-lifetime; `git-session`
 * reads it synchronously per git op via {@link workingCopyDir}.
 *
 * Keying: the scope is keyed through the shared collision-free {@link laneSegment}
 * scheme (same as the native checkpoint store), so a scope's working copy and its
 * checkpoints sort under matching lane names. The relative dir is resolved under
 * the app's private `filesDir` on the native side (mirroring the checkpoint repo).
 *
 * Scope boundary: this module is pure state + orchestration. The JGit `clone`
 * call is injected (the controller supplies `NativeGit.clone`), so the registry
 * stays unit-testable with a fake clone and carries no `@capacitor/core` weight
 * of its own beyond the default binding.
 */

import { NativeGit } from './native-git/plugin';
import type { NativeGitCloneOptions, NativeGitWriteResult } from './native-git/definitions';
import { laneSegment } from './native-git/lane-key';

/** Durable identity of an on-device working copy. */
export interface WorkingCopyScope {
  /** Repo `owner/name`. */
  repoFullName: string;
  /** Active branch checked out in the clone. */
  branch: string;
}

export type WorkingCopyStatus = 'cloning' | 'ready' | 'failed';

/** Public snapshot of a working copy's lifecycle state. */
export interface WorkingCopyState {
  status: WorkingCopyStatus;
  /** On-device dir (relative, resolved under `filesDir` natively). Always known. */
  dir: string;
  /** Failure reason when `status === 'failed'`. */
  message?: string;
}

/** Root under which every session working copy is cloned (sibling of `checkpoints`). */
const WORKING_COPY_ROOT = 'worktrees';

type LogFn = (level: 'info' | 'warn', event: string, ctx: Record<string, unknown>) => void;
const defaultLog: LogFn = (level, event, ctx) =>
  console.log(JSON.stringify({ level, event, ...ctx }));

/** GitHub HTTPS clone URL for a repo `owner/name`. */
function githubHttpsUrl(repoFullName: string): string {
  return `https://github.com/${repoFullName}.git`;
}

/**
 * Relative on-device dir for a scope's working copy. Pure and total — a dir is
 * always computable, independent of whether a clone exists yet. Doubles as the
 * registry's map key: {@link laneSegment} is collision-free, so distinct scopes
 * always produce distinct paths.
 */
export function workingCopyPath(scope: WorkingCopyScope): string {
  return `${WORKING_COPY_ROOT}/${laneSegment(scope.repoFullName)}/${laneSegment(scope.branch)}`;
}

/** In-registry entry; `promise` is present only while a clone is in flight. */
interface WorkingCopyEntry {
  status: WorkingCopyStatus;
  dir: string;
  message?: string;
  promise?: Promise<WorkingCopyState>;
}

const registry = new Map<string, WorkingCopyEntry>();

/**
 * The scope's ready on-device clone dir, or `undefined` when none is registered,
 * still cloning, or the clone failed. This is the synchronous read `git-session`
 * uses to decide the native binding — it deliberately returns `undefined` for any
 * non-ready state so a half-cloned repo is never handed to the native backend.
 */
export function workingCopyDir(scope: WorkingCopyScope): string | undefined {
  const entry = registry.get(workingCopyPath(scope));
  return entry?.status === 'ready' ? entry.dir : undefined;
}

/**
 * Re-key a ready working-copy registry entry after the clone itself switches
 * branches. The physical dir is preserved: typed native branch ops move HEAD in
 * one on-device clone, then the durable `{repoFullName, branch}` lookup needs to
 * follow that same clone under the new branch key.
 */
export function rekeyWorkingCopyScope(
  fromScope: WorkingCopyScope,
  toScope: WorkingCopyScope,
  deps: { log?: LogFn } = {},
): boolean {
  const fromKey = workingCopyPath(fromScope);
  const toKey = workingCopyPath(toScope);
  const entry = registry.get(fromKey);
  if (!entry || entry.status !== 'ready') return false;
  if (fromKey !== toKey) {
    registry.delete(fromKey);
    registry.set(toKey, entry);
  }
  (deps.log ?? defaultLog)('info', 'native_working_copy_rekeyed', {
    repo: fromScope.repoFullName,
    fromBranch: fromScope.branch,
    toBranch: toScope.branch,
    dir: entry.dir,
  });
  return true;
}

/** Injected clone + config for {@link ensureWorkingCopy}. */
export interface EnsureWorkingCopyDeps {
  /** JGit clone (defaults to the `NativeGit` plugin). */
  clone?: (options: NativeGitCloneOptions) => Promise<NativeGitWriteResult>;
  /** GitHub token for private repos; injected transiently into the clone. */
  getToken?: () => string | undefined;
  /** Remote-URL builder (defaults to `https://github.com/<repo>.git`). */
  remoteUrl?: (repoFullName: string) => string;
  /** Shallow-clone depth; omit for a full clone. */
  depth?: number;
  log?: LogFn;
}

/**
 * Ensure the scope's on-device clone exists, cloning it if needed. Idempotent
 * and race-safe: a `ready` scope returns immediately (logged `native_clone_reused`);
 * an in-flight clone returns the SAME promise (concurrent first-turn sends dedupe
 * onto one clone); a `failed` scope re-attempts. The registry entry is written
 * synchronously before the first await, so the in-flight dedupe has no gap.
 *
 * Resolves to the terminal {@link WorkingCopyState} — callers gate on
 * `status === 'ready'` to choose native vs. falling through to sandbox. Never
 * rejects: a clone failure resolves to `{ status: 'failed', message }`.
 */
export function ensureWorkingCopy(
  scope: WorkingCopyScope,
  deps: EnsureWorkingCopyDeps = {},
): Promise<WorkingCopyState> {
  const key = workingCopyPath(scope);
  const log = deps.log ?? defaultLog;
  const existing = registry.get(key);

  if (existing?.status === 'ready') {
    log('info', 'native_clone_reused', {
      repo: scope.repoFullName,
      branch: scope.branch,
      dir: existing.dir,
    });
    return Promise.resolve({ status: 'ready', dir: existing.dir });
  }
  if (existing?.status === 'cloning' && existing.promise) {
    return existing.promise;
  }

  const entry: WorkingCopyEntry = { status: 'cloning', dir: key };
  const promise = runClone(scope, entry, deps, log);
  entry.promise = promise;
  registry.set(key, entry);
  return promise;
}

async function runClone(
  scope: WorkingCopyScope,
  entry: WorkingCopyEntry,
  deps: EnsureWorkingCopyDeps,
  log: LogFn,
): Promise<WorkingCopyState> {
  const clone = deps.clone ?? ((options) => NativeGit.clone(options));
  const url = (deps.remoteUrl ?? githubHttpsUrl)(scope.repoFullName);
  const base = { repo: scope.repoFullName, branch: scope.branch, dir: entry.dir };
  log('info', 'native_clone_started', base);

  try {
    const result = await clone({
      url,
      dir: entry.dir,
      branch: scope.branch,
      token: deps.getToken?.(),
      depth: deps.depth,
    });
    if (result.ok) {
      entry.status = 'ready';
      entry.message = undefined;
      log('info', 'native_clone_ready', base);
      return { status: 'ready', dir: entry.dir };
    }
    entry.status = 'failed';
    entry.message = result.message;
    log('warn', 'native_clone_failed', { ...base, message: result.message ?? null });
    return { status: 'failed', dir: entry.dir, message: result.message };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    entry.status = 'failed';
    entry.message = message;
    log('warn', 'native_clone_failed', { ...base, message });
    return { status: 'failed', dir: entry.dir, message };
  }
}

/**
 * Drop the scope's registry entry (e.g. on explicit disconnect). Deliberately
 * does NOT delete the on-device bytes — leaving the clone on disk makes a later
 * re-attach instant, matching the warm-sandbox posture. A destructive purge (a
 * native `rm -rf` of the lane dir) is a separate concern. `forgotten` is false
 * when there was nothing registered.
 */
export function forgetWorkingCopy(scope: WorkingCopyScope, deps: { log?: LogFn } = {}): boolean {
  const key = workingCopyPath(scope);
  const existed = registry.delete(key);
  if (existed) {
    (deps.log ?? defaultLog)('info', 'native_working_copy_forgotten', {
      repo: scope.repoFullName,
      branch: scope.branch,
      dir: key,
    });
  }
  return existed;
}

/** Test-only: clear the whole registry between cases. */
export function __resetWorkingCopyRegistryForTests(): void {
  registry.clear();
}
