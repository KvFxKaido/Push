/**
 * chat-send-helpers.ts
 *
 * Pure-ish helpers extracted from chat-send.ts. The split keeps chat-send.ts
 * focused on `processAssistantTurn` (the post-stream dispatcher) by pulling
 * out the small support functions that are independent of SendLoopContext:
 *
 *   - shouldEmitPeriodicPulse           — round-counter pulse predicate
 *   - delegateCallNeedsSandbox          — does this delegate call need sandbox prewarm?
 *   - getDelegateCompletionAgent        — agent kind for DELEGATION_COMPLETED events
 *   - isChatHookSource                  — scratchpad/todo source predicate
 *   - executeChatHookToolCall           — local-state executor for chat-hook tools
 *   - executeToolWithChatHooks          — wrapper that routes chat-hook calls locally
 *   - extractChangedPathFromStatusLine  — git status --porcelain parser
 *   - inferVerificationCommandResult    — pulls a verification command result out of a tool card
 *   - collectPostToolPolicyEffects      — drains postHookInject / postHookHalt across tool results
 *   - createTurnRunContext              — Phase 2: per-turn closure factory
 *                                          (post-tool policy effects, tool-failure
 *                                          recording, round sandbox status cache)
 *                                          shared by the three branch handlers.
 */

import type { MutableRefObject } from 'react';
import { isReadOnlyToolCall, type AnyToolCall, type DetectedToolCalls } from '@/lib/tool-dispatch';
import {
  executeTool,
  handleDroppedCandidatesError,
  type ToolExecRunContext,
  type ToolExecRawResult,
} from '@/lib/chat-tool-execution';
import { markLastAssistantToolCall } from '@/lib/chat-tool-messages';
import { summarizeToolResultPreview } from '@/lib/chat-run-events';
import type { DelegationOutcome, ReasoningBlock } from '@/types';
import { createSandboxGitBackend } from '@/lib/git-backend';
import { executeScratchpadToolCall } from '@/lib/scratchpad-tools';
import { executeTodoToolCall } from '@/lib/todo-tools';
import { getToolName } from '@/lib/chat-tool-messages';
import { applyBranchSwitchPayload } from '@/lib/branch-fork-migration';
import {
  recordVerificationArtifact,
  recordVerificationCommandResult,
  recordVerificationMutation,
} from '@/lib/verification-runtime';
import { getToolInvocationKey, type MutationFailureTracker } from '@push/lib/agent-loop-utils';
import { createId } from '@push/lib/id-utils';
import type { ToolCallRecoveryState } from '@/lib/tool-call-recovery';
import type { ChatMessage, ToolExecutionResult } from '@/types';
import type {
  AssistantTurnResult,
  ScratchpadHandlers,
  SendLoopContext,
  TodoHandlers,
} from './chat-send-types';

const TOOL_RESULT_PULSE_INTERVAL = 3;

export function shouldEmitPeriodicPulse(round: number): boolean {
  return (round + 1) % TOOL_RESULT_PULSE_INTERVAL === 0;
}

export function delegateCallNeedsSandbox(call: AnyToolCall): boolean {
  if (call.source !== 'delegate') return false;
  if (call.call.tool === 'delegate_coder') return true;
  if (call.call.tool !== 'plan_tasks') return false;
  return call.call.args.tasks.some((task) => task.agent === 'coder');
}

export function getDelegateCompletionAgent(call: AnyToolCall): 'explorer' | 'coder' | 'task_graph' {
  if (call.source !== 'delegate') return 'coder';
  if (call.call.tool === 'delegate_explorer') return 'explorer';
  if (call.call.tool === 'plan_tasks') return 'task_graph';
  return 'coder';
}

/** Chat-hook-managed sources — executed against refs in this hook, not the
 * generic tool-execution runtime which can only see server-owned state. */
export function isChatHookSource(source: AnyToolCall['source']): boolean {
  return source === 'scratchpad' || source === 'todo';
}

