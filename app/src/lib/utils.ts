import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { asRecord, streamWithTimeout } from '@push/lib/stream-utils';
import type { JsonRecord } from '@push/lib/stream-utils';

export { asRecord, streamWithTimeout };
export type { JsonRecord };

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------------------
// Relative time formatting (previously duplicated across 7 files)
// ---------------------------------------------------------------------------

/**
 * Format an ISO date string as a relative time label.
 * Includes "just now", minutes, hours, days, months, and falls back to locale date.
 */
export function timeAgo(dateStr: string): string {
  if (!dateStr) return '';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

/**
 * Compact variant for timestamps (epoch ms).
 * Omits "ago" suffix — used by chat/history UI.
 */
export function timeAgoCompact(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

// ---------------------------------------------------------------------------
// Card shell — shared class string for all inline cards
// ---------------------------------------------------------------------------

export const CARD_SHELL_CLASS =
  'my-2.5 max-w-full overflow-hidden rounded-[20px] border border-push-edge/80 bg-[linear-gradient(180deg,rgba(11,15,22,0.96)_0%,rgba(6,9,14,0.98)_100%)] shadow-[0_16px_36px_rgba(0,0,0,0.4),0_3px_10px_rgba(0,0,0,0.2)] backdrop-blur-xl';

export const CARD_PANEL_CLASS =
  'rounded-[18px] border border-push-edge/70 bg-[linear-gradient(180deg,rgba(9,13,19,0.88)_0%,rgba(5,8,13,0.94)_100%)] shadow-[0_12px_26px_rgba(0,0,0,0.26),0_2px_8px_rgba(0,0,0,0.14)]';

export const CARD_PANEL_SUBTLE_CLASS = 'rounded-[16px] border border-push-edge/70 bg-black/10';

export const CARD_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-1.5 rounded-full border border-push-edge-subtle bg-push-grad-input px-3 text-push-sm font-medium text-push-fg-secondary shadow-[0_10px_24px_rgba(0,0,0,0.26),0_2px_8px_rgba(0,0,0,0.14)] backdrop-blur-xl transition-all duration-200 hover:border-push-edge-hover hover:text-push-fg hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50';

export const CARD_ICON_BUTTON_CLASS =
  'inline-flex items-center justify-center rounded-full border border-push-edge-subtle bg-push-grad-input text-push-fg-dim shadow-[0_10px_24px_rgba(0,0,0,0.24),0_2px_8px_rgba(0,0,0,0.12)] backdrop-blur-xl transition-all duration-200 hover:border-push-edge-hover hover:text-push-fg hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50';

export const CARD_INPUT_CLASS =
  'w-full rounded-[18px] border border-push-edge-subtle bg-push-grad-input px-3 py-2 text-push-base text-push-fg font-mono placeholder:text-push-fg-dim shadow-[0_10px_24px_rgba(0,0,0,0.22)] outline-none transition-all focus:border-push-sky/50';

// ---------------------------------------------------------------------------
// Card status palette — shared across card components
// ---------------------------------------------------------------------------

export const CARD_TEXT_SUCCESS = 'text-push-status-success';
export const CARD_TEXT_ERROR = 'text-push-status-error';
export const CARD_TEXT_WARNING = 'text-push-status-warning';

/** Pill badge (opacity /15) — inline status tags e.g. "Open", "SAFE". */
export const CARD_BADGE_SUCCESS = 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-300';
export const CARD_BADGE_ERROR = 'border border-red-500/20 bg-red-500/10 text-red-300';
export const CARD_BADGE_WARNING = 'border border-yellow-500/20 bg-yellow-500/10 text-yellow-300';
export const CARD_BADGE_INFO = 'border border-push-edge/70 bg-black/10 text-[#9db8df]';

/** Header background band (opacity /10) — used for card header rows. */
export const CARD_HEADER_BG_SUCCESS =
  'bg-[linear-gradient(180deg,rgba(17,61,42,0.18)_0%,rgba(8,28,20,0.34)_100%)]';
export const CARD_HEADER_BG_ERROR =
  'bg-[linear-gradient(180deg,rgba(70,23,23,0.18)_0%,rgba(31,11,11,0.34)_100%)]';
export const CARD_HEADER_BG_WARNING =
  'bg-[linear-gradient(180deg,rgba(68,52,16,0.18)_0%,rgba(31,23,8,0.34)_100%)]';
export const CARD_HEADER_BG_INFO =
  'bg-[linear-gradient(180deg,rgba(20,34,52,0.18)_0%,rgba(9,18,31,0.34)_100%)]';

/** Divider list container — applies divide-y/border token in one constant. */
export const CARD_LIST_CLASS = 'divide-y divide-push-edge/80';

// ---------------------------------------------------------------------------
// Network error detection (previously duplicated in auth hooks)
// ---------------------------------------------------------------------------

export function isNetworkFetchError(err: unknown): boolean {
  return err instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(err.message);
}

// ---------------------------------------------------------------------------
// GitHub token validation (previously duplicated in auth hooks)
// ---------------------------------------------------------------------------

export async function validateGitHubToken(
  token: string,
): Promise<{ login: string; avatar_url: string } | null> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { login: data.login, avatar_url: data.avatar_url };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CI / Workflow status colors (previously duplicated across 3 card files)
// ---------------------------------------------------------------------------

export function ciStatusColor(status: string | null): string {
  switch (status) {
    case 'success':
      return 'text-push-status-success';
    case 'failure':
      return 'text-push-status-error';
    case 'pending':
      return 'text-push-status-warning';
    default:
      return 'text-push-fg-secondary';
  }
}

export function ciStatusBg(status: string | null): string {
  switch (status) {
    case 'success':
      return CARD_HEADER_BG_SUCCESS;
    case 'failure':
      return CARD_HEADER_BG_ERROR;
    case 'pending':
      return CARD_HEADER_BG_WARNING;
    default:
      return CARD_HEADER_BG_INFO;
  }
}

// ---------------------------------------------------------------------------
// JSON syntax error diagnosis — pinpoints *what* is wrong with malformed JSON
// ---------------------------------------------------------------------------

export interface JsonSyntaxDiagnosis {
  /** Human-readable description of the syntax error. */
  message: string;
  /** Approximate character position (0-based) where the error was detected. */
  position: number | null;
}

/**
 * Diagnose why a JSON string fails to parse. Returns a human-readable
 * description of the first syntax error found. Falls back to the native
 * JSON.parse error message if no specific pattern is detected.
 *
 * This is NOT a repair function — it only describes the problem.
 */
export function diagnoseJsonSyntaxError(text: string): JsonSyntaxDiagnosis | null {
  // If it actually parses, there's no error to diagnose
  try {
    JSON.parse(text);
    return null;
  } catch {
    /* expected */
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { message: 'Empty input — expected a JSON object.', position: 0 };
  }

  // Missing opening brace — starts with "tool" or key-like pattern
  if (/^["']?tool["']?\s*:/.test(trimmed)) {
    return {
      message: 'Missing opening brace `{` — JSON object must start with `{`.',
      position: 0,
    };
  }

  // Starts with something other than { (e.g. a stray character)
  if (trimmed[0] !== '{' && trimmed[0] !== '[') {
    return {
      message: `Unexpected character \`${trimmed[0]}\` at start — JSON object must start with \`{\`.`,
      position: 0,
    };
  }

  // Scan for specific structural errors
  let inString = false;
  let escaped = false;
  let depth = 0;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;

    if (depth < 0) {
      return {
        message: `Extra closing \`${ch}\` at position ${i} — no matching opening bracket.`,
        position: i,
      };
    }
  }

  // Unterminated string
  if (inString) {
    return {
      message: 'Unterminated string — a `"` was opened but never closed.',
      position: null,
    };
  }

  // Unbalanced braces/brackets
  if (depth > 0) {
    return {
      message: `Unbalanced braces — ${depth} unclosed \`{\` or \`[\`. Add ${depth} closing brace(s).`,
      position: trimmed.length,
    };
  }

  // Fall back to native error message
  try {
    JSON.parse(trimmed);
  } catch (e) {
    const nativeMsg = e instanceof SyntaxError ? e.message : 'Unknown JSON syntax error';
    return { message: nativeMsg, position: null };
  }

  return null;
}

// ---------------------------------------------------------------------------
// JSON repair — best-effort recovery for common LLM garbling patterns
// Only runs when JSON.parse fails (fallback, not hot path).
// ---------------------------------------------------------------------------

/**
 * Attempt to repair common JSON garbling from LLM output.
 * Returns the parsed object if it has a "tool" string key, otherwise null.
 *
 * Handles:
 * - Trailing commas before } or ]
 * - Double commas (model stutter): {,, → {,
 * - Single quotes (only when no double quotes present in value positions)
 * - Unquoted keys: {tool: "x"} → {"tool": "x"}
 * - Python-style literals: True/False/None → true/false/null
 * - Raw control characters inside strings (strip or escape)
 * - Auto-close truncated JSON (missing trailing braces/brackets)
 */
export function repairToolJson(candidate: string): Record<string, unknown> | null {
  let repaired = candidate.trim();

  // 0. Missing opening brace — model emitted `"tool": "x", "args": {...}}`
  //    or `tool: "x", args: {...}}` without the leading `{`.
  if (!repaired.startsWith('{') && /^["']?tool["']?\s*:/.test(repaired)) {
    repaired = '{' + repaired;
  }

  // 1. Strip trailing commas before } or ]
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');

  // 2. Double commas (model stutter under stream pressure)
  repaired = repaired.replace(/,(\s*),/g, ',');

  // 3. Single quotes → double quotes (only if string uses single-quote style throughout)
  if (repaired.includes("'") && !/"\s*:/.test(repaired)) {
    repaired = repaired.replace(/'/g, '"');
  }

  // 4. Unquoted keys: {tool: "x", args: {...}} → {"tool": "x", "args": {...}}
  repaired = repaired.replace(/([{,])\s*([a-zA-Z_]\w*)\s*:/g, '$1"$2":');

  // 5. Python-style literals (outside of quoted strings)
  repaired = replacePythonLiterals(repaired);

  // 6. Raw control characters inside strings (tabs OK, strip others)
  // eslint-disable-next-line no-control-regex
  repaired = repaired.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

  if (tryParseToolJson(repaired)) return tryParseToolJson(repaired);

  // 6b. Raw newlines/tabs inside JSON string values — escape them.
  // Models often emit multi-line content with literal newlines inside
  // JSON strings (e.g. search/replace content with template literals).
  // This must run after the initial parse attempt to avoid double-escaping
  // well-formed JSON.
  const rawNewlineEscaped = escapeRawNewlinesInJsonStrings(repaired);
  if (rawNewlineEscaped !== repaired) {
    if (tryParseToolJson(rawNewlineEscaped)) return tryParseToolJson(rawNewlineEscaped);
    repaired = rawNewlineEscaped;
  }

  // 7. Auto-close truncated JSON — if braces/brackets are unbalanced,
  //    try appending closing characters. Only safe when the opening looks
  //    like a tool call (has "tool" key pattern).
  const autoClosed = tryAutoCloseJson(repaired);
  if (autoClosed) return autoClosed;

  return null;
}

/**
 * Replace Python-style True/False/None with JSON equivalents,
 * but only when they appear outside of quoted strings.
 */
function replacePythonLiterals(text: string): string {
  // Only bother if any Python-style literal is present
  if (!/\b(?:True|False|None)\b/.test(text)) return text;
  // Replace outside of strings: scan character-by-character
  let result = '';
  let inString = false;
  let escaped = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (escaped) {
      result += ch;
      escaped = false;
      i++;
      continue;
    }
    if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      i++;
      continue;
    }
    if (inString) {
      result += ch;
      i++;
      continue;
    }
    // Outside string — check for Python literals
    if (text.startsWith('True', i) && !/\w/.test(text[i + 4] || '')) {
      result += 'true';
      i += 4;
      continue;
    }
    if (text.startsWith('False', i) && !/\w/.test(text[i + 5] || '')) {
      result += 'false';
      i += 5;
      continue;
    }
    if (text.startsWith('None', i) && !/\w/.test(text[i + 4] || '')) {
      result += 'null';
      i += 4;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

/**
 * Escape raw (unescaped) newlines, carriage returns, and tabs inside JSON
 * string values so that JSON.parse succeeds. Walks the string character-by-
 * character tracking quote/escape state.
 *
 * This handles the common LLM pattern of emitting multi-line content with
 * literal newlines inside JSON strings, e.g.:
 *   {"tool": "replace", "args": {"search": "line1
 *   line2", "replace": "fixed"}}
 */
function escapeRawNewlinesInJsonStrings(text: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && !escaped) {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString) {
      if (ch === '\n') {
        result += escaped ? 'n' : '\\n';
        escaped = false;
        continue;
      }
      if (ch === '\r') {
        result += escaped ? 'r' : '\\r';
        escaped = false;
        continue;
      }
      if (ch === '\t') {
        result += escaped ? 't' : '\\t';
        escaped = false;
        continue;
      }
    }
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
      continue;
    }
    result += ch;
  }
  return result;
}

/**
 * Try JSON.parse and return a tool object or null.
 */
function tryParseToolJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && typeof parsed.tool === 'string') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // parse failed
  }
  return null;
}

