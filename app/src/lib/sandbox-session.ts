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
  /** Snapshot ID from a prior hibernate. Used to restore when the container is gone. */
  snapshotId?: string;
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
    if (!session.sandboxId || !session.ownerToken || !session.branch || !session.createdAt) {
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
