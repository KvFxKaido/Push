/**
 * chat-send.ts
 *
 * Phase 4 round helpers extracted from useChat.ts sendMessage. Phase 1
 * (2026-05-01) split out the streaming wrapper, types, and pure helpers.
 * Phase 2 (this file's current shape) split `processAssistantTurn` along
 * its three internal phases:
 *
 *   chat-send-types.ts          — SendLoopContext, StreamRoundResult,
 *                                 AssistantTurnResult, handler interfaces
 *   chat-send-helpers.ts        — pure helpers + TurnRunContext factory
 *   chat-stream-round.ts        — streamAssistantRound (LLM streaming + UI)
 *   chat-batched-execution.ts   — reads ‖ file-mutation-batch ≫ trailing branch
 *   chat-no-tool-path.ts        — recovery diagnosis + ungrounded-completion guard
 *   chat-single-tool-execution.ts — single tool-call dispatch + side effects
 *
 * sendMessage stays as the loop orchestrator (round counter, abort checks,
 * tab lock, finally block). `processAssistantTurn` here is now a router:
 * detect tool calls, run the circuit breaker, handle the multiple-mutations
 * malformed case, then dispatch to one of the three branch handlers.
 *
 * Re-exports from the sibling modules below preserve the public import
 * surface for `useChat.ts`, `chat-round-loop.ts`, tests, and
 * `branch-fork-migration.ts`.
 */

import { detectAllToolCalls, detectAnyToolCall } from '@/lib/tool-dispatch';
import { getToolName, markLastAssistantToolCall } from '@/lib/chat-tool-messages';
import { summarizeToolResultPreview } from '@/lib/chat-run-events';
import { handleMultipleMutationsError } from '@/lib/chat-tool-execution';
import type { ToolCallRecoveryState } from '@/lib/tool-call-recovery';
import { getToolInvocationKey, type MutationFailureTracker } from '@push/lib/agent-loop-utils';
import type { ChatMessage } from '@/types';
import { createTurnRunContext } from './chat-send-helpers';
import type { AssistantTurnResult, SendLoopContext } from './chat-send-types';
import { executeBatchedToolCalls } from './chat-batched-execution';
import { processNoToolPath } from './chat-no-tool-path';
import { executeSingleToolCall } from './chat-single-tool-execution';

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
// processAssistantTurn — router across the three branch handlers
// ---------------------------------------------------------------------------

/**
 * Decide what to do with the accumulated LLM response:
 *   - Multiple mutation error  → inject error message, continue loop
 *   - Parallel + batched tool calls → executeBatchedToolCalls
 *   - No tool call             → processNoToolPath (recovery / completion guard)
 *   - Single tool call         → executeSingleToolCall
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
  const { chatId, lockedProvider, setConversations, appendRunEvent } = ctx;

  // --- Detect all tool calls in one pass ---
  const detected = detectAllToolCalls(accumulated);
  const parallelToolCalls = detected.readOnly;

  // --- Circuit breaker: short-circuit if any incoming call has already
  // failed repeatedly with identical arguments. We only record failures
  // after execution, so legitimate repeated operations (re-reading a file,
  // incremental edits) are not affected.
  const MAX_REPEATED_TOOL_CALLS = 3;
  const allIncomingCalls = [
    ...detected.readOnly,
    ...detected.fileMutations,
    ...(detected.mutating ? [detected.mutating] : []),
  ];

  for (const call of allIncomingCalls) {
    // Some AnyToolCall variants (scratchpad, todo) carry their payload
    // inline rather than under `args`. Pass the whole `call` so the key
    // is well-defined for every variant.
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

  // --- Multiple-mutations error: model emitted >1 mutating call in one turn.
  // Surface a structured error to the assistant and continue without execution.
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

  // --- Set up the per-turn run context shared by the three branch handlers.
  // Owns the sandbox-status cache, the post-tool policy drainer, and the
  // circuit-breaker tool-failure recorder.
  const turnCtx = createTurnRunContext(ctx, recoveryState, tracker);

  // --- Branch dispatch ---
  const fileMutationBatch = detected.fileMutations;
  const totalBatchedCalls =
    parallelToolCalls.length + fileMutationBatch.length + (detected.mutating ? 1 : 0);
  if (totalBatchedCalls > 1) {
    return executeBatchedToolCalls(
      detected,
      round,
      accumulated,
      thinkingAccumulated,
      apiMessages,
      ctx,
      recoveryState,
      turnCtx,
    );
  }

  const toolCall = detectAnyToolCall(accumulated);
  if (!toolCall) {
    return processNoToolPath(
      round,
      accumulated,
      thinkingAccumulated,
      apiMessages,
      ctx,
      recoveryState,
    );
  }

  return executeSingleToolCall(
    toolCall,
    round,
    accumulated,
    thinkingAccumulated,
    apiMessages,
    ctx,
    recoveryState,
    turnCtx,
  );
}
