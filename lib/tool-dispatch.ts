/**
 * Shared tool-call dispatch kernel.
 *
 * Background:
 * Before this module landed, tool-call detection (`detectAllToolCalls`)
 * had two independent implementations: `cli/tools.ts` (CLI) and
 * `app/src/lib/tool-dispatch.ts` (web). The CLI version was fence-only
 * and silently dropped any tool-call JSON that wasn't wrapped in a
 * ` ```json ... ``` ` block, which surfaced as an "empty TUI transcript"
 * bug when Gemini-3-flash on Ollama Cloud emitted `json\n{...}` without
 * the leading triple-backtick. See
 * `docs/decisions/Tool-Call Parser Convergence Gap.md` for the full
 * four-layer analysis.
 *
 * This module is the shared kernel the CLI now routes through. It
 * exports a `createToolDispatcher(sources)` factory that takes a list of
 * per-source detectors and returns a `detectAllToolCalls(text)` function.
 * Each shell registers its own source detectors; the dispatcher owns
 * fenced-block extraction, JSON parsing with repair, bare-object
 * fallback (the fix for the missing-fence case), dedup, and
 * malformed-call reporting.
 *
 * The web dispatcher (`app/src/lib/tool-dispatch.ts`) is a separate
 * tranche: its result shape groups calls by execution phase
 * (readOnly / fileMutations / mutating / extraMutations) rather than
 * returning a flat list. Once shape unification lands, the web path can
 * compose `createToolDispatcher` as its low-level primitive and add the
 * grouping state machine on top.
 */

import { repairToolJson } from './tool-call-parsing.js';

/**
 * Result of scanning assistant text for tool calls.
 *
 * `calls` is the list of detections that parsed AND passed at least one
 * registered source's `detect` function, in the order they appeared in
 * the text. Duplicates (same tool + same stable-key serialized args)
 * are collapsed.
 *
 * `malformed` captures parse or shape failures observed on text that
 * explicitly signalled tool-call shape — specifically, content inside a
 * code fence tagged `json`/`tool` that contains a `"tool":` key but
 * doesn't parse or doesn't match the expected shape. Bare-object scans
 * do NOT contribute to `malformed`; they are a best-effort fallback for
 * models that forget the fences, and reporting every prose-embedded
 * `{...}` as malformed would be noise.
 */
export interface ToolDispatchResult<TCall> {
  calls: TCall[];
  malformed: ToolMalformedReport[];
}

export interface ToolMalformedReport {
  /** Machine-readable category — stable identifier for telemetry. */
  reason: ToolMalformedReason;
  /** First ~120 chars of the failing candidate, for diagnostics. */
  sample: string;
}

export type ToolMalformedReason =
  | 'json_parse_error'
  | 'invalid_shape'
  | 'missing_tool'
  | 'missing_args_object'
  | 'unknown_tool';

/**
 * A tool source turns a parsed `{tool, args, ...}` object into a
 * strongly typed tool call for a specific shell, or returns null if
 * this source doesn't claim the object.
 *
 * Sources are tried in registration order; the first source to return
 * a non-null value wins. A detector MUST NOT throw — return null to let
 * the dispatcher try the next source.
 */
export interface ToolSource<TCall> {
  readonly name: string;
  readonly detect: (parsed: ParsedToolObject) => TCall | null;
}

/**
 * Shape of a JSON object that has already passed the dispatcher's
 * structural validation: `.tool` is a non-empty string, `.args` is a
 * plain object. Individual source detectors can trust these invariants.
 */
export interface ParsedToolObject {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /** Full parsed object — sources may read extra fields if needed. */
  readonly raw: Record<string, unknown>;
}

export interface ToolDispatcher<TCall> {
  detectAllToolCalls(text: string): ToolDispatchResult<TCall>;
}

