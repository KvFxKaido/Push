/**
 * chat-send.ts
 *
 * Phase 4 round helpers extracted from useChat.ts sendMessage.
 *
 * sendMessage stays as the loop orchestrator (round counter, abort checks, tab
 * lock, finally block). These two functions handle the per-round work:
 *
 *   streamAssistantRound   — wraps streamChat, accumulates tokens, updates UI
 *   processAssistantTurn   — post-stream: tool detection, dispatch, recovery
 */

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { streamChat } from '@/lib/orchestrator';
import { assertReadyForAssistantTurn } from '@push/lib/llm-message-invariants';
import { buildTodoContext } from '@/lib/todo-tools';
import type { ActiveProvider } from '@/lib/orchestrator';
import { setOpenRouterSessionId } from '@/lib/openrouter-session';
import { detectAnyToolCall, detectAllToolCalls, isReadOnlyToolCall } from '@/lib/tool-dispatch';
import type { AnyToolCall } from '@/lib/tool-dispatch';
import {
  appendCardsToLatestToolCall,
  buildToolMeta,
  buildToolResultMessage,
  getToolName,
  getToolStatusLabel,
  getToolStatusDetail,
  markLastAssistantToolCall,
} from '@/lib/chat-tool-messages';
import { getToolInvocationKey, type MutationFailureTracker } from '@push/lib/agent-loop-utils';
import { summarizeToolResultPreview } from '@/lib/chat-run-events';
import {
  executeTool,
  buildToolOutcome,
  buildMetaLine,
  collectSideEffects,
  handleRecoveryResult,
  handleMultipleMutationsError,
  type ToolExecRunContext,
  type ToolExecRawResult,
} from '@/lib/chat-tool-execution';
import { execInSandbox } from '@/lib/sandbox-client';
import { executeScratchpadToolCall } from '@/lib/scratchpad-tools';
import { executeTodoToolCall, type TodoItem } from '@/lib/todo-tools';
import { resolveToolCallRecovery, type ToolCallRecoveryState } from '@/lib/tool-call-recovery';
import { createId } from '@push/lib/id-utils';
import { type MigrationGuard } from '@/lib/chat-message';
import { applyBranchSwitchPayload } from '@/lib/branch-fork-migration';
import { TurnPolicyRegistry, type TurnContext } from '@/lib/turn-policy';
import {
  createOrchestratorPolicy,
  responseClaimsCompletion,
} from '@/lib/turn-policies/orchestrator-policy';
import type { RunEngineEvent } from '@/lib/run-engine';
import {
  evaluateVerificationState,
  formatVerificationBlock,
  recordVerificationArtifact,
  recordVerificationCommandResult,
  recordVerificationMutation,
} from '@/lib/verification-runtime';
import type {
  ActiveRepo,
  AgentStatus,
  AgentStatusSource,
  ChatCard,
  ChatMessage,
  Conversation,
  CoderWorkingMemory,
  RunEventInput,
  ToolExecutionResult,
  VerificationRuntimeState,
  WorkspaceContext,
} from '@/types';
import type { CheckpointRefs } from './useChatCheckpoint';

// ---------------------------------------------------------------------------
// Interface definitions (exported so useChat.ts can re-export them)
// ---------------------------------------------------------------------------

export interface ScratchpadHandlers {
  content: string;
  replace: (text: string) => void;
  append: (text: string) => void;
}

export interface TodoHandlers {
  todos: readonly TodoItem[];
  replace: (todos: TodoItem[]) => void;
  clear: () => void;
}

export interface UsageHandler {
  trackUsage: (model: string, inputTokens: number, outputTokens: number) => void;
}

export interface ChatRuntimeHandlers {
  onSandboxPromoted?: (repo: ActiveRepo) => void;
  bindSandboxSessionToRepo?: (repoFullName: string, branch?: string) => void;
  /** Called when a sandbox tool switches branches internally. */
  onBranchSwitch?: (branch: string) => void;
  /** Called when a tool result indicates the sandbox is unreachable. */
  onSandboxUnreachable?: (reason: string) => void;
}

const TOOL_RESULT_PULSE_INTERVAL = 3;

function shouldEmitPeriodicPulse(round: number): boolean {
  return (round + 1) % TOOL_RESULT_PULSE_INTERVAL === 0;
}

function delegateCallNeedsSandbox(call: AnyToolCall): boolean {
  if (call.source !== 'delegate') return false;
  if (call.call.tool === 'delegate_coder') return true;
  if (call.call.tool !== 'plan_tasks') return false;
  return call.call.args.tasks.some((task) => task.agent === 'coder');
}

function getDelegateCompletionAgent(call: AnyToolCall): 'explorer' | 'coder' | 'task_graph' {
  if (call.source !== 'delegate') return 'coder';
  if (call.call.tool === 'delegate_explorer') return 'explorer';
  if (call.call.tool === 'plan_tasks') return 'task_graph';
  return 'coder';
}

/** Chat-hook-managed sources — executed against refs in this hook, not the
 * generic tool-execution runtime which can only see server-owned state. */
