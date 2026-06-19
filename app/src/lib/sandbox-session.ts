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