/**
 * Create a tool dispatcher from a list of source detectors.
 *
 * The returned `detectAllToolCalls(text)` does a single textual-order
 * scan in two collection phases:
 *
 *   1. Fenced-block phase — extract content from ` ```json ... ``` `,
 *      ` ```tool ... ``` `, and tilde-fence variants (case-insensitive).
 *      Attempt JSON.parse, falling back to `repairToolJson` for common
 *      LLM garbling. Successful parses run through source detection;
 *      failures (parse error, shape error, no source claims the call)
 *      are recorded in `malformed` so the caller can emit
 *      `tool.call_malformed` events.
 *
 *   2. Bare-object phase — scan regions NOT covered by any fenced
 *      block for brace-counted JSON objects with a `tool` string key.
 *      Fenced regions (regardless of language tag) are skipped so
 *      tool-call-shaped JSON inside illustrative ` ```ts ` / ` ```python `
 *      code examples is not executed. This phase is gated by a
 *      conservative contiguity check — see `isBareBlockEligible` — to
 *      avoid mining a single prose-embedded `{...}` object and
 *      executing it as a real tool call.
 *
 * All candidates are collected with their textual offsets, then
 * sorted by offset before dedup + source match so the final `calls`
 * list preserves the model's intended ordering across both phases.
 * `cli/engine.ts` depends on that ordering to group reads → file
 * mutations → trailing side-effect within one turn.
 *
 * Duplicate calls (same tool + same stable-key args) are collapsed
 * across both phases so a model that echoes the same call in both a
 * fenced block and bare JSON doesn't execute it twice.
 */
export function createToolDispatcher<TCall>(
  sources: readonly ToolSource<TCall>[],
): ToolDispatcher<TCall> {
  return {
    detectAllToolCalls(text: string): ToolDispatchResult<TCall> {
      const malformed: ToolMalformedReport[] = [];
      const candidates: DetectedCandidate[] = [];

      // Phase 1: find all fenced regions so both phases can reason
      // about them. Phase 1 processes the ones with a tool-call-eligible
      // language tag; phase 2 excludes ALL fenced regions from its
      // bare-object scan regardless of language (so code examples in
      // `ts`/`python`/etc. fences can't accidentally execute).
      const fences = findFencedRegions(text);

      for (const fence of fences) {
        if (!isToolCallLangTag(fence.lang)) continue;
        const trimmed = fence.content.trim();
        if (!trimmed || !trimmed.startsWith('{')) continue;
        if (!/"tool"\s*:|'tool'\s*:/.test(trimmed) && !/\btool\s*:/.test(trimmed)) continue;
        const parsed = parseToolCandidate(trimmed);
        if (!parsed.ok) {
          malformed.push({ reason: parsed.reason, sample: truncateSample(trimmed) });
          continue;
        }
        candidates.push({
          kind: 'fenced',
          offset: fence.contentOffset,
          parsed: parsed.value,
          sample: trimmed,
        });
      }

      // Phase 2: bare-object fallback — scans regions OUTSIDE any
      // fenced block. Gated by `isBareBlockEligible` so prose-embedded
      // documentation examples do not execute as tools.
      const bareObjects = extractBareToolObjectsOutsideFences(text, fences);
      if (bareObjects.length > 0 && isBareBlockEligible(text, fences, bareObjects)) {
        for (const bare of bareObjects) {
          const shaped = shapeParsedObject(bare.parsed);
          if (!shaped.ok) continue;
          candidates.push({
            kind: 'bare',
            offset: bare.start,
            parsed: shaped.value,
            sample: text.slice(bare.start, bare.end + 1),
          });
        }
      }

      // Sort by textual offset so the final call order matches the
      // order the model intended. Dedup + source-match after sorting.
      candidates.sort((a, b) => a.offset - b.offset);

      const seen = new Set<string>();
      const calls: TCall[] = [];
      for (const candidate of candidates) {
        const key = canonicalKey(candidate.parsed);
        if (seen.has(key)) continue;
        seen.add(key);
        const matched = matchSources(sources, candidate.parsed);
        if (matched.ok) {
          calls.push(matched.call);
          continue;
        }
        if (candidate.kind === 'fenced') {
          // Fenced block parsed as a tool-shaped object but no source
          // claimed the tool name. Report as malformed so the caller
          // can surface a "this tool name isn't recognized" hint.
          malformed.push({ reason: 'unknown_tool', sample: truncateSample(candidate.sample) });
        }
        // Bare candidates that fail source match are silent — phase 2
        // is already conservative; reporting would just spam
        // tool.call_malformed on uninteresting bare objects.
      }

      return { calls, malformed };
    },
  };
}

/**
 * Pass-through source detector: accepts any structurally-valid tool
 * call and returns it verbatim. Used by the CLI, which doesn't
 * distinguish by source at parse time — tool-name validation happens
 * downstream in the executor.
 */
