/**
 * Defense-in-depth helpers for content that originates from outside the agent
 * runtime (web search results, GitHub PR/issue/comment bodies, file reads,
 * sandbox_exec stdout, MCP tool output, etc.).
 *
 * The agent prompt uses square-bracket markers like `[TOOL_RESULT]`,
 * `[/TOOL_RESULT]`, `[meta]`, `[CODER_STATE]` as plain-text delimiters. If
 * untrusted content contains those literal sequences it can break out of its
 * envelope or spoof an infrastructure block.
 *
 * Mitigation: insert a zero-width space inside each marker so the literal
 * string no longer matches but the content remains visually identical to the
 * model. This is the same approach `sanitizeProjectInstructions` uses for
 * `[PROJECT INSTRUCTIONS]` boundaries.
 *
 * Pure module — no I/O, no dependencies. Safe for both Web and CLI.
 */

const ZWSP = '​';

// Markers that are used as block boundaries in agent prompts. Order matters
// for the closing-tag variants (`[/X]` must be replaced before `[X]` to avoid
// double-escaping).
const INFRASTRUCTURE_MARKERS: readonly string[] = [
  'TOOL_RESULT',
  'TOOL_DENIED',
  'TOOL_CALL_PARSE_ERROR',
  'CHECKPOINT RESPONSE',
  'CODER_STATE',
  'PROJECT INSTRUCTIONS',
  'POSTCONDITIONS',
  'SESSION_CAPABILITIES',
  'SCRATCHPAD',
  'COMMENT CHECK',
];

/**
 * Escape envelope-boundary sequences in untrusted content. Idempotent — the
 * zero-width space inserted on the first pass causes the regex to miss the
 * marker on subsequent passes, so calling this twice does not stack escapes.
 *
 * Use at every boundary where untrusted content (web search snippets,
 * stdout, file contents, GitHub bodies, MCP tool output) is concatenated
 * into an agent prompt.
 */
export function escapeEnvelopeBoundaries(text: string): string {
  if (!text) return text;
  let out = text;
  for (const marker of INFRASTRUCTURE_MARKERS) {
    // Closing tag first so we don't double-escape `[X]` inside `[/X]`.
    const closing = new RegExp(`\\[/${escapeRegex(marker)}\\]`, 'g');
    const opening = new RegExp(`\\[${escapeRegex(marker)}(?=[\\s\\]\\u2014\\-—])`, 'g');
    out = out.replace(closing, `[/${marker}${ZWSP}]`);
    out = out.replace(opening, `[${marker}${ZWSP}`);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Lighter-weight variant that ONLY escapes `[TOOL_RESULT]` / `[/TOOL_RESULT]`.
 * Suitable for the canonical envelope wrapper, which already wraps content in
 * `[TOOL_RESULT]` and only needs to ensure the close tag cannot appear inside
 * the body. Other markers are escaped at their own producers.
 */
export function escapeToolResultBoundaries(text: string): string {
  if (!text) return text;
  return text
    .replace(/\[\/TOOL_RESULT\]/g, `[/TOOL_RESULT${ZWSP}]`)
    .replace(/\[TOOL_RESULT(?=[\s\]—\-—])/g, `[TOOL_RESULT${ZWSP}`);
}

/**
 * Defang JSON tool-call shapes embedded in untrusted content. The prompt
 * protocol expects `{"tool": "name", "args": {...}}`. If a web search result
 * or GitHub comment contains such a shape and the model echoes it in its
 * next reply, the tool-call parser would extract and dispatch it.
 *
 * Defense: insert a zero-width space inside the `"tool"` key so the resulting
 * JSON parses to `{"tool​": ...}` (ZWSP-suffixed key) and fails validation.
 * The displayed text remains visually identical.
 *
 * Apply at sources where executable tool-call shapes are most dangerous —
 * web search snippets, sandbox_exec stdout/stderr, GitHub-API content, MCP
 * tool output. Skip on file reads where the agent legitimately reasons
 * about JSON file contents.
 */
export function defangJsonToolShapes(text: string): string {
  if (!text) return text;
  // Match `"tool"` (or `'tool'`) followed by optional whitespace and `:`.
  // The lookbehind ensures we don't escape an already-escaped key.
  return text.replace(/(["'])tool\1(\s*:)/g, `$1tool${ZWSP}$1$2`);
}

/**
 * Combined source-side sanitizer. Apply at any boundary where untrusted
 * external content enters the agent prompt (web, GitHub, sandbox stdout,
 * MCP). Escapes infrastructure-marker breakouts AND defangs embedded
 * tool-call JSON shapes.
 */
export function sanitizeUntrustedSource(text: string): string {
  return defangJsonToolShapes(escapeEnvelopeBoundaries(text));
}

export const INTERNAL_INFRASTRUCTURE_MARKERS = INFRASTRUCTURE_MARKERS;
