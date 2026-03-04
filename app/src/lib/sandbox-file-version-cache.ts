/**
 * In-memory cache of file version hashes (SHA-256) per sandbox+path.
 *
 * Used by sandbox-tools to pass `expected_version` on writes (stale-write
 * detection) and by useSandbox to clear the cache on teardown / branch switch.
 *
 * Kept as a standalone module so that useSandbox doesn't need to import the
 * large sandbox-tools barrel.
 */

const sandboxFileVersions = new Map<string, string>();

export function fileVersionKey(sandboxId: string, path: string): string {
  return `${sandboxId}:${path}`;
}

export function getFileVersion(sandboxId: string, path: string): string | undefined {
  return sandboxFileVersions.get(fileVersionKey(sandboxId, path));
}

export function setFileVersion(sandboxId: string, path: string, version: string): void {
  sandboxFileVersions.set(fileVersionKey(sandboxId, path), version);
}

export function deleteFileVersion(sandboxId: string, path: string): void {
  sandboxFileVersions.delete(fileVersionKey(sandboxId, path));
}

/** Key-based accessors for callers that pre-compute the cache key. */
export function getByKey(key: string): string | undefined {
  return sandboxFileVersions.get(key);
}

export function setByKey(key: string, version: string): void {
  sandboxFileVersions.set(key, version);
}

export function deleteByKey(key: string): void {
  sandboxFileVersions.delete(key);
}

/**
 * Clear all cached file versions for a given sandbox.
 * Call this when a sandbox is torn down or on branch switch
 * to prevent stale version entries from leaking across sessions.
 */
export function clearFileVersionCache(sandboxId?: string): void {
  if (!sandboxId) {
    sandboxFileVersions.clear();
    return;
  }
  const prefix = `${sandboxId}:`;
  for (const key of [...sandboxFileVersions.keys()]) {
    if (key.startsWith(prefix)) {
      sandboxFileVersions.delete(key);
    }
  }
}
