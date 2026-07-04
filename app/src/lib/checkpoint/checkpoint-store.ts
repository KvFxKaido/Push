/**
 * CheckpointStore — the abstraction over *where* a work checkpoint lives.
 *
 * Push captures in-progress sandbox work so a lost sandbox / session doesn't eat
 * it. The *coordinator* (when to capture — `useWorkspaceSandboxAutoBack`) and the
 * *restore UX* (how recovery is offered — `useWorkspaceSandboxRestore`) are one
 * pipe; only the storage reservoir is pluggable:
 *
 * - **remote-draft-ref** (web/cloud): the existing B2 auto-back — capture the
 *   sandbox tree off-HEAD and force-push it to `origin/draft/auto/<branch>`.
 * - **native-jgit** (APK/native, flagged): an app-private on-device `git init`
 *   repo. Local, durable, offline, no remote exposure. (Skeleton in this
 *   increment; capture/restore land later.)
 *
 * See `docs/decisions/Native Checkpoint Store.md`. The native repo is a SEPARATE
 * backup dir, never the session's active working copy — "native git holds the
 * parachute," not flies the plane.
 *
 * Scope: this lives in `app/src/lib/` (web/Capacitor), not root `lib/` — the
 * CLI/daemon has a reliable local filesystem and needs no checkpoint store
 * (per the auto-back scoping). Promote if a third surface ever needs it.
 *
 * The interface carries only what the existing coordinators consume — `capture`
 * + restore. `list` / `prune` (retention) land with native capture, when there's
 * a real multi-checkpoint store to list and bound; the single remote draft ref
 * has nothing to enumerate today.
 */

import { isNativePlatform } from '../platform';

/** Identity tag for logs / selection assertions. */
export type CheckpointStoreKind = 'remote-draft-ref' | 'native-jgit';

/**
 * Durable identity of a checkpoint lane. `repoFullName + branch` (NOT the
 * per-session `sandboxId`) is the key the native store uses to locate its
 * on-device repo dir, so checkpoints persist across sandboxes/sessions (the
 * CLAUDE.md "scope keys CLI-first" rule). The remote store ignores `repoFullName`
 * — its durable home is the server-side `draft/auto/<branch>` ref.
 */
export interface CheckpointScope {
  repoFullName: string;
  branch: string;
}

export interface CheckpointCaptureInput extends CheckpointScope {
  sandboxId: string;
  /**
   * Opaque dedup token from the prior successful capture on the SAME branch, if
   * any — threaded back so the store can skip redundant work when nothing
   * changed. The coordinator never interprets it (the remote store encodes
   * `tree:head`; the native store encodes the commit id), so it stays a black box
   * at the seam. Undefined on the first capture / after a branch change.
   */
  priorToken?: string;
}

export interface CheckpointDetectInput extends CheckpointScope {
  sandboxId: string;
}

export interface CheckpointRestoreInput extends CheckpointScope {
  sandboxId: string;
  checkpointId: string;
}

/** One checkpoint in the history (the native `git log` of the on-device repo). */
export interface CheckpointRecord {
  checkpointId: string;
  message: string;
  timestampMs: number;
}

export type CheckpointCaptureResult =
  /** A new checkpoint was persisted; `dedupToken` identifies its content. */
  | { status: 'captured'; dedupToken: string }
  /** Identical to `priorToken`; nothing persisted, but the pin stands. */
  | { status: 'unchanged'; dedupToken: string }
  /** Nothing to capture (working tree matches HEAD / empty). */
  | { status: 'clean' }
  /** Pre-conditions not met (no sandbox / no branch / invalid branch). */
  | { status: 'skipped'; reason: string }
  /** A gate refused the capture (e.g. secret scan on the remote draft push). */
  | { status: 'blocked'; reason: string }
  /** Capture attempted but failed (transport / git error). */
  | { status: 'failed'; reason: string }
  /** This store cannot capture (e.g. the native skeleton). */
  | { status: 'unsupported' };

export type CheckpointRestoreAvailability =
  | { available: false; reason?: string }
  /** A recoverable checkpoint exists; `checkpointId` is the store-local handle. */
  | { available: true; checkpointId: string; summary: string };

export type CheckpointRestoreResult =
  | { status: 'restored'; checkpointId: string }
  /** Refused: the target working tree is dirty (don't clobber live work). */
  | { status: 'skipped-dirty' }
  | { status: 'failed'; reason: string }
  | { status: 'unsupported' };

/** Delete one checkpoint from a lane's history (security mitigation, #1103). */
export interface CheckpointDropInput extends CheckpointScope {
  checkpointId: string;
}

