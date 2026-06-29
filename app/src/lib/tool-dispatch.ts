/**
 * Unified tool dispatch — wraps both GitHub and Sandbox tool
 * detection/execution behind a single interface.
 *
 * This keeps useChat.ts clean: it calls detectAnyToolCall() once
 * and gets back the right type, then executeAnyToolCall() routes
 * to the correct implementation.
 */

import type {
  ToolExecutionResult,
  AcceptanceCriterion,
  CoderDelegationArgs,
  ExplorerDelegationArgs,
  TaskGraphArgs,
} from '@/types';
import { type ToolHookRegistry } from './tool-hooks';
import type { ToolDispatchBinding } from './local-daemon-sandbox-client';
import type { ApprovalGateRegistry } from './approval-gates';
import { WebToolExecutionRuntime } from './web-tool-execution-runtime';
import { detectToolCall, type ToolCall } from './github-tools';
import { detectSandboxToolCall, type SandboxToolCall } from './sandbox-tools';
import { detectScratchpadToolCall, type ScratchpadToolCall } from './scratchpad-tools';
import { detectTodoToolCall, type TodoToolCall } from './todo-tools';
import { detectWebSearchToolCall, type WebSearchToolCall } from './web-search-tools';
import { detectAskUserToolCall, type AskUserToolCall } from './ask-user-tools';
import { detectArtifactToolCall, type ArtifactToolCall } from './artifact-tools';
import { detectMemoryToolCall, type MemoryToolCall } from './memory-tools';
import { type ActiveProvider } from './orchestrator';
import { ALL_CAPABILITIES, type Capability } from './capabilities';
import type { AgentRole } from '@push/lib/runtime-contract';
import type { DroppedToolCallCandidate } from '@push/lib/deep-reviewer-agent';
import { asRecord, detectToolFromText, extractBareToolJsonObjects } from './utils';
import {
  getToolCanonicalNames,
  getRecognizedToolNames,
  getToolPublicName,
  isFileMutationToolName,
  isReadOnlyToolName,
  resolveToolName,
} from './tool-registry';
import { logToolArgOutcome, normalizeToolArgs } from '@push/lib/tool-arg-normalization';
import {
  extractAllBareJsonObjects,
  getToolSource,
  inferToolFromArgs,
} from '@push/lib/tool-call-diagnosis';
import { recoverNamespacedToolCalls } from '@push/lib/tool-call-namespaced-recovery';
import { recoverTokenDelimitedToolCalls } from '@push/lib/tool-call-token-recovery';
import { recoverXmlToolCalls } from '@push/lib/tool-call-xml-recovery';
import {
  groupCallsByPhase,
  MAX_FILE_MUTATION_BATCH,
  MAX_PARALLEL_TOOL_CALLS,
} from '@push/lib/tool-call-grouping';
import {
  createToolDispatcher,
  type ParsedToolObject,
  stableInvocationKey,
  type ToolMalformedReport,
  type ToolSource,
} from '@push/lib/tool-dispatch';
import type { NativeToolCall } from '@push/lib/provider-contract';

// ---------------------------------------------------------------------------
// Re-exports — the tool-call diagnosis kernel now lives in
// `@push/lib/tool-call-diagnosis`. These re-exports preserve the existing
// `@/lib/tool-dispatch` import surface so Web callers (orchestrator,
// explorer-agent, deep-reviewer-agent, tool-call-recovery, tool-dispatch.test)
// don't need to churn.
// ---------------------------------------------------------------------------

export { extractBareToolJsonObjects };
export { getToolSource };
export {
  diagnoseToolCallFailure,
  detectUnimplementedToolCall,
  KNOWN_TOOL_NAMES,
  PUBLIC_SANDBOX_TOOL_NAMES,
  type ToolCallDiagnosis,
} from '@push/lib/tool-call-diagnosis';

// ---------------------------------------------------------------------------
// Parallel read-only tool detection
// ---------------------------------------------------------------------------

export const PARALLEL_READ_ONLY_GITHUB_TOOLS = new Set(
  getToolCanonicalNames({ source: 'github', readOnly: true }),
);

export const PARALLEL_READ_ONLY_SANDBOX_TOOLS = new Set(
  getToolCanonicalNames({ source: 'sandbox', readOnly: true }),
);

// Canonical caps live in `@push/lib/tool-call-grouping` so the CLI engine
// (`cli/engine.ts`) and the web dispatcher pull from the same source.
// Re-exported here so existing imports (`@/lib/tool-dispatch`) keep
// working without churn.
export { MAX_PARALLEL_TOOL_CALLS, MAX_FILE_MUTATION_BATCH };
const KNOWN_CAPABILITIES = new Set<Capability>(ALL_CAPABILITIES);

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asTrimmedStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

/** Check whether a tool call is read-only (safe for parallel execution). */
export function isReadOnlyToolCall(toolCall: AnyToolCall): boolean {
  return isReadOnlyToolName(toolCall.call.tool);
}

/**
 * Check whether a tool call is a pure file mutation — safe to batch
 * sequentially within a single turn without any side-effect ordering.
 */
export function isFileMutationToolCall(toolCall: AnyToolCall): boolean {
  return isFileMutationToolName(toolCall.call.tool);
}

/** Result of scanning a response for all tool calls. */
export interface DetectedToolCalls {
  /** Read-only calls that can safely execute in parallel. */
  readOnly: AnyToolCall[];
  /**
   * Parallel-safe delegations (concurrent Explorers) collected during the
   * read phase. Populated only when the caller opts into the bucket via
   * `detectAllToolCalls(text, { maxParallelDelegations })` — the Inline
   * Foreground Lane (cap 2). Empty/absent for the Orchestrator path, which
   * keeps routing a single `delegate_explorer` through `mutating` as before.
   * Optional so existing callers that build a `DetectedToolCalls` literal
   * don't have to populate it; consumers default to `[]`.
   */
  parallelDelegations?: AnyToolCall[];
  /**
   * Contiguous batch of safe file-mutation calls (such as
   * write/edit/patch on sandbox-backed surfaces). Runs sequentially
   * after the parallel reads and before the trailing side-effect.
   * Execution stops on the first hard failure — the batch is NOT
   * atomic, partial state can remain on-disk after an error.
   */
  fileMutations: AnyToolCall[];
  /**
   * Optional trailing side-effecting call (exec, commit, push, delegate,
   * workflow dispatch, etc.). At most one per turn. Runs after the
   * fileMutations batch.
   */
  mutating: AnyToolCall | null;
  /**
   * File-mutation calls that exceeded MAX_FILE_MUTATION_BATCH. Distinct
   * from `extraMutations` so callers can give the model a "split the
   * batch across turns" hint specifically for this case, instead of a
   * generic ordering-violation message. PR #680 (CLI cap adoption +
   * Copilot review on hint shape).
   */
  batchOverflow: AnyToolCall[];
  /**
   * Ordering-violation calls the turn couldn't accommodate. Sources
   * include: a second side-effect, any call after a side-effect, a
   * read emitted after the mutation transaction began, and a file
   * mutation that didn't reach the batch because the transaction was
   * already done (exec → write_file). File-mutation batch overflow
   * lives in `batchOverflow`, NOT here. Callers reject these with a
   * structured error so the model can correct on the next turn.
   */
  extraMutations: AnyToolCall[];
  /**
   * `{tool, args}`-shaped candidates that no source validated. Captured
   * separately so callers can surface a parse error to the model instead
   * of silently dropping them when other calls in the same turn happen to
   * validate. Before this slot existed, a malformed `edit_range` paired
   * with a valid `diff` would execute only the diff, biasing the model
   * into "edit appears clean — try again" loops.
   */
  droppedCandidates: DroppedToolCallCandidate[];
}

