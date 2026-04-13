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
  StructuredToolError,
  ToolHookContext,
  CoderDelegationArgs,
  ExplorerDelegationArgs,
  TaskGraphArgs,
} from '@/types';
import { evaluatePreHooks, evaluatePostHooks, type ToolHookRegistry } from './tool-hooks';
import type { ApprovalGateRegistry } from './approval-gates';
import { detectToolCall, executeToolCall, type ToolCall } from './github-tools';
import {
  detectSandboxToolCall,
  executeSandboxToolCall,
  type SandboxToolCall,
} from './sandbox-tools';
import { detectScratchpadToolCall, type ScratchpadToolCall } from './scratchpad-tools';
import {
  detectWebSearchToolCall,
  executeWebSearch,
  type WebSearchToolCall,
} from './web-search-tools';
import { detectAskUserToolCall, type AskUserToolCall } from './ask-user-tools';
import { getActiveProvider, type ActiveProvider } from './orchestrator';
import { execInSandbox } from './sandbox-client';
import { ALL_CAPABILITIES, type Capability } from './capabilities';
import { asRecord, detectToolFromText, extractBareToolJsonObjects } from './utils';
import {
  getToolCanonicalNames,
  getRecognizedToolNames,
  isReadOnlyToolName,
  resolveToolName,
} from './tool-registry';
import {
  extractAllBareJsonObjects,
  getToolSource,
  inferToolFromArgs,
} from '@push/lib/tool-call-diagnosis';

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

/** Result of scanning a response for all tool calls. */
export interface DetectedToolCalls {
  /** Read-only calls that can safely execute in parallel. */
  readOnly: AnyToolCall[];
  /** Optional trailing mutating call that must execute after reads. */
  mutating: AnyToolCall | null;
  /** Additional mutating calls that were rejected to preserve single-mutation safety. */
  extraMutations: AnyToolCall[];
}

/**
 * Scan assistant output for ALL tool calls — reads + optional trailing mutation.
 * Returns the read-only calls (parallelizable) and the last mutating call (if any).
 * Falls back to single-call detection if only one call is found.
 */
export function detectAllToolCalls(text: string): DetectedToolCalls {
  const explicitToolObjects = extractBareToolJsonObjects(text);
  if (explicitToolObjects.length === 0) return { readOnly: [], mutating: null, extraMutations: [] };

  // Preserve current safety behavior: only do broad bare-object scanning
  // when the response already contains at least one explicit tool wrapper.
  const parsedObjects = extractAllBareJsonObjects(text);
  if (parsedObjects.length === 0) return { readOnly: [], mutating: null, extraMutations: [] };

  const allCalls: AnyToolCall[] = [];
  const seen = new Set<string>();

  for (const parsed of parsedObjects) {
    const serialized = JSON.stringify(parsed);
    const call = detectAnyToolCall(serialized);
    if (!call) continue;
    const key = getCanonicalInvocationKey(call);
    if (seen.has(key)) continue;
    seen.add(key);
    allCalls.push(call);
    if (allCalls.length > MAX_PARALLEL_TOOL_CALLS + 1) break; // +1 for possible trailing mutation
  }

  if (allCalls.length === 0) return { readOnly: [], mutating: null, extraMutations: [] };

  // Single call — classify as read or mutation
  if (allCalls.length === 1) {
    if (isReadOnlyToolCall(allCalls[0])) {
      return { readOnly: allCalls, mutating: null, extraMutations: [] };
    }
    return { readOnly: [], mutating: allCalls[0], extraMutations: [] };
  }

  // Multiple calls — split into reads + optional trailing mutation.
  // Strategy: collect the longest valid prefix of read-only calls,
  // then accept one trailing mutation. If a mutation appears mid-sequence,
  // treat it as the boundary — keep the reads before it and the mutation,
  // but discard anything after.
  const readOnly: AnyToolCall[] = [];
  let mutating: AnyToolCall | null = null;
  const extraMutations: AnyToolCall[] = [];

  for (let i = 0; i < allCalls.length; i++) {
    if (isReadOnlyToolCall(allCalls[i])) {
      if (mutating) {
        // Read after a mutation — stop here (don't process further calls)
        break;
      }
      readOnly.push(allCalls[i]);
    } else {
      if (mutating) {
        // Second mutation — stop here, keep what we have
        extraMutations.push(allCalls[i]);
        break;
      }
      mutating = allCalls[i];
    }
  }

  // Cap parallel reads — truncate to the limit instead of bailing entirely
  if (readOnly.length > MAX_PARALLEL_TOOL_CALLS) {
    readOnly.length = MAX_PARALLEL_TOOL_CALLS;
  }

  return { readOnly, mutating, extraMutations };
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
      return toolCall.call.args;
    case 'scratchpad':
      return { tool: toolCall.call.tool, content: toolCall.call.content };
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

export type AnyToolCall =
  | { source: 'github'; call: ToolCall }
  | { source: 'sandbox'; call: SandboxToolCall }
  | {
      source: 'delegate';
      call:
        | { tool: 'delegate_coder'; args: CoderDelegationArgs }
        | { tool: 'delegate_explorer'; args: ExplorerDelegationArgs }
        | { tool: 'plan_tasks'; args: TaskGraphArgs };
    }
  | { source: 'scratchpad'; call: ScratchpadToolCall }
  | { source: 'web-search'; call: WebSearchToolCall }
  | { source: 'ask-user'; call: AskUserToolCall };

function getHookToolName(toolCall: AnyToolCall): string {
  return toolCall.call.tool;
}

function getHookToolArgs(toolCall: AnyToolCall): Record<string, unknown> {
  switch (toolCall.source) {
    case 'github':
    case 'sandbox':
    case 'delegate':
    case 'web-search':
    case 'ask-user':
      return { ...toolCall.call.args };
    case 'scratchpad':
      return toolCall.call.content ? { content: toolCall.call.content } : {};
    default:
      return {};
  }
}

function applyHookToolArgs(toolCall: AnyToolCall, modifiedArgs: Record<string, unknown>): void {
  switch (toolCall.source) {
    case 'github':
    case 'sandbox':
    case 'delegate':
    case 'web-search':
    case 'ask-user':
      Object.assign(toolCall.call.args, modifiedArgs);
      return;
    case 'scratchpad':
      if (typeof modifiedArgs.content === 'string') {
        toolCall.call.content = modifiedArgs.content;
      }
      return;
    default:
      return;
  }
}

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

  // Check web search tool
  const webSearchCall = detectWebSearchToolCall(text);
  if (webSearchCall) return { source: 'web-search', call: webSearchCall };

  // Check ask_user tool
  const askUserCall = detectAskUserToolCall(text);
  if (askUserCall) return { source: 'ask-user', call: askUserCall };

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

  return null;
}