export type CheckpointDropResult =
  | { status: 'dropped' }
  /** The checkpoint wasn't in the store (already gone). */
  | { status: 'not-found' }
  | { status: 'failed'; reason: string }
  | { status: 'unsupported' };

export type CheckpointClearResult =
  /** Stored checkpoints were purged (the dir was deleted outright). */
  | { status: 'cleared' }
  /** Nothing was stored to clear. */
  | { status: 'noop' }
  | { status: 'failed'; reason: string }
  | { status: 'unsupported' };

export interface CheckpointStore {
  readonly kind: CheckpointStoreKind;
  /** Capture the current sandbox working tree as a checkpoint. */
  capture(input: CheckpointCaptureInput): Promise<CheckpointCaptureResult>;
  /** Is a checkpoint available to restore for this sandbox/branch? */
  detectRestore(input: CheckpointDetectInput): Promise<CheckpointRestoreAvailability>;
  /** Restore `checkpointId` into the sandbox working tree. */
  restore(input: CheckpointRestoreInput): Promise<CheckpointRestoreResult>;
  /** Checkpoint history for a lane, newest first (empty when none / unsupported). */
  list(scope: CheckpointScope): Promise<CheckpointRecord[]>;
  /** Delete one checkpoint from the lane's history (user-initiated). */
  drop(input: CheckpointDropInput): Promise<CheckpointDropResult>;
  /**
   * Purge stored checkpoints — the lane's, or every lane's (`allLanes`). The
   * security mitigation: removes durable on-device WIP/secrets on demand. The
   * remote/web store has nothing on-device to purge and returns `unsupported`.
   */
  clear(scope: CheckpointScope, options?: { allLanes?: boolean }): Promise<CheckpointClearResult>;
}

/**
 * Feature flag for the native (on-device) checkpoint store. Default OFF so the
 * experimental path never ships in mainline builds; only the APK with this flag
 * set uses the JGit store. Mirrors the `VITE_*` build-flag pattern in
 * `relay-binding.ts` (process.env first for vitest/Node, then the
 * Vite-inlined `import.meta.env`).
 */
export function isNativeCheckpointsEnabled(): boolean {
  const raw = readNativeCheckpointsFlag();
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'boolean') return raw;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function readNativeCheckpointsFlag(): string | boolean | undefined {
  if (typeof process !== 'undefined' && process.env?.VITE_NATIVE_CHECKPOINTS !== undefined) {
    return process.env.VITE_NATIVE_CHECKPOINTS;
  }
  const meta = (
    import.meta as ImportMeta & { env?: { VITE_NATIVE_CHECKPOINTS?: string | boolean } }
  ).env;
  return meta?.VITE_NATIVE_CHECKPOINTS;
}

/**
 * The one switch for "this surface recovers from the on-device checkpoint, not
 * the cloud snapshot." True iff we're on the native shell AND native checkpoints
 * are enabled — the *same* condition `selectCheckpointStore` uses to pick the
 * native store. "If you're on native checkpoints, you're not on cloud snapshots"
 * (Increment 2 design): the cloud snapshot paths in `useSandbox` gate off this,
 * and the hub hides its hibernate/restore affordances on it. Kept here, beside
 * the store selector, so the predicate and the selection can never drift — a
 * dedicated kill-switch flag is trivial to add later if an override is wanted.
 */
export function nativeCheckpointsActive(): boolean {
  return isNativePlatform() && isNativeCheckpointsEnabled();
}

export interface ResolveCheckpointStoreDeps {
  /** Platform probe (defaults to the real Capacitor check); injectable for tests. */
  isNative?: () => boolean;
  /** Native-checkpoints flag read (defaults to the real flag); injectable for tests. */
  nativeEnabled?: () => boolean;
  /** The native store (injected to keep this module free of a store import cycle). */
  nativeStore: CheckpointStore;
  /** The remote store (likewise injected). */
  remoteStore: CheckpointStore;
}

/**
 * Pick the checkpoint store for the running platform: the native on-device store
 * only when on the native shell AND the flag is enabled; otherwise the remote
 * draft-ref store. Pure dispatch over injected deps so both arms are testable.
 * The thin live wrapper (`resolveCheckpointStore`) lives in `resolve-store.ts`
 * to avoid an interface↔store import cycle.
 */
export function selectCheckpointStore(deps: ResolveCheckpointStoreDeps): CheckpointStore {
  const isNative = deps.isNative ?? isNativePlatform;
  const nativeEnabled = deps.nativeEnabled ?? isNativeCheckpointsEnabled;
  if (isNative() && nativeEnabled()) return deps.nativeStore;
  return deps.remoteStore;
}
