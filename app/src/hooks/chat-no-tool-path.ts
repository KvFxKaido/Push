/**
 * chat-no-tool-path.ts
 *
 * The no-tool branch of `processAssistantTurn`. Phase 2 of the chat-send
 * split: when the LLM emits an assistant turn with no recognizable tool
 * call, this module owns:
 *
 *   1. Recovery diagnosis (`resolveToolCallRecovery`) — was this a malformed
 *      tool attempt, an unimplemented tool, or a genuine natural-completion?
 *   2. Conversation state finalization (mark malformed, append corrective
 *      message, drop streaming spinner).
 *   3. Ungrounded-completion guard — if recovery says break, but the model
 *      claimed completion without verification grounding, evaluate the
 *      verification state and inject a corrective user message instead of
 *      ending the loop.
 *   4. Turn-policy registry — if the response claims completion but the
 *      orchestrator policy wants to nudge instead of accept, inject the
 *      policy's correction message and continue.
 *
 * No tools execute on this branch, so it doesn't need the `TurnRunContext`
 * helpers (sandbox-status cache, post-tool policy drainer, tool-failure
 * recorder) — only `ctx` and the loop's recovery state.
 */

import { resolveToolCallRecovery, type ToolCallRecoveryState } from '@/lib/tool-call-recovery';
import { summarizeToolResultPreview } from '@/lib/chat-run-events';
import { markLastAssistantToolCall } from '@/lib/chat-tool-messages';
import { handleRecoveryResult } from '@/lib/chat-tool-execution';
import {
  createOrchestratorPolicy,
  hasArtifactInResponse,
  hasGroundingEvidence,
  responseClaimsCompletion,
} from '@/lib/turn-policies/orchestrator-policy';
import { TurnPolicyRegistry, type TurnContext } from '@/lib/turn-policy';
import { evaluateVerificationState, formatVerificationBlock } from '@/lib/verification-runtime';
import { createId } from '@push/lib/id-utils';
import type { ChatMessage } from '@/types';
import type { AssistantTurnResult, SendLoopContext } from './chat-send-types';

export async function processNoToolPath(
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
    sandboxIdRef,
    repoRef,
    setConversations,
    dirtyConversationIdsRef,
    appendRunEvent,
    getVerificationState,
  } = ctx;

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
  //
  // Skip when the response cites concrete artifacts or recent messages
  // already include tool-result grounding — matches the orchestrator-policy
  // gate so read-only summarization turns (e.g. "what changed?" answered
  // from git log) don't loop on a still-pending verification rule.
  if (
    action.loopAction === 'break' &&
    responseClaimsCompletion(accumulated) &&
    !hasArtifactInResponse(accumulated) &&
    !hasGroundingEvidence(action.apiMessages)
  ) {
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