export type { DroppedToolCallCandidate } from '@push/lib/deep-reviewer-agent';

/**
 * Scan assistant output for ALL tool calls and group them into a single
 * mutation transaction per turn.
 *
 * Grouping rule:
 *   1. A contiguous prefix of read-only calls goes into `readOnly` (parallel).
 *   2. Any number of contiguous file-mutation calls (such as write/edit/patch
 *      on sandbox-backed surfaces) go into `fileMutations` (executed sequentially;
 *      stops on first hard failure, NOT atomic).
 *   3. At most one trailing side-effecting call (exec, commit, push,
 *      delegate, workflow dispatch, etc.) goes into `mutating`.
 *   4. Anything that violates that ordering — a read after mutations
 *      started, a second side-effect, any call after a side-effect, or
 *      file-mutation overflow beyond MAX_FILE_MUTATION_BATCH — goes into
 *      `extraMutations` so the caller can surface a structured error and
 *      let the model correct on the next turn.
 *
 * Falls back cleanly when only one call is present.
 */
/**
 * Web's single-source `ToolSource` adapter: hands a kernel-extracted
 * `ParsedToolObject` to the existing `detectAnyToolCall` cascade by
 * re-stringifying. Collapses the per-source typing the kernel was
 * designed for back into the cascade-based detection web has always
 * done — fine, because web's runtime dispatch (`executeAnyToolCall`)
 * branches on `AnyToolCall.source` rather than caring whether the
 * kernel routed it to a typed source.
 *
 * The re-stringify cost is microseconds per detection. The win is that
 * web inherits the kernel's fenced-block + bare-object extraction
 * pipeline — including the fenced-array support, the four
 * 2026-04-18 silent-drop variants, and the `repairToolJson` /
 * `applyJsonTextRepairs` recovery passes — for free.
 *
 * Note: the kernel's structural gate requires `parsed.args` to be a
 * plain object before any source sees it. Tool shapes that don't carry
 * `args` at the top level (notably scratchpad's flat
 * `{tool, content}` form) are rejected by the kernel as
 * `missing_args_object` and never reach this adapter. Those still flow
 * through the legacy fallback below — see `detectFromLegacyScan`.
 */
const WEB_DISPATCH_SOURCE: ToolSource<AnyToolCall> = {
  name: 'web-cascade',
  detect: (parsed: ParsedToolObject) => {
    return detectStructuredToolCall(parsed.tool, parsed.args);
  },
};

// `enableInternalRecovery: false` defers namespaced/XML recovery to the
// web layer's outer pass (gated on `!hasExplicitWrappers`). Otherwise the
// kernel's internal recovery would fire whenever its candidate list is
// empty — including when canonical wrappers were present but failed the
// kernel's structural gate (e.g. scratchpad flat-form) — and a recovered
// call would land in `calls` even though web's own gate would have
// suppressed it. Codex P2 review on PR #679.
const webDispatcher = createToolDispatcher<AnyToolCall>([WEB_DISPATCH_SOURCE], {
  enableInternalRecovery: false,
});

/** Internal: a call paired with its textual start offset in the source. */
interface OffsetCall {
  call: AnyToolCall;
  offset: number;
}

/**
 * Brace-counted scan that returns every top-level JSON object in `text`
 * together with its starting offset. Mirrors `extractAllBareJsonObjects`
 * from `@push/lib/tool-call-diagnosis` (which discards offsets), but
 * keeps the position so the legacy fallback can be merged with kernel
 * results by textual order. Includes the JSON-repair fallback for
 * objects that don't parse cleanly, matching the shared helper.
 */
interface BareObjectAtOffset {
  parsed: Record<string, unknown>;
  start: number;
}
function scanBareObjectsWithOffsets(text: string): BareObjectAtOffset[] {
  const results: BareObjectAtOffset[] = [];
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
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        results.push({ parsed: parsed as Record<string, unknown>, start: braceIdx });
      }
    } catch {
      // Not valid JSON. The shared helper attempts `repairToolJson`
      // here for the well-formed tool-name path; we skip the repair
      // because the legacy fallback only needs to catch the shapes
      // the kernel already missed, and repair-needing shapes will
      // have come through the kernel's malformed channel instead.
    }
    i = end + 1;
  }
  return results;
}

/**
 * True if the text region immediately preceding `objectStart` ends with
 * a namespaced-call prefix (`functions.<name>:<id>` + optional
 * whitespace) or an XML `<tool_call>` / `<invoke>` open tag. These
 * shapes embed a JSON args object that `scanBareObjectsWithOffsets`
 * would otherwise surface as a candidate for bare-args inference.
 *
 * Shape-based, NOT recovery-claimed-based: the recovery functions
 * have their own trailing-context gate that REJECTS prose mentions
 * (e.g. `Note: ignore functions.exec:0 {"command":"rm -rf /"}`), but
 * that prose object would STILL get picked up by bare-args inference
 * and silently execute as a real sandbox_exec. So this check looks
 * at the prefix shape regardless of whether recovery would claim it
 * — the safety bar for bare-args inference is broader than the bar
 * for recovery promotion. Codex P1 review on PR #683 closed the
 * gap that an earlier attempt to use `RecoveredNamespacedCall.endOffset`
 * directly left open (recovery rejects the prose mention but the
 * args still leaks through).
 *
 * Lookback window is 80 chars — covers `<tool_call>\n  ` and
 * `functions.<longname>:<longid>  ` with headroom. Tighter than the
 * 64-char `MAX_PREFIX_TO_ARGS_GAP` used inside the namespaced
 * recovery itself; the extra slack is for the XML tag plus possible
 * newline/whitespace formatting between the open tag and the args
 * object.
 */
