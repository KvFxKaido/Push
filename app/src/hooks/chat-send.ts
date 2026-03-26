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
import type { ActiveProvider } from '@/lib/orchestrator';
import { detectAnyToolCall, detectAllToolCalls } from '@/lib/tool-dispatch';
import type { AnyToolCall } from '@/lib/tool-dispatch';
import {
  appendCardsToLatestToolCall,
  buildToolMeta,
  buildToolResultMessage,
  getToolName,
  getToolStatusLabel,
  markLastAssistantToolCall,
} from '@/lib/chat-tool-messages';
import {
  executeTool,
  buildToolOutcome,
  executeParallelTools,
  buildMetaLine,
  collectSideEffects,
  handleRecoveryResult,
  handleMultipleMutationsError,
  type ToolExecRunContext,
  type ToolExecRawResult,
} from '@/hooks/chat-tool-execution';
import { execInSandbox } from '@/lib/sandbox-client';
import { executeScratchpadToolCall } from '@/lib/scratchpad-tools';
import { resolveToolCallRecovery, type ToolCallRecoveryState } from '@/lib/tool-call-recovery';
import { createId } from '@/hooks/chat-persistence';
import { TurnPolicyRegistry, type TurnContext } from '@/lib/turn-policy';
import { createOrchestratorPolicy } from '@/lib/turn-policies/orchestrator-policy';
import type {
  ActiveRepo,
  AgentStatus,
  AgentStatusSource,
  ChatCard,
  ChatMessage,
  Conversation,
  CoderWorkingMemory,
  ToolExecutionResult,
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
  usageHandlerRef: MutableRefObject<UsageHandler | undefined>;
  workspaceContextRef: MutableRefObject<WorkspaceContext | null>;
  runtimeHandlersRef: MutableRefObject<ChatRuntimeHandlers | undefined>;
  repoRef: MutableRefObject<string | null>;
  isMainProtectedRef: MutableRefObject<boolean>;
  branchInfoRef: MutableRefObject<{ currentBranch?: string; defaultBranch?: string } | undefined>;
  checkpointRefs: CheckpointRefs;
  processedContentRef: MutableRefObject<Set<string>>;
  lastCoderStateRef: MutableRefObject<CoderWorkingMemory | null>;
  // State mutation
  setConversations: Dispatch<SetStateAction<Record<string, Conversation>>>;
  dirtyConversationIdsRef: MutableRefObject<Set<string>>;
  // Callbacks
  updateAgentStatus: (
    status: AgentStatus,
    options?: { chatId?: string; source?: AgentStatusSource; log?: boolean },
  ) => void;
  flushCheckpoint: () => void;
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
    checkpointRefs,
    scratchpadRef,
    usageHandlerRef,
    workspaceContextRef,
    abortControllerRef,
    sandboxIdRef,
    setConversations,
    updateAgentStatus,
  } = ctx;

  let accumulated = '';
  let thinkingAccumulated = '';
  const hasSandboxThisRound = Boolean(sandboxIdRef.current);

  const error = await new Promise<Error | null>((resolve) => {
    streamChat(
      apiMessages,
      (token) => {
        if (abortRef.current) return;
        const contentKey = `${round}:${accumulated.length}:${token}`;
        if (processedContentRef.current.has(contentKey)) return;
        processedContentRef.current.add(contentKey);
        accumulated += token;
        checkpointRefs.accumulated.current = accumulated;
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
        checkpointRefs.thinking.current = thinkingAccumulated;
        updateAgentStatus({ active: true, phase: 'Reasoning...' }, { chatId, log: false });
        setConversations((prev) => {
          const conv = prev[chatId];
          if (!conv) return prev;
          const msgs = [...conv.messages];
          const lastIdx = msgs.length - 1;
          if (msgs[lastIdx]?.role === 'assistant') {
            msgs[lastIdx] = { ...msgs[lastIdx], thinking: thinkingAccumulated, status: 'streaming' };
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
    );
  });

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
): Promise<AssistantTurnResult> {
  const {
    chatId,
    lockedProvider,
    resolvedModel,
    abortRef,
    sandboxIdRef,
    ensureSandboxRef,
    scratchpadRef,
    runtimeHandlersRef,
    repoRef,
    isMainProtectedRef,
    branchInfoRef,
    checkpointRefs,
    lastCoderStateRef,
    dirtyConversationIdsRef,
    setConversations,
    updateAgentStatus,
    flushCheckpoint,
    executeDelegateCall,
  } = ctx;

  // --- Check for multiple independent read-only tool calls in one turn ---
  const detected = detectAllToolCalls(accumulated);
  const parallelToolCalls = detected.readOnly;

  if (detected.extraMutations.length > 0) {
    const errorAction = handleMultipleMutationsError(
      detected,
      accumulated,
      thinkingAccumulated,
      apiMessages,
      lockedProvider,
    );

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
  let roundSandboxStatus: { dirty: boolean; files: number } | null = null;
  let roundSandboxStatusFetched = false;

  const getRoundSandboxStatus = async (): Promise<{ dirty: boolean; files: number } | null> => {
    if (roundSandboxStatusFetched) return roundSandboxStatus;
    roundSandboxStatusFetched = true;
    if (!sandboxIdRef.current) return null;
    try {
      const statusResult = await execInSandbox(
        sandboxIdRef.current,
        'cd /workspace && git status --porcelain 2>/dev/null | head -20',
      );
      const lines = statusResult.stdout.trim().split('\n').filter(Boolean);
      roundSandboxStatus = { dirty: lines.length > 0, files: lines.length };
    } catch {
      // Best-effort — don't block tool execution
    }
    return roundSandboxStatus;
  };

  // --- Parallel tool calls (multiple reads + optional trailing mutation) ---
  if (parallelToolCalls.length > 1 || (parallelToolCalls.length > 0 && Boolean(detected.mutating))) {
    console.log(`[Push] Parallel tool calls detected:`, parallelToolCalls);

    setConversations((prev) => {
      const conv = prev[chatId];
      if (!conv) return prev;
      const msgs = markLastAssistantToolCall(conv.messages, {
        content: accumulated,
        thinking: thinkingAccumulated,
      });
      return { ...prev, [chatId]: { ...conv, messages: msgs } };
    });

    updateAgentStatus(
      { active: true, phase: `Executing ${parallelToolCalls.length} tool calls...` },
      { chatId },
    );

    const hasParallelSandboxCalls = parallelToolCalls.some((call) => call.source === 'sandbox');
    if (hasParallelSandboxCalls && !sandboxIdRef.current && ensureSandboxRef.current) {
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

    const parallelRawResults = await executeParallelTools(parallelToolCalls, runCtx);

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
    );
    const toolResultMessages = parallelRawResults.map(
      (r) => buildToolOutcome(r, parallelMetaLine, lockedProvider).resultMessage,
    );

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

    // Execute trailing mutation after the parallel reads
    if (detected.mutating && abortRef.current) {
      return {
        nextApiMessages,
        nextRecoveryState: recoveryState,
        loopAction: 'break',
        loopCompletedNormally: false,
      };
    }

    if (detected.mutating) {
      const mutCall = detected.mutating;
      console.log(`[Push] Trailing mutation after parallel reads:`, mutCall);
      updateAgentStatus({ active: true, phase: getToolStatusLabel(mutCall) }, { chatId });

      if (
        (mutCall.source === 'sandbox' ||
          (mutCall.source === 'delegate' && mutCall.call.tool === 'delegate_coder')) &&
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
        checkpointRefs.phase.current = 'executing_tools';
        lastCoderStateRef.current = null;

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
        mutRawResult = await executeTool(mutCall, mutCtx);
      }

      roundSandboxStatusFetched = false;
      const mutSandboxStatus = await getRoundSandboxStatus();
      const mutMetaLine = buildMetaLine(
        round,
        nextApiMessages,
        lockedProvider,
        resolvedModel,
        mutSandboxStatus,
      );
      const mutOutcome = buildToolOutcome(mutRawResult, mutMetaLine, lockedProvider);

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
    // --- Turn policy: ungrounded-completion guard ---
    // Before accepting as natural completion, check if the Orchestrator
    // claims "done" without artifact evidence (delegation result, diff, PR).
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
    const policyResult = await orchestratorPolicy.evaluateAfterModel(accumulated, apiMessages, turnCtx);
    if (policyResult?.action === 'inject') {
      // Nudge the model — inject corrective message and continue the loop
      const nextApiMessages = [
        ...apiMessages,
        { id: createId(), role: 'assistant' as const, content: accumulated, timestamp: Date.now() },
        policyResult.message,
      ];
      return {
        nextApiMessages,
        nextRecoveryState: recoveryState,
        loopAction: 'continue',
        loopCompletedNormally: false,
      };
    }

    // --- No tool call: recovery check or natural completion ---
    const recoveryResult = resolveToolCallRecovery(accumulated, recoveryState);
    const nextRecoveryState = recoveryResult.nextState;

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

    return {
      nextApiMessages: action.apiMessages,
      nextRecoveryState,
      loopAction: action.loopAction === 'break' ? 'break' : 'continue',
      loopCompletedNormally: action.loopCompletedNormally ?? false,
    };
  }

  // Tool call detected — execute it
  console.log(`[Push] Tool call detected:`, toolCall);

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
  updateAgentStatus({ active: true, phase: statusLabel }, { chatId });

  let toolExecResult: ToolExecutionResult;

  // Lazy auto-spin: create sandbox on demand for sandbox/coder delegate tools
  if (
    (toolCall.source === 'sandbox' ||
      (toolCall.source === 'delegate' && toolCall.call.tool === 'delegate_coder')) &&
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

  if (toolCall.source === 'scratchpad') {
    const sp = scratchpadRef.current;
    if (!sp) {
      toolExecResult = {
        text: '[Tool Error] Scratchpad not available. The scratchpad may not be initialized — try again after the UI loads.',
      };
    } else {
      const result = executeScratchpadToolCall(
        toolCall.call,
        sp.content,
        sp.replace,
        sp.append,
      );
      if (result.ok) {
        if (toolCall.call.tool === 'set_scratchpad') {
          scratchpadRef.current = { ...sp, content: toolCall.call.content };
        } else if (toolCall.call.tool === 'append_scratchpad') {
          const prev = sp.content.trim();
          scratchpadRef.current = {
            ...sp,
            content: prev ? `${prev}\n\n${toolCall.call.content}` : toolCall.call.content,
          };
        }
      }
      toolExecResult = { text: result.text };
    }
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
    checkpointRefs.phase.current = 'executing_tools';
    lastCoderStateRef.current = null;
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

  if (abortRef.current) {
    return {
      nextApiMessages: apiMessages,
      nextRecoveryState: recoveryState,
      loopAction: 'break',
      loopCompletedNormally: false,
    };
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
    runtimeHandlersRef.current?.onBranchSwitch?.(toolExecResult.branchSwitch);
  }

  if (toolExecResult.structuredError?.type === 'SANDBOX_UNREACHABLE') {
    runtimeHandlersRef.current?.onSandboxUnreachable?.(toolExecResult.structuredError.message);
  }

  // Build result message with post-execution sandbox status
  roundSandboxStatusFetched = false;
  const sbStatus = await getRoundSandboxStatus();
  const metaLine = buildMetaLine(round, apiMessages, lockedProvider, resolvedModel, sbStatus);

  let toolResultMsg: ChatMessage;
  let cardsToAttach: ChatCard[];
  if (singleRawResult) {
    const outcome = buildToolOutcome(singleRawResult, metaLine, lockedProvider);
    toolResultMsg = outcome.resultMessage;
    cardsToAttach = outcome.cards;
  } else {
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
        isError: toolExecResult.text.includes('[Tool Error]'),
      }),
    });
    cardsToAttach =
      toolExecResult.card && toolExecResult.card.type !== 'sandbox-state'
        ? [toolExecResult.card]
        : [];
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

  return {
    nextApiMessages,
    nextRecoveryState: recoveryState,
    loopAction: 'continue',
    loopCompletedNormally: false,
  };
}
