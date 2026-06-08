/**
 * Recovery for token-delimited *native* tool-call output.
 *
 * Distinct from `tool-call-xml-recovery.ts` (tag-shaped: `<tool_call>`,
 * `<function_calls>`, namespace-wrapped `<|DSML|invoke>`) and
 * `tool-call-namespaced-recovery.ts` (`functions.<name>:<id> <args>`).
 * This module handles the two formats whose models emit special control
 * tokens that, when a provider streams them in the content channel
 * instead of converting to OpenAI `tool_calls`, leak into the visible
 * text verbatim:
 *
 *   Mistral (`[TOOL_CALLS]` sentinel). Two payload shapes ship:
 *     pre-v11 tokenizer — a JSON array of `{name, arguments}`:
 *       [TOOL_CALLS] [{"name": "get_weather", "arguments": {"city": "SF"}}]
 *     v11+ tokenizer — a bare name glued to a JSON args object:
 *       [TOOL_CALLS]get_weather{"city": "SF"}
 *
 *   DeepSeek V3 / R1 native. A `tool▁calls▁begin … tool▁calls▁end`
 *   wrapper around one or more `tool▁call▁begin … tool▁call▁end` blocks,
 *   each `type<｜tool▁sep｜>name` then a ```json fenced args object:
 *     <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>get_weather
 *     ```json
 *     {"city": "SF"}
 *     ```<｜tool▁call▁end｜><｜tool▁calls▁end｜>
 *   The delimiters are the full-width pipe `｜` (U+FF5C) and the
 *   SentencePiece underscore `▁` (U+2581); we also tolerate the ASCII
 *   fallbacks (`|`, `_`, space) some detokenizers emit.
 *
 * Mirrors the role the sibling recovery modules play: pair the wrapper
 * with its payload so the shared dispatcher can promote it to a
 * candidate instead of dropping the call silently. Tool-name
 * normalization stays with the dispatcher's source detectors — this
 * module only assembles `{tool, args}` shapes from what the model
 * emitted.
 */

import { applyJsonTextRepairs, escapeRawNewlinesInJsonStrings } from './tool-call-parsing.js';

export interface RecoveredTokenCall {
  /** Tool name as written by the model (no normalization). */
  tool: string;
  /** Parsed args object. `{}` for a name with no recoverable args. */
  args: Record<string, unknown>;
  /** Offset of the call's anchor in the source text (the `[TOOL_CALLS]`
   *  sentinel for Mistral, the `tool▁call▁begin` token for DeepSeek).
   *  Lets the dispatcher merge these into its textual-order ordering. */
  offset: number;
  /** Exclusive end offset — one past the last character of the call's
   *  payload (the args object/array close, or the `tool▁call▁end`
   *  token). Mirrors the field the sibling recoveries expose so callers
   *  can detect a bare JSON object that's actually this call's args. */
  endOffset: number;
  /** Which native format produced this — for sample/diagnostic labels. */
  format: 'mistral' | 'deepseek';
}

// Conservative identifier shape — matches the sibling recoveries' tool
// name capture. Anything outside this is prose noise or a name the
// registry wouldn't accept anyway.
const TOOL_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const MISTRAL_SENTINEL = '[TOOL_CALLS]';

// DeepSeek control tokens. `[|｜]` accepts the ASCII pipe (U+007C) or the
// full-width pipe (U+FF5C); `[▁_ ]` accepts the SentencePiece underscore
// (U+2581), an ASCII underscore, or a space — covering detokenizer
// variants. The wrapper is required (a strong sentinel that bounds the
// false-positive surface without a prose gate); call blocks are matched
// inside it.
const DS_CALLS_BEGIN = /<[|｜]tool[▁_ ]calls[▁_ ]begin[|｜]>/g;
const DS_CALLS_END = /<[|｜]tool[▁_ ]calls[▁_ ]end[|｜]>/g;
const DS_CALL_BLOCK =
  /<[|｜]tool[▁_ ]call[▁_ ]begin[|｜]>([\s\S]*?)<[|｜]tool[▁_ ]call[▁_ ]end[|｜]>/g;