/**
 * Wrap `executeTool` so chat-hook sources (scratchpad + todo) are routed
 * through the local chat-hook executor rather than the runtime, which
 * would reject them with "must be handled by the chat hook". Used in both
 * the parallel-reads path and the trailing-mutation path so batched turns
 * don't deterministically fail when they mix a chat-hook call with a
 * regular read/mutation.
 */
export async function executeToolWithChatHooks(
  call: AnyToolCall,
  ctx: ToolExecRunContext,
  refs: {
    scratchpadRef: MutableRefObject<ScratchpadHandlers | undefined>;
    todoRef: MutableRefObject<TodoHandlers | undefined>;
  },
): Promise<ToolExecRawResult> {
  if (isChatHookSource(call.source)) {
    const start = Date.now();
    const result =
      executeChatHookToolCall(call, refs) ??
      ({ text: '[Tool Error] Chat-hook tool dispatch failed.' } as ToolExecutionResult);
    return { call, raw: result, cards: [], durationMs: Date.now() - start };
  }
  return executeTool(call, ctx);
}

/**
 * Execute a chat-hook-handled tool call (scratchpad or todo) against the
 * local refs. Returns the result if the source is handled here, or null if
 * the caller should fall through to the runtime.
 *
 * These tools live in the chat hook because they mutate React state the
 * runtime can't see. Routed from both the single-call dispatch and the
 * batched (parallel reads / trailing mutation) paths so a model that
 * interleaves a todo_write with a read_file in one turn doesn't land on
 * "[Tool Error] Todo must be handled by the chat hook."
 */
export function executeChatHookToolCall(
  call: AnyToolCall,
  refs: {
    scratchpadRef: MutableRefObject<ScratchpadHandlers | undefined>;
    todoRef: MutableRefObject<TodoHandlers | undefined>;
  },
): ToolExecutionResult | null {
  if (call.source === 'scratchpad') {
    const sp = refs.scratchpadRef.current;
    if (!sp) {
      return {
        text: '[Tool Error] Scratchpad not available. The scratchpad may not be initialized — try again after the UI loads.',
      };
    }
    const result = executeScratchpadToolCall(call.call, sp.content, sp.replace, sp.append);
    if (result.ok) {
      if (call.call.tool === 'set_scratchpad') {
        refs.scratchpadRef.current = { ...sp, content: call.call.content };
      } else if (call.call.tool === 'append_scratchpad') {
        const prev = sp.content.trim();
        refs.scratchpadRef.current = {
          ...sp,
          content: prev ? `${prev}\n\n${call.call.content}` : call.call.content,
        };
      }
    }
    return { text: result.text };
  }

  if (call.source === 'todo') {
    const todo = refs.todoRef.current;
    if (!todo) {
      return {
        text: '[Tool Error] Todo list not available. It may not be initialized — try again after the UI loads.',
      };
    }
    const result = executeTodoToolCall(call.call, todo.todos, {
      replace: todo.replace,
      clear: todo.clear,
    });
    if (result.ok && result.nextTodos) {
      refs.todoRef.current = { ...todo, todos: result.nextTodos };
    }
    return { text: result.text };
  }

  return null;
}

export function extractChangedPathFromStatusLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const candidate = trimmed.slice(3).trim();
  if (!candidate) return null;
  if (candidate.includes(' -> ')) {
    return candidate.split(' -> ').pop()?.trim() || null;
  }
  return candidate;
}

