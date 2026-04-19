import type React from 'react';
import { useCallback } from 'react';
import { type ActiveProvider } from '@/lib/orchestrator';
import {
  handleExplorerDelegation,
  type ExplorerHandlerContext,
  type ExplorerToolCall,
} from '@/lib/explorer-delegation-handler';
import {
  handleCoderDelegation,
  type CoderHandlerContext,
  type CoderToolCall,
} from '@/lib/coder-delegation-handler';
import { handleCoderAuditor, type AuditorHandlerContext } from '@/lib/auditor-delegation-handler';
import {
  handleTaskGraphDelegation,
  type TaskGraphHandlerContext,
  type TaskGraphToolCall,
} from '@/lib/task-graph-delegation-handler';
import { type AnyToolCall } from '@/lib/tool-dispatch';
import { type EvaluationResult } from '@/lib/auditor-agent';
import { appendCardsToLatestToolCall } from '@/lib/chat-tool-messages';
import { summarizeToolResultPreview } from '@/lib/chat-run-events';
import {
  buildDelegationResultCard,
  filterDelegationCardsForInlineDisplay,
  formatCompactDelegationToolResult,
} from '@/lib/delegation-result';
import { writeCoderMemory, invalidateMemoryForChangedFiles } from '@/lib/context-memory';
import { runContextMemoryBestEffort } from '@/lib/memory-context-helpers';
import { type CorrelationContext } from '@push/lib/correlation-context';
import type { RunEngineEvent } from '@/lib/run-engine';
import type { VerificationPolicy } from '@/lib/verification-policy';
import type {
  ToolExecutionResult,
  ChatMessage,
  ChatCard,
  CoderWorkingMemory,
  Conversation,
  AgentStatus,
  AgentStatusSource,
  RunEventInput,
  VerificationRuntimeState,
  DelegationOutcome,
  DelegationEvidence,
  DelegationCheck,
  DelegationGateVerdict,
  DelegationStatus,
} from '@/types';

function appendInlineDelegationCards(
  setConversations: React.Dispatch<React.SetStateAction<Record<string, Conversation>>>,
  chatId: string,
  cards: readonly ChatCard[],
): void {
  const inlineCards = filterDelegationCardsForInlineDisplay(cards);
  if (inlineCards.length === 0) return;
  setConversations((prev) => {
    const conv = prev[chatId];
    if (!conv) return prev;
    const msgs = appendCardsToLatestToolCall(conv.messages, inlineCards);
    return { ...prev, [chatId]: { ...conv, messages: msgs } };
  });
}

export interface UseAgentDelegationParams {
  setConversations: React.Dispatch<React.SetStateAction<Record<string, Conversation>>>;
  updateAgentStatus: (
    status: AgentStatus,
    meta?: { chatId?: string; source?: AgentStatusSource; log?: boolean },
  ) => void;
  appendRunEvent: (chatId: string, event: RunEventInput) => void;
  emitRunEngineEvent: (event: RunEngineEvent) => void;
  getVerificationPolicyForChat: (chatId: string) => VerificationPolicy;
  updateVerificationStateForChat: (
    chatId: string,
    updater: (state: VerificationRuntimeState) => VerificationRuntimeState,
  ) => void;
  branchInfoRef: React.RefObject<
    { currentBranch?: string; defaultBranch?: string } | undefined | null
  >;
  isMainProtectedRef: React.MutableRefObject<boolean>;
  agentsMdRef: React.MutableRefObject<string | null>;
  instructionFilenameRef: React.MutableRefObject<string | null>;
  sandboxIdRef: React.MutableRefObject<string | null>;
  repoRef: React.MutableRefObject<string | null>;
  abortControllerRef: React.MutableRefObject<AbortController | null>;
  abortRef: React.MutableRefObject<boolean>;
  lastCoderStateRef: React.MutableRefObject<CoderWorkingMemory | null>;
}

