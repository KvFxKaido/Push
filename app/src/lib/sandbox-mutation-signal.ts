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
 * Tools that run a command which can touch tracked files even though they aren't
 * "file-mutation" tools:
 *  - verification tools run build/test commands (a lockfile from `npm install`);
 *  - `sandbox_prepare_commit` runs the repo's `.git/hooks/pre-commit` (a
 *    formatter / codegen hook can rewrite tracked files before the audit).
 * Their typical incidental writes (node_modules, caches) are .gitignored, so the
 * backup capture's tree comparison makes those a no-op — but a real tracked-file
 * change (lockfile, formatter rewrite) must signal.
 */
const WORKSPACE_MUTATING_TOOLS = new Set([
  'sandbox_run_tests',
  'sandbox_check_types',
  'sandbox_verify_workspace',
  'sandbox_prepare_commit',
]);

/**
 * Whether a dispatched sandbox tool *may* have mutated the working tree, and so
 * should signal auto-back. Deliberately conservative — it fires on the attempt,
 * not on success, because a tool can mutate then error (a partial patchset; an
 * exec that ran before the sandbox went unreachable). The backup capture's
 * tree-vs-HEAD comparison is the authoritative filter: if nothing actually
 * changed, the backup is a cheap no-op. File-mutation tools, the
 * command-running verification tools, and a mutating `sandbox_exec` qualify;
 * reads, push, commit, branch ops, diff do not (push/commit change refs, not
 * working-tree files, and would otherwise self-trigger auto-back's own push).
 */
export function shouldSignalWorkspaceMutation(
  toolName: string,
  opts: { isFileMutationTool: boolean; isExec: boolean; execIsMutating: boolean },
): boolean {
  if (opts.isFileMutationTool) return true;
  if (WORKSPACE_MUTATING_TOOLS.has(toolName)) return true;
  if (opts.isExec) return opts.execIsMutating;
  return false;
}
