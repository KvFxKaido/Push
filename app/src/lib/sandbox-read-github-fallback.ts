/**
 * Read-tier fallback: map a cloud-sandbox read call to its GitHub-tier
 * equivalent so a read can degrade to GitHub when the sandbox is unavailable,
 * instead of dead-ending on `SANDBOX_UNREACHABLE`.
 *
 * This is the code-enforced half of the read-tier precedence decision
 * (docs/decisions/Agent Runtime Decisions.md §11): the contract guidance makes
 * GitHub the default explore surface; this makes the default *hold* even for a
 * non-cooperating model that calls a sandbox read anyway when the sandbox is
 * down.
 *
 * Scope:
 * - **Web/cloud-sandbox only.** The CLI daemon's local filesystem is its own
 *   reliable read substrate, so it has no equivalent fallback.
 * - Covers the sandbox reads with a clean GitHub-API analog: `read`/`search`/
 *   `list_dir`, plus `find_references` → GitHub code search (references ≈
 *   search hits for the symbol, scoped to its path). `read_symbols` has no
 *   GitHub-tier equivalent (its extractor runs as a Python script inside the
 *   sandbox), so it maps to `null` (no fallback) and the caller keeps the
 *   original sandbox error.
 * - The GitHub tier reads the branch's last **pushed** state, so a fallback
 *   read does not reflect uncommitted working-tree edits. That's acceptable
 *   here: the fallback only fires when the sandbox (the working-tree source) is
 *   unreachable, so pushed state is strictly better than failing — but callers
 *   should annotate the result so the model knows it isn't seeing dirty state.
 */
import { resolveToolName } from '@push/lib/tool-registry';
import type { ToolCall } from './github-tool-protocol';

/** Cloud-sandbox read tool → GitHub read tool, keyed by canonical name. */
const SANDBOX_TO_GITHUB_READ: Record<string, 'read_file' | 'search_files' | 'list_directory'> = {
  sandbox_read_file: 'read_file',
  sandbox_search: 'search_files',
  sandbox_list_dir: 'list_directory',
  // find_references is a scoped grep for a symbol — GitHub code search serves
  // the same intent (file + matching lines) without the sandbox.
  sandbox_find_references: 'search_files',
};

/**
 * Build the GitHub-tier call equivalent to a sandbox read, or `null` when there
 * is no clean equivalent (unmappable tool, missing repo, or required arg
 * absent). Pure — the caller executes the returned call and handles annotation.
 */
export function mapSandboxReadToGitHubCall(
  sandboxCall: { tool: string; args?: Record<string, unknown> },
  repo: string,
  branch?: string,
): ToolCall | null {
  if (!repo) return null;
  const canonical = resolveToolName(sandboxCall.tool) ?? sandboxCall.tool;
  const githubTool = SANDBOX_TO_GITHUB_READ[canonical];
  if (!githubTool) return null;

  const args = sandboxCall.args ?? {};
  switch (githubTool) {
    case 'read_file': {
      if (typeof args.path !== 'string') return null;
      const path = toRepoRelativePath(args.path);
      if (!path) return null; // the `/workspace` root is not a readable file
      return {
        tool: 'read_file',
        args: {
          repo,
          path,
          branch,
          start_line: typeof args.start_line === 'number' ? args.start_line : undefined,
          end_line: typeof args.end_line === 'number' ? args.end_line : undefined,
        },
      };
    }
    case 'search_files': {
      // sandbox_search carries `query`/`path`; sandbox_find_references carries
      // `symbol`/`scope`. Normalize both onto GitHub code search.
      const query = typeof args.query === 'string' ? args.query : args.symbol;
      if (typeof query !== 'string' || query.length === 0) return null;
      const pathArg = typeof args.path === 'string' ? args.path : args.scope;
      return {
        tool: 'search_files',
        args: { repo, query, path: repoRelativePathFilter(pathArg), branch },
      };
    }
    case 'list_directory': {
      return {
        tool: 'list_directory',
        args: { repo, path: repoRelativePathFilter(args.path), branch },
      };
    }
  }
}

/**
 * Sandbox paths are normalized to `/workspace/...` (see `normalizeSandboxPath`
 * in `sandbox-tool-utils.ts`), but the GitHub contents API addresses files
 * repo-relative. Strip the workspace prefix so a fallback read doesn't look for
 * a literal `workspace/` directory. Returns `''` for the workspace root.
 */
function toRepoRelativePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '/workspace' || trimmed === 'workspace' || trimmed === '/') return '';
  return trimmed.replace(/^\/?workspace\//, '').replace(/^\/+/, '');
}

/**
 * Repo-relative form of an optional path filter (search / list_dir): `undefined`
 * when the arg is absent or resolves to the repo root, so GitHub scopes to the
 * whole repo rather than a bogus `workspace/` path.
 */
function repoRelativePathFilter(path: unknown): string | undefined {
  if (typeof path !== 'string') return undefined;
  const rel = toRepoRelativePath(path);
  return rel === '' ? undefined : rel;
}
