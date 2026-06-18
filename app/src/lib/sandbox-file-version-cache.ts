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
const sandboxFileWorkspaceRevisions = new Map<string, number>();
const sandboxWorkspaceRevisions = new Map<string, number>();

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
  const key = fileVersionKey(sandboxId, path);
  sandboxFileVersions.delete(key);
  sandboxFileWorkspaceRevisions.delete(key);
}

export function getFileWorkspaceRevision(sandboxId: string, path: string): number | undefined {
  return sandboxFileWorkspaceRevisions.get(fileVersionKey(sandboxId, path));
}

export function setFileWorkspaceRevision(
  sandboxId: string,
  path: string,
  workspaceRevision: number,
): void {
  sandboxFileWorkspaceRevisions.set(fileVersionKey(sandboxId, path), workspaceRevision);
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
  sandboxFileWorkspaceRevisions.delete(key);
}

export function getWorkspaceRevisionByKey(key: string): number | undefined {
  return sandboxFileWorkspaceRevisions.get(key);
}

export function setWorkspaceRevisionByKey(key: string, workspaceRevision: number): void {
  sandboxFileWorkspaceRevisions.set(key, workspaceRevision);
}

export function getSandboxWorkspaceRevision(sandboxId: string): number | undefined {
  return sandboxWorkspaceRevisions.get(sandboxId);
}

/**
 * Mutation signal. The sandbox's workspace revision is the single chokepoint
 * every mutating exec funnels through (`setSandboxWorkspaceRevision` is called
 * from ~13 sites in `sandbox-client.ts`), and it only advances on a real
 * workspace mutation — a read-only exec reports the same revision. So a revision
 * *increase* is the one reliable "the working tree just changed" event. The B2
 * auto-back coordinator subscribes here and debounces a backup push; keeping the
 * emitter on the cache (a plain module) avoids inventing a parallel event bus.
 */
type WorkspaceMutationListener = (sandboxId: string, revision: number) => void;
const workspaceMutationListeners = new Set<WorkspaceMutationListener>();

/** Subscribe to workspace-revision increases (mutations). Returns unsubscribe. */
export function onWorkspaceMutation(listener: WorkspaceMutationListener): () => void {
  workspaceMutationListeners.add(listener);
  return () => {
    workspaceMutationListeners.delete(listener);
  };
}

export function setSandboxWorkspaceRevision(sandboxId: string, workspaceRevision: number): void {
  const prev = sandboxWorkspaceRevisions.get(sandboxId);
  sandboxWorkspaceRevisions.set(sandboxId, workspaceRevision);
  // Notify only on an increase — a mutation. The same revision (read-only exec)
  // or a lower one (new/reset sandbox, race) is not a mutation signal. A
  // listener throwing must never break revision bookkeeping.
  if (prev === undefined || workspaceRevision > prev) {
    for (const listener of workspaceMutationListeners) {
      try {
        listener(sandboxId, workspaceRevision);
      } catch {
        // swallow — revision tracking is load-bearing; observers are not.
      }
    }
  }
}

export function clearSandboxWorkspaceRevision(sandboxId?: string): void {
  if (!sandboxId) {
    sandboxWorkspaceRevisions.clear();
    return;
  }
  sandboxWorkspaceRevisions.delete(sandboxId);
}

/**
 * Clear all cached file versions for a given sandbox.
 * Call this when a sandbox is torn down or on branch switch
 * to prevent stale version entries from leaking across sessions.
 */
export function clearFileVersionCache(sandboxId?: string): void {
  if (!sandboxId) {
    sandboxFileVersions.clear();
    sandboxFileWorkspaceRevisions.clear();
    return;
  }
  const prefix = `${sandboxId}:`;
  for (const key of [...sandboxFileVersions.keys()]) {
    if (key.startsWith(prefix)) {
      sandboxFileVersions.delete(key);
    }
  }
  for (const key of [...sandboxFileWorkspaceRevisions.keys()]) {
    if (key.startsWith(prefix)) {
      sandboxFileWorkspaceRevisions.delete(key);
    }
  }
}