const NAMESPACED_PREFIX_LOOKBACK = /functions\.[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*[a-zA-Z0-9_]+\s*$/;
const XML_TOOL_CALL_LOOKBACK = /<tool_call\b[^>]*>\s*$/;
const XML_INVOKE_LOOKBACK = /<invoke\b[^>]*>\s*$/;
function isInsideRecoveryArgsRegion(text: string, objectStart: number): boolean {
  const lookback = text.slice(Math.max(0, objectStart - 80), objectStart);
  return (
    NAMESPACED_PREFIX_LOOKBACK.test(lookback) ||
    XML_TOOL_CALL_LOOKBACK.test(lookback) ||
    XML_INVOKE_LOOKBACK.test(lookback)
  );
}

/**
 * Legacy fallback: brace-count extraction + cascade detection over every
 * parsed bare JSON object. Returns each call with its source-text
 * start offset so the caller can merge with kernel calls in textual
 * order. Catches three things the kernel can't:
 *
 *   1. **Scratchpad flat-form** — `{tool, content}` without an `args`
 *      wrapper. The kernel's structural gate rejects it pre-source.
 *   2. **Bare-args inference** — `{repo, path, start_line, end_line}`
 *      with no `tool` field at all. The kernel's bare-object phase
 *      only extracts objects WITH a `tool` field, so these never
 *      reach a source. `detectAnyToolCall`'s `tryRecoverBareToolArgs`
 *      path can still claim them.
 *   3. **Failed bare-block-eligibility** — when one bare object in a
 *      sequence lacks a `tool` field, the kernel's contiguity gate
 *      rejects the whole sequence, including the well-formed sibling.
 *      Legacy picks up the well-formed one here.
 *
 * Bare-args inference (#2) is gated on `isInsideRecoveryArgsRegion`
 * to avoid the false-positive-execution risk where a JSON object
 * preceded by a namespaced or XML prefix shape (regardless of whether
 * the recovery function would claim it) gets re-inferred as a real
 * tool call. The recovery functions have their own trailing-context
 * gate that REJECTS prose mentions, but the args object survives
 * `scanBareObjectsWithOffsets` and would still execute via
 * `tryRecoverBareToolArgs`. The shape-based check closes that gap.
 * Codex P1 review on PR #683.
 *
 * Dedup against kernel-claimed calls happens at the call site via
 * canonical invocation key over the merged offset-sorted list.
 */
function detectFromLegacyScan(text: string): {
  entries: OffsetCall[];
  droppedCandidates: DroppedToolCallCandidate[];
  droppedIdentities: string[];
} {
  const parsedObjects = scanBareObjectsWithOffsets(text);
  if (parsedObjects.length === 0) {
    return { entries: [], droppedCandidates: [], droppedIdentities: [] };
  }
  const entries: OffsetCall[] = [];
  const droppedCandidates: DroppedToolCallCandidate[] = [];
  const droppedIdentities: string[] = [];
  for (const { parsed, start } of parsedObjects) {
    // Skip bare-args inference when the object is preceded by a
    // recovery-shape prefix. Objects WITH a `tool` field still pass
    // through so flat-form scratchpad/todo via the cascade (purpose
    // #1 above) keeps working.
    if (typeof parsed.tool !== 'string' && isInsideRecoveryArgsRegion(text, start)) {
      continue;
    }
    const serialized = JSON.stringify(parsed);
    const call = detectAnyToolCall(serialized);
    if (!call) {
      const rawToolName = typeof parsed.tool === 'string' ? parsed.tool.trim() : null;
      if (rawToolName) {
        const args =
          parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
            ? (parsed.args as Record<string, unknown>)
            : null;
        droppedCandidates.push({
          rawToolName,
          resolvedToolName: resolveToolName(rawToolName),
          sample: serialized.length > 200 ? `${serialized.slice(0, 200)}…` : serialized,
        });
        droppedIdentities.push(
          args ? stableInvocationKey(rawToolName, args) : `raw:${rawToolName}`,
        );
      }
      continue;
    }
    entries.push({ call, offset: start });
  }
  return { entries, droppedCandidates, droppedIdentities };
}

/**
 * Map a kernel `ToolMalformedReport` into web's `DroppedToolCallCandidate`
 * shape. The kernel now carries the attempted `tool` name as `rawToolName`,
 * so we resolve the canonical name from it directly. When the kernel couldn't
 * recover a name (e.g. `json_parse_error` with no `tool` substring), the
 * candidate is dropped silently — matching prior behavior where unparseable
 * malformed text never reached `droppedCandidates` either.
 */
function mapMalformedToDropped(report: ToolMalformedReport): DroppedToolCallCandidate | null {
  // The kernel now carries the parsed `tool` name on the report, so we resolve
  // the canonical name directly instead of re-parsing `report.sample` — the
  // sample is truncated, which made the old JSON.parse lossy on longer calls.
  const rawToolName = report.rawToolName?.trim();
  if (!rawToolName) return null;
  return {
    rawToolName,
    resolvedToolName: resolveToolName(rawToolName),
    sample: report.sample.length > 200 ? `${report.sample.slice(0, 200)}…` : report.sample,
  };
}

/** Per-call opts for {@link detectAllToolCalls}. */
export interface DetectToolCallsOptions {
  /**
   * Enable the parallel-delegation bucket (concurrent Explorers) with this
   * cap. Omitted/0 → `delegate_explorer` keeps falling through to the single
   * trailing `mutating` slot (the Orchestrator default). The Inline Foreground
   * Lane passes 2.
   */
  maxParallelDelegations?: number;
}

export function detectAllToolCalls(text: string, opts?: DetectToolCallsOptions): DetectedToolCalls {
  const empty: DetectedToolCalls = {
    readOnly: [],
    parallelDelegations: [],
    fileMutations: [],
    mutating: null,
    batchOverflow: [],
    extraMutations: [],
    droppedCandidates: [],
  };

  // Phase 1: kernel-driven fenced + bare-object extraction. Inherits
  // the Gemini-3-Flash fenced-array fix and the four 2026-04-18
  // silent-drop variants for free. `callOffsets` is parallel to
  // `calls` and gives the textual start position of each call's
  // source candidate — exact data from the kernel, not a heuristic
  // re-derivation.
  const kernelResult = webDispatcher.detectAllToolCalls(text);
  const kernelEntries: OffsetCall[] = kernelResult.calls.map((call, i) => ({
    call,
    offset: kernelResult.callOffsets[i],
  }));
  const droppedCandidates: DroppedToolCallCandidate[] = [];
  const droppedIdentities: string[] = [];

  // Track which dropped candidates we've already surfaced so the legacy
  // fallback below doesn't double-report shapes the kernel already
  // claimed. Prefer a stable invocation key when the candidate parsed far
  // enough to expose args; fall back to rawToolName for older/more malformed
  // shapes where args are unavailable.
  const droppedSeen = new Set<string>();
  for (const malformed of kernelResult.malformed) {
    // `missing_args_object` cases are shapes the kernel's structural
    // gate rejected pre-source. The legacy fallback owns the verdict
    // for those (it cascades through detectors that accept `args`-less
    // shapes like scratchpad-flat-form). Skip them here so legacy can
    // report them exactly once.
    if (malformed.reason === 'missing_args_object') continue;
    const dropped = mapMalformedToDropped(malformed);
    if (!dropped) continue;
    const identity = malformed.canonicalInvocationKey ?? `raw:${dropped.rawToolName}`;
    if (droppedSeen.has(identity)) continue;
    droppedSeen.add(identity);
    droppedCandidates.push(dropped);
    droppedIdentities.push(identity);
  }

  // `extractBareToolJsonObjects` requires a string `tool` field, so
  // `hasExplicitWrappers` is the same signal the old code used as
  // `extractBareToolJsonObjects(text).length > 0`. Used to gate both
  // Phase 2 (namespaced/XML recovery — only when zero canonical
  // wrappers exist) and Phase 3 (legacy fallback — only when at least
  // one canonical wrapper exists, so prose JSON examples like
  // `{ path: "...", content: "..." }` aren't mis-inferred as tool
  // calls). Matches pre-kernel behavior exactly.
  const hasExplicitWrappers = extractBareToolJsonObjects(text).length > 0;

  // Phase 2: namespaced + XML recovery (Kimi/Blackbox + Hermes/Qwen/Nous
  // finetunes). Only fires when the model emitted ZERO canonical
  // `{tool: ...}` wrappers in the text. A wrapper that exists but
  // fails source-claiming still suppresses recovery: the canonical
  // signal trumps heuristic recovery. Copilot review on PR #678.
  const recoveryEntries: OffsetCall[] = [];
  if (!hasExplicitWrappers && kernelEntries.length === 0) {
    const recoveries = [
      ...recoverNamespacedToolCalls(text),
      ...recoverXmlToolCalls(text),
      ...recoverTokenDelimitedToolCalls(text),
    ].sort((a, b) => a.offset - b.offset);
    const recoveredKeys = new Set<string>();
    for (const recovered of recoveries) {
      const call = wrapRecoveredCallToAny(recovered.tool, recovered.args);
      if (!call) continue;
      recoveryEntries.push({ call, offset: recovered.offset });
      recoveredKeys.add(stableInvocationKey(recovered.tool.trim(), recovered.args));
    }
    // Reconcile the kernel's malformed reports against what this pass
    // claimed. `enableInternalRecovery: false` makes the kernel emit every
    // recovery shape as an `unknown_tool` malformed (it defers recovery to
    // this layer), and those mapped into `droppedCandidates` above. Now
    // that this pass has turned the same shapes into real calls, drop the
    // duplicate reports — otherwise the dropped-candidate guard in
    // `chat-send` short-circuits the turn into a parse-error correction and
    // the recovered call never executes. Because this branch only runs when
    // `!hasExplicitWrappers` (no canonical/bare JSON in the text), every
    // kernel malformed here is recovery-origin, so matching on the full
    // invocation key can't shadow a genuine canonical drop. Recovery shapes
    // this pass could NOT claim (`wrapRecoveredCallToAny` → null, e.g. a
    // genuinely unknown tool or invalid args for that tool) are absent from
    // the set and correctly stay in `droppedCandidates`, even when another
    // recovered sibling used the same raw tool name.
    if (recoveredKeys.size > 0) {
      for (let i = droppedCandidates.length - 1; i >= 0; i--) {
        const identity = droppedIdentities[i];
        if (identity && recoveredKeys.has(identity)) {
          droppedSeen.delete(identity);
          droppedCandidates.splice(i, 1);
          droppedIdentities.splice(i, 1);
        }
      }
    }
  }

  // Phase 3: legacy fallback for shapes the kernel's structural gate
  // rejects (scratchpad flat-form, bare-args inference, failed
  // bare-block-eligibility). Gated on `hasExplicitWrappers` ONLY —
  // not on `kernelEntries.length > 0 || hasExplicitWrappers` — so a
  // recovered namespaced/XML call from Phase 2 doesn't enable
  // bare-args inference over a prose `{ path: ... }` example. That
  // false-positive risk is exactly what the pre-kernel
  // `extractBareToolJsonObjects(text).length > 0` gate prevented.
  // Copilot review on PR #679.
  let legacyEntries: OffsetCall[] = [];
  if (hasExplicitWrappers) {
    const legacyResult = detectFromLegacyScan(text);
    legacyEntries = legacyResult.entries;
    for (let i = 0; i < legacyResult.droppedCandidates.length; i++) {
      const dropped = legacyResult.droppedCandidates[i];
      const identity = legacyResult.droppedIdentities[i] ?? `raw:${dropped.rawToolName}`;
      if (droppedSeen.has(identity)) continue;
      droppedSeen.add(identity);
      droppedCandidates.push(dropped);
      droppedIdentities.push(identity);
    }
  }

  // Merge all three sources by textual offset and dedup by canonical
  // invocation key. Preserves the model's intended ordering so the
  // grouping state machine sees calls in emit order — critical when
  // a flat-form call precedes a kernel-claimed wrapped call, since
  // the order determines which side-effect runs vs lands in
  // extraMutations. Codex P1 / Copilot review on PR #679.
  const merged: OffsetCall[] = [...kernelEntries, ...recoveryEntries, ...legacyEntries].sort(
    (a, b) => a.offset - b.offset,
  );
  const allCalls: AnyToolCall[] = [];
  const seen = new Set<string>();
  for (const entry of merged) {
    const key = getCanonicalInvocationKey(entry.call);
    if (seen.has(key)) continue;
    seen.add(key);
    allCalls.push(entry.call);
    // Soft cap: leave headroom for the batch + trailing side-effect.
    if (allCalls.length > MAX_PARALLEL_TOOL_CALLS + MAX_FILE_MUTATION_BATCH + 1) break;
  }

  // Enforce argument-type contracts: a call whose args still carry a
  // non-coercible `type_mismatch` after normalization is diverted to
  // `droppedCandidates` (→ `validation_failed` feedback) rather than executed
  // with an unusable arg. Only `type_mismatch` blocks; `missing_required` and
  // `enum_violation` stay advisory (see `divertArgTypeMismatches`).
  const validatedCalls = divertArgTypeMismatches(allCalls, droppedCandidates);
  if (validatedCalls.length === 0) return { ...empty, droppedCandidates };
  return { ...classifyDetectedCalls(validatedCalls, opts), droppedCandidates };
}

export function detectNativeToolCalls(
  nativeCalls: readonly NativeToolCall[],
  opts?: DetectToolCallsOptions,
): DetectedToolCalls {
  const allCalls: AnyToolCall[] = [];
  const droppedCandidates: DroppedToolCallCandidate[] = [];
  const seen = new Set<string>();

  for (const nativeCall of nativeCalls) {
    const rawToolName = nativeCall.name.trim();
    const args = asRecord(nativeCall.args);
    const sample = sampleNativeToolCall(nativeCall);
    if (!rawToolName || !args) {
      droppedCandidates.push({
        rawToolName: rawToolName || '(missing)',
        resolvedToolName: rawToolName ? resolveToolName(rawToolName) : null,
        sample,
      });
      continue;
    }

    const key = stableInvocationKey(rawToolName, args);
    if (seen.has(key)) continue;
    seen.add(key);

    // Native function-calls bypass the shared kernel (which logs the text
    // path), so log this surface's coercion/mismatch outcome here. The actual
    // coercion happens inside `detectStructuredToolCall`; this is the one log
    // for the native path. (Kimi/GLM — the providers most prone to type drift.)
    logToolArgOutcome(rawToolName, normalizeToolArgs(rawToolName, args));

    const call = detectStructuredToolCall(rawToolName, args);
    if (call) {
      // Carry the Gemini signed-reasoning token (when present) onto the detected
      // call so it survives classification and lands on the stored tool_use
      // block for replay. Top-level sibling — the per-tool `call` stays typed.
      allCalls.push(
        nativeCall.thoughtSignature
          ? { ...call, thoughtSignature: nativeCall.thoughtSignature }
          : call,
      );
      continue;
    }
    droppedCandidates.push({
      rawToolName,
      resolvedToolName: resolveToolName(rawToolName),
      sample,
    });
  }

  const validatedCalls = divertArgTypeMismatches(allCalls, droppedCandidates);
  if (validatedCalls.length === 0) {
    return {
      readOnly: [],
      parallelDelegations: [],
      fileMutations: [],
      mutating: null,
      batchOverflow: [],
      extraMutations: [],
      droppedCandidates,
    };
  }
  return { ...classifyDetectedCalls(validatedCalls, opts), droppedCandidates };
}

/**
 * Run the reads → fileMutations → trailing side-effect grouping over a
 * deduped, ordered list of tool calls. Delegates to the shared kernel
 * in `lib/tool-call-grouping.ts` so the web dispatcher and the CLI
 * engine (`cli/engine.ts`) enforce the same per-turn contract by
 * construction rather than via two parallel state machines.
 *
 * Web adds the `droppedCandidates: []` field to fit `DetectedToolCalls`;
 * the shared kernel returns the minimal four-field shape.
 */
function normalizeMutationPathKey(path: string): string {
  let normalized = path.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  const isAbsolute = normalized.startsWith('/');
  let isWorkspaceRelative = false;
  if (normalized.startsWith('/workspace/')) {
    normalized = normalized.slice('/workspace/'.length);
    isWorkspaceRelative = true;
  } else if (normalized === '/workspace') {
    return '.';
  }
  // Resolve . and .. segments so alias paths like `src/../api.ts` collide with `api.ts`.
  const segments = normalized.split('/');
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(seg);
  }
  const joined = resolved.join('/') || '.';
  // Preserve the absolute root for non-workspace paths so /tmp/out.txt and
  // a workspace-relative tmp/out.txt don't collide.
  return isAbsolute && !isWorkspaceRelative ? `/${joined}` : joined;
}

