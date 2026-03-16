/**
 * Shared tool protocol utilities.
 *
 * Runtime-agnostic helpers for tool call detection, JSON repair,
 * diagnosis, and deduplication. Both the web app and CLI import
 * these primitives and layer surface-specific routing on top.
 *
 * Extracted from app/src/lib/utils.ts and app/src/lib/tool-dispatch.ts
 * during Track 2 convergence.
 */

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : null;
}

// ---------------------------------------------------------------------------
// JSON syntax diagnosis
// ---------------------------------------------------------------------------

export interface JsonSyntaxDiagnosis {
  message: string;
  /** Approximate character position (0-based) where the error was detected. */
  position: number | null;
}

/**
 * Diagnose why a JSON string fails to parse. Returns a human-readable
 * description of the first syntax error found.
 */
export function diagnoseJsonSyntaxError(text: string): JsonSyntaxDiagnosis | null {
  try { JSON.parse(text); return null; } catch { /* expected */ }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { message: 'Empty input — expected a JSON object.', position: 0 };
  }

  if (/^["']?tool["']?\s*:/.test(trimmed)) {
    return {
      message: 'Missing opening brace — JSON value must start with `{` or `[`.',
      position: 0,
    };
  }

  if (trimmed[0] !== '{' && trimmed[0] !== '[') {
    return {
      message: `Unexpected character \`${trimmed[0]}\` at start — JSON value must start with \`{\` or \`[\`.`,
      position: 0,
    };
  }

  let inString = false;
  let escaped = false;
  let depth = 0;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
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

  if (inString) {
    return {
      message: 'Unterminated string — a `"` was opened but never closed.',
      position: null,
    };
  }

  if (depth > 0) {
    return {
      message: `Unbalanced braces — ${depth} unclosed \`{\` or \`[\`. Add ${depth} closing brace(s).`,
      position: trimmed.length,
    };
  }

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
// ---------------------------------------------------------------------------

/**
 * Attempt to repair common JSON garbling from LLM output.
 * Returns the parsed object if it has a "tool" string key, otherwise null.
 *
 * Handles: trailing commas, double commas, single quotes, unquoted keys,
 * Python-style literals, raw control characters, auto-close truncated JSON.
 */
export function repairToolJson(candidate: string): JsonRecord | null {
  let repaired = candidate.trim();

  // 0. Missing opening brace
  if (!repaired.startsWith('{') && /^["']?tool["']?\s*:/.test(repaired)) {
    repaired = '{' + repaired;
  }

  // 1. Strip trailing commas before } or ]
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');

  // 2. Double commas (model stutter)
  repaired = repaired.replace(/,(\s*),/g, ',');

  // 3. Single quotes → double quotes (only if string uses single-quote style)
  if (repaired.includes("'") && !/"\s*:/.test(repaired)) {
    repaired = repaired.replace(/'/g, '"');
  }

  // 4. Unquoted keys
  repaired = repaired.replace(/([{,])\s*([a-zA-Z_]\w*)\s*:/g, '$1"$2":');

  // 5. Python-style literals
  repaired = replacePythonLiterals(repaired);

  // 6. Raw control characters inside strings
  // eslint-disable-next-line no-control-regex
  repaired = repaired.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

  const parsed = tryParseToolJson(repaired);
  if (parsed) return parsed;

  // 7. Auto-close truncated JSON
  const autoClosed = tryAutoCloseJson(repaired);
  if (autoClosed) return autoClosed;

  return null;
}

function replacePythonLiterals(text: string): string {
  if (!/\b(?:True|False|None)\b/.test(text)) return text;
  let result = '';
  let inString = false;
  let escaped = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (escaped) { result += ch; escaped = false; i++; continue; }
    if (ch === '\\' && inString) { result += ch; escaped = true; i++; continue; }
    if (ch === '"') { inString = !inString; result += ch; i++; continue; }
    if (inString) { result += ch; i++; continue; }
    if (text.startsWith('True', i) && !/\w/.test(text[i + 4] || '')) {
      result += 'true'; i += 4; continue;
    }
    if (text.startsWith('False', i) && !/\w/.test(text[i + 5] || '')) {
      result += 'false'; i += 5; continue;
    }
    if (text.startsWith('None', i) && !/\w/.test(text[i + 4] || '')) {
      result += 'null'; i += 4; continue;
    }
    result += ch; i++;
  }
  return result;
}

function tryParseToolJson(text: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && typeof parsed.tool === 'string') {
      return parsed as JsonRecord;
    }
  } catch {
    // parse failed
  }
  return null;
}

function tryAutoCloseJson(text: string): JsonRecord | null {
  if (!text.startsWith('{')) return null;
  if (!/["']tool["']\s*:/.test(text)) return null;

  const stack: ('{' | '[')[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') stack.push('{');
    if (ch === '[') stack.push('[');
    if (ch === '}') { if (stack.length && stack[stack.length - 1] === '{') stack.pop(); }
    if (ch === ']') { if (stack.length && stack[stack.length - 1] === '[') stack.pop(); }
  }

  if (stack.length === 0 || stack.length > 3) return null;

  let suffix = '';
  if (inString) suffix += '"';
  for (let i = stack.length - 1; i >= 0; i--) {
    suffix += stack[i] === '{' ? '}' : ']';
  }

  return tryParseToolJson(text + suffix);
}

// ---------------------------------------------------------------------------
// Truncation detection
// ---------------------------------------------------------------------------

/**
 * Detect if text ends with a truncated tool call (unbalanced braces after
 * a {"tool" pattern). Returns the tool name if found.
 */
export function detectTruncatedToolCall(text: string): { toolName: string } | null {
  const toolPattern = /\{\s*"?'?tool"?'?\s*:\s*["']([^"']+)["']/g;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;

  while ((m = toolPattern.exec(text)) !== null) {
    lastMatch = m;
  }

  if (!lastMatch) return null;

  const remainder = text.slice(lastMatch.index);
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const ch of remainder) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
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
// Bare JSON extraction (brace-counting)
// ---------------------------------------------------------------------------

/**
 * Extract bare JSON objects containing a "tool" key from text.
 * Uses brace-counting so nested objects are captured correctly.
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
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) { end = j; break; }
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
 * Supports triple/4+ backtick fences, tilde fences, and prose-surrounded JSON.
 */
export function detectToolFromText<T>(
  text: string,
  validate: (parsed: unknown) => T | null,
): T | null {
  const fenceRegex = /(?:`{3,}|~{3,})(?:json[c5]?|tool|javascript)?\s*\n?([\s\S]*?)\n?\s*(?:`{3,}|~{3,})/g;
  let match;

  while ((match = fenceRegex.exec(text)) !== null) {
    const content = match[1].trim();

    try {
      const parsed = JSON.parse(content);
      const result = validate(parsed);
      if (result) return result;
    } catch {
      const repaired = repairToolJson(content);
      if (repaired) {
        const result = validate(repaired);
        if (result) return result;
      }

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
// Stable JSON stringify — canonical key generation for dedup
// ---------------------------------------------------------------------------

/**
 * Stable JSON stringify: recursively sorts object keys and drops undefined
 * properties so logically-equivalent payloads produce the same key.
 */
export function stableJsonStringify(value: unknown): string {
  const normalized = normalizeJsonValue(value);
  return JSON.stringify(normalized === undefined ? null : normalized);
}

function normalizeJsonValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const normalized = normalizeJsonValue(item);
      return normalized === undefined ? null : normalized;
    });
  }
  if (typeof value === 'object') {
    const record = asRecord(value);
    if (!record) return undefined;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const normalized = normalizeJsonValue(record[key]);
      if (normalized !== undefined) output[key] = normalized;
    }
    return output;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tool call diagnosis types
// ---------------------------------------------------------------------------

/** Result of diagnosing why a tool call was not detected. */
export interface ToolCallDiagnosis {
  reason: 'truncated' | 'validation_failed' | 'malformed_json' | 'natural_language_intent';
  toolName: string | null;
  errorMessage: string;
  /** When true, record the metric but do not inject an error or trigger a retry. */
  telemetryOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Inline code detection helper
// ---------------------------------------------------------------------------

/**
 * Check if position `pos` in `text` is inside an inline code span (single backticks).
 * Ignores fenced code blocks (triple backticks) which are handled separately.
 */
export function isInsideInlineCode(text: string, pos: number): boolean {
  let backtickCount = 0;
  for (let i = 0; i < pos; i++) {
    if (text[i] === '`') {
      if (text[i + 1] === '`' && text[i + 2] === '`') {
        const closeIdx = text.indexOf('```', i + 3);
        if (closeIdx !== -1 && closeIdx < pos) {
          i = closeIdx + 2;
          continue;
        }
        return false;
      }
      backtickCount++;
    }
  }
  return backtickCount % 2 === 1;
}

// ---------------------------------------------------------------------------
// Brace-matching helpers for region extraction
// ---------------------------------------------------------------------------

/**
 * Find the nearest `{` before `pos` in text (within 200 chars).
 * Returns `pos` if no preceding brace is found.
 */
export function findPrecedingBrace(text: string, pos: number): number {
  const searchStart = Math.max(0, pos - 200);
  for (let i = pos - 1; i >= searchStart; i--) {
    if (text[i] === '{') return i;
  }
  return pos;
}

/**
 * Find the nearest balanced `}` after `pos` in text.
 * Falls back to end-of-line or end-of-text if no closing brace is found.
 */
export function findFollowingBrace(text: string, pos: number): number {
  const searchEnd = Math.min(text.length, pos + 2000);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = pos; i < searchEnd; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      if (depth === 0) return i;
      depth--;
    }
  }
  const newlineIdx = text.indexOf('\n', pos);
  return newlineIdx !== -1 && newlineIdx < searchEnd ? newlineIdx : searchEnd - 1;
}
