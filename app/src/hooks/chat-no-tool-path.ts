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

import {
  MAX_REASONING_TOOL_CALL_NUDGES,
  MAX_TRAILING_INTENT_NUDGES,
  createReasoningToolCallIntervention,
  resolveToolCallRecovery,
  type ToolCallRecoveryState,
} from '@/lib/tool-call-recovery';
import { detectAnyToolCall } from '@/lib/tool-dispatch';
import { summarizeToolResultPreview } from '@/lib/chat-run-events';
import { markLastAssistantToolCall } from '@/lib/chat-tool-messages';
import { handleRecoveryResult } from '@/lib/chat-tool-execution';
import {
  ANNOUNCED_NO_ACTION_POLICY_MARKER,
  createOrchestratorPolicy,
  detectTrailingActionIntent,
  hasArtifactInResponse,
  hasGroundingEvidence,
  responseClaimsCompletion,
} from '@/lib/turn-policies/orchestrator-policy';
import { TurnPolicyRegistry, type TurnContext } from '@/lib/turn-policy';
import { evaluateVerificationState, formatVerificationBlock } from '@/lib/verification-runtime';
import { createId } from '@push/lib/id-utils';
import { resolveMessageWriteBranch, stampMessageBranch } from '@/lib/chat-message';
import type { ChatMessage, ReasoningBlock } from '@/types';
import type { ResponsesReasoningItem } from '@push/lib/provider-contract';
import type { AssistantTurnResult, SendLoopContext } from './chat-send-types';