export function inferVerificationCommandResult(result: ToolExecutionResult): {
  command: string;
  exitCode: number;
  detail: string;
} | null {
  const card = result.card;
  if (!card) return null;

  if (card.type === 'sandbox') {
    return {
      command: card.data.command,
      exitCode: card.data.exitCode,
      detail: `Command "${card.data.command}" exited with code ${card.data.exitCode}.`,
    };
  }

  if (card.type === 'type-check') {
    const command =
      card.data.tool === 'tsc'
        ? 'npx tsc --noEmit'
        : card.data.tool === 'pyright'
          ? 'pyright'
          : card.data.tool === 'mypy'
            ? 'mypy'
            : null;
    if (!command) return null;
    return {
      command,
      exitCode: card.data.exitCode,
      detail: `${card.data.tool} exited with code ${card.data.exitCode}.`,
    };
  }

  if (card.type === 'test-results') {
    const command =
      card.data.framework === 'npm'
        ? 'npm test'
        : card.data.framework === 'pytest'
          ? 'pytest -v'
          : card.data.framework === 'cargo'
            ? 'cargo test'
            : card.data.framework === 'go'
              ? 'go test ./...'
              : null;
    if (!command) return null;
    return {
      command,
      exitCode: card.data.exitCode,
      detail: `${command} exited with code ${card.data.exitCode}.`,
    };
  }

  return null;
}

export interface PostToolPolicyEffects {
  messages: ChatMessage[];
  halted: boolean;
  haltDetail?: string;
}

export function collectPostToolPolicyEffects(
  results: readonly ToolExecutionResult[],
): PostToolPolicyEffects {
  const messages: ChatMessage[] = [];
  let haltDetail: string | undefined;

  for (const result of results) {
    if (result.postHookInject) {
      messages.push(result.postHookInject);
    }
    if (!haltDetail && result.postHookHalt) {
      haltDetail = result.postHookHalt;
      messages.push({
        id: createId(),
        role: 'user',
        content: result.postHookHalt,
        timestamp: Date.now(),
      });
    }
  }

  return {
    messages,
    halted: Boolean(haltDetail),
    haltDetail,
  };
}

// ---------------------------------------------------------------------------
// Per-turn run context — Phase 2 split.
//
// The three branch handlers (`executeBatchedToolCalls`, `processNoToolPath`,
// `executeSingleToolCall`) extracted out of `processAssistantTurn` share three
// stateful pieces of work:
//
//   1. `applyPostToolPolicyEffects(msgs, results)` — drains postHookInject /
//      postHookHalt across one or more tool results, mutates conversation
//      state, writes the checkpoint, and returns an `AssistantTurnResult` if
//      any effects fired (or null to fall through).
//   2. `recordToolFailure(call, isError)` — feeds the circuit-breaker tracker
//      after a tool execution.
//   3. `getRoundSandboxStatus()` / `invalidateSandboxStatus()` — per-turn
//      `git status` cache so a sequence of tool executions only pays the
//      sandbox round-trip once between mutations.
//
// `createTurnRunContext` builds these once per `processAssistantTurn` call,
// closing over `ctx`, `recoveryState`, and `tracker`. Each branch handler
// receives the resulting `TurnRunContext` and uses it through stable method
// names — keeps call sites identical to the pre-extraction inline code.
// ---------------------------------------------------------------------------

export type RoundSandboxStatus = {
  dirty: boolean;
  files: number;
  branch?: string;
  head?: string;
  changedFiles?: string[];
};

export interface TurnRunContext {
  applyPostToolPolicyEffects: (
    currentApiMessages: ChatMessage[],
    results: readonly ToolExecutionResult[],
  ) => AssistantTurnResult | null;
  recordToolFailure: (call: AnyToolCall, isError: boolean) => void;
  /**
   * Record the structured outcome of a delegation against the tracker
   * so consecutive non-complete delegations of the same agent trip
   * the breaker even when the orchestrator varies the task text
   * between retries. No-op for tool calls that don't carry a
   * `delegationOutcome` payload, AND for `plan_tasks` whose inner
   * Coder/Explorer nodes already record their own outcomes — counting
   * the wrapper's combined outcome again would double-count and could
   * falsely break a later direct `delegate_coder` (Codex P1 review
   * on PR #603). See PR #603.
   */
  recordDelegationOutcome: (
    toolCall: AnyToolCall,
    toolExecResult: { delegationOutcome?: DelegationOutcome },
  ) => void;
  getRoundSandboxStatus: () => Promise<RoundSandboxStatus | null>;
  invalidateSandboxStatus: () => void;
}