function getFileMutationPathKeys(toolCall: AnyToolCall): string[] {
  if (toolCall.source !== 'sandbox') return [];
  const { call } = toolCall;
  switch (call.tool) {
    case 'sandbox_write_file':
    case 'sandbox_edit_file':
    case 'sandbox_edit_range':
    case 'sandbox_search_replace':
      return [normalizeMutationPathKey(call.args.path)];
    case 'sandbox_apply_patchset':
      return [
        ...new Set(
          call.args.edits
            .map((edit) => normalizeMutationPathKey(edit.path))
            .filter((path) => path.length > 0),
        ),
      ];
    default:
      return [];
  }
}

function splitOverlappingFileMutations(fileMutations: AnyToolCall[]): {
  accepted: AnyToolCall[];
  rejected: AnyToolCall[];
} {
  const seenPaths = new Set<string>();
  const accepted: AnyToolCall[] = [];
  const rejected: AnyToolCall[] = [];

  for (const call of fileMutations) {
    const pathKeys = getFileMutationPathKeys(call);
    const conflicts = pathKeys.some((path) => seenPaths.has(path));
    if (conflicts) {
      rejected.push(call);
      continue;
    }
    accepted.push(call);
    for (const path of pathKeys) seenPaths.add(path);
  }

  return { accepted, rejected };
}

