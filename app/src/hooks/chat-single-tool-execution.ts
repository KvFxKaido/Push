/**
 * chat-single-tool-execution.ts
 *
 * The single-tool branch of `processAssistantTurn`. Phase 2 of the
 * chat-send split: when the model emits exactly one tool call in a turn,
 * this module owns:
 *
 *   1. Pre-dispatch verification gate for delivery tools
 *      (`prepare_push`, `sandbox_push`).
 *   2. Lazy sandbox auto-spin for sandbox + sandbox-needing delegate calls.
 *   3. Source-keyed dispatch:
 *        - scratchpad/todo → executeChatHookToolCall (local React state)
 *        - delegate        → executeDelegateCall (Coder/Explorer/task graph)
 *        - default         → executeTool (sandbox runtime)
 *   4. Post-execution side effects: workspace mutation tracking,
 *      verification command/artifact recording, repo promotion, branch-
 *      switch state update, sandbox-unreachable propagation.
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
import { EXEC_PROGRESS_TAIL_TOOLS, createExecProgressTail } from '@/lib/exec-progress';
import { isReadOnlyToolCall, type AnyToolCall } from '@/lib/tool-dispatch';
import { evaluateVerificationState, formatVerificationBlock } from '@/lib/verification-runtime';
import { createId } from '@push/lib/id-utils';
import { startElapsedMs } from '@push/lib/monotonic-elapsed';
import {
  buildToolResultBlock,
  buildToolUseBlock,
  createToolUseBlockId,
} from '@push/lib/tool-blocks';
import { workspaceModeToExecutionMode } from '@push/lib/capabilities';
import { requestApproval } from '@/lib/approval-bridge';
import { clearRuntimeCoderWorkingMemory } from '@push/lib/runtime-context';
import { composeToolResultBody } from '@/lib/tool-call-recovery';
import type { ToolCallRecoveryState } from '@/lib/tool-call-recovery';
import type { ChatCard, ChatMessage, ReasoningBlock, ToolExecutionResult } from '@/types';
import {
  applyPostExecutionSideEffects,
  delegateCallNeedsSandbox,
  executeChatHookToolCall,
  getCurrentWriteBranch,
  getDelegateCompletionAgent,
  shouldEmitPeriodicPulse,
  type TurnRunContext,
} from './chat-send-helpers';
import type { AssistantTurnResult, SendLoopContext } from './chat-send-types';

export async function executeSingleToolCall(
  toolCall: AnyToolCall,
  round: number,
  accumulated: string,
  thinkingAccumulated: string,
  reasoningBlocks: ReasoningBlock[],
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
    abortControllerRef,
    sandboxIdRef,
    ensureSandboxRef,
    localDaemonBindingRef,
    workspaceContextRef,
    scratchpadRef,
    todoRef,
    repoRef,
    isMainProtectedRef,
    branchInfoRef,
    checkpointRefs,
    dirtyConversationIdsRef,
    setConversations,
    updateAgentStatus,
    appendRunEvent,
    emitRunEngineEvent,
    flushCheckpoint,
    getVerificationState,
    executeDelegateCall,
  } = ctx;

  // Resolve the named execution mode once at the round-loop seam from
  // `workspaceContext.mode` — same input the prompt builder reads. See
  // the matching comment in `chat-batched-execution.ts`.
  const executionMode = workspaceModeToExecutionMode(workspaceContextRef.current?.mode);
  const {
    applyPostToolPolicyEffects,
    recordToolFailure,
    recordDelegationOutcome,
    getRoundSandboxStatus,
    invalidateSandboxStatus,
  } = turnCtx;
  const currentWriteBranch = getCurrentWriteBranch(ctx);

  console.log(`[Push] Tool call detected:`, toolCall);
  const executionId = createId();
  const toolUseId = createToolUseBlockId(executionId);
  const toolUseBlock = buildToolUseBlock({
    id: toolUseId,
    name: toolCall.call.tool,
    input: 'args' in toolCall.call ? toolCall.call.args : undefined,
    // Round-trips Gemini's `thoughtSignature` (native calls only) so the next
    // turn's replay carries it — Gemini 3.x 400s without it.
    thoughtSignature: toolCall.thoughtSignature,
  });

  setConversations((prev) => {
    const conv = prev[chatId];
    if (!conv) return prev;
    const msgs = markLastAssistantToolCall(conv.messages, {
      content: accumulated,
      thinking: thinkingAccumulated,
    });
    return { ...prev, [chatId]: { ...conv, messages: msgs } };
  });

  // `toolExecStart` is a wall-clock timestamp for the `startedAt` fields below;
  // the DURATION is measured monotonically (Date.now can step backward).
  const toolExecStart = Date.now();
  const toolExecElapsed = startElapsedMs();
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
  // Gate-at-Push Move A: the verification preflight is a "don't ship untested
  // code" check, so it gates the delivery tools (prepare_push / sandbox_push),
  // not the now-silent local commit (sandbox_commit).
  const isCommitVerificationTool =
    toolCall.source === 'sandbox' &&
    (toolCall.call.tool === 'prepare_push' || toolCall.call.tool === 'sandbox_push');

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
  // Daemon-bound sessions skip this entirely — their binding is the transport.
  if (
    !toolExecResult &&
    (toolCall.source === 'sandbox' || delegateCallNeedsSandbox(toolCall)) &&
    !sandboxIdRef.current &&
    !localDaemonBindingRef.current
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
    toolExecDurationMs = toolExecElapsed();
  } else if (toolCall.source === 'delegate') {
    toolExecResult = await executeDelegateCall(
      chatId,
      toolCall,
      apiMessages,
      lockedProvider,
      resolvedModel || undefined,
    );
    toolExecDurationMs = toolExecElapsed();
    clearRuntimeCoderWorkingMemory(ctx.runtimeContext);
    emitRunEngineEvent({
      type: 'DELEGATION_COMPLETED',
      timestamp: Date.now(),
      agent: getDelegateCompletionAgent(toolCall),
    });
  } else {
    // Live tail for the cloud detached-exec path: stream the latest output
    // line into the status bar's `detail` slot (phase + startedAt stay put so
    // the elapsed timer keeps ticking). Daemon execs ignore the observer.
    const execProgressTail =
      toolCall.source === 'sandbox' && EXEC_PROGRESS_TAIL_TOOLS.has(toolCall.call.tool)
        ? createExecProgressTail({
            onTail: (line) => {
              // A cancel mid-drain must not resurrect the running status —
              // the runner still drains the log tail after an abort.
              if (abortRef.current) return;
              updateAgentStatus(
                { active: true, phase: statusLabel, detail: line, startedAt: toolExecStart },
                // log:false — tails are transient display state. Logging them
                // would churn the 200-entry agent-event log at throttle rate
                // AND persist attacker-controlled command output into
                // conversation state / console copy.
                { chatId, log: false },
              );
            },
          })
        : undefined;
    const singleCtx: ToolExecRunContext = {
      repoFullName: repoRef.current,
      chatId,
      sandboxId: sandboxIdRef.current,
      role: 'orchestrator',
      localDaemonBinding: localDaemonBindingRef.current ?? undefined,
      executionMode,
      isMainProtected: isMainProtectedRef.current,
      currentBranch: branchInfoRef.current?.currentBranch,
      defaultBranch: branchInfoRef.current?.defaultBranch,
      provider: lockedProvider,
      model: resolvedModel,
      abortSignal: abortControllerRef.current?.signal,
      onExecProgress: execProgressTail,
      // Runtime-driven approval: a policy gate that returns 'ask_user' suspends
      // here on the card's decision instead of bouncing to the model.
      approvalCallback: (request) =>
        requestApproval(chatId, request, abortControllerRef.current?.signal),
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

  // Per-tool side effects (verification mutation/command/artifact tracking,
  // repo promotion, branch-switch state update, sandbox unreachable).
  // Shared with the batched branch — see chat-send-helpers.ts.
  await applyPostExecutionSideEffects(toolCall, toolExecResult, ctx);

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
    const outcome = buildToolOutcome(singleRawResult, metaLine, lockedProvider, {
      toolUseId,
      currentBranch: currentWriteBranch,
    });
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
      target: getToolStatusDetail(toolCall),
      ...(outcome.raw.branch ? { branch: outcome.raw.branch } : {}),
    });
  } else {
    const isError = toolExecResult.text.includes('[Tool Error]');
    recordToolFailure(toolCall, isError);
    // Delegations carry a structured outcome (`complete | incomplete |
    // inconclusive`) that the args-keyed failure tracker can't see —
    // the orchestrator varies task text between retries, so identical
    // args never match. Per-agent outcome tracking catches that loop
    // shape independently of the text variation. PR #603.
    recordDelegationOutcome(toolCall, toolExecResult);
    toolResultMsg = buildToolResultMessage({
      id: createId(),
      timestamp: Date.now(),
      text: toolExecResult.text,
      metaLine,
      toolMeta: buildToolMeta({
        toolName: getToolName(toolCall),
        target: getToolStatusDetail(toolCall),
        source: toolCall.source,
        provider: lockedProvider,
        durationMs: toolExecDurationMs,
        isError,
      }),
      toolResults: [
        buildToolResultBlock({
          toolUseId,
          // Same body the text envelope wraps (metaLine + result) so the sidecar
          // keeps runtime [meta]/[pulse] context for the Slice 2 block path.
          content: composeToolResultBody(toolExecResult.text, metaLine),
          isError,
        }),
      ],
      branch:
        toolExecResult.originBranch ?? toolExecResult.branchSwitch?.name ?? currentWriteBranch,
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
      target: getToolStatusDetail(toolCall),
      ...(toolExecResult.branch ? { branch: toolExecResult.branch } : {}),
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
    const msgs = markLastAssistantToolCall(conv.messages, {
      content: accumulated,
      thinking: thinkingAccumulated,
      toolUses: [toolUseBlock],
    });
    const updated = { ...prev, [chatId]: { ...conv, messages: [...msgs, toolResultMsg] } };
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
      ...(currentWriteBranch !== undefined ? { branch: currentWriteBranch } : {}),
      // Carry the turn's plain reasoning text onto the wire copy, not just the
      // displayed message. DeepSeek thinking mode rejects the tool-result
      // continuation request unless the assistant turn that made the call
      // echoes its `reasoning_content` (orchestrator emits it from `thinking`
      // on the route-gated DeepSeek path; without this it arrives empty → the
      // `reasoning_content must be passed back` 400). Sibling of the signed
      // `reasoningBlocks` sidecar below, which was already carried (#1193).
      ...(thinkingAccumulated ? { thinking: thinkingAccumulated } : {}),
      ...(reasoningBlocks.length > 0 ? { reasoningBlocks: [...reasoningBlocks] } : {}),
      toolUses: [toolUseBlock],
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
