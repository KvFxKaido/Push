import { resolveToolName } from './tool-registry.js';

/** Compact, user-facing target extracted from a tool call's salient argument.
 *
 * Used by status UI, settled tool summaries, and run events. Keep this small:
 * it is intentionally a scannable label, not a full argument renderer.
 */
export function getToolTargetDetail(tool: string, rawArgs: unknown): string | undefined {
  const canonicalTool = resolveToolName(tool) ?? tool;
  const args = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {};

  if (canonicalTool === 'sandbox_exec') {
    return truncateDetail(asNonEmptyString(args.command), 60);
  }

  // Searches name what was searched FOR, not where. This runs ahead of the
  // `args.path` branch on purpose: `search_files` takes `{pattern, path?}`, and
  // the optional path is the haystack — "Searched src/" answers a question
  // nobody asked while dropping the term. The pattern is the point.
  //
  // Without this branch a `search_files` call fell all the way through to
  // `undefined`, and a settled search rendered as the nonsense "Searched a
  // search" — `formatToolTitle`'s no-target form pairing the verb with its own
  // noun. `web_search` was the only search this knew about.
  if (SEARCH_TOOLS.has(canonicalTool)) {
    const term = asNonEmptyString(args.pattern) ?? asNonEmptyString(args.query);
    if (term) return truncateDetail(term, 50);
  }

  if (typeof args.path === 'string') {
    return truncateDetail(asNonEmptyString(args.path), 60);
  }

  if (canonicalTool === 'delegate_coder' || canonicalTool === 'delegate_explorer') {
    return truncateDetail(asNonEmptyString(args.task), 50);
  }

  // Long-running exec sessions: `exec_start` carries the command, the rest
  // carry only a session id, which is not a user-facing label.
  if (canonicalTool === 'exec_start') {
    return truncateDetail(asNonEmptyString(args.command), 60);
  }

  if (canonicalTool === 'git_commit') {
    return truncateDetail(asNonEmptyString(args.message), 50);
  }

  if (canonicalTool === 'git_create_branch' || canonicalTool === 'create_branch') {
    return truncateDetail(asNonEmptyString(args.name), 50);
  }

  if (canonicalTool === 'fetch_url') {
    return truncateDetail(asNonEmptyString(args.url), 60);
  }

  return undefined;
}

/**
 * Tools whose salient argument is a search term. Canonical + CLI-native names:
 * the CLI's `search_files` / `grep` are not in `TOOL_SPECS` (see the note in
 * `tool-registry.ts`), so `resolveToolName` returns them unchanged and both
 * spellings must be listed.
 */
const SEARCH_TOOLS: ReadonlySet<string> = new Set([
  'search_files',
  'grep',
  'grep_file',
  'sandbox_search',
  'web_search',
]);

function asNonEmptyString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function truncateDetail(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined;
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}\u2026`;
}
