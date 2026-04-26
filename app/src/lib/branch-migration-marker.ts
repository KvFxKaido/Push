import { safeStorageGet, safeStorageRemove, safeStorageSet } from './safe-storage';

const MARKER_STORAGE_KEY = 'push:branch-migration-marker';

export const MIGRATION_MARKER_STALE_MS = 5_000;

export interface BranchMigrationMarker {
  chatId: string;
  fromBranch: string;
  toBranch: string;
  startedAt: number;
}

function parseMigrationMarker(value: string | null): BranchMigrationMarker | null {
  if (!value) return null;

  try {
    const parsed: unknown = JSON.parse(value);
    if (!isBranchMigrationMarker(parsed)) return null;
    if (Date.now() - parsed.startedAt > MIGRATION_MARKER_STALE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isBranchMigrationMarker(value: unknown): value is BranchMigrationMarker {
  if (!value || typeof value !== 'object') return false;

  const marker = value as Partial<BranchMigrationMarker>;
  return (
    typeof marker.chatId === 'string' &&
    typeof marker.fromBranch === 'string' &&
    typeof marker.toBranch === 'string' &&
    typeof marker.startedAt === 'number' &&
    Number.isFinite(marker.startedAt)
  );
}

/** Write the marker. The forking tab calls this BEFORE updating any
 *  conversation/branch state to persistence. */
export function setMigrationMarker(input: Omit<BranchMigrationMarker, 'startedAt'>): void {
  const marker: BranchMigrationMarker = {
    ...input,
    startedAt: Date.now(),
  };

  const didWrite = safeStorageSet(MARKER_STORAGE_KEY, JSON.stringify(marker));
  if (!didWrite) {
    console.warn('Unable to write branch migration marker to localStorage.');
  }
}

/** Clear the marker. The forking tab calls this AFTER both writes settle
 *  (conversation update + currentBranch update). */
export function clearMigrationMarker(): void {
  safeStorageRemove(MARKER_STORAGE_KEY);
}

/** Read the marker. Returns null if missing OR stale (older than the
 *  staleness threshold; see MIGRATION_MARKER_STALE_MS). */
export function getMigrationMarker(): BranchMigrationMarker | null {
  return parseMigrationMarker(safeStorageGet(MARKER_STORAGE_KEY));
}

/** Subscribe to cross-tab marker changes. Calls back when a `storage` event
 *  fires for the marker key (set or clear in another tab). Returns an
 *  unsubscribe function. */
export function subscribeToMigrationMarker(
  callback: (marker: BranchMigrationMarker | null) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};

  const handleStorage = (event: StorageEvent): void => {
    if (event.key !== MARKER_STORAGE_KEY) return;
    callback(parseMigrationMarker(event.newValue));
  };

  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener('storage', handleStorage);
  };
}