export function createTurnRunContext(
  ctx: SendLoopContext,
  recoveryState: ToolCallRecoveryState,
  tracker: MutationFailureTracker,
): TurnRunContext {
  const {
    chatId,
    sandboxIdRef,
    checkpointRefs,
    setConversations,
    dirtyConversationIdsRef,
    updateAgentStatus,
    flushCheckpoint,
  } = ctx;

  // Per-round sandbox status cache — fetched lazily after the first tool
  // executes; invalidated by the branch handlers each time a tool runs so
  // subsequent reads observe post-mutation state.
  let cachedStatus: RoundSandboxStatus | null = null;
  let cacheFetched = false;

  const getRoundSandboxStatus = async (): Promise<RoundSandboxStatus | null> => {
    if (cacheFetched) return cachedStatus;
    if (!sandboxIdRef.current) {
      // Stable state — no sandbox to fetch from. Cache so callers don't
      // re-evaluate on every getRoundSandboxStatus() within the same turn.
      cacheFetched = true;
      return null;
    }
    try {
      const backend = createSandboxGitBackend(sandboxIdRef.current);
      const [branch, head, info] = await Promise.all([
        backend.currentBranch(),
        backend.headSha({ short: true }),
        backend.status(),
      ]);
      // Preserve the prior `git status --porcelain | head -20` cap; entries
      // already exclude the `-b` header line.
      const statusLines = (info?.entries ?? []).slice(0, 20).map((entry) => entry.raw);
      cachedStatus = {
        dirty: statusLines.length > 0,
        files: statusLines.length,
        branch: branch ?? undefined,
        head: head ?? undefined,
        changedFiles: statusLines
          .map(extractChangedPathFromStatusLine)
          .filter((value): value is string => Boolean(value))
          .slice(0, 6),
      };
      cacheFetched = true;
    } catch {
      // Best-effort — leave cacheFetched=false so the next call retries
      // rather than locking the rest of the turn into a stale empty status.
    }
    return cachedStatus;
  };

  const invalidateSandboxStatus = () => {
    cacheFetched = false;
  };

  const applyPostToolPolicyEffects = (
    currentApiMessages: ChatMessage[],
    results: readonly ToolExecutionResult[],
  ): AssistantTurnResult | null => {
    const effects = collectPostToolPolicyEffects(results);
    if (effects.messages.length === 0) return null;

    setConversations((prev) => {
      const conv = prev[chatId];
      if (!conv) return prev;
      const updated = {
        ...prev,
        [chatId]: {
          ...conv,
          messages: [...conv.messages, ...effects.messages],
          lastMessageAt: Date.now(),
        },
      };
      dirtyConversationIdsRef.current.add(chatId);
      return updated;
    });

    const nextApiMessages = [...currentApiMessages, ...effects.messages];
    checkpointRefs.apiMessages.current = nextApiMessages;
    flushCheckpoint();

    if (effects.halted) {
      updateAgentStatus(
        { active: true, phase: 'Policy halt', detail: effects.haltDetail },
        { chatId },
      );
    }

    return {
      nextApiMessages,
      nextRecoveryState: recoveryState,
      loopAction: 'continue',
      loopCompletedNormally: false,
    };
  };

  const recordToolFailure = (call: AnyToolCall, isError: boolean) => {
    // Every call feeds the consecutive-repetition tracker — that's how
    // the "model keeps re-running the same read" loop gets caught even
    // though no individual call errored. The persistent failure count
    // only ticks on real errors.
    const key = getToolInvocationKey(getToolName(call), call.call);
    tracker.recordCall(key);
    if (!isError) return;
    tracker.recordFailure(key);
  };

  const recordDelegationOutcome = (
    toolCall: AnyToolCall,
    toolExecResult: { delegationOutcome?: DelegationOutcome },
  ) => {
    const outcome = toolExecResult.delegationOutcome;
    if (!outcome) return;
    if (shouldSkipDelegationOutcomeRecording(toolCall)) return;
    tracker.recordDelegationOutcome(outcome.agent, outcome.status);
  };

  return {
    applyPostToolPolicyEffects,
    recordToolFailure,
    recordDelegationOutcome,
    getRoundSandboxStatus,
    invalidateSandboxStatus,
  };
}