/** Tools that modify the main branch (commit/push). Blocked when Protect Main is active. */
const PROTECTED_MAIN_TOOLS = new Set(['sandbox_prepare_commit', 'sandbox_push']);

/**
 * Check the current git branch in the sandbox. Returns the branch name or null on error.
 */
async function getSandboxBranch(sandboxId: string): Promise<string | null> {
  try {
    const result = await execInSandbox(sandboxId, 'cd /workspace && git branch --show-current');
    if (result.exitCode === 0 && result.stdout?.trim()) {
      return result.stdout.trim();
    }
  } catch {
    // Best-effort — fail-safe (return null → will block)
  }
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
  isMainProtected?: boolean,
  defaultBranch?: string,
  activeProvider?: ActiveProvider,
  activeModel?: string,
  hooks?: ToolHookRegistry,
  approvalGates?: ApprovalGateRegistry,
  capabilityLedger?: import('./capabilities').CapabilityLedger,
  // Phase 4 seam — set by daemon adapter in Phase 6; unset in Web chat-loop.
  approvalCallback?: (toolName: string, reason: string, recoveryPath: string) => Promise<boolean>,
): Promise<ToolExecutionResult> {
  const toolName = getHookToolName(toolCall);
  const toolArgs = getHookToolArgs(toolCall);
  const hookContext: ToolHookContext = {
    sandboxId,
    allowedRepo,
    activeProvider,
    activeModel,
    capabilityLedger,
  };

  try {
    // --- Pre-hooks evaluation ---
    if (hooks && hooks.pre.length > 0) {
      const preResult = await evaluatePreHooks(hooks, toolName, toolArgs, hookContext);

      if (preResult?.decision === 'deny') {
        const result: ToolExecutionResult = {
          text: `[Tool Blocked] ${preResult.reason || 'Blocked by pre-execution hook.'}`,
        };
        return result;
      }

      // Apply modified args if a hook rewrote them
      if (preResult?.modifiedArgs) {
        Object.assign(toolArgs, preResult.modifiedArgs);
        applyHookToolArgs(toolCall, preResult.modifiedArgs);
      }
    }

    // --- Approval gate evaluation ---
    if (approvalGates) {
      const gateResult = await approvalGates.evaluate(toolName, toolArgs, hookContext);
      if (gateResult) {
        if (gateResult.decision === 'blocked') {
          const err: StructuredToolError = {
            type: 'APPROVAL_GATE_BLOCKED',
            retryable: false,
            message: gateResult.reason,
            detail: gateResult.recoveryPath,
          };
          return {
            text: `[Tool Blocked — ${toolName}] ${gateResult.reason}\n\nRecovery: ${gateResult.recoveryPath}`,
            structuredError: err,
          };
        }
        if (gateResult.decision === 'ask_user') {
          if (approvalCallback) {
            const approved = await approvalCallback(
              toolName,
              gateResult.reason,
              gateResult.recoveryPath,
            );
            if (!approved) {
              return {
                text: `[Approval Denied — ${toolName}] User denied approval.\n\nReason: ${gateResult.reason}`,
              };
            }
            // Approved — fall through to normal tool execution below.
          } else {
            return {
              text: `[Approval Required — ${toolName}] This action requires explicit user approval.\n\nReason: ${gateResult.reason}\n\nUse ask_user to request permission before proceeding. Explain what you want to do and why.\n\nRecovery: ${gateResult.recoveryPath}`,
              structuredError: {
                type: 'APPROVAL_GATE_BLOCKED',
                retryable: true,
                message: gateResult.reason,
                detail: `Use ask_user to get approval. ${gateResult.recoveryPath}`,
              },
            };
          }
        }
      }
    }

    // Enforce Protect Main: block commit/push tools when on the default branch
    if (
      isMainProtected &&
      toolCall.source === 'sandbox' &&
      PROTECTED_MAIN_TOOLS.has(toolCall.call.tool) &&
      sandboxId
    ) {
      const currentBranch = await getSandboxBranch(sandboxId);
      const mainBranches = new Set(['main', 'master']);
      if (defaultBranch) mainBranches.add(defaultBranch);
      // Block if we can't determine the branch (fail-safe) or if we're on the default branch
      if (!currentBranch || mainBranches.has(currentBranch)) {
        return {
          text: `[Tool Error] Protect Main is enabled. Commits and pushes to the main/default branch are blocked. Create a new branch first (e.g. sandbox_exec with "git checkout -b feature/my-change"), then retry.`,
        };
      }
    }

    // Execute through the appropriate handler
    let result: ToolExecutionResult;

    switch (toolCall.source) {
      case 'github':
        result = await executeToolCall(toolCall.call, allowedRepo);
        break;

      case 'sandbox':
        if (!sandboxId) {
          const err: StructuredToolError = {
            type: 'SANDBOX_UNREACHABLE',
            retryable: true,
            message: 'No active sandbox session',
            detail: `Attempted tool: ${toolCall.call.tool}`,
          };
          result = {
            text: `[Tool Error] No active sandbox. The sandbox may still be starting — wait a moment and retry. If this persists, the user needs to start a sandbox from the UI.\nerror_type: ${err.type}\nretryable: ${err.retryable}`,
            structuredError: err,
          };
          break;
        }
        result = await executeSandboxToolCall(toolCall.call, sandboxId, {
          auditorProviderOverride: activeProvider,
          auditorModelOverride: activeModel,
        });
        break;

      case 'delegate':
        result = { text: '[Tool Error] Delegation must be handled by the chat hook.' };
        break;

      case 'scratchpad':
        result = { text: '[Tool Error] Scratchpad must be handled by the chat hook.' };
        break;

      case 'web-search': {
        const provider = activeProvider || getActiveProvider();
        result = await executeWebSearch(toolCall.call.args.query, provider);
        break;
      }

      case 'ask-user':
        result = {
          text: '[Tool Result] Question sent to user. The system will wait for their response.',
          card: { type: 'ask-user', data: toolCall.call.args },
        };
        break;

      default:
        result = { text: '[Tool Error] Unknown tool source.' };
    }

    // --- Record capability usage ---
    if (capabilityLedger) {
      capabilityLedger.recordToolUse(toolName);
    }

    // --- Post-hooks evaluation ---
    if (hooks && hooks.post.length > 0) {
      const postResult = await evaluatePostHooks(hooks, toolName, toolArgs, result, hookContext);

      if (postResult?.resultOverride) {
        result = { ...result, text: postResult.resultOverride };
      }
      // systemMessage is returned to the caller for injection into the conversation
      if (postResult?.systemMessage) {
        result = { ...result, text: `${result.text}\n\n[Hook] ${postResult.systemMessage}` };
      }
      // Policy actions: inject/halt flow through ToolExecutionResult to the caller
      if (postResult?.action === 'inject' && postResult.injectMessage) {
        result = { ...result, postHookInject: postResult.injectMessage };
      }
      if (postResult?.action === 'halt' && postResult.haltSummary) {
        result = { ...result, postHookHalt: postResult.haltSummary };
      }
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const structuredError: StructuredToolError = {
      type: 'UNKNOWN',
      retryable: true,
      message: `Unexpected error executing ${toolName}: ${message}`,
    };
    return { text: `[Tool Error] ${structuredError.message}`, structuredError };
  }
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

