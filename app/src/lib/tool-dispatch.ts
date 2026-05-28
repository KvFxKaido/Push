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
import { type ActiveProvider } from './orchestrator';
import { ALL_CAPABILITIES, type Capability } from './capabilities';
import type { AgentRole } from '@push/lib/runtime-contract';
import type { DroppedToolCallCandidate } from '@push/lib/deep-reviewer-agent';
import { asRecord, detectToolFromText, extractBareToolJsonObjects } from './utils';
import {
  getToolCanonicalNames,
  getRecognizedToolNames,
  isFileMutationToolName,
  isReadOnlyToolName,
  resolveToolName,
} from './tool-registry';
import {
  extractAllBareJsonObjects,
  getToolSource,
  inferToolFromArgs,
} from '@push/lib/tool-call-diagnosis';
import { recoverNamespacedToolCalls } from '@push/lib/tool-call-namespaced-recovery';
import { recoverXmlToolCalls } from '@push/lib/tool-call-xml-recovery';
import { groupCallsByPhase } from '@push/lib/tool-call-grouping';
import {
  createToolDispatcher,
  type ParsedToolObject,
  type ToolMalformedReport,
  type ToolSource,
} from '@push/lib/tool-dispatch';

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

export const MAX_PARALLEL_TOOL_CALLS = 6;
/**
 * Cap on the number of file mutations the dispatcher will execute as a
 * single batch in one turn. Generous enough to cover realistic scaffolds
 * (a handful of new docs, a coordinated multi-file config update) but
 * bounded so a runaway tool-call loop still surfaces a clear overflow
 * error instead of executing thousands of writes sequentially.
 */
export const MAX_FILE_MUTATION_BATCH = 8;
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
   * Overflow calls that the turn couldn't accommodate. Sources include:
   * a second side-effect, any call after a side-effect, a read emitted
   * after the mutation transaction began, and file-mutation batch
   * overflow (more than MAX_FILE_MUTATION_BATCH). Callers reject these
   * with a structured error so the model can correct on the next turn.
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
    const serialized = JSON.stringify({ tool: parsed.tool, args: parsed.args });
    return detectAnyToolCall(serialized);
  },
};

const webDispatcher = createToolDispatcher<AnyToolCall>([WEB_DISPATCH_SOURCE]);

/**
 * Legacy fallback: brace-count extraction + cascade detection over every
 * parsed bare JSON object. Catches three things the kernel can't:
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
 * Dedup against kernel-claimed calls happens via `alreadySeen` keyed
 * by `getCanonicalInvocationKey`. Drops dedup against kernel-reported
 * malformed rawToolNames at the call site.
 */
function detectFromLegacyScan(
  text: string,
  alreadySeen: ReadonlySet<string>,
): {
  calls: AnyToolCall[];
  droppedCandidates: DroppedToolCallCandidate[];
} {
  const parsedObjects = extractAllBareJsonObjects(text);
  if (parsedObjects.length === 0) return { calls: [], droppedCandidates: [] };
  const calls: AnyToolCall[] = [];
  const droppedCandidates: DroppedToolCallCandidate[] = [];
  const seen = new Set<string>(alreadySeen);
  for (const parsed of parsedObjects) {
    const parsedRecord = asRecord(parsed);
    const serialized = JSON.stringify(parsed);
    const call = detectAnyToolCall(serialized);
    if (!call) {
      const rawToolName =
        parsedRecord && typeof parsedRecord.tool === 'string' ? parsedRecord.tool.trim() : null;
      if (rawToolName) {
        droppedCandidates.push({
          rawToolName,
          resolvedToolName: resolveToolName(rawToolName),
          sample: serialized.length > 200 ? `${serialized.slice(0, 200)}…` : serialized,
        });
      }
      continue;
    }
    const key = getCanonicalInvocationKey(call);
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push(call);
    if (calls.length > MAX_PARALLEL_TOOL_CALLS + MAX_FILE_MUTATION_BATCH + 1) break;
  }
  return { calls, droppedCandidates };
}

