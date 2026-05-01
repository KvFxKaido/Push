/**
 * chat-send.ts
 *
 * Phase 4 round helpers extracted from useChat.ts sendMessage. The dispatcher
 * `processAssistantTurn` lives here; siblings carry the support code:
 *
 *   chat-send-types.ts    — SendLoopContext, StreamRoundResult, AssistantTurnResult
 *                           and the four handler interfaces (Scratchpad/Todo/Usage/Runtime)
 *   chat-send-helpers.ts  — pure helpers: pulse, delegate predicates, chat-hook
 *                           executor, status-line parser, verification-command
 *                           inference, post-tool policy collector
 *   chat-stream-round.ts  — streamAssistantRound (LLM streaming + UI accumulation)
 *
 * sendMessage stays as the loop orchestrator (round counter, abort checks, tab
 * lock, finally block). `processAssistantTurn` handles post-stream work:
 * tool detection, dispatch, recovery, batched + single-call execution paths.
 *
 * Re-exports from the sibling modules below preserve the public import surface
 * for `useChat.ts`, `chat-round-loop.ts`, tests, and `branch-fork-migration.ts`,
 * which all import from this module.
 */

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
import { resolveToolCallRecovery, type ToolCallRecoveryState } from '@/lib/tool-call-recovery';
import { createId } from '@push/lib/id-utils';
import { applyBranchSwitchPayload } from '@/lib/branch-fork-migration';
import { TurnPolicyRegistry, type TurnContext } from '@/lib/turn-policy';
import {
  createOrchestratorPolicy,
  responseClaimsCompletion,
} from '@/lib/turn-policies/orchestrator-policy';
import {
  evaluateVerificationState,
  formatVerificationBlock,
  recordVerificationArtifact,
  recordVerificationCommandResult,
  recordVerificationMutation,
} from '@/lib/verification-runtime';
import type { ChatCard, ChatMessage, ToolExecutionResult } from '@/types';
import {
  shouldEmitPeriodicPulse,
  delegateCallNeedsSandbox,
  getDelegateCompletionAgent,
  executeChatHookToolCall,
  executeToolWithChatHooks,
  extractChangedPathFromStatusLine,
  inferVerificationCommandResult,
  collectPostToolPolicyEffects,
} from './chat-send-helpers';
import type { AssistantTurnResult, SendLoopContext } from './chat-send-types';

// ---------------------------------------------------------------------------
// Re-exports — preserve the public import surface so consumers
// (useChat.ts, chat-round-loop.ts, tests, branch-fork-migration.ts) keep
// importing from './chat-send' without churn.
// ---------------------------------------------------------------------------

export type {
  AssistantTurnResult,
  ChatRuntimeHandlers,
  ScratchpadHandlers,
  SendLoopContext,
  StreamRoundResult,
  TodoHandlers,
  UsageHandler,
} from './chat-send-types';

export { streamAssistantRound } from './chat-stream-round';

// ---------------------------------------------------------------------------
// processAssistantTurn — post-stream decision and dispatch
// ---------------------------------------------------------------------------

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