/**
 * A parallel-safe delegation: read-only investigation the lead may fan out
 * concurrently. Only `delegate_explorer` qualifies — `delegate_coder` and
 * `plan_tasks` carry real side effects and stay in the single trailing slot.
 */
export function isParallelDelegationToolCall(toolCall: AnyToolCall): boolean {
  return toolCall.source === 'delegate' && toolCall.call.tool === 'delegate_explorer';
}

/**
 * Enforcement pass for the web surface: divert any call carrying a
 * non-coercible argument-type mismatch into `droppedCandidates`, where
 * `handleDroppedCandidatesError` turns it into a `validation_failed`
 * `[TOOL_CALL_PARSE_ERROR]` with the tool's schema + example
 * (`buildValidationFailedHint`). Returns the calls that passed.
 *
 * Scope — only `type_mismatch`, only when BOTH sides are scalar, only on web:
 *   - By the time a call reaches here its args have already been coerced
 *     (`detectStructuredToolCall`), so every *recoverable* drift is gone. A
 *     surviving scalar `type_mismatch` (a non-numeric string for an integer, a
 *     non-boolean string for a flag) is an unusable value — blocking it is
 *     strictly better than passing it downstream.
 *   - Blocking is gated to scalar expected/actual types on purpose. The derived
 *     schema (`tool-function-schemas.ts`) is best-effort and global-by-param-
 *     name, so it's least reliable exactly where a name carries different
 *     *structure* across tools — `checks` was a boolean in one place and an
 *     object array in another. A structural mismatch is therefore far more
 *     likely a schema gap than a real model error, so it stays advisory (logged)
 *     rather than hard-rejecting an already-validated call (Codex P1 on #1185).
 *   - `missing_required` and `enum_violation` also stay advisory: required-field
 *     gaps overlap with the executors' own checks, and the only enum today is
 *     the active-repo pin, which the dispatcher doesn't bind here.
 *   - The CLI deliberately drops the kernel's `malformed` channel
 *     (`wrapCliDetectAllToolCalls`) and enforces arg types in its executor
 *     instead, so the equivalent enforcement there is downstream, not at parse
 *     time. Diverting at the shared kernel would silently drop the call on the
 *     CLI with no feedback — hence this lives on the web dispatcher only.
 */
function divertArgTypeMismatches(
  allCalls: AnyToolCall[],
  droppedCandidates: DroppedToolCallCandidate[],
): AnyToolCall[] {
  const kept: AnyToolCall[] = [];
  for (const toolCall of allCalls) {
    const dropped = validateCallArgTypes(toolCall);
    if (dropped) {
      droppedCandidates.push(dropped);
      continue;
    }
    kept.push(toolCall);
  }
  return kept;
}

/**
 * Return a `DroppedToolCallCandidate` describing a blocking arg-type mismatch on
 * `toolCall`, or null when the call's args satisfy the schema (or carry no
 * validatable args object, e.g. scratchpad flat-form). Emits a structured log on
 * the blocking branch so the diversion is visible to ops.
 */
