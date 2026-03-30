import type React from 'react';
import { useCallback } from 'react';
import { getActiveProvider, type ActiveProvider } from '@/lib/orchestrator';
import { getSandboxDiff } from '@/lib/sandbox-client';
import { runCoderAgent, generateCheckpointAnswer, summarizeCoderStateForHandoff } from '@/lib/coder-agent';
import { runExplorerAgent } from '@/lib/explorer-agent';
import { type AnyToolCall } from '@/lib/tool-dispatch';
import { runPlanner, formatPlannerBrief } from '@/lib/planner-agent';
import { runAuditorEvaluation, type EvaluationResult } from '@/lib/auditor-agent';
import { resolveHarnessSettings } from '@/lib/model-capabilities';
import { appendCardsToLatestToolCall } from '@/lib/chat-tool-messages';
import { summarizeToolResultPreview } from '@/lib/chat-run-events';
import { formatElapsedTime } from '@/lib/utils';
import { createId } from '@/hooks/chat-persistence';
import { setSpanAttributes, withActiveSpan, SpanKind, SpanStatusCode } from '@/lib/tracing';
import type { RunEngineEvent } from '@/lib/run-engine';
import type { VerificationPolicy } from '@/lib/verification-policy';
import type {
  ToolExecutionResult,
  ChatMessage,
  ChatCard,
  CoderWorkingMemory,
  CriterionResult,
  Conversation,
  AgentStatus,
  AgentStatusSource,
  RunEventInput,
} from '@/types';

function getTaskStatusLabel(criteriaResults?: CriterionResult[]): string {
  if (!criteriaResults || criteriaResults.length === 0) return 'OK';
  const allPassed = criteriaResults.every(r => r.passed);
  return allPassed ? 'OK' : 'CHECKS_FAILED';
}

