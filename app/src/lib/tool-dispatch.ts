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
}

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
export function detectAllToolCalls(text: string): DetectedToolCalls {
  const empty: DetectedToolCalls = {
    readOnly: [],
    fileMutations: [],
    mutating: null,
    extraMutations: [],
  };

  const explicitToolObjects = extractBareToolJsonObjects(text);
  const allCalls: AnyToolCall[] = [];
  const seen = new Set<string>();

  // OpenAI-style namespaced fallback (`functions.<name>:<id>  <args>`).
  // Models like Kimi-via-Blackbox emit this format with no canonical
  // wrapper, so the existing precondition below would have dropped them
  // silently. Only fires when there are zero explicit wrappers — once a
  // real tool block exists, trust the model's primary intent and let
  // the standard scan handle it.
  if (explicitToolObjects.length === 0) {
    for (const recovered of recoverNamespacedToolCalls(text)) {
      const call = wrapRecoveredCallToAny(recovered.tool, recovered.args);
      if (!call) continue;
      const key = getCanonicalInvocationKey(call);
      if (seen.has(key)) continue;
      seen.add(key);
      allCalls.push(call);
      if (allCalls.length > MAX_PARALLEL_TOOL_CALLS + MAX_FILE_MUTATION_BATCH + 1) break;
    }
    if (allCalls.length === 0) return empty;
    return classifyDetectedCalls(allCalls, empty);
  }

  // Preserve current safety behavior: only do broad bare-object scanning
  // when the response already contains at least one explicit tool wrapper.
  const parsedObjects = extractAllBareJsonObjects(text);
  if (parsedObjects.length === 0) return empty;

  for (const parsed of parsedObjects) {
    const serialized = JSON.stringify(parsed);
    const call = detectAnyToolCall(serialized);
    if (!call) continue;
    const key = getCanonicalInvocationKey(call);
    if (seen.has(key)) continue;
    seen.add(key);
    allCalls.push(call);
    // Soft cap: leave headroom for the batch + trailing side-effect. We
    // don't want to parse an unbounded number of calls — the tail beyond
    // the cap falls out on the next round if the model really needs it.
    if (allCalls.length > MAX_PARALLEL_TOOL_CALLS + MAX_FILE_MUTATION_BATCH + 1) break;
  }

  if (allCalls.length === 0) return empty;
  return classifyDetectedCalls(allCalls, empty);
}

/**
 * Run the reads → fileMutations → trailing side-effect grouping over a
 * deduped, ordered list of tool calls. Extracted from `detectAllToolCalls`
 * so the namespaced-recovery branch can reuse the same classification
 * pipeline rather than duplicating it.
 */
function classifyDetectedCalls(
  allCalls: AnyToolCall[],
  empty: DetectedToolCalls,
): DetectedToolCalls {
  // Single call — classify directly.
  if (allCalls.length === 1) {
    const only = allCalls[0];
    if (isReadOnlyToolCall(only)) return { ...empty, readOnly: [only] };
    if (isFileMutationToolCall(only)) return { ...empty, fileMutations: [only] };
    return { ...empty, mutating: only };
  }

  // Multi-call state machine: reads → fileMutations → trailing side-effect.
  const readOnly: AnyToolCall[] = [];
  const fileMutations: AnyToolCall[] = [];
  let mutating: AnyToolCall | null = null;
  const extraMutations: AnyToolCall[] = [];
  let phase: 'reads' | 'mutations' | 'done' = 'reads';

  for (const call of allCalls) {
    const isRead = isReadOnlyToolCall(call);
    const isFileMut = !isRead && isFileMutationToolCall(call);

    if (phase === 'done') {
      // A side-effect already landed — anything else is overflow.
      extraMutations.push(call);
      continue;
    }

    if (isRead) {
      if (phase === 'reads') {
        readOnly.push(call);
        continue;
      }
      // Read after a mutation has started — ordering violation. Push it
      // (and treat subsequent calls from here as overflow too) into
      // extraMutations so the caller can surface a structured error and
      // the model can correct on the next turn. Falling through to the
      // `done` branch on the next iteration keeps that behavior.
      extraMutations.push(call);
      phase = 'done';
      continue;
    }

    if (isFileMut) {
      // Transition into the mutation batch. Further file mutations keep
      // appending to it; a side-effect will terminate it.
      phase = 'mutations';
      fileMutations.push(call);
      continue;
    }

    // Side-effecting call. Only one allowed per turn.
    mutating = call;
    phase = 'done';
  }

  // Cap parallel reads — truncate instead of bailing entirely.
  if (readOnly.length > MAX_PARALLEL_TOOL_CALLS) {
    readOnly.length = MAX_PARALLEL_TOOL_CALLS;
  }

  // Cap file-mutation batch — push overflow to extraMutations so the caller
  // surfaces a clear "too many writes" error instead of silently dropping.
  if (fileMutations.length > MAX_FILE_MUTATION_BATCH) {
    const overflow = fileMutations.splice(MAX_FILE_MUTATION_BATCH);
    extraMutations.unshift(...overflow);
  }

  return { readOnly, fileMutations, mutating, extraMutations };
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

  // Fallback for OpenAI-style namespaced output (`functions.<name>:<id>
  // <args>`) — see `recoverNamespacedToolCalls` for the model behavior
  // this addresses.
  for (const namespaced of recoverNamespacedToolCalls(text)) {
    const call = wrapRecoveredCallToAny(namespaced.tool, namespaced.args);
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