// ---------------------------------------------------------------------------
// applyPostExecutionSideEffects
//
// Per-tool side-effect handling shared between the single-tool and batched
// execution branches. Pre-2026-05-01 these effects only fired in the
// single-tool path; the batched path silently dropped them, so a verification
// command, branch switch, or repo promotion emitted as part of a batched turn
// would not update the corresponding state. This helper unifies the seven
// per-tool side effects so both branches behave identically:
//
//   1. Verification mutation tracking from postcondition `touchedFiles`
//   2. Verification mutation fallback for `sandbox_exec` (best-effort)
//   3. Verification command result + artifact (typed-check / test-results /
//      sandbox `exec` cards)
//   4. Verification artifact for `sandbox_diff` / `sandbox_prepare_commit` /
//      `sandbox_push` (artifact-only commands without a typed result)
//   5. Repo promotion (`promotion.repo` → bind sandbox, update conversation,
//      fire onSandboxPromoted)
//   6. Branch switch payload (forked / switched conversation migration)
//   7. Sandbox unreachable structured-error propagation
//
// Helpers are idempotent at the runtime-handler layer — repeated calls during
// a batched turn (e.g., parallel reads where multiple results carry
// `structuredError: SANDBOX_UNREACHABLE`) re-fire the handler but do not
// corrupt state.
// ---------------------------------------------------------------------------

export function applyPostExecutionSideEffects(
  call: AnyToolCall,
  result: ToolExecutionResult,
  ctx: SendLoopContext,
): void {
  const {
    chatId,
    repoRef,
    setConversations,
    dirtyConversationIdsRef,
    runtimeHandlersRef,
    activeChatIdRef,
    conversationsRef,
    branchInfoRef,
    skipAutoCreateRef,
    updateVerificationState,
  } = ctx;

  // 1+2. Workspace mutation tracking.
  const touchedPaths = result.postconditions?.touchedFiles.map((file) => file.path) ?? [];
  if (touchedPaths.length > 0) {
    updateVerificationState(chatId, (state) =>
      recordVerificationMutation(state, {
        source: 'tool',
        touchedPaths,
        detail: `${getToolName(call)} mutated the workspace.`,
      }),
    );
  } else if (
    call.source === 'sandbox' &&
    call.call.tool === 'sandbox_exec' &&
    !isReadOnlyToolCall(call)
  ) {
    updateVerificationState(chatId, (state) =>
      recordVerificationMutation(state, {
        source: 'tool',
        detail: 'sandbox_exec may have mutated the workspace.',
      }),
    );
  }

  // 3+4. Verification command + artifact.
  const verificationCommand = inferVerificationCommandResult(result);
  if (verificationCommand) {
    updateVerificationState(chatId, (state) =>
      recordVerificationCommandResult(state, verificationCommand.command, {
        exitCode: verificationCommand.exitCode,
        detail: verificationCommand.detail,
      }),
    );
    updateVerificationState(chatId, (state) =>
      recordVerificationArtifact(
        state,
        `Verification command produced output: ${verificationCommand.command}`,
      ),
    );
  } else if (
    call.source === 'sandbox' &&
    (call.call.tool === 'sandbox_diff' ||
      call.call.tool === 'sandbox_prepare_commit' ||
      call.call.tool === 'sandbox_push')
  ) {
    updateVerificationState(chatId, (state) =>
      recordVerificationArtifact(state, `${call.call.tool} produced artifact evidence.`),
    );
  }

  // 5. Repo promotion.
  if (result.promotion?.repo) {
    const promotedRepo = result.promotion.repo;
    repoRef.current = promotedRepo.full_name;

    setConversations((prev) => {
      const conv = prev[chatId];
      if (!conv) return prev;
      const updated = {
        ...prev,
        [chatId]: {
          ...conv,
          repoFullName: promotedRepo.full_name,
          lastMessageAt: Date.now(),
        },
      };
      dirtyConversationIdsRef.current.add(chatId);
      return updated;
    });

    runtimeHandlersRef.current?.bindSandboxSessionToRepo?.(
      promotedRepo.full_name,
      promotedRepo.default_branch,
    );
    runtimeHandlersRef.current?.onSandboxPromoted?.(promotedRepo);
  }

  // 6. Branch switch payload (Slice 2 conversation-fork migration).
  // Migration logic lives in branch-fork-migration.ts so this helper stays
  // small and the migration is testable in isolation. Dispatches on
  // payload.kind: 'forked' migrates the active conversation; 'switched' or
  // undefined falls through to the existing auto-switch behavior.
  if (result.branchSwitch) {
    applyBranchSwitchPayload(result.branchSwitch, {
      activeChatIdRef,
      conversationsRef,
      branchInfoRef,
      skipAutoCreateRef,
      setConversations,
      dirtyConversationIdsRef,
      runtimeHandlersRef,
    });
  }

  // 7. Sandbox unreachable.
  if (result.structuredError?.type === 'SANDBOX_UNREACHABLE') {
    runtimeHandlersRef.current?.onSandboxUnreachable?.(result.structuredError.message);
  }
}

