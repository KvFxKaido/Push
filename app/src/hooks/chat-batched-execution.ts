/**
 * chat-batched-execution.ts
 *
 * The batched-tool-execution branch of `processAssistantTurn`. Phase 2 of
 * the chat-send split: when the model emits more than one tool call in a
 * single turn, this module owns the
 *
 *   reads ‖ file-mutation batch ≫ optional trailing side-effect
 *
 * three-stage execution shape. Reads run concurrently, file mutations run
 * sequentially with first-error short-circuit, then a single trailing
 * non-file mutation (if any) runs against post-mutation sandbox state.
 *
 * The branch handler receives a `TurnRunContext` (created once at the top
 * of `processAssistantTurn`) so the per-round sandbox-status cache, the
 * post-tool policy drainer, and the circuit-breaker tool-failure recorder
 * are shared with the other two branches without duplicate closure setup.
 */

import {
  executeTool,
  buildToolOutcome,
  buildMetaLine,
  type ToolExecRunContext,
  type ToolExecRawResult,
} from '@/lib/chat-tool-execution';
import {
  appendCardsToLatestToolCall,
  getToolName,
  getToolStatusLabel,
  getToolStatusDetail,
  markLastAssistantToolCall,
} from '@/lib/chat-tool-messages';
import { summarizeToolResultPreview } from '@/lib/chat-run-events';
import { createId } from '@push/lib/id-utils';
import type { DetectedToolCalls } from '@/lib/tool-dispatch';
import type { ToolCallRecoveryState } from '@/lib/tool-call-recovery';
import type { ChatMessage } from '@/types';
import {
  applyPostExecutionSideEffects,
  delegateCallNeedsSandbox,
  executeToolWithChatHooks,
  getDelegateCompletionAgent,
  shouldEmitPeriodicPulse,
  type TurnRunContext,
} from './chat-send-helpers';
import type { AssistantTurnResult, SendLoopContext } from './chat-send-types';

export async function executeBatchedToolCalls(
  detected: DetectedToolCalls,
  round: number,
  accumulated: string,
  thinkingAccumulated: string,
  apiMessages: ChatMessage[],
  ctx: SendLoopContext,
  recoveryState: ToolCallRecoveryState,
  turnCtx: TurnRunContext,
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
    executeDelegateCall,
  } = ctx;
  const {
    applyPostToolPolicyEffects,
    recordToolFailure,
    getRoundSandboxStatus,
    invalidateSandboxStatus,
  } = turnCtx;

  const parallelToolCalls = detected.readOnly;
  const fileMutationBatch = detected.fileMutations;

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
    chatId,
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

  // Per-tool side effects for each parallel read result. This is the seam
  // that previously dropped verification command updates emitted by
  // `sandbox_check_types` / `sandbox_run_tests` inside a batched turn —
  // those are read-only and land in the parallel slot, but the
  // pre-extraction code only handled `onSandboxUnreachable` here.
  parallelRawResults.forEach((result) => {
    applyPostExecutionSideEffects(result.call, result.raw, ctx);
  });

  const allCards = parallelRawResults.flatMap((r) => r.cards);
  if (allCards.length > 0) {
    setConversations((prev) => {
      const conv = prev[chatId];
      if (!conv) return prev;
      const msgs = appendCardsToLatestToolCall(conv.messages, allCards);
      return { ...prev, [chatId]: { ...conv, messages: msgs } };
    });
  }

  invalidateSandboxStatus(); // tools may have changed sandbox
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
      chatId,
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

      invalidateSandboxStatus();
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

      // Per-tool side effects for this file mutation. File mutations
      // (`edit_file`, `write_file`, `apply_patchset`, etc.) typically only
      // trigger #1 (touched-files verification mutation) and #7
      // (sandbox-unreachable propagation) inside the helper; the remaining
      // checks no-op for this slot.
      applyPostExecutionSideEffects(batchCall, batchOutcome.raw, ctx);

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
  // Abort check is unconditional: an aborted turn must `break` regardless
  // of whether a trailing mutation was queued (pre-extraction code gated
  // this on `detected.mutating`, which let an abort-without-mutation case
  // fall through to `continue` instead of breaking — flagged in PR #467
  // review).
  if (abortRef.current) {
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
        chatId,
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

    invalidateSandboxStatus();
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

    // Per-tool side effects for the trailing mutation. This is the slot
    // where `branchSwitch` (sandbox_create_branch / sandbox_switch_branch)
    // and `promotion` (promote_to_github) realistically appear in a
    // batched turn — pre-extraction those payloads were dropped here.
    applyPostExecutionSideEffects(mutCall, mutOutcome.raw, ctx);

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