const DS_SEP = /<[|｜]tool[▁_ ]sep[|｜]>/;

// Whole-message eligibility gate — mirrors `XML_GAP_REGEX` in the XML
// recovery. Every region OUTSIDE a recovered call's covered span must be
// whitespace plus an optional fence / language marker. A recovered call's
// `[offset, endOffset)` span (inclusive of the `[TOOL_CALLS]` sentinel or
// the whole DeepSeek wrapper) is exempt; everything else is checked.
const TOKEN_GAP_REGEX =
  /^\s*(?:`{3,}|~{3,})?\s*(?:json[c5]?|tool|xml|javascript)?\s*(?:`{3,}|~{3,})?\s*$/i;

/** A half-open `[start, end)` span of `text` covered by a recovered call. */
type Region = [number, number];

interface FormatRecovery {
  calls: RecoveredTokenCall[];
  /** Spans the eligibility gate treats as "this is a tool call, not
   *  prose" — the inverse regions are what must be whitespace/markers. */
  regions: Region[];
}

/**
 * Scan `text` for Mistral `[TOOL_CALLS]` and DeepSeek-native tool-call
 * blocks. Order-preserving across both formats, no dedup — the
 * dispatcher dedupes across all phases by canonical key.
 *
 * Promotion is gated on a whole-message surrounding-context check (see
 * `TOKEN_GAP_REGEX`): the regions outside the recovered calls must be
 * whitespace + optional fence/language markers. Without it, a prose
 * mention or a pasted transcript like `[TOOL_CALLS] [{"name":"exec",
 * "arguments":{...}}]` would execute the example whenever no canonical
 * wrappers are present. Codex P1 review on PR #830. The gate is
 * all-or-nothing, matching the XML recovery: any prose-bearing gap
 * rejects the whole batch. False-negative trade (a model that mixes a
 * tool call with surrounding prose is skipped, resolving next turn) is
 * preferable to a false-positive that runs a destructive command — the
 * same trade the XML and namespaced recoveries make.
 */
export function recoverTokenDelimitedToolCalls(text: string): RecoveredTokenCall[] {
  const mistral = recoverMistralToolCalls(text);
  const deepseek = recoverDeepSeekToolCalls(text);
  const calls = [...mistral.calls, ...deepseek.calls];
  if (calls.length === 0) return [];

  const regions = mergeRegions([...mistral.regions, ...deepseek.regions]);
  if (!regionsAreContextEligible(text, regions)) return [];

  calls.sort((a, b) => a.offset - b.offset);
  return calls;
}

/** Merge overlapping/adjacent covered spans into a sorted, disjoint list. */
function mergeRegions(regions: Region[]): Region[] {
  if (regions.length === 0) return [];
  const sorted = [...regions].sort((a, b) => a[0] - b[0]);
  const merged: Region[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i][0] <= last[1]) {
      last[1] = Math.max(last[1], sorted[i][1]);
    } else {
      merged.push(sorted[i]);
    }
  }
  return merged;
}

/**
 * True when every region of `text` outside the covered `regions` is
 * whitespace + optional fence/language markers. Checks the prefix before
 * the first region, each inter-region gap, and the suffix after the last.
 */
function regionsAreContextEligible(text: string, regions: Region[]): boolean {
  if (regions.length === 0) return false;
  const isAllowedGap = (slice: string): boolean => TOKEN_GAP_REGEX.test(slice);
  if (!isAllowedGap(text.slice(0, regions[0][0]))) return false;
  for (let i = 1; i < regions.length; i++) {
    if (!isAllowedGap(text.slice(regions[i - 1][1], regions[i][0]))) return false;
  }
  return isAllowedGap(text.slice(regions[regions.length - 1][1]));
}

// ---------------------------------------------------------------------------
// Mistral `[TOOL_CALLS]`
// ---------------------------------------------------------------------------