function validateCallArgTypes(toolCall: AnyToolCall): DroppedToolCallCandidate | null {
  if (!('args' in toolCall.call)) return null;
  const args = (toolCall.call as { args?: unknown }).args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;

  const toolName = toolCall.call.tool;
  const { mismatches } = normalizeToolArgs(toolName, args as Record<string, unknown>);
  // Block only scalar-vs-scalar mismatches; structural mismatches are where the
  // best-effort schema is least trustworthy, so they stay advisory (see above).
  const SCALAR_EXPECTED = new Set(['integer', 'number', 'boolean']);
  const SCALAR_ACTUAL = new Set(['string', 'number', 'boolean']);
  const blocking = mismatches.filter(
    (m) =>
      m.reason === 'type_mismatch' &&
      !!m.expected &&
      SCALAR_EXPECTED.has(m.expected) &&
      !!m.actualType &&
      SCALAR_ACTUAL.has(m.actualType),
  );
  if (blocking.length === 0) return null;

  const detail = blocking
    .map((m) => `${m.param}: expected ${m.expected}, got ${m.actualType}`)
    .join('; ');
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'tool_arg_validation_blocked',
      tool: toolName,
      mismatches: blocking,
    }),
  );
  const publicName = getToolPublicName(toolName);
  return {
    rawToolName: publicName,
    resolvedToolName: toolName,
    sample: `{"tool":"${publicName}", ...} — argument type mismatch (${detail})`,
  };
}

function classifyDetectedCalls(
  allCalls: AnyToolCall[],
  opts?: DetectToolCallsOptions,
): DetectedToolCalls {
  const grouped = groupCallsByPhase<AnyToolCall>(
    allCalls,
    {
      isReadOnly: isReadOnlyToolCall,
      isFileMutation: isFileMutationToolCall,
      isParallelDelegation: isParallelDelegationToolCall,
    },
    {
      maxParallelReads: MAX_PARALLEL_TOOL_CALLS,
      maxFileMutationBatch: MAX_FILE_MUTATION_BATCH,
      maxParallelDelegations: opts?.maxParallelDelegations,
    },
  );
  const splitFileMutations = splitOverlappingFileMutations(grouped.fileMutations);
  return {
    ...grouped,
    fileMutations: splitFileMutations.accepted,
    extraMutations: [...splitFileMutations.rejected, ...grouped.extraMutations],
    droppedCandidates: [],
  };
}

/** Extract the tool name from a unified tool call. */
function getToolCallName(toolCall: AnyToolCall): string {
  return toolCall.call.tool;
}

/**
 * Build a canonical key for deduping logically-identical tool invocations.
 * Uses stable-key JSON serialization so key order differences do not matter.
 */
function getCanonicalInvocationKey(toolCall: AnyToolCall): string {
  const canonical: CanonicalToolInvocation = {
    source: toolCall.source,
    toolName: getToolCallName(toolCall),
    args: getToolCallArgs(toolCall),
  };
  return `${canonical.source}:${canonical.toolName}:${stableJsonStringify(canonical.args)}`;
}

interface CanonicalToolInvocation {
  source: AnyToolCall['source'];
  toolName: string;
  args: unknown;
}

/** Build a normalized arg payload for canonical invocation dedupe. */
function getToolCallArgs(toolCall: AnyToolCall): unknown {
  switch (toolCall.source) {
    case 'github':
    case 'sandbox':
    case 'delegate':
    case 'web-search':
    case 'artifacts':
    case 'memory':
      return toolCall.call.args;
    case 'scratchpad':
      return { tool: toolCall.call.tool, content: toolCall.call.content };
    case 'todo':
      if (toolCall.call.tool === 'todo_write') {
        return { tool: toolCall.call.tool, todos: toolCall.call.todos };
      }
      return { tool: toolCall.call.tool };
    default:
      return {};
  }
}

/**
 * Stable JSON stringify: recursively sorts object keys and drops undefined
 * object properties so logically-equivalent payloads produce the same key.
 */
function stableJsonStringify(value: unknown): string {
  const normalized = normalizeJsonValue(value);
  return JSON.stringify(normalized === undefined ? null : normalized);
}

function normalizeJsonValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const normalized = normalizeJsonValue(item);
      // Mirror JSON.stringify behavior for arrays: undefined -> null.
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
  // Functions/symbols/bigints are not valid JSON values.
  return undefined;
}

// Delegate variants are kept as separate union members (rather than a single
// variant with a union of `call` shapes) so that `Extract<AnyToolCall, { call:
// { tool: '...' } }>` distributes correctly in each handler. The runtime
// payload is unchanged; this is purely for the type projection.
type AnyToolCallSource =
  | { source: 'github'; call: ToolCall }
  | { source: 'sandbox'; call: SandboxToolCall }
  | { source: 'delegate'; call: { tool: 'delegate_coder'; args: CoderDelegationArgs } }
  | { source: 'delegate'; call: { tool: 'delegate_explorer'; args: ExplorerDelegationArgs } }
  | { source: 'delegate'; call: { tool: 'plan_tasks'; args: TaskGraphArgs } }
  | { source: 'scratchpad'; call: ScratchpadToolCall }
  | { source: 'todo'; call: TodoToolCall }
  | { source: 'web-search'; call: WebSearchToolCall }
  | { source: 'ask-user'; call: AskUserToolCall }
  | { source: 'artifacts'; call: ArtifactToolCall }
  | { source: 'memory'; call: MemoryToolCall };

/**
 * A detected tool call. `thoughtSignature` is an optional top-level sibling
 * (not inside the per-tool `call`, which is strongly typed per source) carrying
 * Gemini's signed-reasoning token from a native function-call so it can be
 * stored on the tool_use block and replayed. The intersection distributes the
 * optional field across every arm without touching any construction site or
 * disturbing discriminant narrowing on `source` / `call.tool`.
 */
export type AnyToolCall = AnyToolCallSource & { thoughtSignature?: string };

/**
 * Scan assistant output for any tool call (GitHub, Sandbox, Scratchpad, or delegation).
 * Returns the first match, or null if no tool call is detected.
 */
export function detectAnyToolCall(text: string): AnyToolCall | null {
  // Check delegation tools first (special dispatch, not repo tools)
  const delegateMatch = detectDelegationTool(text);
  if (delegateMatch) return delegateMatch;

  // Check scratchpad tools (set_scratchpad, append_scratchpad)
  const scratchpadCall = detectScratchpadToolCall(text);
  if (scratchpadCall) return { source: 'scratchpad', call: scratchpadCall };

  // Check todo tools (todo_write, todo_read, todo_clear)
  const todoCall = detectTodoToolCall(text);
  if (todoCall) return { source: 'todo', call: todoCall };

  // Check web search tool
  const webSearchCall = detectWebSearchToolCall(text);
  if (webSearchCall) return { source: 'web-search', call: webSearchCall };

  // Check ask_user tool
  const askUserCall = detectAskUserToolCall(text);
  if (askUserCall) return { source: 'ask-user', call: askUserCall };

  // Check create_artifact tool (artifact dispatch)
  const artifactCall = detectArtifactToolCall(text);
  if (artifactCall) return { source: 'artifacts', call: artifactCall };

  // Check memory tools (memory_grep, memory_expand)
  const memoryCall = detectMemoryToolCall(text);
  if (memoryCall) return { source: 'memory', call: memoryCall };

  // Check sandbox tools (sandbox_ prefix)
  const sandboxCall = detectSandboxToolCall(text);
  if (sandboxCall) return { source: 'sandbox', call: sandboxCall };

  // Check GitHub tools
  const githubCall = detectToolCall(text);
  if (githubCall) return { source: 'github', call: githubCall };

  // Last resort: try to recover bare JSON args (missing {"tool":..,"args":..} wrapper).
  // Some models emit just the arguments object without the required wrapper format.
  const recovered = tryRecoverBareToolArgs(text);
  if (recovered) return recovered;

  // Fallback for non-canonical wrappers — namespaced (`functions.<name>:<id>
  // <args>`, Kimi/Blackbox), XML (`<tool_call>...</tool_call>`,
  // Hermes/Qwen/Nous finetunes), and token-delimited native formats
  // (Mistral `[TOOL_CALLS]`, DeepSeek `<｜tool▁calls▁begin｜>`). Merge +
  // sort by offset so the textually-first call wins regardless of which
  // shape it's in — matches the "returns the first match" docstring.
  const fallbackRecoveries = [
    ...recoverNamespacedToolCalls(text),
    ...recoverXmlToolCalls(text),
    ...recoverTokenDelimitedToolCalls(text),
  ].sort((a, b) => a.offset - b.offset);
  for (const recovered of fallbackRecoveries) {
    const call = wrapRecoveredCallToAny(recovered.tool, recovered.args);
    if (call) return call;
  }

  return null;
}

