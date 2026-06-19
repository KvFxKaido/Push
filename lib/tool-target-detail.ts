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

  if (typeof args.path === 'string') {
    return truncateDetail(asNonEmptyString(args.path), 60);
  }

  if (canonicalTool === 'delegate_coder' || canonicalTool === 'delegate_explorer') {
    return truncateDetail(asNonEmptyString(args.task), 50);
  }

  if (canonicalTool === 'web_search') {
    return truncateDetail(asNonEmptyString(args.query), 50);
  }

  return undefined;
}

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
