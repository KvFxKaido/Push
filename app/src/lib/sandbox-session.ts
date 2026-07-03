import { safeStorageGet, safeStorageRemove, safeStorageSet } from './safe-storage';

const LEGACY_SANDBOX_SESSION_KEY = 'sandbox_session';
const SANDBOX_SESSION_STORAGE_PREFIX = 'sandbox_session:';
const SCRATCH_SESSION_SCOPE = '__scratch__';

export interface PersistedSandboxSession {
  sandboxId: string;
  ownerToken: string;
  repoFullName: string;
  branch: string;
  createdAt: number;
  /**
   * Epoch ms of the last real sandbox activity. Distinct from `createdAt` (the
   * container's birth): an actively-used container keeps resetting CF's
   * sleepAfter clock, so it stays alive well past the container's nominal age.
   * Refreshed by the keep-warm interval so a full reload/eviction — which wipes
   * the in-memory activity clock — can still tell a recently-active, still-live
   * container from a stale one on reconnect. Absent on legacy/just-created
   * sessions; reconnect falls back to `createdAt` then.
   */
  lastActivityAt?: number;
  /** Snapshot ID from a prior hibernate. Used to restore when the container is gone. */
  snapshotId?: string;
  /** Token required to authorize snapshot restore. Stored alongside snapshotId. */
  restoreToken?: string;
  /** Epoch ms when the snapshot was taken. Used to surface snapshot age on resume. */
  snapshotCreatedAt?: number;
  /**
   * Whether a real workspace mutation (write/upload/delete, or a mutating
   * exec) has happened this session, per `onWorkspaceMutation`. Set to
   * `false` explicitly at creation and flipped `true` on first mutation —
   * `false` is a positive claim, not a default, so a pre-existing session
   * (persisted before this field existed) reads `undefined` and is never
   * treated as safe to discard. Lets `useSandbox.ts`'s definitively-gone
   * recovery skip a snapshot restore and cold-start from the default branch
   * for a session with nothing worth restoring, instead of resurrecting a
   * snapshot that may itself be a false positive (auto-back's dirty-tree
   * fail-safe can misfire and push a WIP snapshot with nothing real in it).
   * `saveSandboxSession` replaces the whole record, so every writer must
   * carry the existing value forward or a real `true` silently reverts.
   */
  hasMutated?: boolean;
}

function normalizeSandboxSessionBranch(
  repoFullName?: string | null,
  branch?: string | null,
): string | null {
  const trimmed = branch?.trim();
  if (trimmed) return trimmed;
  return repoFullName === '' ? 'main' : null;
}

function getSandboxSessionScope(repoFullName?: string | null): string | null {
  if (repoFullName == null) return null;
  return repoFullName === '' ? SCRATCH_SESSION_SCOPE : `repo:${repoFullName}`;
}

function parsePersistedSandboxSession(raw: string | null): PersistedSandboxSession | null {
  if (!raw) return null;

  try {
    const session = JSON.parse(raw) as PersistedSandboxSession;
    // Sessions with a snapshotId can have an empty ownerToken (the
    // container was terminated, token cleared). Accept them so the
    // restore flow can find the snapshotId on next app open.
    const hasSnapshot = !!session.snapshotId;
    if (
      !session.sandboxId ||
      (!session.ownerToken && !hasSnapshot) ||
      !session.branch ||
      !session.createdAt
    ) {
      return null;
    }
    if (typeof session.repoFullName !== 'string') return null;
    return session;
  } catch {
    return null;
  }
}

export function buildSandboxSessionStorageKey(
  repoFullName?: string | null,
  branch?: string | null,
): string | null {
  const scope = getSandboxSessionScope(repoFullName);
  const normalizedBranch = normalizeSandboxSessionBranch(repoFullName, branch);
  if (!scope || !normalizedBranch) return null;
  return `${SANDBOX_SESSION_STORAGE_PREFIX}${encodeURIComponent(scope)}:${encodeURIComponent(normalizedBranch)}`;
}

export function clearSandboxSessionByStorageKey(
  storageKey?: string | null,
  expectedSandboxId?: string,
): boolean {
  if (!storageKey) return false;
  if (expectedSandboxId) {
    const existing = parsePersistedSandboxSession(safeStorageGet(storageKey));
    if (existing && existing.sandboxId !== expectedSandboxId) return false;
  }
  return safeStorageRemove(storageKey);
}

export function loadSandboxSession(
  repoFullName?: string | null,
  branch?: string | null,
): PersistedSandboxSession | null {
  const storageKey = buildSandboxSessionStorageKey(repoFullName, branch);
  if (!storageKey) return null;

  const direct = parsePersistedSandboxSession(safeStorageGet(storageKey));
  if (direct) return direct;

  const legacy = parsePersistedSandboxSession(safeStorageGet(LEGACY_SANDBOX_SESSION_KEY));
  if (!legacy) return null;

  const normalizedBranch = normalizeSandboxSessionBranch(repoFullName, branch);
  if (!normalizedBranch) return null;
  if (legacy.repoFullName !== (repoFullName ?? '') || legacy.branch !== normalizedBranch)
    return null;

  safeStorageSet(storageKey, JSON.stringify(legacy));
  safeStorageRemove(LEGACY_SANDBOX_SESSION_KEY);
  return legacy;
}