export const PASS_THROUGH_CLI_SOURCE: ToolSource<{
  tool: string;
  args: Record<string, unknown>;
}> = {
  name: 'cli',
  detect: (parsed) => ({ tool: parsed.tool, args: parsed.args }),
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Captured shape of a fenced code block.
 *
 * `blockStart` / `blockEnd` cover the entire fenced region including
 * opening and closing fences — phase 2's bare-object scanner uses these
 * to skip over fence interiors regardless of language tag.
 *
 * `contentOffset` points at the first character of the captured content
 * group and is the offset phase 1 attaches to a fenced candidate so the
 * final textual-order sort places each fenced call where it originally
 * appeared in the assistant message.
 */
interface FencedRegion {
  blockStart: number;
  blockEnd: number;
  contentOffset: number;
  content: string;
  /** Lowercased language tag, possibly empty. */
  lang: string;
}

/**
 * Match opening + optional language tag + content + closing fence.
 * Uses the `d` flag so `match.indices` gives us per-group offsets, and
 * the `i` flag so `JSON` / `Tool` / `JavaScript` language tags aren't
 * skipped (the old CLI parser lowercased the tag before matching).
 */
const FENCE_REGEX = /(?:`{3,}|~{3,})([a-z0-9_+-]*)[ \t]*\n?([\s\S]*?)\n?[ \t]*(?:`{3,}|~{3,})/dgi;

const TOOL_CALL_LANG_TAGS = new Set(['', 'json', 'jsonc', 'json5', 'tool', 'javascript']);

function isToolCallLangTag(lang: string): boolean {
  return TOOL_CALL_LANG_TAGS.has(lang.toLowerCase());
}

function findFencedRegions(text: string): FencedRegion[] {
  const out: FencedRegion[] = [];
  const regex = new RegExp(FENCE_REGEX.source, FENCE_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const blockStart = match.index;
    const blockEnd = match.index + match[0].length;
    const contentIndices = match.indices?.[2];
    const contentOffset = contentIndices ? contentIndices[0] : blockStart;
    out.push({
      blockStart,
      blockEnd,
      contentOffset,
      content: match[2] ?? '',
      lang: (match[1] ?? '').toLowerCase(),
    });
  }
  return out;
}

interface BareToolObject {
  /** Offset of the opening `{` in the source text. */
  start: number;
  /** Offset of the matching closing `}` in the source text. */
  end: number;
  parsed: Record<string, unknown>;
}

/**
 * Scan `text` for brace-counted JSON objects containing a `tool` string
 * key, skipping any region covered by a fenced block. Returns both the
 * parsed object and its start/end offsets so the caller can reason
 * about contiguity (see `isBareBlockEligible`) and can sort candidates
 * by textual position.
 *
 * Mirrors `extractBareToolJsonObjects` from `lib/tool-call-parsing.ts`
 * but inlined here so the offset plumbing stays local and the
 * tool-call-parsing helper can keep its simpler shape for the Web
 * dispatcher until the second convergence tranche lands.
 */
function extractBareToolObjectsOutsideFences(
  text: string,
  fences: readonly FencedRegion[],
): BareToolObject[] {
  const out: BareToolObject[] = [];
  let i = 0;
  while (i < text.length) {
    const braceIdx = text.indexOf('{', i);
    if (braceIdx === -1) break;

    // If this brace is inside any fenced block, jump past the fence.
    const containing = fences.find((f) => braceIdx >= f.blockStart && braceIdx < f.blockEnd);
    if (containing) {
      i = containing.blockEnd;
      continue;
    }

    // Brace-counting scan with string/escape awareness.
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
      if (isRecord(parsed) && typeof parsed.tool === 'string') {
        out.push({ start: braceIdx, end, parsed });
      }
    } catch {
      const repaired = repairToolJson(candidate);
      if (repaired) {
        out.push({ start: braceIdx, end, parsed: repaired });
      }
    }
    i = end + 1;
  }
  return out;
}

/**
 * Gate for the bare-object fallback. Returns true iff the text looks
 * like the model intended to emit tool calls without fences, and false
 * iff it looks like the model is describing/documenting tool calls
 * (prose-embedded examples).
 *
 * Accepted shapes:
 *
 *   - The whole text is exactly one bare `{tool, args}` object,
 *     possibly prefixed by whitespace and an optional `json` / `tool`
 *     language marker on its own line. Matches the old CLI's
 *     whole-message fallback behavior.
 *   - Two or more bare `{tool, args}` objects appear in sequence, with
 *     only whitespace (and optional `json` / `tool` markers) between
 *     them, and the entire text consists of those objects plus
 *     allowed whitespace/markers. Matches the Gemini-3-flash failure
 *     mode documented in Tool-Call Parser Convergence Gap.md.
 *
 * Rejected shapes (false negatives are acceptable for safety):
 *
 *   - A single bare `{tool, args}` object preceded or followed by
 *     prose — looks like a documentation example, not an invocation.
 *   - Multiple bare objects separated by prose (`"use {...} or {...}"`)
 *     — looks like inline documentation.
 *   - Any shape where non-whitespace prose sits between bare objects.
 *
 * The regex allows an optional stray ` ``` ` or `~~~` marker so we
 * handle models that produce almost-correct fences (missing only the
 * closing or opening triple-backtick but still marking the language).
 */