function recoverMistralToolCalls(text: string): FormatRecovery {
  const calls: RecoveredTokenCall[] = [];
  const regions: Region[] = [];
  let searchFrom = 0;
  for (;;) {
    const sentinel = text.indexOf(MISTRAL_SENTINEL, searchFrom);
    if (sentinel === -1) break;
    const anchor = sentinel;
    searchFrom = sentinel + MISTRAL_SENTINEL.length;

    // Skip whitespace between the sentinel and its payload.
    let cursor = sentinel + MISTRAL_SENTINEL.length;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
    if (cursor >= text.length) continue;

    if (text[cursor] === '[') {
      // Array form: [{"name": "...", "arguments": {...}}, ...]
      const arrayEnd = findBalancedEnd(text, cursor, ']');
      if (arrayEnd === -1) continue;
      const parsed = parseJsonWithRepairs(text.slice(cursor, arrayEnd + 1));
      if (!Array.isArray(parsed)) continue;
      let recoveredAny = false;
      for (const element of parsed) {
        const call = shapeMistralElement(element);
        if (!call) continue;
        recoveredAny = true;
        calls.push({ ...call, offset: anchor, endOffset: arrayEnd + 1, format: 'mistral' });
      }
      // Only advance the scan past a payload we actually consumed; an
      // unrecognized array shape leaves `searchFrom` at the sentinel end
      // so a later genuine sentinel still gets a chance.
      if (recoveredAny) {
        regions.push([anchor, arrayEnd + 1]);
        searchFrom = arrayEnd + 1;
      }
      continue;
    }

    // Name-glued form: get_weather{"city": "SF"}
    const nameMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(text.slice(cursor));
    if (!nameMatch) continue;
    const tool = nameMatch[0];
    let braceCursor = cursor + tool.length;
    while (braceCursor < text.length && /\s/.test(text[braceCursor])) braceCursor++;
    if (text[braceCursor] !== '{') continue;
    const objEnd = findBalancedEnd(text, braceCursor, '}');
    if (objEnd === -1) continue;
    const args = parseArgsObject(text.slice(braceCursor, objEnd + 1));
    if (!args) continue;
    calls.push({ tool, args, offset: anchor, endOffset: objEnd + 1, format: 'mistral' });
    regions.push([anchor, objEnd + 1]);
    searchFrom = objEnd + 1;
  }
  return { calls, regions };
}

function shapeMistralElement(
  element: unknown,
): { tool: string; args: Record<string, unknown> } | null {
  if (!element || typeof element !== 'object' || Array.isArray(element)) return null;
  const obj = element as Record<string, unknown>;
  // Some Mistral traces nest the call under `function: {name, arguments}`
  // (OpenAI-echoing finetunes); accept that as well as the flat shape.
  const fn =
    obj.function && typeof obj.function === 'object' && !Array.isArray(obj.function)
      ? (obj.function as Record<string, unknown>)
      : obj;
  const name = typeof fn.name === 'string' ? fn.name.trim() : '';
  if (!name || !TOOL_NAME_REGEX.test(name)) return null;
  const args = coerceArgsField(fn.arguments ?? fn.parameters);
  if (!args) return null;
  return { tool: name, args };
}

// ---------------------------------------------------------------------------
// DeepSeek V3 / R1 native
// ---------------------------------------------------------------------------

function recoverDeepSeekToolCalls(text: string): FormatRecovery {
  // Require the `tool▁calls▁begin` wrapper — a strong sentinel that
  // bounds each recovery region. Without it, a lone `tool▁call▁begin` in
  // prose (vanishingly unlikely, but cheap to exclude) won't promote.
  // Iterate ALL wrappers, not just the first: concatenated multi-turn
  // logs / transcript dumps can carry several `tool_calls` wrappers, and
  // blocks in later wrappers were previously dropped. github-actions
  // review on PR #830.
  const beginRegex = new RegExp(DS_CALLS_BEGIN.source, DS_CALLS_BEGIN.flags);
  const endRegex = new RegExp(DS_CALLS_END.source, DS_CALLS_END.flags);
  const calls: RecoveredTokenCall[] = [];
  const regions: Region[] = [];

  let begin: RegExpExecArray | null;
  while ((begin = beginRegex.exec(text)) !== null) {
    // Recovery region runs from this wrapper open to its matching close
    // (or end-of-text if the close leaked away / was truncated).
    endRegex.lastIndex = begin.index + begin[0].length;
    const endMatch = endRegex.exec(text);
    const regionEnd = endMatch ? endMatch.index + endMatch[0].length : text.length;

    const blockRegex = new RegExp(DS_CALL_BLOCK.source, DS_CALL_BLOCK.flags);
    blockRegex.lastIndex = begin.index;
    let block: RegExpExecArray | null;
    while ((block = blockRegex.exec(text)) !== null) {
      if (block.index >= regionEnd) break;
      const parsed = parseDeepSeekBlock(block[1]);
      if (!parsed) continue;
      calls.push({
        tool: parsed.tool,
        args: parsed.args,
        offset: block.index,
        endOffset: block.index + block[0].length,
        format: 'deepseek',
      });
    }
    regions.push([begin.index, regionEnd]);
    // Resume scanning for the next wrapper past this region's close so a
    // truncated wrapper (regionEnd === text.length) terminates the loop.
    if (regionEnd > beginRegex.lastIndex) beginRegex.lastIndex = regionEnd;
  }
  return { calls, regions };
}

