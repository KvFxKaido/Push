/**
 * chat-single-tool-execution.ts
 *
 * The single-tool branch of `processAssistantTurn`. Phase 2 of the
 * chat-send split: when the model emits exactly one tool call in a turn,
 * this module owns:
 *
 *   1. Pre-dispatch verification gate for commit-class tools
 *      (`sandbox_prepare_commit`, `sandbox_push`).
 *   2. Lazy sandbox auto-spin for sandbox + sandbox-needing delegate calls.
 *   3. Source-keyed dispatch:
 *        - scratchpad/todo → executeChatHookToolCall (local React state)
 *        - delegate        → executeDelegateCall (Coder/Explorer/task graph)
 *        - default         → executeTool (sandbox runtime)
 *   4. Post-execution side effects: workspace mutation tracking,
 *      verification command/artifact recording, repo promotion, branch-
 *      switch payload migration, sandbox-unreachable propagation.
 *   5. Result message construction with post-execution sandbox status.
 *
 * Receives a `TurnRunContext` for shared per-turn state with the other
 * branches (sandbox-status cache, post-tool policy drainer, circuit-
 * breaker tool-failure recorder).
 */

import {
  executeTool,
  buildMetaLine,
  buildToolOutcome,
  type ToolExecRunContext,
  type ToolExecRawResult,
} from '@/lib/chat-tool-execution';
import {
  appendCardsToLatestToolCall,
  buildToolMeta,
  buildToolResultMessage,
  getToolName,
  getToolStatusLabel,
  getToolStatusDetail,
  markLastAssistantToolCall,
} from '@/lib/chat-tool-messages';
import { summarizeToolResultPreview } from '@/lib/chat-run-events';
import { isReadOnlyToolCall, type AnyToolCall } from '@/lib/tool-dispatch';
import {
  evaluateVerificationState,
  formatVerificationBlock,
  recordVerificationArtifact,
  recordVerificationCommandResult,
  recordVerificationMutation,
} from '@/lib/verification-runtime';
import { applyBranchSwitchPayload } from '@/lib/branch-fork-migration';
import { createId } from '@push/lib/id-utils';
import type { ToolCallRecoveryState } from '@/lib/tool-call-recovery';
import type { ChatCard, ChatMessage, ToolExecutionResult } from '@/types';
import {
  delegateCallNeedsSandbox,
  executeChatHookToolCall,
  getDelegateCompletionAgent,
  inferVerificationCommandResult,
  shouldEmitPeriodicPulse,
  type TurnRunContext,
} from './chat-send-helpers';
import type { AssistantTurnResult, SendLoopContext } from './chat-send-types';

export async function executeSingleToolCall(
  toolCall: AnyToolCall,
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
  const {
    applyPostToolPolicyEffects,
    recordToolFailure,
    getRoundSandboxStatus,
    invalidateSandboxStatus,
  } = turnCtx;

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
  invalidateSandboxStatus();
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
