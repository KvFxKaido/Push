// AGENTS.md / CLAUDE.md / GEMINI.md content is user-controlled (repo owner writes it).
// We apply the same defense-in-depth as scratchpad and user bio:
//   1. Size cap — prevents context bloat / 413 errors
//   2. Delimiter escaping — zero-width space breaks block boundaries
const MAX_PROJECT_INSTRUCTIONS_SIZE = 8000;

/**
 * Sanitize project instructions before injection into prompts. Truncates to a
 * bounded size and escapes delimiter sequences so the content cannot break out
 * of its labeled block.
 */
export function sanitizeProjectInstructions(raw: string): string {
  let content = raw;

  if (content.length > MAX_PROJECT_INSTRUCTIONS_SIZE) {
    content =
      content.slice(0, MAX_PROJECT_INSTRUCTIONS_SIZE) +
      `\n\n[Project instructions truncated — ${raw.length - MAX_PROJECT_INSTRUCTIONS_SIZE} chars omitted]`;
  }

  content = content
    .replace(/\[PROJECT INSTRUCTIONS\]/gi, '[PROJECT INSTRUCTIONS\u200B]')
    .replace(/\[\/PROJECT INSTRUCTIONS\]/gi, '[/PROJECT INSTRUCTIONS\u200B]');

  return content;
}
