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
import { markLastAssistantToolCall } from '@/lib/chat-tool-messages';
import { summarizeToolResultPreview } from '@/lib/chat-run-events';
import { handleMultipleMutationsError } from '@/lib/chat-tool-execution';
import type { ToolCallRecoveryState } from '@/lib/tool-call-recovery';
import { type MutationFailureTracker } from '@push/lib/agent-loop-utils';
import {
  createSimilarityLoopDetector,
  type SimilarityLoopDetector,
} from '@push/lib/loop-detection';
import type { ChatMessage, ReasoningBlock } from '@/types';
import {
  createLoopLadderState,
  createTurnRunContext,
  dispatchDroppedCandidatesError,
  handleLoopVerdict,
  recordGithubToolTurnUsage,
  type LoopLadderState,
} from './chat-send-helpers';
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
} from './chat-send-types';

export { streamAssistantRound } from './chat-stream-round';

// Re-export the loop-ladder run-state helpers through this module so consumers
// (chat-round-loop.ts) import them across the same boundary as
// `processAssistantTurn`. Importing them directly from './chat-send-helpers'
// would pull the real module past test mocks of './chat-send' and load its
// heavy `tool-dispatch` → `web-search-tools` transitive graph.
export { createLoopLadderState } from './chat-send-helpers';
export type { LoopLadderState } from './chat-send-helpers';

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
  reasoningBlocks: ReasoningBlock[],
  apiMessages: ChatMessage[],
  ctx: SendLoopContext,
  recoveryState: ToolCallRecoveryState,
  tracker: MutationFailureTracker = {
    recordFailure: () => {},
    isRepeatedFailure: () => false,
    recordCall: () => {},
    isRepeatedCall: () => false,
    recordDelegationOutcome: () => {},
    isRepeatedDelegationFailure: () => false,
    clear: () => {},
  },
  loopDetector: SimilarityLoopDetector = createSimilarityLoopDetector(),
  loopLadder: LoopLadderState = createLoopLadderState(),
): Promise<AssistantTurnResult> {
  const { chatId, lockedProvider, setConversations, appendRunEvent } = ctx;

  // --- Detect all tool calls in one pass ---
  const detected = detectAllToolCalls(accumulated);
  const parallelToolCalls = detected.readOnly;

  // Measurement pass for the schema-deferral decision: record whether this
  // protocol-paying turn actually called a GitHub tool. See the helper.
  recordGithubToolTurnUsage(detected, ctx, round);

  // --- Circuit breaker: evaluate the per-turn loop verdict (exact-match
  // breakers + graded near-duplicate ladder). `handleLoopVerdict` returns a
  // turn result when the loop fires (abort → break; warn/block/compact →
  // inject steering + skip the batch), else null to proceed. See
  // `checkLoopBreaker` for the trip rules.
  const loopResult = handleLoopVerdict(
    detected,
    tracker,
    loopDetector,
    loopLadder,
    round,
    accumulated,
    thinkingAccumulated,
    reasoningBlocks,
    apiMessages,
    recoveryState,
    ctx,
  );
  if (loopResult) return loopResult;

  // --- Dropped-candidate error: model emitted one or more `{tool, args}`-
  // shaped calls that failed source validation. Runs before the extra-
  // mutation check so a malformed primary call surfaces with the right
  // reason. See `dispatchDroppedCandidatesError` for state-update details.
  if (detected.droppedCandidates.length > 0) {
    return dispatchDroppedCandidatesError(
      detected,
      round,
      accumulated,
      thinkingAccumulated,
      reasoningBlocks,
      apiMessages,
      recoveryState,
      ctx,
    );
  }

  // --- Mutation-transaction violation: file-mutation batch overflow OR
  // ordering violation (or both). Pre-PR #680 kernel split, batch overflow
  // was lumped into extraMutations; post-split, web has to check both
  // lists or batch overflow (e.g. 9+ file mutations in one turn) would
  // silently drop the overflow without surfacing a model-facing error.
  if (detected.batchOverflow.length > 0 || detected.extraMutations.length > 0) {
    const errorAction = handleMultipleMutationsError(
      detected,
      accumulated,
      thinkingAccumulated,
      reasoningBlocks,
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
      reasoningBlocks,
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
      reasoningBlocks,
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
    reasoningBlocks,
    apiMessages,
    ctx,
    recoveryState,
    turnCtx,
  );
}