function parseDeepSeekBlock(inner: string): { tool: string; args: Record<string, unknown> } | null {
  // `type<｜tool▁sep｜>name … {args}` — the separator splits the type
  // (ignored) from the name + args region.
  const sep = DS_SEP.exec(inner);
  if (!sep) return null;
  const afterSep = inner.slice(sep.index + sep[0].length);
  const nameMatch = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)/.exec(afterSep);
  if (!nameMatch) return null;
  const tool = nameMatch[1];

  // Args are the first balanced `{...}` after the name (inside the
  // ```json fence when present; the fence markers are skipped over by
  // the brace scan). A block with NO object at all is a legitimate
  // zero-arg call (e.g. `git_status`). But an object that opens and
  // never closes is truncated/malformed — drop the call rather than
  // execute the tool with silently-empty args, which could run it
  // without its intended arguments. github-actions review on PR #830.
  const braceIdx = afterSep.indexOf('{', nameMatch[0].length);
  if (braceIdx === -1) return { tool, args: {} };
  const objEnd = findBalancedEnd(afterSep, braceIdx, '}');
  if (objEnd === -1) return null;
  const args = parseArgsObject(afterSep.slice(braceIdx, objEnd + 1));
  if (!args) return null;
  return { tool, args };
}

// ---------------------------------------------------------------------------
// Shared JSON helpers (string-aware, no dispatcher dependency)
// ---------------------------------------------------------------------------

/**
 * Brace/bracket-counted scan from `start` (which must point at an opener)
 * to its matching closer, tracking both `{}` and `[]` so nested
 * structures resolve correctly. `close` is the closer expected for the
 * anchored opener; a mismatched top-level closer means malformed nesting
 * and returns -1. Returns the closer index or -1.
 */
function findBalancedEnd(text: string, start: number, close: '}' | ']'): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = start; j < text.length; j++) {
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
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        // Only accept when the closer matches the opener we anchored on;
        // a mismatched closer means malformed nesting — bail.
        return ch === close ? j : -1;
      }
    }
  }
  return -1;
}

/** Parse JSON with the shared shape-agnostic repair ladder. */
function parseJsonWithRepairs(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    /* fall through */
  }
  const repaired = applyJsonTextRepairs(candidate);
  try {
    return JSON.parse(repaired);
  } catch {
    /* fall through */
  }
  const escaped = escapeRawNewlinesInJsonStrings(repaired);
  if (escaped === repaired) return undefined;
  try {
    return JSON.parse(escaped);
  } catch {
    return undefined;
  }
}

/** Parse a candidate args object string into a plain record, or null. */
function parseArgsObject(candidate: string): Record<string, unknown> | null {
  const parsed = parseJsonWithRepairs(candidate);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * Coerce a Mistral `arguments`/`parameters` field into a record. Mistral
 * emits it as an object normally, but some finetunes JSON-encode it as a
 * string — accept both. Anything else (number, array, missing) is not a
 * valid args payload.
 */
function coerceArgsField(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    // An empty string is a common "no args" encoding.
    if (value.trim() === '') return {};
    return parseArgsObject(value);
  }
  return null;
}
