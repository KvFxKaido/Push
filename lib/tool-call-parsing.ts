/**
 * Pure text → tool-call JSON parsing primitives.
 *
 * Originally lived in `app/src/lib/utils.ts`. Moved here so any lib/-side
 * module that needs to parse or repair tool-call JSON can reach them
 * without importing the Web utils bundle (tailwind classes, GitHub token
 * validation, etc). These functions are deliberately *tool-agnostic* in
 * the sense that they don't know about any specific tool source (github,
 * sandbox, scratchpad, etc.) — they only understand the tool-call wrapper
 * shape `{"tool": "...", "args": {...}}`.
 *
 * Higher-level tool-typed detection now has two layers:
 *
 *   - `lib/tool-dispatch.ts` owns the shared `createToolDispatcher` kernel
 *     the CLI routes through. It handles fence extraction, bare-object
 *     fallback (the fix for the "empty TUI on daemon" convergence-gap
 *     bug), parse + repair, dedup, and malformed reporting.
 *
 *   - `app/src/lib/tool-dispatch.ts` still owns the Web-side
 *     `detectAnyToolCall` / `detectAllToolCalls` / `diagnoseToolCallFailure`
 *     implementations because the Web result shape groups calls by
 *     execution phase (readOnly / fileMutations / mutating /
 *     extraMutations) rather than returning a flat list. Unifying the Web
 *     path on top of `createToolDispatcher` is a future convergence
 *     tranche — see docs/decisions/Tool-Call Parser Convergence Gap.md.
 */

import { asRecord } from './stream-utils.js';

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
 * Apply the textual JSON repairs the tool-call parsers use, without
 * any final shape check. Useful for callers that want to recover a
 * parseable JSON value without committing to the `{tool, args}`
 * object shape — e.g., the array-wrapped tool-call path in
 * `lib/tool-dispatch.ts`'s `parseToolArrayCandidate`.
 *
 * Handles the high-frequency LLM garbling patterns:
 * - Trailing commas before `}` or `]`
 * - Double commas (model stutter under stream pressure)
 * - Single quotes (only when no double-quoted keys present)
 * - Unquoted keys (`{tool: "x"}` → `{"tool": "x"}`)
 * - Python-style literals (`True`/`False`/`None` → `true`/`false`/`null`)
 * - Raw control characters inside strings (stripped, except tabs)
 *
 * Excludes the object-specific repairs that `repairToolJson` layers on
 * top: the missing-`{` prepend (step 0) and the auto-close pass
 * (step 7). Callers handle those shape-specifically.
 *
 * Excludes the raw-newline-in-string escape (step 6b): that pass
 * MUST run after the initial parse attempt to avoid double-escaping
 * well-formed JSON, so it stays in `repairToolJson` and any sibling
 * function that wants it.
 */
export function applyJsonTextRepairs(text: string): string {
  let repaired = text;
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
  return repaired;
}

/**
 * Attempt to repair common JSON garbling from LLM output.
 * Returns the parsed object if it has a "tool" string key, otherwise null.
 *
 * Handles:
 * - Missing opening brace (`"tool": "x"` → `{"tool": "x"}`)
 * - All shape-agnostic textual repairs from `applyJsonTextRepairs`
 * - Raw newlines inside JSON string values (escape after first parse)
 * - Auto-close truncated JSON (missing trailing braces/brackets)
 */
export function repairToolJson(candidate: string): Record<string, unknown> | null {
  let repaired = candidate.trim();

  // 0. Missing opening brace — model emitted `"tool": "x", "args": {...}}`
  //    or `tool: "x", args: {...}}` without the leading `{`. This is
  //    object-specific (the array analogue would be much rarer and would
  //    require a `[` prepend with no `tool` substring marker), so it
  //    stays in repairToolJson rather than the shared helper.
  if (!repaired.startsWith('{') && /^["']?tool["']?\s*:/.test(repaired)) {
    repaired = '{' + repaired;
  }

  // Steps 1-6: shape-agnostic textual repairs.
  repaired = applyJsonTextRepairs(repaired);

  if (tryParseToolJson(repaired)) return tryParseToolJson(repaired);

  // 6b. Raw newlines/tabs inside JSON string values — escape them.
  // Models often emit multi-line content with literal newlines inside
  // JSON strings (e.g. search/replace content with template literals).
  // This must run after the initial parse attempt to avoid double-escaping
  // well-formed JSON, so it stays here rather than in the shared helper.
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
 *
 * Exported so the array-tool-call path in `lib/tool-dispatch.ts` can apply
 * the same recovery; otherwise array-wrapped `write_file` / `edit_file`
 * calls with multiline content fail to recover where their single-object
 * equivalents succeed (Codex P1 review on PR #334).
 */
export function escapeRawNewlinesInJsonStrings(text: string): string {
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
// Fenced-JSON tool detection factory
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
