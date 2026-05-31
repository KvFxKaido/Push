// AGENTS.md / CLAUDE.md / GEMINI.md content is user-controlled (repo owner writes it).
// We apply the same defense-in-depth as scratchpad and user bio:
//   1. Size cap — prevents context bloat / 413 errors
//   2. Delimiter escaping — zero-width space breaks block boundaries
const MAX_PROJECT_INSTRUCTIONS_SIZE = 8000;

/**
 * Canonical project-instructions block boundaries — the single source of truth
 * shared by the web and CLI orchestrators. The open marker carries an optional
 * `source="<file>"` provenance attribute, so consumers match on the prefix
 * (`[PROJECT_INSTRUCTIONS`) rather than a fixed string. Keeping these here (and
 * having the sanitizer escape the same form) means neither surface can drift on
 * the marker or ship content that forges the boundary.
 */
export const PROJECT_INSTRUCTIONS_OPEN_PREFIX = '[PROJECT_INSTRUCTIONS';
export const PROJECT_INSTRUCTIONS_CLOSE = '[/PROJECT_INSTRUCTIONS]';

/**
 * Sanitize project instructions before injection into prompts. Truncates to a
 * bounded size and escapes delimiter sequences so the content cannot break out
 * of its labeled block. `maxSize` lets each consumer keep its own budget (the
 * orchestrators use the 8000 default; the delegated-role agents pass tighter or
 * looser caps) while sharing the one escaping implementation.
 */
export function sanitizeProjectInstructions(
  raw: string,
  maxSize: number = MAX_PROJECT_INSTRUCTIONS_SIZE,
): string {
  // Defensive clamp on the public injection-defense boundary: a non-finite or
  // negative cap would silently disable truncation (`len > NaN` is always
  // false) or produce a negative-index slice with a nonsense omit-count. Fall
  // back to the default budget so the cap stays predictable regardless of input.
  const cap =
    Number.isFinite(maxSize) && maxSize >= 0 ? Math.floor(maxSize) : MAX_PROJECT_INSTRUCTIONS_SIZE;
  let content = raw;

  if (content.length > cap) {
    content =
      content.slice(0, cap) +
      `\n\n[Project instructions truncated — ${raw.length - cap} chars omitted]`;
  }

  // Break any block boundary the content tries to forge — both the canonical
  // underscore envelope (including an attribute-bearing open tag like
  // `[PROJECT_INSTRUCTIONS source="x"]`) and the legacy space form, so neither
  // surface's marker can be spoofed regardless of which one is in use.
  content = content
    .replace(/\[PROJECT_INSTRUCTIONS/gi, '[PROJECT_INSTRUCTIONS\u200B')
    .replace(/\[\/PROJECT_INSTRUCTIONS\]/gi, '[/PROJECT_INSTRUCTIONS\u200B]')
    .replace(/\[PROJECT INSTRUCTIONS\]/gi, '[PROJECT INSTRUCTIONS\u200B]')
    .replace(/\[\/PROJECT INSTRUCTIONS\]/gi, '[/PROJECT INSTRUCTIONS\u200B]');

  return content;
}

/** Strip characters that would let a `source` label break out of the
 *  `source="..."` attribute (filenames are safe in practice; defensive). */
function sanitizeSourceLabel(source: string | null | undefined): string | null {
  const trimmed = source?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/["\]\r\n]/g, '');
}

/**
 * Format a project-instructions block in the canonical envelope, with the
 * content sanitized (size-capped + delimiter-escaped). The single formatter
 * shared by the web and CLI orchestrators so both emit an identical, equally
 * defended block — previously the CLI wrapped raw content in the underscore
 * marker without escaping, while the web used a different (space) marker and
 * the delegated-role agents used a bespoke prose header with no escaping at all.
 * `source` records provenance (e.g. "AGENTS.md") when known; `maxSize` overrides
 * the default sanitizer budget for consumers with their own cap.
 */
export function formatProjectInstructionsBlock(
  rawContent: string,
  options: { source?: string | null; maxSize?: number } = {},
): string {
  const safe = sanitizeProjectInstructions(rawContent, options.maxSize);
  const source = sanitizeSourceLabel(options.source);
  const open = source
    ? `${PROJECT_INSTRUCTIONS_OPEN_PREFIX} source="${source}"]`
    : `${PROJECT_INSTRUCTIONS_OPEN_PREFIX}]`;
  return `${open}\n${safe}\n${PROJECT_INSTRUCTIONS_CLOSE}`;
}
