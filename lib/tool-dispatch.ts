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

import { extractBareToolJsonObjects, repairToolJson } from './tool-call-parsing.js';

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
 * The returned `detectAllToolCalls(text)` runs in two phases:
 *
 *   1. Fenced-block phase — extract content from ` ```json ... ``` `,
 *      ` ```tool ... ``` `, and tilde-fence variants. Attempt
 *      JSON.parse, falling back to `repairToolJson` for common LLM
 *      garbling. Successful parses run through source detection;
 *      failures (parse error, shape error, no source claims the call)
 *      are recorded in `malformed` so the caller can emit
 *      `tool.call_malformed` events.
 *
 *   2. Bare-object phase — scan the whole text for brace-counted JSON
 *      objects with a `tool` string key. Successful parses run through
 *      source detection; failures are SILENT (see comment on
 *      `ToolDispatchResult`). This phase catches the missing-fence
 *      case documented in Tool-Call Parser Convergence Gap.md.
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
      const calls: TCall[] = [];
      const malformed: ToolMalformedReport[] = [];
      const seen = new Set<string>();

      // Phase 1: fenced blocks — strict, parse failures reported.
      for (const candidate of extractFencedToolCandidates(text)) {
        const parsed = parseToolCandidate(candidate);
        if (!parsed.ok) {
          malformed.push({ reason: parsed.reason, sample: truncateSample(candidate) });
          continue;
        }
        const matched = matchSources(sources, parsed.value);
        if (matched.ok) {
          const key = canonicalKey(parsed.value);
          if (!seen.has(key)) {
            seen.add(key);
            calls.push(matched.call);
          }
        } else {
          // Fenced block parsed as a tool-shaped object but no source
          // claimed the tool name. Report as malformed so the caller
          // can surface a "this tool name isn't recognized" hint.
          malformed.push({ reason: 'unknown_tool', sample: truncateSample(candidate) });
        }
      }

      // Phase 2: bare-object fallback — silent on failure. This is the
      // convergence-gap fix: catches `json\n{...}` where the model knew
      // tool-call shape but omitted the opening triple-backtick.
      for (const bare of extractBareToolJsonObjects(text)) {
        if (!isRecord(bare)) continue;
        const shaped = shapeParsedObject(bare);
        if (!shaped.ok) continue;
        const matched = matchSources(sources, shaped.value);
        if (!matched.ok) continue;
        const key = canonicalKey(shaped.value);
        if (seen.has(key)) continue;
        seen.add(key);
        calls.push(matched.call);
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

const FENCE_REGEX =
  /(?:`{3,}|~{3,})(?:json[c5]?|tool|javascript)?\s*\n?([\s\S]*?)\n?\s*(?:`{3,}|~{3,})/g;

function extractFencedToolCandidates(text: string): string[] {
  const out: string[] = [];
  // Regex state is per-instance; use exec in a loop. We rebuild the
  // lastIndex window explicitly to avoid accidental state leakage if
  // FENCE_REGEX is ever shared across calls.
  const regex = new RegExp(FENCE_REGEX.source, FENCE_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const inner = (match[1] ?? '').trim();
    if (!inner) continue;
    // Must look like a JSON object with a tool-call key. We intentionally
    // match on the raw (possibly unquoted) key here because repair may
    // fix unquoted keys downstream.
    if (!inner.startsWith('{')) continue;
    if (!/"tool"\s*:|'tool'\s*:/.test(inner) && !/\btool\s*:/.test(inner)) continue;
    out.push(inner);
  }
  return out;
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