export function useAgentDelegation({
  setConversations,
  updateAgentStatus,
  appendRunEvent,
  emitRunEngineEvent,
  getVerificationPolicyForChat,
  updateVerificationStateForChat,
  branchInfoRef,
  isMainProtectedRef,
  agentsMdRef,
  instructionFilenameRef,
  sandboxIdRef,
  repoRef,
  abortControllerRef,
  abortRef,
  lastCoderStateRef,
}: UseAgentDelegationParams) {
  // Wire up the Sequential Explorer handler context with the hook's refs and
  // callbacks. Kept hook-local (not exported) so the extraction boundary stays
  // one-way: the handler module never imports from this hook.
  const buildExplorerContext = useCallback(
    (): ExplorerHandlerContext => ({
      sandboxIdRef,
      repoRef,
      branchInfoRef,
      isMainProtectedRef,
      agentsMdRef,
      instructionFilenameRef,
      abortControllerRef,
      abortRef,
      emitRunEngineEvent,
      appendRunEvent,
      updateAgentStatus,
      appendInlineDelegationCards: (chatId, cards) =>
        appendInlineDelegationCards(setConversations, chatId, cards),
      updateVerificationStateForChat,
    }),
    [
      sandboxIdRef,
      repoRef,
      branchInfoRef,
      isMainProtectedRef,
      agentsMdRef,
      instructionFilenameRef,
      abortControllerRef,
      abortRef,
      emitRunEngineEvent,
      appendRunEvent,
      updateAgentStatus,
      setConversations,
      updateVerificationStateForChat,
    ],
  );

  // Wire up the Sequential Coder handler context. Same one-way boundary
  // rule as buildExplorerContext: the handler never imports from this
  // hook. `resetCoderState` and `onCoderStateUpdate` bridge the hook's
  // `lastCoderStateRef` ownership into the handler's execution path
  // without handing the ref itself across the seam.
  const buildCoderContext = useCallback(
    (): CoderHandlerContext => ({
      sandboxIdRef,
      repoRef,
      branchInfoRef,
      isMainProtectedRef,
      agentsMdRef,
      instructionFilenameRef,
      abortControllerRef,
      abortRef,
      emitRunEngineEvent,
      appendRunEvent,
      updateAgentStatus,
      updateVerificationStateForChat,
      resetCoderState: () => {
        lastCoderStateRef.current = null;
      },
      onCoderStateUpdate: (state) => {
        lastCoderStateRef.current = state;
      },
      readLatestCoderState: () => lastCoderStateRef.current,
    }),
    [
      sandboxIdRef,
      repoRef,
      branchInfoRef,
      isMainProtectedRef,
      agentsMdRef,
      instructionFilenameRef,
      abortControllerRef,
      abortRef,
      emitRunEngineEvent,
      appendRunEvent,
      updateAgentStatus,
      updateVerificationStateForChat,
      lastCoderStateRef,
    ],
  );

  // Wire up the Sequential Auditor handler context. Reads a narrow
  // slice of the hook's refs — just repoRef + branchInfoRef for the
  // memory scope, plus a read-only getter for the latest Coder
  // working memory. Gating stays in the hook; the handler is only
  // invoked when the hook decides the Auditor should fire.
  const buildAuditorContext = useCallback(
    (): AuditorHandlerContext => ({
      repoRef,
      branchInfoRef,
      readLatestCoderState: () => lastCoderStateRef.current,
      appendRunEvent,
      updateAgentStatus,
      updateVerificationStateForChat,
    }),
    [
      repoRef,
      branchInfoRef,
      lastCoderStateRef,
      appendRunEvent,
      updateAgentStatus,
      updateVerificationStateForChat,
    ],
  );

  // Wire up the Task-Graph handler context. Same one-way boundary rule
  // as the sibling build* helpers: the handler never imports from this
  // hook. The three coder-state callbacks (reset/update/read) preserve
  // the Option A contract from the Phase 5 design spike — the ref
  // stays hook-owned while the handler operates through these narrow
  // hooks. See docs/decisions/Phase 5 Handoff - Task-Graph Extraction.md
  // §"Open Design Question" for the full reasoning.
  const buildTaskGraphContext = useCallback(
    (): TaskGraphHandlerContext => ({
      sandboxIdRef,
      repoRef,
      branchInfoRef,
      isMainProtectedRef,
      agentsMdRef,
      instructionFilenameRef,
      abortControllerRef,
      abortRef,
      emitRunEngineEvent,
      appendRunEvent,
      updateAgentStatus,
      updateVerificationStateForChat,
      appendInlineDelegationCards: (chatId, cards) =>
        appendInlineDelegationCards(setConversations, chatId, cards),
      resetCoderState: () => {
        lastCoderStateRef.current = null;
      },
      onCoderStateUpdate: (state) => {
        lastCoderStateRef.current = state;
      },
      readLatestCoderState: () => lastCoderStateRef.current,
    }),
    [
      sandboxIdRef,
      repoRef,
      branchInfoRef,
      isMainProtectedRef,
      agentsMdRef,
      instructionFilenameRef,
      abortControllerRef,
      abortRef,
      emitRunEngineEvent,
      appendRunEvent,
      updateAgentStatus,
      updateVerificationStateForChat,
      setConversations,
      lastCoderStateRef,
    ],
  );

  const executeDelegateCall = useCallback(
    async (
      chatId: string,
      toolCall: AnyToolCall,
      apiMessages: ChatMessage[],
      lockedProviderForChat: ActiveProvider,
      resolvedModelForChat: string | undefined,
    ): Promise<ToolExecutionResult> => {
      let toolExecResult: ToolExecutionResult = { text: '' };
      const verificationPolicy = getVerificationPolicyForChat(chatId);
      // Base correlation context for every span emitted in this delegation.
      // Per-role extensions (executionId, taskGraphId, taskId) are built
      // by `extendCorrelation` at each span site so the merge is
      // copy-on-write rather than mutation.
      const baseCorrelation: CorrelationContext = {
        surface: 'web',
        chatId,
      };

      if (toolCall.call.tool === 'delegate_explorer') {
        toolExecResult = await handleExplorerDelegation(buildExplorerContext(), {
          chatId,
          toolCall: toolCall as ExplorerToolCall,
          baseCorrelation,
          lockedProviderForChat,
          resolvedModelForChat,
        });
      } else if (toolCall.call.tool === 'delegate_coder') {
        const coderHandlerResult = await handleCoderDelegation(buildCoderContext(), {
          chatId,
          toolCall: toolCall as CoderToolCall,
          apiMessages,
          baseCorrelation,
          lockedProviderForChat,
          resolvedModelForChat,
          verificationPolicy,
        });
        if (coderHandlerResult.status !== 'ok') {
          toolExecResult = coderHandlerResult.toolExecResult;
        } else {
          const { executionId, coderStartMs, auditorInput } = coderHandlerResult;
          const {
            allCards,
            summaries,
            allCriteriaResults,
            totalRounds,
            totalCheckpoints,
            lastTaskDiff,
            latestDiffPaths,
            coderMemoryScope,
            verificationCommandsById,
          } = auditorInput;
          let coderEvalResult: EvaluationResult | null = null;

          // --- Auditor Evaluation ---
          // Gating is policy and stays in the hook. The handler is
          // reactive — it runs the Auditor span, emits events, and
          // returns `{ evalResult, auditorSummaryLine }`. The hook
          // folds `evalResult` into the final DelegationOutcome
          // (status, gateVerdicts, missingRequirements) below.
          if (auditorInput.harnessSettings.evaluateAfterCoder && summaries.length > 0) {
            const { evalResult, auditorSummaryLine } = await handleCoderAuditor(
              buildAuditorContext(),
              {
                chatId,
                baseCorrelation,
                lockedProviderForChat,
                resolvedModelForChat,
                verificationPolicy,
                auditorInput,
              },
            );
            coderEvalResult = evalResult;
            if (auditorSummaryLine) {
              summaries.push(auditorSummaryLine);
            }
          }

          // --- Build structured DelegationOutcome for coder ---
          const coderOutcome: DelegationOutcome = (() => {
            let status: DelegationStatus;
            if (coderEvalResult) {
              status = coderEvalResult.verdict === 'complete' ? 'complete' : 'incomplete';
            } else if (allCriteriaResults.length > 0) {
              status = allCriteriaResults.every((r) => r.passed) ? 'complete' : 'incomplete';
            } else {
              status = 'inconclusive';
            }

            const evidence: DelegationEvidence[] = [];
            if (lastTaskDiff) {
              evidence.push({
                kind: 'diff',
                label: 'Workspace diff',
                detail: summarizeToolResultPreview(lastTaskDiff),
              });
            }
            for (const cr of allCriteriaResults) {
              evidence.push({
                kind: 'test',
                label: cr.id,
                detail: cr.output,
              });
            }

            const checks: DelegationCheck[] = allCriteriaResults.map((cr) => ({
              id: cr.id,
              passed: cr.passed,
              exitCode: cr.exitCode,
              output: cr.output,
            }));

            const gateVerdicts: DelegationGateVerdict[] = [];
            if (coderEvalResult) {
              gateVerdicts.push({
                gate: 'auditor',
                outcome: coderEvalResult.verdict === 'complete' ? 'passed' : 'failed',
                summary: coderEvalResult.summary,
              });
            }

            const missingRequirements: string[] =
              coderEvalResult?.gaps ??
              allCriteriaResults.filter((cr) => !cr.passed).map((cr) => `Check failed: ${cr.id}`);

            let nextRequiredAction: string | null = null;
            if (status === 'incomplete') {
              nextRequiredAction = coderEvalResult?.gaps.length
                ? 'Address gaps identified by auditor'
                : 'Fix failing checks';
            }

            return {
              agent: 'coder' as const,
              status,
              summary: summaries.join('\n'),
              evidence,
              checks,
              gateVerdicts,
              missingRequirements,
              nextRequiredAction,
              rounds: totalRounds,
              checkpoints: totalCheckpoints,
              elapsedMs: Date.now() - coderStartMs,
            };
          })();

          appendInlineDelegationCards(setConversations, chatId, allCards);

          if (coderMemoryScope && latestDiffPaths && latestDiffPaths.length > 0) {
            await runContextMemoryBestEffort('invalidating coder memory after file changes', () =>
              invalidateMemoryForChangedFiles({
                scope: {
                  repoFullName: coderMemoryScope.repoFullName,
                  branch: coderMemoryScope.branch,
                  chatId: coderMemoryScope.chatId,
                },
                changedPaths: latestDiffPaths,
                reason: 'Coder delegation updated file-backed context.',
              }),
            );
          }

          if (coderMemoryScope && coderOutcome.status !== 'inconclusive') {
            await runContextMemoryBestEffort('persisting coder memory', () =>
              writeCoderMemory({
                scope: coderMemoryScope,
                outcome: coderOutcome,
                diffPaths: latestDiffPaths,
                verificationCommandsById:
                  verificationCommandsById.size > 0
                    ? Object.fromEntries(verificationCommandsById)
                    : undefined,
              }),
            );
          }

          toolExecResult = {
            text: formatCompactDelegationToolResult({
              agent: 'coder',
              outcome: coderOutcome,
              fileCount: latestDiffPaths?.length,
            }),
            card: buildDelegationResultCard({
              agent: 'coder',
              outcome: coderOutcome,
              fileCount: latestDiffPaths?.length,
            }),
            delegationOutcome: coderOutcome,
          };
          appendRunEvent(chatId, {
            type: 'subagent.completed',
            executionId,
            agent: 'coder',
            summary: summarizeToolResultPreview(toolExecResult.text),
            delegationOutcome: coderOutcome,
          });
        }
      } else if (toolCall.call.tool === 'plan_tasks') {
        toolExecResult = await handleTaskGraphDelegation(buildTaskGraphContext(), {
          chatId,
          toolCall: toolCall as TaskGraphToolCall,
          baseCorrelation,
          lockedProviderForChat,
          resolvedModelForChat,
          verificationPolicy,
        });
      }

      return toolExecResult;
    },
    // The build* helpers track ref/callback identity for their handler
    // contexts, so executeDelegateCall's deps only need the build*
    // helpers + the direct references (appendRunEvent, setConversations,
    // getVerificationPolicyForChat) the body uses outside those helpers.
    [
      appendRunEvent,
      buildAuditorContext,
      buildCoderContext,
      buildExplorerContext,
      buildTaskGraphContext,
      getVerificationPolicyForChat,
      setConversations,
    ],
  );

  return { executeDelegateCall };
}