/**
 * Map a kernel `ToolMalformedReport` into web's `DroppedToolCallCandidate`
 * shape. The kernel only reports `{reason, sample}`; web needs raw +
 * resolved tool name. We do a best-effort parse of the sample to
 * extract the tool name; if that fails, the candidate is dropped silently
 * (matching pre-migration behavior where unparseable malformed text
 * never reached `droppedCandidates` either).
 */
function mapMalformedToDropped(report: ToolMalformedReport): DroppedToolCallCandidate | null {
  try {
    const parsed = JSON.parse(report.sample);
    const record = asRecord(parsed);
    const rawToolName = record && typeof record.tool === 'string' ? record.tool.trim() : null;
    if (!rawToolName) return null;
    return {
      rawToolName,
      resolvedToolName: resolveToolName(rawToolName),
      sample: report.sample.length > 200 ? `${report.sample.slice(0, 200)}…` : report.sample,
    };
  } catch {
    return null;
  }
}

export function detectAllToolCalls(text: string): DetectedToolCalls {
  const empty: DetectedToolCalls = {
    readOnly: [],
    fileMutations: [],
    mutating: null,
    extraMutations: [],
    droppedCandidates: [],
  };

  // Phase 1: kernel-driven fenced + bare-object extraction. Inherits
  // the Gemini-3-Flash fenced-array fix and the four 2026-04-18
  // silent-drop variants for free.
  const kernelResult = webDispatcher.detectAllToolCalls(text);
  const allCalls: AnyToolCall[] = [];
  const seen = new Set<string>();
  const droppedCandidates: DroppedToolCallCandidate[] = [];

  for (const call of kernelResult.calls) {
    const key = getCanonicalInvocationKey(call);
    if (seen.has(key)) continue;
    seen.add(key);
    allCalls.push(call);
    if (allCalls.length > MAX_PARALLEL_TOOL_CALLS + MAX_FILE_MUTATION_BATCH + 1) break;
  }

  // Track which dropped candidates we've already surfaced so the legacy
  // fallback below doesn't double-report shapes the kernel already
  // claimed. Key on rawToolName because the two paths emit different
  // samples (kernel: raw fenced text; legacy: re-stringified parsed
  // object), so sample-based deduplication doesn't work.
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
    if (droppedSeen.has(dropped.rawToolName)) continue;
    droppedSeen.add(dropped.rawToolName);
    droppedCandidates.push(dropped);
  }

  // Compute explicit-wrapper presence once — used by both Phase 2 and
  // Phase 3 gates. The pre-kernel code keyed every gate on this value,
  // so we preserve it here to match prior behavior exactly.
  // `extractBareToolJsonObjects` requires a string `tool` field, so
  // `hasExplicitWrappers` is the same signal the old code used as
  // `extractBareToolJsonObjects(text).length > 0`.
  const hasExplicitWrappers = extractBareToolJsonObjects(text).length > 0;

  // Phase 2: namespaced + XML recovery (Kimi/Blackbox + Hermes/Qwen/Nous
  // finetunes). Only fires when the model emitted ZERO canonical
  // `{tool: ...}` wrappers in the text — same gate the pre-kernel
  // code used. A wrapper that exists but fails source-claiming (kernel
  // reports `unknown_tool` malformed) still suppresses recovery: the
  // model signaled intent in canonical form, and a heuristic
  // recovery competing with that intent would override it
  // unpredictably. Copilot review on PR #678.
  if (!hasExplicitWrappers && allCalls.length === 0) {
    const recoveries = [...recoverNamespacedToolCalls(text), ...recoverXmlToolCalls(text)].sort(
      (a, b) => a.offset - b.offset,
    );
    for (const recovered of recoveries) {
      const call = wrapRecoveredCallToAny(recovered.tool, recovered.args);
      if (!call) continue;
      const key = getCanonicalInvocationKey(call);
      if (seen.has(key)) continue;
      seen.add(key);
      allCalls.push(call);
      if (allCalls.length > MAX_PARALLEL_TOOL_CALLS + MAX_FILE_MUTATION_BATCH + 1) break;
    }
  }

  // Phase 3: legacy fallback for shapes the kernel's structural gate
  // rejects (notably scratchpad's flat `{tool, content}` form, plus
  // bare-args inference). Gated on the same condition the pre-kernel
  // code used — at least one `{tool: string}`-shaped object must
  // exist in the text — so we don't mis-detect documentation
  // examples like `{ path: "...", content: "..." }` in a tutorial as
  // real tool calls (Codex review on PR #678). The `allCalls.length`
  // check is belt-and-suspenders for the Phase 2 recovery branch
  // above: if recovery promoted a call, we still want Phase 3 to
  // sweep up any flat-form shapes the recovered text might contain.
  const hasExplicitToolIntent = allCalls.length > 0 || hasExplicitWrappers;
  if (hasExplicitToolIntent) {
    const legacyResult = detectFromLegacyScan(text, seen);
    for (const call of legacyResult.calls) {
      allCalls.push(call);
      if (allCalls.length > MAX_PARALLEL_TOOL_CALLS + MAX_FILE_MUTATION_BATCH + 1) break;
    }
    for (const dropped of legacyResult.droppedCandidates) {
      if (droppedSeen.has(dropped.rawToolName)) continue;
      droppedSeen.add(dropped.rawToolName);
      droppedCandidates.push(dropped);
    }
  }

  if (allCalls.length === 0) return { ...empty, droppedCandidates };
  return { ...classifyDetectedCalls(allCalls), droppedCandidates };
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
function classifyDetectedCalls(allCalls: AnyToolCall[]): DetectedToolCalls {
  const grouped = groupCallsByPhase<AnyToolCall>(
    allCalls,
    { isReadOnly: isReadOnlyToolCall, isFileMutation: isFileMutationToolCall },
    { maxParallelReads: MAX_PARALLEL_TOOL_CALLS, maxFileMutationBatch: MAX_FILE_MUTATION_BATCH },
  );
  return { ...grouped, droppedCandidates: [] };
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
export type AnyToolCall =
  | { source: 'github'; call: ToolCall }
  | { source: 'sandbox'; call: SandboxToolCall }
  | { source: 'delegate'; call: { tool: 'delegate_coder'; args: CoderDelegationArgs } }
  | { source: 'delegate'; call: { tool: 'delegate_explorer'; args: ExplorerDelegationArgs } }
  | { source: 'delegate'; call: { tool: 'plan_tasks'; args: TaskGraphArgs } }
  | { source: 'scratchpad'; call: ScratchpadToolCall }
  | { source: 'todo'; call: TodoToolCall }
  | { source: 'web-search'; call: WebSearchToolCall }
  | { source: 'ask-user'; call: AskUserToolCall }
  | { source: 'artifacts'; call: ArtifactToolCall };

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
  // <args>`, Kimi/Blackbox) and XML (`<tool_call>...</tool_call>`,
  // Hermes/Qwen/Nous finetunes). Merge + sort by offset so the
  // textually-first call wins regardless of which shape it's in —
  // matches the "returns the first match" docstring.
  const fallbackRecoveries = [
    ...recoverNamespacedToolCalls(text),
    ...recoverXmlToolCalls(text),
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
    const wrapped = JSON.stringify({ tool: name, args });
    return detectAnyToolCall(wrapped);
  };
  const direct = tryName(toolName);
  if (direct) return direct;
  const inferred = inferToolFromArgs(args);
  if (inferred && inferred !== toolName) return tryName(inferred);
  return null;
}

/**
 * Execute a detected tool call through the appropriate handler.
 *
 * Note: 'scratchpad' and 'delegate' tools are handled at a higher level (useChat),
 * not here. They're detected here but executed in the chat hook.
 *
 * @param isMainProtected — when true, commit/push tools on the default branch are blocked.
 * @param defaultBranch — the repo's default branch name (e.g. 'main', 'master').
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
  approvalCallback?: (toolName: string, reason: string, recoveryPath: string) => Promise<boolean>,
  chatId?: string,
  localDaemonBinding?: ToolDispatchBinding,
  abortSignal?: AbortSignal,
  executionMode?: import('@push/lib/capabilities').ExecutionMode,
): Promise<ToolExecutionResult> {
  const runtime = new WebToolExecutionRuntime();
  return runtime.execute(toolCall, {
    allowedRepo,
    sandboxId,
    role,
    isMainProtected: isMainProtected ?? false,
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