/**
 * Wrap a recovered `{tool, args}` pair as a typed AnyToolCall.
 *
 * Tries the prefix-derived name first, then falls back to args-shape
 * inference. The fallback handles the namespace collision where models
 * emit unprefixed names like `read_file` (which the registry resolves to
 * the GitHub variant requiring a `repo` arg) when they actually mean the
 * sandbox tool. `inferToolFromArgs({path: "..."})` correctly returns
 * `sandbox_read_file` in that case.
 */
function wrapRecoveredCallToAny(
  toolName: string,
  args: Record<string, unknown>,
): AnyToolCall | null {
  const tryName = (name: string): AnyToolCall | null => {
    return detectStructuredToolCall(name, args);
  };
  const direct = tryName(toolName);
  if (direct) return direct;
  const inferred = inferToolFromArgs(args);
  if (inferred && inferred !== toolName) return tryName(inferred);
  return null;
}

function detectStructuredToolCall(
  toolName: string,
  args: Record<string, unknown>,
): AnyToolCall | null {
  // Coerce cross-provider argument-type drift against the tool's derived schema
  // before the per-source detectors build the typed call. This is the web
  // chokepoint every structured path funnels through — the kernel `ToolSource`
  // adapter (text path), native function-calls, and namespaced/XML recovery —
  // so all three inherit the same normalization the shared kernel applies to the
  // CLI. Silent (no log) on purpose: the kernel already logs the text path it
  // coerced, and the native entry point logs its own outcome; coercion is
  // idempotent, so re-running it here on already-coerced args is a safe no-op.
  const { args: normalizedArgs } = normalizeToolArgs(toolName, args);
  const text = JSON.stringify({ tool: toolName, args: normalizedArgs });

  const delegateMatch = detectDelegationTool(text);
  if (delegateMatch) return delegateMatch;

  const scratchpadCall = detectScratchpadToolCall(text);
  if (scratchpadCall) return { source: 'scratchpad', call: scratchpadCall };

  const todoCall = detectTodoToolCall(text);
  if (todoCall) return { source: 'todo', call: todoCall };

  const webSearchCall = detectWebSearchToolCall(text);
  if (webSearchCall) return { source: 'web-search', call: webSearchCall };

  const askUserCall = detectAskUserToolCall(text);
  if (askUserCall) return { source: 'ask-user', call: askUserCall };

  const artifactCall = detectArtifactToolCall(text);
  if (artifactCall) return { source: 'artifacts', call: artifactCall };

  const memoryCall = detectMemoryToolCall(text);
  if (memoryCall) return { source: 'memory', call: memoryCall };

  const sandboxCall = detectSandboxToolCall(text);
  if (sandboxCall) return { source: 'sandbox', call: sandboxCall };

  const githubCall = detectToolCall(text);
  if (githubCall) return { source: 'github', call: githubCall };

  return null;
}

function sampleNativeToolCall(call: NativeToolCall): string {
  try {
    const sample = JSON.stringify({
      ...(call.id ? { id: call.id } : {}),
      tool: call.name,
      args: call.args,
    });
    return sample.length > 200 ? `${sample.slice(0, 200)}…` : sample;
  } catch {
    return `{"tool":${JSON.stringify(call.name)},"args":null}`;
  }
}

/**
 * Execute a detected tool call through the appropriate handler.
 *
 * Note: 'scratchpad' and 'delegate' tools are handled at a higher level (useChat),
 * not here. They're detected here but executed in the chat hook.
 *
 * @param isMainProtected — when true, commit/push tools on the default branch are blocked.
 * @param defaultBranch — the repo's default branch name (e.g. 'main', 'master').
 * @param currentBranch — the repo branch Push currently has selected.
 */
export async function executeAnyToolCall(
  toolCall: AnyToolCall,
  allowedRepo: string,
  sandboxId: string | null,
  role: AgentRole,
  isMainProtected?: boolean,
  defaultBranch?: string,
  activeProvider?: ActiveProvider,
  activeModel?: string,
  hooks?: ToolHookRegistry,
  approvalGates?: ApprovalGateRegistry,
  capabilityLedger?: import('./capabilities').CapabilityLedger,
  approvalCallback?: import('@push/lib/tool-execution-runtime').ApprovalCallback,
  chatId?: string,
  localDaemonBinding?: ToolDispatchBinding,
  abortSignal?: AbortSignal,
  executionMode?: import('@push/lib/capabilities').ExecutionMode,
  onExecProgress?: (chunk: { stdout: string; stderr: string }) => void,
  currentBranch?: string,
): Promise<ToolExecutionResult> {
  const runtime = new WebToolExecutionRuntime();
  return runtime.execute(toolCall, {
    allowedRepo,
    sandboxId,
    role,
    isMainProtected: isMainProtected ?? false,
    currentBranch,
    defaultBranch,
    activeProvider: activeProvider,
    activeModel,
    hooks,
    approvalGates,
    capabilityLedger,
    approvalCallback,
    chatId,
    localDaemonBinding,
    abortSignal,
    executionMode,
    onExecProgress,
  }) as Promise<ToolExecutionResult>;
}

// ---------------------------------------------------------------------------
// Tool name sets used by the bare-args recovery path below. The canonical
// union (KNOWN_TOOL_NAMES) and the public sandbox list live in
// `@push/lib/tool-call-diagnosis` and are re-exported at the top of this file.
// ---------------------------------------------------------------------------

const GITHUB_TOOL_NAMES = new Set(getRecognizedToolNames({ source: 'github' }));