const BARE_GAP_REGEX =
  /^\s*(?:`{3,}|~{3,})?\s*(?:json[c5]?|tool|javascript)?\s*(?:`{3,}|~{3,})?\s*$/i;

function isBareBlockEligible(
  text: string,
  fences: readonly FencedRegion[],
  bareObjects: readonly BareToolObject[],
): boolean {
  if (bareObjects.length === 0) return false;

  // Extract a `[start, end)` slice of `text` with any overlapping
  // fenced regions removed. Fenced blocks are handled by phase 1, so
  // from phase 2's perspective they behave as "gaps the user is
  // allowed to put between bare tool calls" — we test only the
  // non-fenced residue against BARE_GAP_REGEX.
  const sliceWithoutFences = (start: number, end: number): string => {
    if (end <= start) return '';
    let out = '';
    let cursor = start;
    for (const fence of fences) {
      if (fence.blockEnd <= start || fence.blockStart >= end) continue;
      if (fence.blockStart > cursor) out += text.slice(cursor, fence.blockStart);
      cursor = Math.max(cursor, fence.blockEnd);
      if (cursor >= end) break;
    }
    if (cursor < end) out += text.slice(cursor, end);
    return out;
  };

  // Prefix before the first bare object must be allowed.
  if (!BARE_GAP_REGEX.test(sliceWithoutFences(0, bareObjects[0].start))) return false;

  // Each gap between consecutive bare objects must be allowed —
  // whitespace, optional language markers, and fenced blocks only.
  for (let i = 1; i < bareObjects.length; i++) {
    const gap = sliceWithoutFences(bareObjects[i - 1].end + 1, bareObjects[i].start);
    if (!BARE_GAP_REGEX.test(gap)) return false;
  }

  // Suffix after the last bare object must be allowed.
  const suffix = sliceWithoutFences(bareObjects[bareObjects.length - 1].end + 1, text.length);
  if (!BARE_GAP_REGEX.test(suffix)) return false;

  return true;
}

interface DetectedCandidate {
  kind: 'fenced' | 'bare';
  offset: number;
  parsed: ParsedToolObject;
  /** Truncatable sample for malformed reports. */
  sample: string;
}

type ParseOutcome =
  | { ok: true; value: ParsedToolObject }
  | { ok: false; reason: ToolMalformedReason };

function parseToolCandidate(candidate: string): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const repaired = repairToolJson(candidate);
    if (!repaired) return { ok: false, reason: 'json_parse_error' };
    parsed = repaired;
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'invalid_shape' };
  return shapeParsedObject(parsed);
}

function shapeParsedObject(parsed: Record<string, unknown>): ParseOutcome {
  if (typeof parsed.tool !== 'string' || parsed.tool.trim().length === 0) {
    return { ok: false, reason: 'missing_tool' };
  }
  if (!isRecord(parsed.args)) {
    return { ok: false, reason: 'missing_args_object' };
  }
  return {
    ok: true,
    value: {
      tool: parsed.tool,
      args: parsed.args,
      raw: parsed,
    },
  };
}

function matchSources<TCall>(
  sources: readonly ToolSource<TCall>[],
  parsed: ParsedToolObject,
): { ok: true; call: TCall } | { ok: false } {
  for (const source of sources) {
    const call = source.detect(parsed);
    if (call != null) return { ok: true, call };
  }
  return { ok: false };
}

function canonicalKey(parsed: ParsedToolObject): string {
  return `${parsed.tool}:${stableJsonStringify(parsed.args)}`;
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value) ?? null);
}

function normalizeJsonValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      const normalized = normalizeJsonValue(item);
      return normalized === undefined ? null : normalized;
    });
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = normalizeJsonValue(value[key]);
      if (normalized !== undefined) output[key] = normalized;
    }
    return output;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncateSample(text: string): string {
  return text.length > 120 ? text.slice(0, 120) : text;
}