export function saveSandboxSession(
  repoFullName: string,
  branch: string,
  session: PersistedSandboxSession,
): boolean {
  const storageKey = buildSandboxSessionStorageKey(repoFullName, branch);
  if (!storageKey) return false;
  return safeStorageSet(storageKey, JSON.stringify(session));
}

/**
 * Refresh only the `lastActivityAt` field of the stored session, leaving the
 * rest of the record untouched. Called from the keep-warm interval so the
 * persisted activity timestamp stays at most one tick stale — that's what lets a
 * reconnect after a full reload (which clears the in-memory activity clock) keep
 * a recently-active, still-live container instead of discarding it as too old.
 * No-op when the stored session is missing or points at a different sandbox (a
 * stale interval from a swapped-out container must not stamp the new one).
 */
export function touchSandboxSessionActivity(
  repoFullName: string | null | undefined,
  branch: string | null | undefined,
  sandboxId: string,
  at: number,
): boolean {
  const storageKey = buildSandboxSessionStorageKey(repoFullName, branch);
  if (!storageKey) return false;
  const existing = parsePersistedSandboxSession(safeStorageGet(storageKey));
  if (!existing || existing.sandboxId !== sandboxId) return false;
  return safeStorageSet(storageKey, JSON.stringify({ ...existing, lastActivityAt: at }));
}

/**
 * Flip `hasMutated` to `true` the first time a real workspace mutation is
 * reported for this session. Idempotent (a no-op write once already `true`)
 * and, like `touchSandboxSessionActivity`, a no-op when the stored session is
 * missing or points at a different sandbox — a stale listener from a
 * swapped-out container must not stamp the new one.
 */
export function markSandboxSessionMutated(
  repoFullName: string | null | undefined,
  branch: string | null | undefined,
  sandboxId: string,
): boolean {
  const storageKey = buildSandboxSessionStorageKey(repoFullName, branch);
  if (!storageKey) return false;
  const existing = parsePersistedSandboxSession(safeStorageGet(storageKey));
  if (!existing || existing.sandboxId !== sandboxId) return false;
  if (existing.hasMutated === true) return true;
  return safeStorageSet(storageKey, JSON.stringify({ ...existing, hasMutated: true }));
}

/**
 * Whether a saved session is worth a reconnect probe. The container may have
 * survived even when its nominal age exceeds `maxAgeMs`: an actively-used
 * container keeps resetting CF's sleepAfter clock. So a session is recoverable
 * when it's young, was recently active, OR has a snapshot to restore from — and
 * is discarded outright only when it's old AND idle AND snapshot-less, where a
 * probe would almost certainly just confirm a dead container. `idleMs` is the
 * freshest of the in-memory activity clock and the persisted `lastActivityAt`.
 */
export function isSavedSessionRecoverable(args: {
  ageMs: number;
  idleMs: number;
  hasSnapshot: boolean;
  maxAgeMs: number;
  maxIdleMs?: number;
}): boolean {
  const { ageMs, idleMs, hasSnapshot, maxAgeMs, maxIdleMs = maxAgeMs } = args;
  if (hasSnapshot) return true;
  if (ageMs <= maxAgeMs) return true;
  if (idleMs <= maxIdleMs) return true;
  return false;
}

/** A record of the last auto-reconnect probe issued for a saved sandbox. */
export interface ReconnectAttempt {
  /** The saved sandbox id that was probed. */
  sandboxId: string;
  /** When the probe was issued (ms epoch). Set to `0` to force the cooldown open. */
  at: number;
  /** How many probes have been issued for this sandbox in the current burst. */
  attempts: number;
}

/**
 * Decide whether to (re-)probe a saved sandbox on the auto-reconnect path, and
 * with what attempt count. This is the spin-breaker: a *transient* probe failure
 * parks the hook's status back at 'idle' — the very trigger the reconnect effect
 * waits on — so without a cooldown it re-probes immediately, forever (and
 * keep-warm snapshots keep `isSavedSessionRecoverable` true, so the spin never
 * self-terminates). When the same sandbox was probed within `backoffMs`, skip;
 * otherwise probe and return the attempt record to persist. The attempt count
 * carries forward for the same sandbox (so the retry budget holds) and resets to
 * 1 for a different one.
 */
export function decideReconnectProbe(args: {
  savedSandboxId: string;
  prior: ReconnectAttempt | null;
  now: number;
  backoffMs: number;
}): { probe: boolean; nextAttempt: ReconnectAttempt } {
  const { savedSandboxId, prior, now, backoffMs } = args;
  if (prior !== null && prior.sandboxId === savedSandboxId) {
    if (now - prior.at < backoffMs) {
      return { probe: false, nextAttempt: prior };
    }
    return {
      probe: true,
      nextAttempt: { sandboxId: savedSandboxId, at: now, attempts: prior.attempts + 1 },
    };
  }
  return { probe: true, nextAttempt: { sandboxId: savedSandboxId, at: now, attempts: 1 } };
}

/**
 * Whether a transiently-failed reconnect should schedule another backoff retry.
 * Bounds the auto-retry burst to `maxAttempts` probes total; past that the
 * session is kept but left alone until a real trigger (user action, repo/branch
 * change) re-enters the reconnect path.
 */
export function shouldRetryReconnect(attempts: number, maxAttempts: number): boolean {
  return attempts < maxAttempts;
}