// ---------------------------------------------------------------------------
// Bare JSON recovery — models sometimes emit just the args object without
// the required {"tool":"..","args":{..}} wrapper. The helpers
// `extractAllBareJsonObjects` and `inferToolFromArgs` now live in
// `@push/lib/tool-call-diagnosis` and are imported at the top of this file;
// `tryRecoverBareToolArgs` stays here because it depends on the Web-side
// sandbox/github/web-search detectors.
// ---------------------------------------------------------------------------

/**
 * Try to recover valid tool calls from bare JSON args objects.
 * Wraps inferred args in the {"tool":..,"args":..} format and validates
 * through the normal detection pipeline.
 */
function tryRecoverBareToolArgs(text: string): AnyToolCall | null {
  const objects = extractAllBareJsonObjects(text);

  for (const obj of objects) {
    // Skip objects that already have a 'tool' key — those went through normal detection
    if (typeof obj.tool === 'string') continue;

    const toolName = inferToolFromArgs(obj);
    if (!toolName) continue;

    // Wrap as proper tool call JSON and validate through existing detectors
    const wrappedJson = JSON.stringify({ tool: toolName, args: obj });

    if (GITHUB_TOOL_NAMES.has(toolName)) {
      const call = detectToolCall(wrappedJson);
      if (call) return { source: 'github', call };
    } else if (getToolSource(toolName) === 'sandbox') {
      const call = detectSandboxToolCall(wrappedJson);
      if (call) return { source: 'sandbox', call };
    } else if (toolName === 'web_search') {
      const call = detectWebSearchToolCall(wrappedJson);
      if (call) return { source: 'web-search', call };
    }
  }

  return null;
}

// --- Delegation tool detection ---

function detectDelegationTool(text: string): AnyToolCall | null {
  return detectToolFromText<AnyToolCall>(text, (parsed) => {
    const parsedObj = asRecord(parsed);
    const toolName =
      typeof parsedObj?.tool === 'string'
        ? (resolveToolName(parsedObj.tool) ?? parsedObj.tool)
        : '';
    const args = asRecord(parsedObj?.args);
    const task = asTrimmedString(args?.task);
    const tasks = asTrimmedStringArray(args?.tasks);
    const files = asTrimmedStringArray(args?.files);
    const intent = asTrimmedString(args?.intent);
    const deliverable = asTrimmedString(args?.deliverable);
    const knownContext = asTrimmedStringArray(args?.knownContext);
    const constraints = asTrimmedStringArray(args?.constraints);
    const declaredCapabilities = Array.isArray(args?.declaredCapabilities)
      ? (args.declaredCapabilities as unknown[]).filter(
          (entry): entry is Capability =>
            typeof entry === 'string' && KNOWN_CAPABILITIES.has(entry as Capability),
        )
      : undefined;
    // Parse acceptance criteria if provided
    let acceptanceCriteria: AcceptanceCriterion[] | undefined;
    if (Array.isArray(args?.acceptanceCriteria)) {
      acceptanceCriteria = (args.acceptanceCriteria as unknown[])
        .filter((c): c is AcceptanceCriterion => {
          const cr = asRecord(c);
          return !!cr && typeof cr.id === 'string' && typeof cr.check === 'string';
        })
        .map((c) => ({
          id: c.id,
          check: c.check,
          exitCode: typeof c.exitCode === 'number' ? c.exitCode : undefined,
          description: typeof c.description === 'string' ? c.description : undefined,
        }));
      if (acceptanceCriteria.length === 0) acceptanceCriteria = undefined;
    }
    // Require a meaningful task description — reject placeholder/trivially short tasks
    // to prevent phantom delegations when the model fires coder calls inappropriately.
    const MIN_CODER_TASK_LENGTH = 20;
    const hasValidTask = task && task.length >= MIN_CODER_TASK_LENGTH;
    const hasValidTasks =
      tasks && tasks.length > 0 && tasks.some((t) => t.length >= MIN_CODER_TASK_LENGTH);
    if (toolName === 'delegate_coder' && (hasValidTask || hasValidTasks)) {
      return {
        source: 'delegate',
        call: {
          tool: 'delegate_coder',
          args: {
            task,
            tasks,
            files,
            acceptanceCriteria,
            intent,
            deliverable,
            knownContext: knownContext && knownContext.length > 0 ? knownContext : undefined,
            constraints: constraints && constraints.length > 0 ? constraints : undefined,
            declaredCapabilities:
              declaredCapabilities && declaredCapabilities.length > 0
                ? declaredCapabilities
                : undefined,
          },
        },
      };
    }
    const MIN_EXPLORER_TASK_LENGTH = 10;
    if (toolName === 'delegate_explorer' && task && task.length >= MIN_EXPLORER_TASK_LENGTH) {
      return {
        source: 'delegate',
        call: {
          tool: 'delegate_explorer',
          args: {
            task,
            files,
            intent,
            deliverable,
            knownContext: knownContext && knownContext.length > 0 ? knownContext : undefined,
            constraints: constraints && constraints.length > 0 ? constraints : undefined,
          },
        },
      };
    }
    // plan_tasks — dependency-aware multi-agent task graph
    if (toolName === 'plan_tasks' && Array.isArray(args?.tasks)) {
      const rawTasks = args.tasks as unknown[];
      const parsedTasks: import('@/types').TaskGraphNode[] = [];
      for (const raw of rawTasks) {
        const t = asRecord(raw);
        if (!t) continue;
        const id = asTrimmedString(t.id);
        const agent = asTrimmedString(t.agent);
        const nodeTask = asTrimmedString(t.task);
        if (!id || !agent || !nodeTask) continue;
        if (agent !== 'explorer' && agent !== 'coder') continue;
        // Parse per-node acceptance criteria (coder tasks)
        let nodeAcceptanceCriteria: AcceptanceCriterion[] | undefined;
        if (Array.isArray(t.acceptanceCriteria)) {
          nodeAcceptanceCriteria = (t.acceptanceCriteria as unknown[])
            .filter((c): c is AcceptanceCriterion => {
              const cr = asRecord(c);
              return !!cr && typeof cr.id === 'string' && typeof cr.check === 'string';
            })
            .map((c) => ({
              id: c.id,
              check: c.check,
              exitCode: typeof c.exitCode === 'number' ? c.exitCode : undefined,
              description: typeof c.description === 'string' ? c.description : undefined,
            }));
          if (nodeAcceptanceCriteria.length === 0) nodeAcceptanceCriteria = undefined;
        }
        parsedTasks.push({
          id,
          agent: agent as 'explorer' | 'coder',
          task: nodeTask,
          files: asTrimmedStringArray(t.files),
          dependsOn: asTrimmedStringArray(t.dependsOn),
          deliverable: asTrimmedString(t.deliverable),
          acceptanceCriteria: nodeAcceptanceCriteria,
          knownContext: asTrimmedStringArray(t.knownContext),
          constraints: asTrimmedStringArray(t.constraints),
          addresses: asTrimmedString(t.addresses),
        });
      }
      if (parsedTasks.length >= 1) {
        return {
          source: 'delegate',
          call: {
            tool: 'plan_tasks',
            args: { tasks: parsedTasks },
          },
        };
      }
    }
    return null;
  });
}
