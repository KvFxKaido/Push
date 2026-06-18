/**
 * Client-side "the working tree was mutated" signal.
 *
 * Emitted at tool dispatch (`executeSandboxToolCall`) when a file-mutation tool
 * — or a mutating `sandbox_exec` — completes successfully. Two reasons it lives
 * here and not on the sandbox's `workspace_revision`:
 *
 *  - **Provider-agnostic.** It does not depend on the sandbox reporting an
 *    increasing revision. The Cloudflare provider returns `workspace_revision: 0`
 *    for exec/write paths, so a revision-based signal is dead on the default
 *    backend.
 *  - **Self-loop-free.** It fires only from the tool dispatcher, on actual file
 *    mutations. Auto-back's own capture/push go through `execInSandbox` / the git
 *    backend directly (not the dispatcher), and push/commit aren't file
 *    mutations — so a backup never re-triggers itself.
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

/**
 * Whether a successfully-dispatched sandbox tool counts as a working-tree
 * mutation for auto-back. File-mutation tools always do; `sandbox_exec` does
 * when it's a mutating command (explicit flag, else the heuristic). Reads,
 * push, commit, branch ops, diff, etc. do not — push/commit change refs, not
 * working-tree files, and would otherwise self-trigger auto-back's own push.
 */
export function shouldSignalWorkspaceMutation(
  isFileMutationTool: boolean,
  opts: { isExec: boolean; execIsMutating: boolean },
): boolean {
  if (isFileMutationTool) return true;
  if (opts.isExec) return opts.execIsMutating;
  return false;
}
