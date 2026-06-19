/**
 * Client-side "the working tree was mutated" signal.
 *
 * Emitted at the sandbox client boundary when a write endpoint succeeds or an
 * exec path is explicitly marked `markWorkspaceMutated`. Two reasons it lives
 * here and not on the sandbox's `workspace_revision`:
 *
 *  - **Provider-agnostic.** It does not depend on the sandbox reporting an
 *    increasing revision. The Cloudflare provider returns `workspace_revision: 0`
 *    for exec/write paths, so a revision-based signal is dead on the default
 *    backend.
 *  - **Self-loop-free.** Internal git/auto-back operations explicitly suppress
 *    the client-side signal, so auto-back's own capture/push never wakes itself
 *    while ordinary mutating exec/write paths do.
 *
 * The B2 auto-back coordinator subscribes here and debounces a backup push.
 */
type WorkspaceMutationListener = (sandboxId: string) => void;
const listeners = new Set<WorkspaceMutationListener>();

/** Subscribe to working-tree mutations. Returns an unsubscribe fn. */
export function onWorkspaceMutation(listener: WorkspaceMutationListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Notify subscribers that the working tree was mutated in `sandboxId`. */
export function notifyWorkspaceMutation(sandboxId: string): void {
  for (const listener of listeners) {
    try {
      listener(sandboxId);
    } catch {
      // Observers must never break tool dispatch.
    }
  }
}