export interface UseAgentDelegationParams {
  setConversations: React.Dispatch<React.SetStateAction<Record<string, Conversation>>>;
  updateAgentStatus: (status: AgentStatus, meta?: { chatId?: string; source?: AgentStatusSource; log?: boolean }) => void;
  appendRunEvent: (chatId: string, event: RunEventInput) => void;
  emitRunEngineEvent: (event: RunEngineEvent) => void;
  getVerificationPolicyForChat: (chatId: string) => VerificationPolicy;
  branchInfoRef: React.RefObject<{ currentBranch?: string; defaultBranch?: string } | undefined | null>;
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
  const executeDelegateCall = useCallback(async (
    chatId: string,
    toolCall: AnyToolCall,
    apiMessages: ChatMessage[],
    lockedProviderForChat: ActiveProvider,
    resolvedModelForChat: string | undefined,
  ): Promise<ToolExecutionResult> => {
    let toolExecResult: ToolExecutionResult = { text: '' };
    const verificationPolicy = getVerificationPolicyForChat(chatId);

    if (toolCall.call.tool === 'delegate_explorer') {
      const executionId = createId();
      emitRunEngineEvent({
        type: 'DELEGATION_STARTED',
        timestamp: Date.now(),
        agent: 'explorer',
      });
      const explorerTask = toolCall.call.args.task?.trim();
      const explorerArgs = toolCall.call.args;
      if (!explorerTask) {
        toolExecResult = { text: '[Tool Error] delegate_explorer requires a non-empty "task" string.' };
      } else {
        appendRunEvent(chatId, {
          type: 'subagent.started',
          executionId,
          agent: 'explorer',
          detail: explorerTask,
        });
        try {
          const explorerResult = await withActiveSpan('subagent.explorer', {
            scope: 'push.delegation',
            kind: SpanKind.INTERNAL,
            attributes: {
              'push.agent.role': 'explorer',
              'push.execution_id': executionId,
              'push.task_count': 1,
              'push.provider': lockedProviderForChat,
              'push.model': resolvedModelForChat,
              'push.has_sandbox': Boolean(sandboxIdRef.current),
              'push.has_repo': Boolean(repoRef.current),
            },
          }, async (span) => {
            const result = await runExplorerAgent(
              {
                task: explorerTask,
                files: explorerArgs.files || [],
                intent: explorerArgs.intent,
                deliverable: explorerArgs.deliverable,
                knownContext: explorerArgs.knownContext,
                constraints: explorerArgs.constraints,
                branchContext: branchInfoRef.current?.currentBranch ? {
                  activeBranch: branchInfoRef.current.currentBranch,
                  defaultBranch: branchInfoRef.current.defaultBranch || 'main',
                  protectMain: isMainProtectedRef.current,
                } : undefined,
                provider: lockedProviderForChat,
                model: resolvedModelForChat || undefined,
                projectInstructions: agentsMdRef.current || undefined,
                instructionFilename: instructionFilenameRef.current || undefined,
              },
              sandboxIdRef.current,
              repoRef.current || '',
              {
                onStatus: (phase, detail) => {
                  updateAgentStatus(
                    { active: true, phase, detail },
                    { chatId, source: 'explorer' },
                  );
                },
                signal: abortControllerRef.current?.signal,
              },
            );
            setSpanAttributes(span, {
              'push.round_count': result.rounds,
              'push.card_count': result.cards.length,
            });
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          });

          if (explorerResult.cards.length > 0) {
            setConversations((prev) => {
              const conv = prev[chatId];
              if (!conv) return prev;
              const msgs = appendCardsToLatestToolCall(conv.messages, explorerResult.cards);
              return { ...prev, [chatId]: { ...conv, messages: msgs } };
            });
          }

          toolExecResult = {
            text: `[Tool Result — delegate_explorer]\n${explorerResult.summary}\n(${explorerResult.rounds} round${explorerResult.rounds !== 1 ? 's' : ''})`,
          };
          appendRunEvent(chatId, {
            type: 'subagent.completed',
            executionId,
            agent: 'explorer',
            summary: summarizeToolResultPreview(explorerResult.summary),
          });
        } catch (err) {
          const isAbort = err instanceof DOMException && err.name === 'AbortError';
          if (isAbort || abortRef.current) {
            toolExecResult = { text: '[Tool Result — delegate_explorer]\nExplorer cancelled by user.' };
            appendRunEvent(chatId, {
              type: 'subagent.completed',
              executionId,
              agent: 'explorer',
              summary: 'Cancelled by user.',
            });
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            toolExecResult = { text: `[Tool Error] Explorer failed: ${msg}` };
            appendRunEvent(chatId, {
              type: 'subagent.failed',
              executionId,
              agent: 'explorer',
              error: summarizeToolResultPreview(msg),
            });
          }
        }
      }
    } else if (toolCall.call.tool === 'delegate_coder') {
      const executionId = createId();
      // Handle Coder delegation (Phase 3b)
      emitRunEngineEvent({
        type: 'DELEGATION_STARTED',
        timestamp: Date.now(),
        agent: 'coder',
      });
      lastCoderStateRef.current = null; // Will be populated by onWorkingMemoryUpdate callback
      const currentSandboxId = sandboxIdRef.current;
      if (!currentSandboxId) {
        toolExecResult = { text: '[Tool Error] Failed to start sandbox automatically. Try again.' };
      } else {
        try {
          // --- Harness Profile Resolution ---
          // Resolve scaffolding level based on the model being used for this delegation.
          const harnessProvider = lockedProviderForChat || getActiveProvider();
          const harnessModelId = resolvedModelForChat || undefined;
          const harnessSettings = resolveHarnessSettings(
            harnessProvider,
            harnessModelId,
          );

          const delegateArgs = toolCall.call.args;
          const taskList = Array.isArray(delegateArgs.tasks)
            ? delegateArgs.tasks.filter((t: unknown) => typeof t === 'string' && t.trim())
            : [];
          if (delegateArgs.task?.trim()) {
            taskList.unshift(delegateArgs.task.trim());
          }

          if (taskList.length === 0) {
            toolExecResult = { text: '[Tool Error] delegate_coder requires "task" or non-empty "tasks" array.' };
          } else {
            appendRunEvent(chatId, {
              type: 'subagent.started',
              executionId,
              agent: 'coder',
              detail: taskList.length === 1 ? taskList[0] : `${taskList.length} tasks`,
            });
            const allCards: ChatCard[] = [];
            const summaries: string[] = [];
            let totalRounds = 0;
            let totalCheckpoints = 0;
            // Collect acceptance criteria results across all tasks for evaluation
            const allCriteriaResults: { id: string; passed: boolean; exitCode: number; output: string }[] = [];

            // --- Planner Pre-Pass ---
            // When the harness profile requires it (or the task is large enough),
            // run the planner to decompose into a feature checklist.
            let plannerBrief: string | undefined;
            if (harnessSettings.plannerRequired && taskList.length === 1) {
              const plannerExecutionId = createId();
              appendRunEvent(chatId, {
                type: 'subagent.started',
                executionId: plannerExecutionId,
                agent: 'planner',
                detail: taskList[0],
              });
              updateAgentStatus(
                { active: true, phase: 'Planning task...', detail: `Profile: ${harnessSettings.profile}` },
                { chatId, source: 'coder' },
              );
              const plan = await withActiveSpan('subagent.planner', {
                scope: 'push.delegation',
                kind: SpanKind.INTERNAL,
                attributes: {
                  'push.agent.role': 'planner',
                  'push.execution_id': plannerExecutionId,
                  'push.provider': lockedProviderForChat,
                  'push.model': resolvedModelForChat,
                },
              }, async (span) => {
                const result = await runPlanner(
                  taskList[0],
                  delegateArgs.files || [],
                  (phase) => updateAgentStatus({ active: true, phase }, { chatId, source: 'coder' }),
                  {
                    providerOverride: lockedProviderForChat,
                    modelOverride: resolvedModelForChat || undefined,
                  },
                );
                setSpanAttributes(span, {
                  'push.plan.generated': Boolean(result),
                });
                span.setStatus({ code: SpanStatusCode.OK });
                return result;
              });
              if (plan) {
                plannerBrief = formatPlannerBrief(plan);
                appendRunEvent(chatId, {
                  type: 'subagent.completed',
                  executionId: plannerExecutionId,
                  agent: 'planner',
                  summary: summarizeToolResultPreview(plannerBrief),
                });
              } else {
                appendRunEvent(chatId, {
                  type: 'subagent.failed',
                  executionId: plannerExecutionId,
                  agent: 'planner',
                  error: 'Planner did not return a plan.',
                });
              }
              // Fail-open: if planner returns null, Coder proceeds without a plan
            }

            for (let taskIndex = 0; taskIndex < taskList.length; taskIndex++) {
              const task = taskList[taskIndex];

              // Interactive Checkpoint callback: when the Coder pauses to ask
              // the Orchestrator for guidance, this generates an answer using the
              // Orchestrator's LLM with recent chat history for context.
              const handleCheckpoint = async (question: string, context: string): Promise<string> => {
                const prefix = taskList.length > 1 ? `[${taskIndex + 1}/${taskList.length}] ` : '';
                updateAgentStatus(
                  { active: true, phase: `${prefix}Coder checkpoint`, detail: question },
                  { chatId, source: 'coder' },
                );

                const stateSummary = summarizeCoderStateForHandoff(lastCoderStateRef.current);
                const checkpointContext = [
                  context.trim(),
                  stateSummary ? `Latest coder state:\n${stateSummary}` : null,
                ]
                  .filter((value): value is string => Boolean(value && value.trim()))
                  .join('\n\n');

                const answer = await generateCheckpointAnswer(
                  question,
                  checkpointContext,
                  apiMessages.slice(-6), // recent chat for user intent context
                  abortControllerRef.current?.signal,
                  lockedProviderForChat,
                  resolvedModelForChat || undefined,
                );

                updateAgentStatus(
                  { active: true, phase: `${prefix}Coder resuming...` },
                  { chatId, source: 'coder' },
                );
                return answer;
              };

              // Apply acceptance criteria to every task — validates each independently.
              // For sequential single-sandbox mode this also catches regressions
              // introduced by earlier tasks before they compound.
              const seqTaskStart = Date.now();
              const seqBi = branchInfoRef.current;
              const coderResult = await withActiveSpan('subagent.coder', {
                scope: 'push.delegation',
                kind: SpanKind.INTERNAL,
                attributes: {
                  'push.agent.role': 'coder',
                  'push.execution_id': executionId,
                  'push.task_index': taskIndex,
                  'push.task_count': taskList.length,
                  'push.provider': lockedProviderForChat,
                  'push.model': resolvedModelForChat,
                  'push.has_acceptance_criteria': Boolean(delegateArgs.acceptanceCriteria?.length),
                },
              }, async (span) => {
                const result = await runCoderAgent(
                  task,
                  currentSandboxId,
                  delegateArgs.files || [],
                  (phase, detail) => {
                    const prefix = taskList.length > 1 ? `[${taskIndex + 1}/${taskList.length}] ` : '';
                    updateAgentStatus(
                      { active: true, phase: `${prefix}${phase}`, detail },
                      { chatId, source: 'coder' },
                    );
                  },
                  agentsMdRef.current || undefined,
                  abortControllerRef.current?.signal,
                  handleCheckpoint,
                  delegateArgs.acceptanceCriteria,
                  (state) => { lastCoderStateRef.current = state; },
                  lockedProviderForChat,
                  resolvedModelForChat || undefined,
                  {
                    intent: delegateArgs.intent,
                    deliverable: delegateArgs.deliverable,
                    knownContext: delegateArgs.knownContext,
                    constraints: delegateArgs.constraints,
                    branchContext: seqBi?.currentBranch ? {
                      activeBranch: seqBi.currentBranch,
                      defaultBranch: seqBi.defaultBranch || 'main',
                      protectMain: isMainProtectedRef.current,
                    } : undefined,
                    instructionFilename: instructionFilenameRef.current || undefined,
                    harnessSettings,
                    plannerBrief,
                    verificationPolicy,
                  },
                );
                setSpanAttributes(span, {
                  'push.round_count': result.rounds,
                  'push.checkpoint_count': result.checkpoints,
                  'push.card_count': result.cards.length,
                  'push.criteria_count': result.criteriaResults?.length,
                });
                span.setStatus({ code: SpanStatusCode.OK });
                return result;
              });
              const seqElapsed = formatElapsedTime(Date.now() - seqTaskStart);
              const seqStatus = getTaskStatusLabel(coderResult.criteriaResults);
              totalRounds += coderResult.rounds;
              totalCheckpoints += coderResult.checkpoints;
              if (taskList.length > 1) {
                summaries.push(`Task ${taskIndex + 1} [${seqStatus}, ${seqElapsed}]: ${coderResult.summary}`);
              } else {
                summaries.push(`${coderResult.summary} (${seqElapsed})`);
              }
              if (coderResult.criteriaResults) {
                allCriteriaResults.push(...coderResult.criteriaResults);
              }
              allCards.push(...coderResult.cards);
            }

            // --- Auditor Evaluation ---
            // After all Coder tasks complete, run the Auditor in evaluation
            // mode to assess whether the work is actually complete.
            if (harnessSettings.evaluateAfterCoder && summaries.length > 0) {
              let evalResult: EvaluationResult | null = null;
              const auditorExecutionId = createId();
              try {
                appendRunEvent(chatId, {
                  type: 'subagent.started',
                  executionId: auditorExecutionId,
                  agent: 'auditor',
                  detail: 'Evaluating coder output',
                });
                updateAgentStatus(
                  { active: true, phase: 'Evaluating output...' },
                  { chatId, source: 'coder' },
                );
                // Get sandbox diff for evaluation context
                let evalDiff: string | null = null;
                try {
                  const diffResult = await getSandboxDiff(currentSandboxId);
                  evalDiff = diffResult.diff || null;
                } catch { /* no diff available — evaluation proceeds without it */ }

                const combinedTask = taskList.join('\n\n');
                const combinedSummary = summaries.join('\n');
                // For multi-task delegations, only the last task's working memory
                // is available — pass null to avoid misleading the evaluator.
                const evalWorkingMemory = taskList.length <= 1
                  ? lastCoderStateRef.current
                  : null;
                // Scale max rounds by task count so multi-task totals don't
                // falsely trigger the "hit round cap" signal.
                const evalMaxRounds = harnessSettings.maxCoderRounds * Math.max(taskList.length, 1);
                evalResult = await withActiveSpan('subagent.auditor', {
                  scope: 'push.delegation',
                  kind: SpanKind.INTERNAL,
                  attributes: {
                    'push.agent.role': 'auditor',
                    'push.execution_id': auditorExecutionId,
                    'push.provider': lockedProviderForChat,
                    'push.model': resolvedModelForChat,
                    'push.criteria_count': allCriteriaResults.length,
                  },
                }, async (span) => {
                  const result = await runAuditorEvaluation(
                    combinedTask,
                    combinedSummary,
                    evalWorkingMemory,
                    evalDiff,
                    (phase) => updateAgentStatus({ active: true, phase }, { chatId, source: 'coder' }),
                    {
                      providerOverride: lockedProviderForChat,
                      modelOverride: resolvedModelForChat || undefined,
                      coderRounds: totalRounds,
                      coderMaxRounds: evalMaxRounds,
                      criteriaResults: allCriteriaResults.length > 0 ? allCriteriaResults : undefined,
                      verificationPolicy,
                    },
                  );
                  if (result) {
                    setSpanAttributes(span, {
                      'push.auditor.verdict': result.verdict,
                      'push.auditor.gap_count': result.gaps.length,
                    });
                  }
                  span.setStatus({ code: SpanStatusCode.OK });
                  return result;
                });
                if (evalResult) {
                  appendRunEvent(chatId, {
                    type: 'subagent.completed',
                    executionId: auditorExecutionId,
                    agent: 'auditor',
                    summary: summarizeToolResultPreview(evalResult.summary),
                  });
                } else {
                  appendRunEvent(chatId, {
                    type: 'subagent.failed',
                    executionId: auditorExecutionId,
                    agent: 'auditor',
                    error: 'Auditor returned no evaluation.',
                  });
                }
              } catch {
                appendRunEvent(chatId, {
                  type: 'subagent.failed',
                  executionId: auditorExecutionId,
                  agent: 'auditor',
                  error: 'Evaluation failed.',
                });
                // Fail-open: if evaluation fails, Coder result stands as-is
              }

              // Append evaluation verdict to summaries
              if (evalResult) {
                const evalLine = `\n[Evaluation: ${evalResult.verdict.toUpperCase()}] ${evalResult.summary}`;
                const gapLines = evalResult.gaps.length > 0
                  ? evalResult.gaps.map(g => `  - ${g}`).join('\n')
                  : '';
                summaries.push(evalLine + (gapLines ? `\n${gapLines}` : ''));
              }
            }

            // Attach all Coder cards to the assistant message
            if (allCards.length > 0) {
              setConversations((prev) => {
                const conv = prev[chatId];
                if (!conv) return prev;
                const msgs = appendCardsToLatestToolCall(conv.messages, allCards);
                return { ...prev, [chatId]: { ...conv, messages: msgs } };
              });
            }

            const checkpointNote = totalCheckpoints > 0
              ? `, ${totalCheckpoints} checkpoint${totalCheckpoints !== 1 ? 's' : ''}`
              : '';
            toolExecResult = {
              text: `[Tool Result — delegate_coder]\n${summaries.join('\n')}\n(${totalRounds} round${totalRounds !== 1 ? 's' : ''}${checkpointNote})`,
            };
            appendRunEvent(chatId, {
              type: 'subagent.completed',
              executionId,
              agent: 'coder',
              summary: summarizeToolResultPreview(toolExecResult.text),
            });
          }

        } catch (err) {
          const isAbort = err instanceof DOMException && err.name === 'AbortError';
          if (isAbort || abortRef.current) {
            toolExecResult = { text: '[Tool Result — delegate_coder]\nCoder cancelled by user.' };
            appendRunEvent(chatId, {
              type: 'subagent.completed',
              executionId,
              agent: 'coder',
              summary: 'Cancelled by user.',
            });
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            toolExecResult = { text: `[Tool Error] Coder failed: ${msg}` };
            appendRunEvent(chatId, {
              type: 'subagent.failed',
              executionId,
              agent: 'coder',
              error: summarizeToolResultPreview(msg),
            });
          }
        }
      }
    }
    
    return toolExecResult;
  }, [setConversations, updateAgentStatus, appendRunEvent, emitRunEngineEvent, getVerificationPolicyForChat, branchInfoRef, isMainProtectedRef, agentsMdRef, instructionFilenameRef, sandboxIdRef, repoRef, abortControllerRef, abortRef, lastCoderStateRef]);

  return { executeDelegateCall };
}