/**
 * Dispatch the parse-error branch when `detectAllToolCalls` reports
 * `{tool, args}`-shaped candidates that no source validated. Builds the
 * structured error via `handleDroppedCandidatesError`, emits the
 * `tool.call_malformed` run event, marks the last assistant message as
 * malformed in conversation state, and returns the assistant-turn result
 * the loop expects. Extracted from `chat-send.ts` to keep that file
 * within the `max-lines` ESLint cap.
 */
export function dispatchDroppedCandidatesError(
  detected: DetectedToolCalls,
  round: number,
  accumulated: string,
  thinkingAccumulated: string,
  reasoningBlocks: ReasoningBlock[],
  apiMessages: ChatMessage[],
  recoveryState: ToolCallRecoveryState,
  ctx: SendLoopContext,
): AssistantTurnResult {
  const { chatId, lockedProvider, resolvedModel, setConversations, appendRunEvent } = ctx;
  const errorAction = handleDroppedCandidatesError(
    detected,
    accumulated,
    thinkingAccumulated,
    reasoningBlocks,
    apiMessages,
    lockedProvider,
    resolvedModel,
  );

  appendRunEvent(chatId, {
    type: 'tool.call_malformed',
    round,
    reason: 'validation_failed',
    toolName: errorAction.assistantUpdate.toolMeta.toolName,
    preview: summarizeToolResultPreview(errorAction.errorMessage.content),
  });

  setConversations((prev) => {
    const conv = prev[chatId];
    if (!conv) return prev;
    const msgs = markLastAssistantToolCall(conv.messages, {
      content: errorAction.assistantUpdate.content,
      thinking: errorAction.assistantUpdate.thinking,
      malformed: true,
      toolMeta: errorAction.assistantUpdate.toolMeta,
    });
    return { ...prev, [chatId]: { ...conv, messages: [...msgs, errorAction.errorMessage] } };
  });

  return {
    nextApiMessages: errorAction.apiMessages,
    nextRecoveryState: recoveryState,
    loopAction: 'continue',
    loopCompletedNormally: false,
  };
}