/**
 * Try to auto-close truncated JSON by appending missing closing braces/brackets.
 * Only attempts this if the text starts with `{` and contains a "tool" key pattern,
 * and the depth is small (≤ 3 unmatched openers) to avoid nonsensical recovery.
 */
function tryAutoCloseJson(text: string): Record<string, unknown> | null {
  if (!text.startsWith('{')) return null;
  // Quick check for tool-call shape
  if (!/["']tool["']\s*:/.test(text)) return null;

  // Count unbalanced braces/brackets (respecting strings)
  const stack: ('{' | '[')[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') stack.push('{');
    if (ch === '[') stack.push('[');
    if (ch === '}') {
      if (stack.length && stack[stack.length - 1] === '{') stack.pop();
    }
    if (ch === ']') {
      if (stack.length && stack[stack.length - 1] === '[') stack.pop();
    }
  }

  if (stack.length === 0 || stack.length > 3) return null;

  // If we're inside a string (unmatched quote), close the string first
  let suffix = '';
  if (inString) suffix += '"';
  // Close openers in reverse order
  for (let i = stack.length - 1; i >= 0; i--) {
    suffix += stack[i] === '{' ? '}' : ']';
  }

  return tryParseToolJson(text + suffix);
}

/**
 * Detect if text ends with a truncated tool call (unbalanced braces after
 * a {"tool" pattern). Returns the tool name if found.
 */
export function detectTruncatedToolCall(text: string): { toolName: string } | null {
  // Find the last occurrence of a tool-call-like pattern
  const toolPattern = /\{\s*"?'?tool"?'?\s*:\s*["']([^"']+)["']/g;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;

  while ((m = toolPattern.exec(text)) !== null) {
    lastMatch = m;
  }

  if (!lastMatch) return null;

  // Check if braces are unbalanced from that point (depth > 0 = truncated)
  const remainder = text.slice(lastMatch.index);
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const ch of remainder) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') depth--;
  }

  if (depth > 0) {
    return { toolName: lastMatch[1] };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Bare JSON extraction (brace-counting, moved from tool-dispatch.ts)
// ---------------------------------------------------------------------------

/**
 * Extract bare JSON objects containing a "tool" key from text.
 * Uses brace-counting instead of regex so nested objects like
 * {"tool":"x","args":{"repo":"a/b","path":"c"}} are captured correctly.
 */
export function extractBareToolJsonObjects(text: string): unknown[] {
  const results: unknown[] = [];
  let i = 0;

  while (i < text.length) {
    const braceIdx = text.indexOf('{', i);
    if (braceIdx === -1) break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let j = braceIdx; j < text.length; j++) {
      const ch = text[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }

    if (end === -1) {
      i = braceIdx + 1;
      continue;
    }

    const candidate = text.slice(braceIdx, end + 1);
    try {
      const parsed = JSON.parse(candidate);
      const parsedObj = asRecord(parsed);
      if (parsedObj && typeof parsedObj.tool === 'string') {
        results.push(parsed);
      }
    } catch {
      // Not valid JSON — try repair
      const repaired = repairToolJson(candidate);
      if (repaired) {
        results.push(repaired);
      }
    }

    i = end + 1;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Fenced-JSON tool detection factory (previously duplicated 7+ times)
// ---------------------------------------------------------------------------

/**
 * Generic tool detection: scans text for fenced JSON blocks and bare JSON,
 * delegates validation to the provided `validate` function.
 *
 * Supports:
 * - Triple-backtick fences (```) with optional language hint
 * - 4+ backtick fences (some models use ```` for nesting)
 * - Tilde fences (~~~) per CommonMark
 * - Prose-surrounded JSON within fenced blocks (extracts the JSON object)
 */
export function detectToolFromText<T>(
  text: string,
  validate: (parsed: unknown) => T | null,
): T | null {
  // Match backtick fences (3+), optional language hint, and tilde fences (3+)
  const fenceRegex =
    /(?:`{3,}|~{3,})(?:json[c5]?|tool|javascript)?\s*\n?([\s\S]*?)\n?\s*(?:`{3,}|~{3,})/g;
  let match;

  while ((match = fenceRegex.exec(text)) !== null) {
    const content = match[1].trim();

    // Phase 1: Direct JSON.parse
    try {
      const parsed = JSON.parse(content);
      const result = validate(parsed);
      if (result) return result;
    } catch {
      // Phase 2: JSON repair on fenced content
      const repaired = repairToolJson(content);
      if (repaired) {
        const result = validate(repaired);
        if (result) return result;
      }

      // Phase 3: Prose-surrounded JSON — model put explanatory text around
      // the JSON inside the fence. Extract the JSON object from within.
      const innerObjects = extractBareToolJsonObjects(content);
      for (const innerParsed of innerObjects) {
        const result = validate(innerParsed);
        if (result) return result;
      }
    }
  }

  for (const parsed of extractBareToolJsonObjects(text)) {
    const result = validate(parsed);
    if (result) return result;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Streaming timeout helper (previously duplicated in auditor/coder agents)
// ---------------------------------------------------------------------------

/** Format milliseconds into a human-friendly duration string (e.g. "1m 23s"). */
export function formatElapsedTime(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

// streamWithTimeout is re-exported at the top of this file from
// @push/lib/stream-utils.