function isChatHookSource(source: AnyToolCall['source']): boolean {
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
async function executeToolWithChatHooks(
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
function executeChatHookToolCall(
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

function extractChangedPathFromStatusLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const candidate = trimmed.slice(3).trim();
  if (!candidate) return null;
  if (candidate.includes(' -> ')) {
    return candidate.split(' -> ').pop()?.trim() || null;
  }
  return candidate;
}

function inferVerificationCommandResult(result: ToolExecutionResult): {
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

interface PostToolPolicyEffects {
  messages: ChatMessage[];
  halted: boolean;
  haltDetail?: string;
}

function collectPostToolPolicyEffects(
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
// Shared run context — stays constant for the duration of one sendMessage call
// ---------------------------------------------------------------------------

export interface SendLoopContext {
  chatId: string;
  lockedProvider: ActiveProvider;
  resolvedModel: string | undefined;
  // Refs
  abortRef: MutableRefObject<boolean>;
  abortControllerRef: MutableRefObject<AbortController | null>;
  sandboxIdRef: MutableRefObject<string | null>;
  ensureSandboxRef: MutableRefObject<(() => Promise<string | null>) | null>;
  scratchpadRef: MutableRefObject<ScratchpadHandlers | undefined>;
  todoRef: MutableRefObject<TodoHandlers | undefined>;
  usageHandlerRef: MutableRefObject<UsageHandler | undefined>;
  workspaceContextRef: MutableRefObject<WorkspaceContext | null>;
  runtimeHandlersRef: MutableRefObject<ChatRuntimeHandlers | undefined>;
  repoRef: MutableRefObject<string | null>;
  isMainProtectedRef: MutableRefObject<boolean>;
  branchInfoRef: MutableRefObject<{ currentBranch?: string; defaultBranch?: string } | undefined>;
  checkpointRefs: CheckpointRefs;
  processedContentRef: MutableRefObject<Set<string>>;
  lastCoderStateRef: MutableRefObject<CoderWorkingMemory | null>;
  // Slice 2 conversation-fork migration. Set by chat-send when a 'forked'
  // branchSwitch arrives; cleared by useChat's state-observed effect once the
  // migration is observable. While set, useChat's auto-switch effect early-
  // returns to suppress both auto-create AND chat-id-steal.
  skipAutoCreateRef: MutableRefObject<MigrationGuard | null>;
  // For stale-capture avoidance: read activeChatId at migration time, not at
  // closure-capture time, so a chat switch between dispatch and resolution
  // doesn't migrate the wrong conversation.
  activeChatIdRef: MutableRefObject<string | null>;
  // Used by applyBranchSwitchPayload to verify the target conversation
  // exists BEFORE setting guards — see Codex P1 review feedback.
  conversationsRef: MutableRefObject<Record<string, Conversation>>;
  // State mutation
  setConversations: Dispatch<SetStateAction<Record<string, Conversation>>>;
  dirtyConversationIdsRef: MutableRefObject<Set<string>>;
  // Callbacks
  updateAgentStatus: (
    status: AgentStatus,
    options?: { chatId?: string; source?: AgentStatusSource; log?: boolean },
  ) => void;
  appendRunEvent: (chatId: string, event: RunEventInput) => void;
  emitRunEngineEvent: (event: RunEngineEvent) => void;
  flushCheckpoint: () => void;
  getVerificationState: (chatId: string) => VerificationRuntimeState;
  updateVerificationState: (
    chatId: string,
    updater: (state: VerificationRuntimeState) => VerificationRuntimeState,
  ) => VerificationRuntimeState;
  executeDelegateCall: (
    chatId: string,
    toolCall: AnyToolCall,
    apiMessages: ChatMessage[],
    provider: ActiveProvider,
    resolvedModel?: string,
  ) => Promise<ToolExecutionResult>;
}

// ---------------------------------------------------------------------------
// streamAssistantRound
// ---------------------------------------------------------------------------

export interface StreamRoundResult {
  accumulated: string;
  thinkingAccumulated: string;
  error: Error | null;
}

/**
 * Stream one LLM round, accumulate tokens, and update the UI in real time.
 * Updates checkpointRefs synchronously so a visibility-change flush sees
 * the latest accumulated state without waiting for React to re-render.
 */
export async function streamAssistantRound(
  round: number,
  apiMessages: ChatMessage[],
  ctx: SendLoopContext,
): Promise<StreamRoundResult> {
  const {
    chatId,
    lockedProvider,
    resolvedModel,
    abortRef,
    processedContentRef,
    scratchpadRef,
    todoRef,
    usageHandlerRef,
    workspaceContextRef,
    abortControllerRef,
    sandboxIdRef,
    setConversations,
    updateAgentStatus,
    emitRunEngineEvent,
  } = ctx;

  processedContentRef.current.clear();
  let accumulated = '';
  let thinkingAccumulated = '';
  const hasSandboxThisRound = Boolean(sandboxIdRef.current);

  // Set OpenRouter session_id so all requests in this conversation are grouped.
  // Set unconditionally: the orchestrator may resolve to OpenRouter even when
  // lockedProvider is something else, and the getter is consume-and-clear so
  // it won't leak into non-OpenRouter requests.
  setOpenRouterSessionId(chatId);

  let invariantError: Error | null = null;
  try {
    assertReadyForAssistantTurn(apiMessages, 'web/streamAssistantRound');
  } catch (err) {
    invariantError = err instanceof Error ? err : new Error(String(err));
  }
  if (invariantError) {
    return { accumulated, thinkingAccumulated, error: invariantError };
  }

  const error = await new Promise<Error | null>((resolve) => {
    streamChat(
      apiMessages,
      (token) => {
        if (abortRef.current) return;
        const contentKey = `${round}:${accumulated.length}:${token}`;
        if (processedContentRef.current.has(contentKey)) return;
        processedContentRef.current.add(contentKey);
        accumulated += token;
        emitRunEngineEvent({
          type: 'ACCUMULATED_UPDATED',
          timestamp: Date.now(),
          text: accumulated,
          thinking: thinkingAccumulated,
        });
        updateAgentStatus({ active: true, phase: 'Responding...' }, { chatId, log: false });
        setConversations((prev) => {
          const conv = prev[chatId];
          if (!conv) return prev;
          const msgs = [...conv.messages];
          const lastIdx = msgs.length - 1;
          if (msgs[lastIdx]?.role === 'assistant') {
            msgs[lastIdx] = { ...msgs[lastIdx], content: accumulated, status: 'streaming' };
          }
          return { ...prev, [chatId]: { ...conv, messages: msgs } };
        });
      },
      (usage) => {
        if (usage && usageHandlerRef.current) {
          usageHandlerRef.current.trackUsage('k2p5', usage.inputTokens, usage.outputTokens);
        }
        resolve(null);
      },
      (err) => resolve(err),
      (thinkingToken) => {
        if (abortRef.current) return;
        if (thinkingToken === null) {
          updateAgentStatus({ active: true, phase: 'Responding...' }, { chatId, log: false });
          return;
        }
        const thinkingKey = `think:${round}:${thinkingAccumulated.length}:${thinkingToken}`;
        if (processedContentRef.current.has(thinkingKey)) return;
        processedContentRef.current.add(thinkingKey);
        thinkingAccumulated += thinkingToken;
        emitRunEngineEvent({
          type: 'ACCUMULATED_UPDATED',
          timestamp: Date.now(),
          text: accumulated,
          thinking: thinkingAccumulated,
        });
        updateAgentStatus({ active: true, phase: 'Reasoning...' }, { chatId, log: false });
        setConversations((prev) => {
          const conv = prev[chatId];
          if (!conv) return prev;
          const msgs = [...conv.messages];
          const lastIdx = msgs.length - 1;
          if (msgs[lastIdx]?.role === 'assistant') {
            msgs[lastIdx] = {
              ...msgs[lastIdx],
              thinking: thinkingAccumulated,
              status: 'streaming',
            };
          }
          return { ...prev, [chatId]: { ...conv, messages: msgs } };
        });
      },
      workspaceContextRef.current ?? undefined,
      hasSandboxThisRound,
      scratchpadRef.current?.content,
      abortControllerRef.current?.signal,
      lockedProvider,
      resolvedModel,
      undefined,
      todoRef.current ? buildTodoContext(todoRef.current.todos) : undefined,
    );
  });

  // Safety net: some providers (observed on Workers AI / GLM-4.7-flash) emit a
  // round's entire output on the reasoning channel — either via native
  // `reasoning_content` deltas or an unclosed `<think>` block that
  // `normalizeReasoning` flushes as `reasoning_delta` at stream end. The user
  // sees the final answer trapped inside a "Thought process" block and no
  // visible reply. If the stream completed without error, wasn't cancelled by
  // the user, emitted no content, and produced no native tool call (those
  // flush through the content parser via `flushNativeToolCalls`), promote the
  // reasoning tail to content. Skipping the promotion on abort is load-bearing:
  // `streamAssistantRound` resolves with `error === null` on user cancel, so
  // without the guard a cancelled turn with only reasoning tokens would
  // surface that partial reasoning as if it were the model's final answer.
  if (!error && !abortRef.current && !accumulated && thinkingAccumulated) {
    console.warn(
      `[Push] Round ${round}: no content emitted, promoting reasoning tail (${thinkingAccumulated.length} chars) to content.`,
    );
    accumulated = thinkingAccumulated;
    thinkingAccumulated = '';
    setConversations((prev) => {
      const conv = prev[chatId];
      if (!conv) return prev;
      const msgs = [...conv.messages];
      const lastIdx = msgs.length - 1;
      if (msgs[lastIdx]?.role === 'assistant') {
        msgs[lastIdx] = {
          ...msgs[lastIdx],
          content: accumulated,
          thinking: undefined,
          status: 'streaming',
        };
      }
      return { ...prev, [chatId]: { ...conv, messages: msgs } };
    });
    emitRunEngineEvent({
      type: 'ACCUMULATED_UPDATED',
      timestamp: Date.now(),
      text: accumulated,
      thinking: '',
    });
  }

  return { accumulated, thinkingAccumulated, error };
}

// ---------------------------------------------------------------------------
// processAssistantTurn — post-stream decision and dispatch
// ---------------------------------------------------------------------------

export interface AssistantTurnResult {
  nextApiMessages: ChatMessage[];
  nextRecoveryState: ToolCallRecoveryState;
  /** What the sendMessage loop should do after this turn. */
  loopAction: 'break' | 'continue';
  loopCompletedNormally: boolean;
}

/**
 * Decide what to do with the accumulated LLM response:
 *   - Multiple mutation error  → inject error message, continue loop
 *   - Parallel read-only calls → execute concurrently, continue loop
 *   - Single tool call         → execute, continue loop
 *   - No tool call             → recovery check or natural completion, break
 */
export async function processAssistantTurn(
  round: number,
  accumulated: string,
  thinkingAccumulated: string,
  apiMessages: ChatMessage[],
  ctx: SendLoopContext,
  recoveryState: ToolCallRecoveryState,
  tracker: MutationFailureTracker = {
    recordFailure: () => {},
    isRepeatedFailure: () => false,
    clear: () => {},
  },
): Promise<AssistantTurnResult> {
  const {
    chatId,
    lockedProvider,
    resolvedModel,
    abortRef,
    sandboxIdRef,
    ensureSandboxRef,
    scratchpadRef,
    todoRef,
    runtimeHandlersRef,
    repoRef,
    isMainProtectedRef,
    branchInfoRef,
    checkpointRefs,
    lastCoderStateRef,
    dirtyConversationIdsRef,
    setConversations,
    updateAgentStatus,
    appendRunEvent,
    emitRunEngineEvent,
    flushCheckpoint,
    getVerificationState,
    updateVerificationState,
    executeDelegateCall,
    skipAutoCreateRef,
    activeChatIdRef,
    conversationsRef,
  } = ctx;

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

  // checkpointRefs.apiMessages is the only remaining checkpoint ref;
  // phase/round/accumulated are read from RunEngineState.

  // --- Check for multiple independent read-only tool calls in one turn ---
  const detected = detectAllToolCalls(accumulated);
  const parallelToolCalls = detected.readOnly;

  // --- Circuit breaker: short-circuit if any incoming call has already
  // failed repeatedly with identical arguments. We only record failures
  // after execution (see recordToolFailure below), so legitimate repeated
  // operations (re-reading a file, incremental edits) are not affected.
  const MAX_REPEATED_TOOL_CALLS = 3;
  const allIncomingCalls = [
    ...detected.readOnly,
    ...detected.fileMutations,
    ...(detected.mutating ? [detected.mutating] : []),
  ];

  for (const call of allIncomingCalls) {
    // Some AnyToolCall variants (scratchpad, todo) carry their payload
    // inline rather than under `args`. Pass the whole `call` so the key
    // is well-defined for every variant; the tool name is already part
    // of it, which is harmless redundancy for keying.
    const key = getToolInvocationKey(getToolName(call), call.call);
    if (tracker.isRepeatedFailure(key, MAX_REPEATED_TOOL_CALLS)) {
      console.warn(
        `[Push] Turn ${round}: loop circuit breaker tripped for ${getToolName(call)}. Breaking loop.`,
      );
      return {
        nextApiMessages: apiMessages,
        nextRecoveryState: recoveryState,
        loopAction: 'break',
        loopCompletedNormally: false,
      };
    }
  }

  const recordToolFailure = (call: AnyToolCall, isError: boolean) => {
    if (!isError) return;
    tracker.recordFailure(getToolInvocationKey(getToolName(call), call.call));
  };

  if (detected.extraMutations.length > 0) {
    const errorAction = handleMultipleMutationsError(
      detected,
      accumulated,
      thinkingAccumulated,
      apiMessages,
      lockedProvider,
    );

    appendRunEvent(chatId, {
      type: 'tool.call_malformed',
      round,
      reason: 'multiple_mutating_calls',
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

  // Per-round sandbox status cache — fetched lazily after the first tool executes
  let roundSandboxStatus: {
    dirty: boolean;
    files: number;
    branch?: string;
    head?: string;
    changedFiles?: string[];
  } | null = null;
  let roundSandboxStatusFetched = false;

  const getRoundSandboxStatus = async (): Promise<{
    dirty: boolean;
    files: number;
    branch?: string;
    head?: string;
    changedFiles?: string[];
  } | null> => {
    if (roundSandboxStatusFetched) return roundSandboxStatus;
    roundSandboxStatusFetched = true;
    if (!sandboxIdRef.current) return null;
    try {
      const statusResult = await execInSandbox(
        sandboxIdRef.current,
        [
          'cd /workspace || exit 1',
          'echo "---BRANCH---"',
          'git branch --show-current 2>/dev/null',
          'echo "---HEAD---"',
          'git rev-parse --short HEAD 2>/dev/null',
          'echo "---STATUS---"',
          'git status --porcelain 2>/dev/null | head -20',
        ].join('\n'),
      );
      const sections: Record<string, string[]> = {};
      let currentSection: string | null = null;
      for (const line of statusResult.stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '---BRANCH---') {
          currentSection = 'branch';
          sections[currentSection] = [];
          continue;
        }
        if (trimmed === '---HEAD---') {
          currentSection = 'head';
          sections[currentSection] = [];
          continue;
        }
        if (trimmed === '---STATUS---') {
          currentSection = 'status';
          sections[currentSection] = [];
          continue;
        }
        if (currentSection) {
          sections[currentSection].push(line);
        }
      }
      const statusLines = (sections.status || []).map((line) => line.trimEnd()).filter(Boolean);
      roundSandboxStatus = {
        dirty: statusLines.length > 0,
        files: statusLines.length,
        branch: sections.branch?.map((line) => line.trim()).find(Boolean),
        head: sections.head?.map((line) => line.trim()).find(Boolean),
        changedFiles: statusLines
          .map(extractChangedPathFromStatusLine)
          .filter((value): value is string => Boolean(value))
          .slice(0, 6),
      };
    } catch {
      // Best-effort — don't block tool execution
    }
    return roundSandboxStatus;
  };

  // --- Batched tool calls (reads ‖ file-mutation batch ≫ optional trailing side-effect) ---
  const fileMutationBatch = detected.fileMutations;
  const totalBatchedCalls =
    parallelToolCalls.length + fileMutationBatch.length + (detected.mutating ? 1 : 0);
  if (totalBatchedCalls > 1) {
    console.log(`[Push] Batched tool calls detected:`, {
      reads: parallelToolCalls.length,
      fileMutations: fileMutationBatch.length,
      trailing: detected.mutating ? getToolName(detected.mutating) : null,
    });
    const parallelExecutionIds = parallelToolCalls.map(() => createId());

    setConversations((prev) => {
      const conv = prev[chatId];
      if (!conv) return prev;
      const msgs = markLastAssistantToolCall(conv.messages, {
        content: accumulated,
        thinking: thinkingAccumulated,
      });
      return { ...prev, [chatId]: { ...conv, messages: msgs } };
    });

    if (parallelToolCalls.length > 0) {
      updateAgentStatus(
        { active: true, phase: `Executing ${parallelToolCalls.length} tool calls...` },
        { chatId },
      );
      parallelToolCalls.forEach((call, index) => {
        appendRunEvent(chatId, {
          type: 'tool.execution_start',
          round,
          executionId: parallelExecutionIds[index],
          toolName: getToolName(call),
          toolSource: call.source,
        });
      });
    }

    const hasParallelSandboxCalls = parallelToolCalls.some((call) => call.source === 'sandbox');
    const batchNeedsSandbox =
      hasParallelSandboxCalls ||
      fileMutationBatch.some((call) => call.source === 'sandbox') ||
      detected.mutating?.source === 'sandbox';
    if (batchNeedsSandbox && !sandboxIdRef.current && ensureSandboxRef.current) {
      updateAgentStatus({ active: true, phase: 'Starting sandbox...' }, { chatId });
      const newId = await ensureSandboxRef.current();
      if (newId) sandboxIdRef.current = newId;
    }

    const runCtx: ToolExecRunContext = {
      repoFullName: repoRef.current,
      sandboxId: sandboxIdRef.current,
      isMainProtected: isMainProtectedRef.current,
      defaultBranch: branchInfoRef.current?.defaultBranch,
      provider: lockedProvider,
      model: resolvedModel,
    };

    const parallelRawResults = await Promise.all(
      parallelToolCalls.map((call) =>
        executeToolWithChatHooks(call, runCtx, { scratchpadRef, todoRef }),
      ),
    );

    if (abortRef.current) {
      return {
        nextApiMessages: apiMessages,
        nextRecoveryState: recoveryState,
        loopAction: 'break',
        loopCompletedNormally: false,
      };
    }

    const parallelEffects = collectSideEffects(parallelRawResults);
    if (parallelEffects.sandboxUnreachable) {
      runtimeHandlersRef.current?.onSandboxUnreachable?.(parallelEffects.sandboxUnreachable);
    }

    const allCards = parallelRawResults.flatMap((r) => r.cards);
    if (allCards.length > 0) {
      setConversations((prev) => {
        const conv = prev[chatId];
        if (!conv) return prev;
        const msgs = appendCardsToLatestToolCall(conv.messages, allCards);
        return { ...prev, [chatId]: { ...conv, messages: msgs } };
      });
    }

    roundSandboxStatusFetched = false; // invalidate — tools may have changed sandbox
    const parallelSandboxStatus = await getRoundSandboxStatus();
    const parallelMetaLine = buildMetaLine(
      round,
      apiMessages,
      lockedProvider,
      resolvedModel,
      parallelSandboxStatus,
      shouldEmitPeriodicPulse(round) && !detected.mutating
        ? { includePulse: true, pulseReason: 'periodic' }
        : undefined,
    );
    const toolResultMessages = parallelRawResults.map(
      (r) => buildToolOutcome(r, parallelMetaLine, lockedProvider).resultMessage,
    );
    parallelRawResults.forEach((result, index) => {
      const isError = result.raw.text.includes('[Tool Error]');
      recordToolFailure(result.call, isError);
      appendRunEvent(chatId, {
        type: 'tool.execution_complete',
        round,
        executionId: parallelExecutionIds[index],
        toolName: getToolName(result.call),
        toolSource: result.call.source,
        durationMs: result.durationMs,
        isError,
        preview: summarizeToolResultPreview(result.raw.text),
      });
    });

    setConversations((prev) => {
      const conv = prev[chatId];
      if (!conv) return prev;
      const updated = {
        ...prev,
        [chatId]: {
          ...conv,
          messages: [...conv.messages, ...toolResultMessages],
          lastMessageAt: Date.now(),
        },
      };
      dirtyConversationIdsRef.current.add(chatId);
      return updated;
    });

    let nextApiMessages: ChatMessage[] = [
      ...apiMessages,
      {
        id: createId(),
        role: 'assistant' as const,
        content: accumulated,
        timestamp: Date.now(),
        status: 'done' as const,
      },
      ...toolResultMessages,
    ];
    checkpointRefs.apiMessages.current = nextApiMessages;
    flushCheckpoint();

    const parallelPolicyAction = applyPostToolPolicyEffects(
      nextApiMessages,
      parallelRawResults.map((result) => result.raw),
    );
    if (parallelPolicyAction) {
      return parallelPolicyAction;
    }

    // --- File-mutation batch (sequential, between reads and trailing side-effect) ---
    // Runs pure file writes/edits in the order the model emitted them.
    // Each call's result is appended before the next runs so errors
    // propagate naturally. On the first hard failure we short-circuit
    // the batch and suppress the trailing side-effect so the model can
    // correct before we commit or exec against partial state.
    let batchHadHardFailure = false;
    if (fileMutationBatch.length > 0) {
      updateAgentStatus(
        {
          active: true,
          phase: `Applying ${fileMutationBatch.length} file mutation${fileMutationBatch.length === 1 ? '' : 's'}...`,
        },
        { chatId },
      );

      const batchCtx: ToolExecRunContext = {
        repoFullName: repoRef.current,
        sandboxId: sandboxIdRef.current,
        isMainProtected: isMainProtectedRef.current,
        defaultBranch: branchInfoRef.current?.defaultBranch,
        provider: lockedProvider,
        model: resolvedModel,
      };

      for (let i = 0; i < fileMutationBatch.length; i++) {
        if (abortRef.current) {
          return {
            nextApiMessages,
            nextRecoveryState: recoveryState,
            loopAction: 'break',
            loopCompletedNormally: false,
          };
        }
        const batchCall = fileMutationBatch[i];
        const batchExecutionId = createId();
        appendRunEvent(chatId, {
          type: 'tool.execution_start',
          round,
          executionId: batchExecutionId,
          toolName: getToolName(batchCall),
          toolSource: batchCall.source,
        });

        const batchRawResult = await executeTool(batchCall, batchCtx);

        roundSandboxStatusFetched = false;
        const batchSandboxStatus = await getRoundSandboxStatus();
        const batchMetaLine = buildMetaLine(
          round,
          nextApiMessages,
          lockedProvider,
          resolvedModel,
          batchSandboxStatus,
          { includePulse: true, pulseReason: 'mutation' },
        );
        const batchOutcome = buildToolOutcome(batchRawResult, batchMetaLine, lockedProvider);
        const isBatchError = batchOutcome.raw.text.includes('[Tool Error]');
        recordToolFailure(batchCall, isBatchError);
        appendRunEvent(chatId, {
          type: 'tool.execution_complete',
          round,
          executionId: batchExecutionId,
          toolName: getToolName(batchCall),
          toolSource: batchCall.source,
          durationMs: batchRawResult.durationMs,
          isError: isBatchError,
          preview: summarizeToolResultPreview(batchOutcome.raw.text),
        });

        if (batchOutcome.raw.structuredError?.type === 'SANDBOX_UNREACHABLE') {
          runtimeHandlersRef.current?.onSandboxUnreachable?.(
            batchOutcome.raw.structuredError.message,
          );
        }

        // Single state update per batch member: apply cards (if any)
        // and append the result message in one pass so React only
        // re-renders once instead of twice per mutation.
        setConversations((prev) => {
          const conv = prev[chatId];
          if (!conv) return prev;
          const withCards =
            batchOutcome.cards.length > 0
              ? appendCardsToLatestToolCall(conv.messages, batchOutcome.cards)
              : conv.messages;
          return {
            ...prev,
            [chatId]: {
              ...conv,
              messages: [...withCards, batchOutcome.resultMessage],
              lastMessageAt: Date.now(),
            },
          };
        });

        nextApiMessages = [...nextApiMessages, batchOutcome.resultMessage];
        checkpointRefs.apiMessages.current = nextApiMessages;
        flushCheckpoint();

        const batchPolicyAction = applyPostToolPolicyEffects(nextApiMessages, [batchOutcome.raw]);
        if (batchPolicyAction) {
          return batchPolicyAction;
        }

        if (isBatchError) {
          // Stop the batch on the first hard error so the model sees the
          // failure and can correct before we commit or exec. The trailing
          // side-effect is also suppressed — partial mutation state is
          // already visible through the results we injected.
          batchHadHardFailure = true;
          break;
        }
      }
    }

    // Execute trailing side-effect after the batch, unless the batch
    // hard-failed above (in which case we return to the model for a fix).
    if (detected.mutating && abortRef.current) {
      return {
        nextApiMessages,
        nextRecoveryState: recoveryState,
        loopAction: 'break',
        loopCompletedNormally: false,
      };
    }
    if (detected.mutating && batchHadHardFailure) {
      return {
        nextApiMessages,
        nextRecoveryState: recoveryState,
        loopAction: 'continue',
        loopCompletedNormally: false,
      };
    }

    if (detected.mutating) {
      const mutCall = detected.mutating;
      const mutExecutionId = createId();
      console.log(`[Push] Trailing mutation after parallel reads:`, mutCall);
      updateAgentStatus(
        {
          active: true,
          phase: getToolStatusLabel(mutCall),
          detail: getToolStatusDetail(mutCall),
          startedAt: Date.now(),
        },
        { chatId },
      );
      appendRunEvent(chatId, {
        type: 'tool.execution_start',
        round,
        executionId: mutExecutionId,
        toolName: getToolName(mutCall),
        toolSource: mutCall.source,
      });

      if (
        (mutCall.source === 'sandbox' || delegateCallNeedsSandbox(mutCall)) &&
        !sandboxIdRef.current &&
        ensureSandboxRef.current
      ) {
        updateAgentStatus({ active: true, phase: 'Starting sandbox...' }, { chatId });
        const newId = await ensureSandboxRef.current();
        if (newId) sandboxIdRef.current = newId;
      }

      let mutRawResult: ToolExecRawResult;

      if (mutCall.source === 'delegate') {
        const delegateStart = Date.now();
        const mutResult = await executeDelegateCall(
          chatId,
          mutCall,
          nextApiMessages,
          lockedProvider,
          resolvedModel || undefined,
        );
        lastCoderStateRef.current = null;
        emitRunEngineEvent({
          type: 'DELEGATION_COMPLETED',
          timestamp: Date.now(),
          agent: getDelegateCompletionAgent(mutCall),
        });

        const mutCards =
          mutResult.card && mutResult.card.type !== 'sandbox-state' ? [mutResult.card] : [];
        mutRawResult = {
          call: mutCall,
          raw: mutResult,
          cards: mutCards,
          durationMs: Date.now() - delegateStart,
        };
      } else {
        const mutCtx: ToolExecRunContext = {
          repoFullName: repoRef.current,
          sandboxId: sandboxIdRef.current,
          isMainProtected: isMainProtectedRef.current,
          defaultBranch: branchInfoRef.current?.defaultBranch,
          provider: lockedProvider,
          model: resolvedModel,
        };
        mutRawResult = await executeToolWithChatHooks(mutCall, mutCtx, {
          scratchpadRef,
          todoRef,
        });
      }

      roundSandboxStatusFetched = false;
      const mutSandboxStatus = await getRoundSandboxStatus();
      const mutMetaLine = buildMetaLine(
        round,
        nextApiMessages,
        lockedProvider,
        resolvedModel,
        mutSandboxStatus,
        { includePulse: true, pulseReason: 'mutation' },
      );
      const mutOutcome = buildToolOutcome(mutRawResult, mutMetaLine, lockedProvider);
      const isMutError = mutOutcome.raw.text.includes('[Tool Error]');
      recordToolFailure(mutCall, isMutError);
      appendRunEvent(chatId, {
        type: 'tool.execution_complete',
        round,
        executionId: mutExecutionId,
        toolName: getToolName(mutCall),
        toolSource: mutCall.source,
        durationMs: mutRawResult.durationMs,
        isError: isMutError,
        preview: summarizeToolResultPreview(mutOutcome.raw.text),
      });

      if (mutOutcome.raw.structuredError?.type === 'SANDBOX_UNREACHABLE') {
        runtimeHandlersRef.current?.onSandboxUnreachable?.(mutOutcome.raw.structuredError.message);
      }

      if (mutOutcome.cards.length > 0) {
        setConversations((prev) => {
          const conv = prev[chatId];
          if (!conv) return prev;
          const msgs = appendCardsToLatestToolCall(conv.messages, mutOutcome.cards);
          return { ...prev, [chatId]: { ...conv, messages: msgs } };
        });
      }

      setConversations((prev) => {
        const conv = prev[chatId];
        if (!conv) return prev;
        return {
          ...prev,
          [chatId]: {
            ...conv,
            messages: [...conv.messages, mutOutcome.resultMessage],
            lastMessageAt: Date.now(),
          },
        };
      });

      nextApiMessages = [...nextApiMessages, mutOutcome.resultMessage];
      checkpointRefs.apiMessages.current = nextApiMessages;
      flushCheckpoint();

      const trailingPolicyAction = applyPostToolPolicyEffects(nextApiMessages, [mutOutcome.raw]);
      if (trailingPolicyAction) {
        return trailingPolicyAction;
      }
    }

    return {
      nextApiMessages,
      nextRecoveryState: recoveryState,
      loopAction: 'continue',
      loopCompletedNormally: false,
    };
  }

  // --- Single tool call ---
  const toolCall = detectAnyToolCall(accumulated);

  if (!toolCall) {
    // --- No tool call: recovery check or natural completion ---
    const recoveryResult = resolveToolCallRecovery(accumulated, recoveryState);
    const nextRecoveryState = recoveryResult.nextState;

    if (recoveryResult.kind === 'feedback' && recoveryResult.diagnosis) {
      appendRunEvent(chatId, {
        type: 'tool.call_malformed',
        round,
        reason: recoveryResult.diagnosis.reason,
        toolName: recoveryResult.diagnosis.toolName || undefined,
        preview: summarizeToolResultPreview(recoveryResult.diagnosis.errorMessage),
      });
    } else if (
      recoveryResult.kind === 'telemetry_only' ||
      recoveryResult.kind === 'diagnosis_exhausted'
    ) {
      appendRunEvent(chatId, {
        type: 'tool.call_malformed',
        round,
        reason: recoveryResult.diagnosis.reason,
        toolName: recoveryResult.diagnosis.toolName || undefined,
        preview: summarizeToolResultPreview(recoveryResult.diagnosis.errorMessage),
      });
    } else if (
      recoveryResult.kind === 'feedback' &&
      recoveryResult.feedback.mode === 'unimplemented_tool'
    ) {
      appendRunEvent(chatId, {
        type: 'tool.call_malformed',
        round,
        reason: 'unimplemented_tool',
        toolName: recoveryResult.feedback.toolName,
        preview: summarizeToolResultPreview(recoveryResult.feedback.content),
      });
    }

    const action = handleRecoveryResult(
      recoveryResult,
      accumulated,
      thinkingAccumulated,
      apiMessages,
      lockedProvider,
      resolvedModel,
    );

    if (action.conversationUpdate) {
      const upd = action.conversationUpdate;
      if (upd.appendMessage) {
        setConversations((prev) => {
          const conv = prev[chatId];
          if (!conv) return prev;
          const msgs = markLastAssistantToolCall(conv.messages, {
            content: upd.assistantContent,
            thinking: upd.assistantThinking,
            malformed: upd.assistantMalformed,
            toolMeta: upd.assistantToolMeta,
          });
          return { ...prev, [chatId]: { ...conv, messages: [...msgs, upd.appendMessage!] } };
        });
      } else {
        setConversations((prev) => {
          const conv = prev[chatId];
          if (!conv) return prev;
          const msgs = [...conv.messages];
          const lastIdx = msgs.length - 1;
          if (msgs[lastIdx]?.role === 'assistant') {
            msgs[lastIdx] = {
              ...msgs[lastIdx],
              content: upd.assistantContent,
              thinking: upd.assistantThinking || undefined,
              status: 'done',
              isMalformed: upd.assistantMalformed || undefined,
            };
          }
          const updated = {
            ...prev,
            [chatId]: { ...conv, messages: msgs, lastMessageAt: Date.now() },
          };
          if (upd.markDirty) dirtyConversationIdsRef.current.add(chatId);
          return updated;
        });
      }
    }

    // --- Turn policy: ungrounded-completion guard ---
    // Only runs when recovery decides this is a genuine natural completion
    // (not a malformed tool call needing retry). This prevents the policy
    // from intercepting responses that should go through the recovery path.
    if (action.loopAction === 'break' && responseClaimsCompletion(accumulated)) {
      const verificationEvaluation = evaluateVerificationState(
        getVerificationState(chatId),
        'completion',
      );
      if (!verificationEvaluation.passed) {
        setConversations((prev) => {
          const conv = prev[chatId];
          if (!conv) return prev;
          const msgs = [...conv.messages];
          const lastIdx = msgs.length - 1;
          if (msgs[lastIdx]?.role === 'assistant') {
            msgs[lastIdx] = { ...msgs[lastIdx], content: accumulated, status: 'done' };
          }
          dirtyConversationIdsRef.current.add(chatId);
          return { ...prev, [chatId]: { ...conv, messages: msgs, lastMessageAt: Date.now() } };
        });

        return {
          nextApiMessages: [
            ...action.apiMessages,
            {
              id: createId(),
              role: 'user',
              content: formatVerificationBlock(verificationEvaluation, 'completion'),
              timestamp: Date.now(),
            },
          ],
          nextRecoveryState,
          loopAction: 'continue',
          loopCompletedNormally: false,
        };
      }

      const orchestratorPolicy = new TurnPolicyRegistry();
      orchestratorPolicy.register(createOrchestratorPolicy());
      const turnCtx: TurnContext = {
        role: 'orchestrator',
        round,
        maxRounds: 100,
        sandboxId: sandboxIdRef.current,
        allowedRepo: repoRef.current || '',
        activeProvider: lockedProvider,
        activeModel: resolvedModel,
      };
      const policyResult = await orchestratorPolicy.evaluateAfterModel(
        accumulated,
        apiMessages,
        turnCtx,
      );
      if (policyResult?.action === 'inject') {
        // Finalize the assistant message in conversation state before continuing,
        // so it doesn't remain with status: 'streaming' (stale spinner).
        setConversations((prev) => {
          const conv = prev[chatId];
          if (!conv) return prev;
          const msgs = [...conv.messages];
          const lastIdx = msgs.length - 1;
          if (msgs[lastIdx]?.role === 'assistant') {
            msgs[lastIdx] = { ...msgs[lastIdx], content: accumulated, status: 'done' };
          }
          dirtyConversationIdsRef.current.add(chatId);
          return { ...prev, [chatId]: { ...conv, messages: msgs, lastMessageAt: Date.now() } };
        });

        // Nudge the model — inject corrective message and continue the loop
        const nextApiMessages = [...action.apiMessages, policyResult.message];
        return {
          nextApiMessages,
          nextRecoveryState,
          loopAction: 'continue',
          loopCompletedNormally: false,
        };
      }
    }

    return {
      nextApiMessages: action.apiMessages,
      nextRecoveryState,
      loopAction: action.loopAction === 'break' ? 'break' : 'continue',
      loopCompletedNormally: action.loopCompletedNormally ?? false,
    };
  }

  // Tool call detected — execute it
  console.log(`[Push] Tool call detected:`, toolCall);
  const executionId = createId();

  setConversations((prev) => {
    const conv = prev[chatId];
    if (!conv) return prev;
    const msgs = markLastAssistantToolCall(conv.messages, {
      content: accumulated,
      thinking: thinkingAccumulated,
    });
    return { ...prev, [chatId]: { ...conv, messages: msgs } };
  });

  const toolExecStart = Date.now();
  let toolExecDurationMs = 0;
  let singleRawResult: ToolExecRawResult | null = null;
  const statusLabel = getToolStatusLabel(toolCall);
  updateAgentStatus(
    {
      active: true,
      phase: statusLabel,
      detail: getToolStatusDetail(toolCall),
      startedAt: toolExecStart,
    },
    { chatId },
  );
  appendRunEvent(chatId, {
    type: 'tool.execution_start',
    round,
    executionId,
    toolName: getToolName(toolCall),
    toolSource: toolCall.source,
  });

  let toolExecResult: ToolExecutionResult | undefined;
  const isCommitVerificationTool =
    toolCall.source === 'sandbox' &&
    (toolCall.call.tool === 'sandbox_prepare_commit' || toolCall.call.tool === 'sandbox_push');

  if (isCommitVerificationTool) {
    const verificationEvaluation = evaluateVerificationState(
      getVerificationState(chatId),
      'commit',
    );
    if (!verificationEvaluation.passed) {
      toolExecResult = {
        text: `[Tool Error] ${formatVerificationBlock(verificationEvaluation, 'commit')}`,
      };
      toolExecDurationMs = 0;
    }
  }

  // Lazy auto-spin: create sandbox on demand for sandbox calls and any
  // delegation that can execute Coder work (direct or via task graph).
  if (
    !toolExecResult &&
    (toolCall.source === 'sandbox' || delegateCallNeedsSandbox(toolCall)) &&
    !sandboxIdRef.current
  ) {
    if (ensureSandboxRef.current) {
      updateAgentStatus({ active: true, phase: 'Starting sandbox...' }, { chatId });
      const newId = await ensureSandboxRef.current();
      if (newId) {
        sandboxIdRef.current = newId;
      }
    }
  }

  if (toolExecResult) {
    // Runtime verification blocked this tool before dispatch.
  } else if (toolCall.source === 'scratchpad' || toolCall.source === 'todo') {
    const chatHookResult = executeChatHookToolCall(toolCall, { scratchpadRef, todoRef });
    toolExecResult = chatHookResult ?? { text: '[Tool Error] Chat-hook tool dispatch failed.' };
    toolExecDurationMs = Date.now() - toolExecStart;
  } else if (toolCall.source === 'delegate') {
    toolExecResult = await executeDelegateCall(
      chatId,
      toolCall,
      apiMessages,
      lockedProvider,
      resolvedModel || undefined,
    );
    toolExecDurationMs = Date.now() - toolExecStart;
    lastCoderStateRef.current = null;
    emitRunEngineEvent({
      type: 'DELEGATION_COMPLETED',
      timestamp: Date.now(),
      agent: getDelegateCompletionAgent(toolCall),
    });
  } else {
    const singleCtx: ToolExecRunContext = {
      repoFullName: repoRef.current,
      sandboxId: sandboxIdRef.current,
      isMainProtected: isMainProtectedRef.current,
      defaultBranch: branchInfoRef.current?.defaultBranch,
      provider: lockedProvider,
      model: resolvedModel,
    };
    singleRawResult = await executeTool(toolCall, singleCtx);
    toolExecResult = singleRawResult.raw;
    toolExecDurationMs = singleRawResult.durationMs;
  }

  if (!toolExecResult) {
    throw new Error('Tool execution did not produce a result.');
  }

  if (abortRef.current) {
    return {
      nextApiMessages: apiMessages,
      nextRecoveryState: recoveryState,
      loopAction: 'break',
      loopCompletedNormally: false,
    };
  }

  const verificationResult = singleRawResult?.raw ?? toolExecResult;
  const touchedPaths =
    verificationResult.postconditions?.touchedFiles.map((file) => file.path) ?? [];
  if (touchedPaths.length > 0) {
    updateVerificationState(chatId, (state) =>
      recordVerificationMutation(state, {
        source: 'tool',
        touchedPaths,
        detail: `${getToolName(toolCall)} mutated the workspace.`,
      }),
    );
  } else if (
    toolCall.source === 'sandbox' &&
    toolCall.call.tool === 'sandbox_exec' &&
    !isReadOnlyToolCall(toolCall)
  ) {
    updateVerificationState(chatId, (state) =>
      recordVerificationMutation(state, {
        source: 'tool',
        detail: 'sandbox_exec may have mutated the workspace.',
      }),
    );
  }

  const verificationCommand = inferVerificationCommandResult(verificationResult);
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
    toolCall.source === 'sandbox' &&
    (toolCall.call.tool === 'sandbox_diff' ||
      toolCall.call.tool === 'sandbox_prepare_commit' ||
      toolCall.call.tool === 'sandbox_push')
  ) {
    updateVerificationState(chatId, (state) =>
      recordVerificationArtifact(state, `${toolCall.call.tool} produced artifact evidence.`),
    );
  }

  // Post-execution side effects
  if (toolExecResult.promotion?.repo) {
    const promotedRepo = toolExecResult.promotion.repo;
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

  if (toolExecResult.branchSwitch) {
    // Slice 2 conversation-fork migration. Migration logic lives in
    // branch-fork-migration.ts so this dispatcher stays small and the
    // migration is testable in isolation. Dispatches on payload.kind:
    // 'forked' migrates the active conversation; 'switched' or undefined
    // falls through to the existing auto-switch behavior.
    applyBranchSwitchPayload(toolExecResult.branchSwitch, {
      activeChatIdRef,
      conversationsRef,
      branchInfoRef,
      skipAutoCreateRef,
      setConversations,
      dirtyConversationIdsRef,
      runtimeHandlersRef,
    });
  }

  if (toolExecResult.structuredError?.type === 'SANDBOX_UNREACHABLE') {
    runtimeHandlersRef.current?.onSandboxUnreachable?.(toolExecResult.structuredError.message);
  }

  // Build result message with post-execution sandbox status
  roundSandboxStatusFetched = false;
  const sbStatus = await getRoundSandboxStatus();
  const metaLine = buildMetaLine(
    round,
    apiMessages,
    lockedProvider,
    resolvedModel,
    sbStatus,
    !isReadOnlyToolCall(toolCall)
      ? { includePulse: true, pulseReason: 'mutation' }
      : shouldEmitPeriodicPulse(round)
        ? { includePulse: true, pulseReason: 'periodic' }
        : undefined,
  );

  let toolResultMsg: ChatMessage;
  let cardsToAttach: ChatCard[];
  if (singleRawResult) {
    const outcome = buildToolOutcome(singleRawResult, metaLine, lockedProvider);
    toolResultMsg = outcome.resultMessage;
    cardsToAttach = outcome.cards;
    const isError = outcome.raw.text.includes('[Tool Error]');
    recordToolFailure(toolCall, isError);
    appendRunEvent(chatId, {
      type: 'tool.execution_complete',
      round,
      executionId,
      toolName: getToolName(toolCall),
      toolSource: toolCall.source,
      durationMs: singleRawResult.durationMs,
      isError,
      preview: summarizeToolResultPreview(outcome.raw.text),
    });
  } else {
    const isError = toolExecResult.text.includes('[Tool Error]');
    recordToolFailure(toolCall, isError);
    toolResultMsg = buildToolResultMessage({
      id: createId(),
      timestamp: Date.now(),
      text: toolExecResult.text,
      metaLine,
      toolMeta: buildToolMeta({
        toolName: getToolName(toolCall),
        source: toolCall.source,
        provider: lockedProvider,
        durationMs: toolExecDurationMs,
        isError,
      }),
    });
    cardsToAttach =
      toolExecResult.card && toolExecResult.card.type !== 'sandbox-state'
        ? [toolExecResult.card]
        : [];
    appendRunEvent(chatId, {
      type: 'tool.execution_complete',
      round,
      executionId,
      toolName: getToolName(toolCall),
      toolSource: toolCall.source,
      durationMs: toolExecDurationMs,
      isError,
      preview: summarizeToolResultPreview(toolExecResult.text),
    });
  }

  if (cardsToAttach.length > 0) {
    setConversations((prev) => {
      const conv = prev[chatId];
      if (!conv) return prev;
      const msgs = appendCardsToLatestToolCall(conv.messages, cardsToAttach);
      return { ...prev, [chatId]: { ...conv, messages: msgs } };
    });
  }

  setConversations((prev) => {
    const conv = prev[chatId];
    if (!conv) return prev;
    const updated = { ...prev, [chatId]: { ...conv, messages: [...conv.messages, toolResultMsg] } };
    dirtyConversationIdsRef.current.add(chatId);
    return updated;
  });

  const nextApiMessages: ChatMessage[] = [
    ...apiMessages,
    {
      id: createId(),
      role: 'assistant' as const,
      content: accumulated,
      timestamp: Date.now(),
      status: 'done' as const,
    },
    toolResultMsg,
  ];
  checkpointRefs.apiMessages.current = nextApiMessages;
  flushCheckpoint();

  const policyAction = applyPostToolPolicyEffects(nextApiMessages, [toolExecResult]);
  if (policyAction) {
    return policyAction;
  }

  return {
    nextApiMessages,
    nextRecoveryState: recoveryState,
    loopAction: 'continue',
    loopCompletedNormally: false,
  };
}