/**
 * `plan_tasks` aggregates per-node outcomes into one wrapper payload
 * with `agent: 'coder' | 'explorer'`. The inner Coder/Explorer nodes
 * record their own outcomes via the per-task delegation handler, so
 * counting the wrapper here would double-count and could falsely
 * break a later direct `delegate_coder` call. Codex P1 review on
 * PR #603. Exported for unit testing; the runtime caller is the
 * `recordDelegationOutcome` closure built by `createTurnRunContext`.
 */
export function shouldSkipDelegationOutcomeRecording(toolCall: AnyToolCall): boolean {
  return toolCall.source === 'delegate' && toolCall.call.tool === 'plan_tasks';
}

/**
 * Map a delegation tool name to the agent label the delegation-outcome
 * tracker is keyed on. Returns null for non-delegation tools so the
 * breaker silently skips them. `plan_tasks` orchestrates per-task
 * Coder/Explorer delegations internally that each record their own
 * outcomes, so the wrapper itself is not tracked here.
 */
function delegateAgentForToolName(toolName: string): 'coder' | 'explorer' | null {
  if (toolName === 'delegate_coder') return 'coder';
  if (toolName === 'delegate_explorer') return 'explorer';
  return null;
}

/**
 * Circuit-breaker pre-check for incoming tool calls. Returns true if
 * the loop should break before any tool executes; false to proceed.
 *
 * Three independent trip rules, all applied against the same tracker:
 *
 *   1. **Per-args failure budget** — `(tool, args)` has errored
 *      `>= MAX` times this session. Applies to every incoming call;
 *      an exhausted-budget mutation key shouldn't be retried
 *      regardless of execution order.
 *
 *   2. **Per-agent delegation-outcome streak** — the same delegation
 *      agent (`coder` / `explorer`) has returned `incomplete` or
 *      `inconclusive` for `MAX` consecutive delegations. Catches the
 *      "model re-delegates the same task with reworded prompt" loop
 *      the args-keyed path dodges because each retry's `task` text
 *      differs. Applies to every incoming delegate_* call.
 *
 *   3. **Consecutive identical call** — `(tool, args)` has been the
 *      previous N recorded calls in a row with nothing different
 *      between. Only checked against the FIRST executable call in
 *      the batch; subsequent calls inherit the correct streak-reset
 *      semantics naturally (Copilot review on PR #602).
 *
 * Extracted from chat-send.ts to keep that module under the
 * max-lines ESLint cap.
 */
const MAX_REPEATED_TOOL_CALLS = 3;

export function checkLoopBreaker(
  detected: DetectedToolCalls,
  tracker: MutationFailureTracker,
  round: number,
): boolean {
  const allIncomingCalls = [
    ...detected.readOnly,
    ...detected.fileMutations,
    ...(detected.mutating ? [detected.mutating] : []),
  ];

  for (let i = 0; i < allIncomingCalls.length; i++) {
    const call = allIncomingCalls[i];
    const toolName = getToolName(call);
    const key = getToolInvocationKey(toolName, call.call);

    if (tracker.isRepeatedFailure(key, MAX_REPEATED_TOOL_CALLS)) {
      console.warn(
        `[Push] Turn ${round}: loop circuit breaker tripped for ${toolName}. Breaking loop.`,
      );
      return true;
    }

    const delegateAgent = delegateAgentForToolName(toolName);
    if (
      delegateAgent &&
      tracker.isRepeatedDelegationFailure(delegateAgent, MAX_REPEATED_TOOL_CALLS)
    ) {
      console.warn(
        `[Push] Turn ${round}: delegation-outcome breaker tripped for ${toolName} (${MAX_REPEATED_TOOL_CALLS}+ consecutive non-complete ${delegateAgent} delegations). Breaking loop.`,
      );
      return true;
    }

    if (i === 0 && tracker.isRepeatedCall(key, MAX_REPEATED_TOOL_CALLS)) {
      console.warn(
        `[Push] Turn ${round}: repeated-call breaker tripped for ${toolName} (same args ${MAX_REPEATED_TOOL_CALLS}+ rounds in a row). Breaking loop.`,
      );
      return true;
    }
  }

  return false;
}
