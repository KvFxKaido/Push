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

// Use the explicit unicode escape rather than a literal zero-width space —
// matches the convention in `sanitizeProjectInstructions` and stays visible
// in diffs/editors.
const ZWSP = '\u200B';

// Markers that are used as block boundaries OR single-line telemetry tags in
// agent prompts. Both block markers (`[X]…[/X]`) and inline telemetry tags
// (`[meta] …`, `[pulse] …`, `[SESSION_RESUMED] …`) are listed here — the
// regex below handles both. Order matters for closing-tag variants: `[/X]` is
// replaced before `[X]` to avoid double-escaping.
//
// Sourced from `lib/system-prompt-sections.ts` (the canonical inventory).
// `[CODER_STATE delta]` is covered by the `CODER_STATE` entry — the open
// regex matches `[CODER_STATE` followed by whitespace.
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
  'FILE_AWARENESS',
  'SANDBOX_ENVIRONMENT',
  'SESSION_RESUMED',
  'RETRIEVED_FACTS',
  'RETRIEVED_TASK_MEMORY',
  'RETRIEVED_VERIFICATION',
  'STALE_CONTEXT',
  'meta',
  'pulse',
];

// Pre-compile regex pairs once at module load. Both forms are anchored so an
// already-escaped marker (containing the trailing ZWSP) is not re-matched,
// keeping the helpers idempotent.
const MARKER_REGEXES: ReadonlyArray<{
  closing: RegExp;
  opening: RegExp;
  marker: string;
}> = INFRASTRUCTURE_MARKERS.map((marker) => ({
  marker,
  closing: new RegExp(`\\[/${escapeRegex(marker)}\\]`, 'g'),
  // Lookahead allows the marker to be terminated by whitespace, the closing
  // bracket, em-dash (U+2014), en-dash (U+2013), or ASCII hyphen — covering
  // both `[TOOL_RESULT — ...]` and `[meta] round=…` shapes.
  opening: new RegExp(`\\[${escapeRegex(marker)}(?=[\\s\\]\\u2013\\u2014-])`, 'g'),
}));

const TOOL_RESULT_CLOSE_REGEX = /\[\/TOOL_RESULT\]/g;
const TOOL_RESULT_OPEN_REGEX = /\[TOOL_RESULT(?=[\s\]–—-])/g;

const QUOTED_TOOL_KEY_REGEX = /(["'])tool\1(\s*:)/g;
// Unquoted-key form `{tool: "x"}` — applyJsonTextRepairs in the parser
// quotes unquoted identifiers, so this shape would otherwise survive the
// quoted-key defang and reach validation. Match `tool` only when not
// preceded by an identifier character (so we don't mangle words like
// `mytool` or `tooling`).
const UNQUOTED_TOOL_KEY_REGEX = /(?<![A-Za-z0-9_])tool(?=\s*:)/g;

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
  for (const { marker, closing, opening } of MARKER_REGEXES) {
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
    .replace(TOOL_RESULT_CLOSE_REGEX, `[/TOOL_RESULT${ZWSP}]`)
    .replace(TOOL_RESULT_OPEN_REGEX, `[TOOL_RESULT${ZWSP}`);
}

/**
 * Defang JSON tool-call shapes embedded in untrusted content. The prompt
 * protocol expects `{"tool": "name", "args": {...}}`. If a web search result
 * or GitHub comment contains such a shape and the model echoes it in its
 * next reply, the tool-call parser would extract and dispatch it.
 *
 * Two forms are covered:
 *  - Quoted key:   `"tool":` / `'tool':` → ZWSP suffix on the key string
 *  - Unquoted key: `{tool:` / `, tool:` → ZWSP suffix on the identifier
 *
 * Both are needed because `applyJsonTextRepairs` in the parser quotes
 * unquoted identifiers before validation, so the unquoted form would
 * otherwise be re-quoted and accepted as a valid tool call.
 *
 * The defanged JSON still parses but the validator's
 * `typeof parsed.tool === 'string'` check fails because the key is
 * `tool​` rather than `tool`.
 *
 * Apply at sources where executable tool-call shapes are most dangerous —
 * web search snippets, sandbox_exec stdout/stderr, GitHub-API content, MCP
 * tool output. Skip on file reads where the agent legitimately reasons
 * about JSON file contents.
 */
export function defangJsonToolShapes(text: string): string {
  if (!text) return text;
  return text
    .replace(QUOTED_TOOL_KEY_REGEX, `$1tool${ZWSP}$1$2`)
    .replace(UNQUOTED_TOOL_KEY_REGEX, `tool${ZWSP}`);
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