export async function processNoToolPath(
  round: number,
  accumulated: string,
  thinkingAccumulated: string,
  reasoningBlocks: ReasoningBlock[],
  apiMessages: ChatMessage[],
  ctx: SendLoopContext,
  recoveryState: ToolCallRecoveryState,
  responsesReasoningItems: ResponsesReasoningItem[] = [],
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
  const currentWriteBranch = resolveMessageWriteBranch(
    ctx.branchInfoRef.current,
    ctx.conversationsRef.current[chatId]?.branch,
  );

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
    reasoningBlocks,
    apiMessages,
    lockedProvider,
    resolvedModel,
    currentWriteBranch,
    responsesReasoningItems,
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

  // --- Tool call buried in the reasoning channel ---
  // Some models — most reliably the Kimi K2.x family — emit their
  // `{"tool": ...}` / namespaced `functions.x:0 {...}` tool calls inside the
  // reasoning/thinking channel instead of response content. The dispatcher
  // only scans content (the orchestrator forwards `content` tokens to the
  // parser, never reasoning), so the call is silently dropped, no tool runs,
  // and the turn dead-ends as a "natural completion" — the model then narrates
  // an answer it never actually gathered (the stale/hallucinated "recent
  // activity" symptom). The prompt's "Tool Call Placement" section asks
  // cooperating models not to do this; this is the runtime backstop for models
  // that ignore it. We never execute the reasoning-channel call (that channel
  // is untrusted for dispatch) — we surface the drop and nudge the model to
  // re-emit in content, capped so a model that keeps burying calls still breaks.
  const reasoningNudges = nextRecoveryState.reasoningToolCallNudges ?? 0;
  const buriedCall =
    action.loopAction === 'break' &&
    recoveryResult.kind === 'none' &&
    reasoningNudges < MAX_REASONING_TOOL_CALL_NUDGES &&
    thinkingAccumulated.trim().length > 0 &&
    !detectAnyToolCall(accumulated)
      ? detectAnyToolCall(thinkingAccumulated)
      : null;
  if (buriedCall) {
    const buriedToolName = buriedCall.call.tool;
    const reasoningIntervention = createReasoningToolCallIntervention(buriedToolName);
    // Structured log: the symptom is otherwise invisible to ops — no tool ran,
    // no malformed event fired, the turn just ended. Pair with the run event
    // below so both the operator and the transcript see the dropped call.
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'orchestrator_tool_call_in_reasoning',
        chatId,
        round,
        toolName: buriedToolName,
      }),
    );
    appendRunEvent(chatId, {
      type: 'tool.call_malformed',
      round,
      reason: 'tool_call_in_reasoning',
      toolName: buriedToolName,
      preview: summarizeToolResultPreview(
        'A tool call was emitted in the reasoning channel, which the runtime never executes. The model was nudged to re-emit it in response content.',
      ),
    });
    // Finalize the assistant message so it doesn't linger with a streaming
    // spinner while the loop continues.
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
          content: reasoningIntervention.guidance ?? reasoningIntervention.message ?? '',
          timestamp: Date.now(),
          ...(currentWriteBranch !== undefined ? { branch: currentWriteBranch } : {}),
        },
      ],
      nextRecoveryState: { ...nextRecoveryState, reasoningToolCallNudges: reasoningNudges + 1 },
      loopAction: 'continue',
      loopCompletedNormally: false,
    };
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
            ...(currentWriteBranch !== undefined ? { branch: currentWriteBranch } : {}),
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
      const nextApiMessages = [
        ...action.apiMessages,
        stampMessageBranch(policyResult.message, currentWriteBranch),
      ];
      return {
        nextApiMessages,
        nextRecoveryState,
        loopAction: 'continue',
        loopCompletedNormally: false,
      };
    }
  }

  // --- Turn policy: announced-action-without-tool-call guard ---
  // The model ended its turn by announcing an imminent action ("Let's read
  // README.md", "I'll search the docs") but emitted no tool call, so recovery
  // found nothing to retry and the loop would dead-end with the work undone.
  // Nudge it to actually emit the call (or conclude) and continue, instead of
  // breaking. This stays out of the parser entirely — we never synthesize a
  // call or guess args from prose; we just re-prompt. Capped to avoid an
  // unbounded nudge loop. Mutually exclusive with the ungrounded-completion
  // guard above via the `!responseClaimsCompletion` check.
  const trailingIntentNudges = nextRecoveryState.trailingIntentNudges ?? 0;
  const trailingIntentDetected =
    action.loopAction === 'break' &&
    !responseClaimsCompletion(accumulated) &&
    detectTrailingActionIntent(accumulated);

  if (trailingIntentDetected && trailingIntentNudges >= MAX_TRAILING_INTENT_NUDGES) {
    // Symmetric structured log — the cap-hit branch, greppable against
    // orchestrator_trailing_intent_nudged below. Without this, a dead-ended
    // turn (model announces an action, never emits it, nudge budget spent)
    // is indistinguishable in the logs from any other normal loop break.
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'orchestrator_trailing_intent_cap_exhausted',
        chatId,
        round,
        maxNudges: MAX_TRAILING_INTENT_NUDGES,
      }),
    );
  }

  if (trailingIntentDetected && trailingIntentNudges < MAX_TRAILING_INTENT_NUDGES) {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'orchestrator_trailing_intent_nudged',
        chatId,
        round,
        nudgeCount: trailingIntentNudges + 1,
      }),
    );
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
          content: [
            ANNOUNCED_NO_ACTION_POLICY_MARKER,
            'You described an action you were about to take (e.g. reading or searching a file) but did not emit a tool call, so nothing actually happened.',
            'If you intended to act, emit the tool-call JSON now. If you are actually finished, state your conclusion directly without describing further steps.',
            '[/POLICY]',
          ].join('\n'),
          timestamp: Date.now(),
          ...(currentWriteBranch !== undefined ? { branch: currentWriteBranch } : {}),
        },
      ],
      nextRecoveryState: { ...nextRecoveryState, trailingIntentNudges: trailingIntentNudges + 1 },
      loopAction: 'continue',
      loopCompletedNormally: false,
    };
  }

  return {
    nextApiMessages: action.apiMessages,
    nextRecoveryState,
    loopAction: action.loopAction === 'break' ? 'break' : 'continue',
    loopCompletedNormally: action.loopCompletedNormally ?? false,
  };
}
