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
import { validateTaskGraph, executeTaskGraph, type TaskExecutor } from '@/lib/task-graph';
import { appendCardsToLatestToolCall } from '@/lib/chat-tool-messages';
import { summarizeToolResultPreview } from '@/lib/chat-run-events';
import {
  buildDelegationResultCard,
  filterDelegationCardsForInlineDisplay,
  formatCompactDelegationToolResult,
} from '@/lib/delegation-result';
import {
  buildRetrievedMemoryKnownContext,
  writeDecisionMemory,
  writeExplorerMemory,
  writeTaskGraphNodeMemory,
  writeCoderMemory,
  invalidateMemoryForChangedFiles,
} from '@/lib/context-memory';
import {
  activateVerificationGate,
  buildVerificationAcceptanceCriteria,
  extractChangedPathsFromDiff,
  recordVerificationArtifact,
  recordVerificationCommandResult,
  recordVerificationGateResult,
  recordVerificationMutation,
} from '@/lib/verification-runtime';
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
  AcceptanceCriterion,
  AgentStatus,
  AgentStatusSource,
  RunEventInput,
  VerificationRuntimeState,
  DelegationOutcome,
  DelegationEvidence,
  DelegationCheck,
  DelegationGateVerdict,
  DelegationStatus,
  MemoryQuery,
  MemoryScope,
} from '@/types';

function getTaskStatusLabel(criteriaResults?: CriterionResult[]): string {
  if (!criteriaResults || criteriaResults.length === 0) return 'OK';
  const allPassed = criteriaResults.every(r => r.passed);
  return allPassed ? 'OK' : 'CHECKS_FAILED';
}

/**
 * Build a memory scope for the active delegation. Returns null in scratch
 * mode (no repo) — memory records require a repo for scoping and retrieval.
 */
function buildMemoryScope(
  chatId: string,
  repoFullName: string | null,
  branch: string | null | undefined,
  extras: Partial<MemoryScope> = {},
): MemoryScope | null {
  if (!repoFullName) return null;
  return {
    repoFullName,
    chatId,
    ...(branch ? { branch } : {}),
    ...extras,
  };
}

const MAX_RETRIEVED_MEMORY_RECORDS = 6;

function formatMemoryError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function logContextMemoryWarning(action: string, error: unknown): void {
  console.warn(`[context-memory] ${action} failed; continuing without persisted memory.`, formatMemoryError(error));
}

async function runContextMemoryBestEffort(
  action: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    logContextMemoryWarning(action, error);
  }
}

/**
 * Retrieve typed memory and return a compact knownContext line or null.
 * Callers splice the returned string into the delegation's `knownContext`.
 */
async function retrieveMemoryKnownContextLine(
  scope: MemoryScope | null,
  role: MemoryQuery['role'],
  taskText: string,
  fileHints?: string[],
  extras: Partial<MemoryQuery> = {},
): Promise<string | null> {
  if (!scope) return null;
  try {
    const query: MemoryQuery = {
      repoFullName: scope.repoFullName,
      branch: scope.branch,
      chatId: scope.chatId,
      role,
      taskText,
      fileHints,
      maxRecords: MAX_RETRIEVED_MEMORY_RECORDS,
      ...extras,
    };
    const { line } = await buildRetrievedMemoryKnownContext(query);
    return line;
  } catch (error) {
    logContextMemoryWarning(`retrieving ${role} context`, error);
    return null;
  }
}

/** Merge a retrieved-memory line into an existing knownContext array. */
function withMemoryContext(
  base: string[] | undefined,
  line: string | null,
): string[] | undefined {
  if (!line) return base;
  if (!base || base.length === 0) return [line];
  return [...base, line];
}

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
  updateAgentStatus: (status: AgentStatus, meta?: { chatId?: string; source?: AgentStatusSource; log?: boolean }) => void;
  appendRunEvent: (chatId: string, event: RunEventInput) => void;
  emitRunEngineEvent: (event: RunEngineEvent) => void;
  getVerificationPolicyForChat: (chatId: string) => VerificationPolicy;
  updateVerificationStateForChat: (
    chatId: string,
    updater: (state: VerificationRuntimeState) => VerificationRuntimeState,
  ) => void;
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
  const mergeAcceptanceCriteria = useCallback((
    explicitCriteria: AcceptanceCriterion[] | undefined,
    verificationCriteria: AcceptanceCriterion[],
  ): AcceptanceCriterion[] => {
    const merged: AcceptanceCriterion[] = [];
    const seen = new Set<string>();

    for (const criterion of [...(explicitCriteria ?? []), ...verificationCriteria]) {
      const key = `${criterion.id}::${criterion.check}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(criterion);
    }

    return merged;
  }, []);

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
      const explorerStartMs = Date.now();
      if (!explorerTask) {
        toolExecResult = { text: '[Tool Error] delegate_explorer requires a non-empty "task" string.' };
      } else {
        appendRunEvent(chatId, {
          type: 'subagent.started',
          executionId,
          agent: 'explorer',
          detail: explorerTask,
        });
        const explorerMemoryScope = buildMemoryScope(
          chatId,
          repoRef.current,
          branchInfoRef.current?.currentBranch,
        );
        const explorerMemoryLine = await retrieveMemoryKnownContextLine(
          explorerMemoryScope,
          'explorer',
          explorerTask,
          explorerArgs.files,
        );
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
                knownContext: withMemoryContext(explorerArgs.knownContext, explorerMemoryLine),
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

          appendInlineDelegationCards(setConversations, chatId, explorerResult.cards);

          // --- Build structured DelegationOutcome for explorer ---
          const explorerOutcome: DelegationOutcome = {
            agent: 'explorer',
            status: explorerResult.rounds > 0 && explorerResult.summary.trim()
              ? 'complete'
              : 'inconclusive',
            summary: explorerResult.summary,
            evidence: explorerResult.summary.trim()
              ? [{ kind: 'observation', label: 'Investigation findings' }]
              : [],
            checks: [],
            gateVerdicts: [],
            missingRequirements: [],
            nextRequiredAction: null,
            rounds: explorerResult.rounds,
            checkpoints: 0,
            elapsedMs: Date.now() - explorerStartMs,
          };

          toolExecResult = {
            text: formatCompactDelegationToolResult({
              agent: 'explorer',
              outcome: explorerOutcome,
            }),
            card: buildDelegationResultCard({
              agent: 'explorer',
              outcome: explorerOutcome,
            }),
            delegationOutcome: explorerOutcome,
          };

          if (explorerMemoryScope && explorerOutcome.status === 'complete') {
            await runContextMemoryBestEffort('persisting explorer memory', () =>
              writeExplorerMemory({
                scope: explorerMemoryScope,
                summary: explorerResult.summary,
                relatedFiles: explorerArgs.files,
                rounds: explorerResult.rounds,
              }),
            );
          }

          updateVerificationStateForChat(chatId, (state) =>
            recordVerificationArtifact(
              state,
              `Explorer produced evidence: ${summarizeToolResultPreview(explorerResult.summary)}`,
            ),
          );
          appendRunEvent(chatId, {
            type: 'subagent.completed',
            executionId,
            agent: 'explorer',
            summary: summarizeToolResultPreview(explorerResult.summary),
            delegationOutcome: explorerOutcome,
          });
        } catch (err) {
          const isAbort = err instanceof DOMException && err.name === 'AbortError';
          if (isAbort || abortRef.current) {
            const abortOutcome: DelegationOutcome = {
              agent: 'explorer',
              status: 'inconclusive',
              summary: 'Explorer cancelled by user.',
              evidence: [],
              checks: [],
              gateVerdicts: [],
              missingRequirements: [],
              nextRequiredAction: null,
              rounds: 0,
              checkpoints: 0,
              elapsedMs: Date.now() - explorerStartMs,
            };
            toolExecResult = {
              text: formatCompactDelegationToolResult({
                agent: 'explorer',
                outcome: abortOutcome,
              }),
              card: buildDelegationResultCard({
                agent: 'explorer',
                outcome: abortOutcome,
              }),
              delegationOutcome: abortOutcome,
            };
            appendRunEvent(chatId, {
              type: 'subagent.completed',
              executionId,
              agent: 'explorer',
              summary: 'Cancelled by user.',
              delegationOutcome: abortOutcome,
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
      const coderStartMs = Date.now();
      // Handle Coder delegation (Phase 3b)
      emitRunEngineEvent({
        type: 'DELEGATION_STARTED',
        timestamp: Date.now(),
        agent: 'coder',
      });
      updateVerificationStateForChat(chatId, (state) =>
        activateVerificationGate(
          state,
          'auditor',
          'Coder delegation started; auditor evaluation pending.',
        ),
      );
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
            const coderMemoryScope = buildMemoryScope(
              chatId,
              repoRef.current,
              branchInfoRef.current?.currentBranch,
            );
            const coderMemoryLine = await retrieveMemoryKnownContextLine(
              coderMemoryScope,
              'coder',
              taskList.join('\n\n'),
              delegateArgs.files,
            );
            const allCards: ChatCard[] = [];
            const summaries: string[] = [];
            let totalRounds = 0;
            let totalCheckpoints = 0;
            // Collect acceptance criteria results across all tasks for evaluation
            const allCriteriaResults: { id: string; passed: boolean; exitCode: number; output: string }[] = [];
            const verificationCriteria = buildVerificationAcceptanceCriteria(verificationPolicy, 'always');
            const verificationCommandsById = new Map<string, string>();
            let lastTaskDiff: string | null = null;
            let latestDiffPaths: string[] | undefined;
            let coderEvalResult: EvaluationResult | null = null;

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

                if (coderMemoryScope) {
                  await runContextMemoryBestEffort('persisting checkpoint decision memory', () =>
                    writeDecisionMemory({
                      scope: coderMemoryScope,
                      question,
                      answer,
                    }),
                  );
                }

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
              const effectiveAcceptanceCriteria = mergeAcceptanceCriteria(
                delegateArgs.acceptanceCriteria,
                verificationCriteria,
              );
              const criteriaCommandById = new Map(
                effectiveAcceptanceCriteria.map((criterion) => [criterion.id, criterion.check]),
              );
              for (const [criterionId, command] of criteriaCommandById.entries()) {
                verificationCommandsById.set(criterionId, command);
              }
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
                  'push.has_acceptance_criteria': Boolean(effectiveAcceptanceCriteria.length),
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
                  effectiveAcceptanceCriteria,
                  (state) => { lastCoderStateRef.current = state; },
                  lockedProviderForChat,
                  resolvedModelForChat || undefined,
                  {
                    intent: delegateArgs.intent,
                    deliverable: delegateArgs.deliverable,
                    knownContext: withMemoryContext(delegateArgs.knownContext, coderMemoryLine),
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
                    declaredCapabilities: delegateArgs.declaredCapabilities,
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
              let taskDiff: string | null = null;
              try {
                const diffResult = await getSandboxDiff(currentSandboxId);
                taskDiff = diffResult.diff || null;
              } catch {
                // Verification state can still update from summaries/checks.
              }
              lastTaskDiff = taskDiff;
              if (taskDiff) {
                const touchedPaths = extractChangedPathsFromDiff(taskDiff);
                latestDiffPaths = touchedPaths;
                updateVerificationStateForChat(chatId, (state) =>
                  recordVerificationMutation(
                    state,
                    {
                      source: 'coder',
                      touchedPaths,
                      detail: 'Coder delegation mutated the workspace.',
                    },
                  ),
                );
              }
              if (taskList.length > 1) {
                summaries.push(`Task ${taskIndex + 1} [${seqStatus}, ${seqElapsed}]: ${coderResult.summary}`);
              } else {
                summaries.push(`${coderResult.summary} (${seqElapsed})`);
              }
              updateVerificationStateForChat(chatId, (state) =>
                recordVerificationArtifact(
                  state,
                  `Coder produced evidence: ${summarizeToolResultPreview(coderResult.summary)}`,
                ),
              );
              if (coderResult.criteriaResults) {
                for (const result of coderResult.criteriaResults) {
                  const command = criteriaCommandById.get(result.id);
                  if (!command) continue;
                  updateVerificationStateForChat(chatId, (state) =>
                    recordVerificationCommandResult(
                      state,
                      command,
                      {
                        exitCode: result.exitCode,
                        detail: `${result.id} exited with code ${result.exitCode}.`,
                      },
                    ),
                  );
                }
                allCriteriaResults.push(...coderResult.criteriaResults);
              }
              allCards.push(...coderResult.cards);
            }

            // --- Auditor Evaluation ---
            // After all Coder tasks complete, run the Auditor in evaluation
            // mode to assess whether the work is actually complete.
            if (harnessSettings.evaluateAfterCoder && summaries.length > 0) {
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
                coderEvalResult = await withActiveSpan('subagent.auditor', {
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
                      memoryScope: buildMemoryScope(chatId, repoRef.current, branchInfoRef.current?.currentBranch),
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
                if (coderEvalResult) {
                  const completedEvaluation = coderEvalResult;
                  updateVerificationStateForChat(chatId, (state) =>
                    recordVerificationGateResult(
                      state,
                      'auditor',
                      completedEvaluation.verdict === 'complete' ? 'passed' : 'failed',
                      completedEvaluation.summary,
                    ),
                  );
                  appendRunEvent(chatId, {
                    type: 'subagent.completed',
                    executionId: auditorExecutionId,
                    agent: 'auditor',
                    summary: summarizeToolResultPreview(coderEvalResult.summary),
                  });
                } else {
                  updateVerificationStateForChat(chatId, (state) =>
                    recordVerificationGateResult(
                      state,
                      'auditor',
                      'inconclusive',
                      'Auditor evaluation returned no result.',
                    ),
                  );
                  appendRunEvent(chatId, {
                    type: 'subagent.failed',
                    executionId: auditorExecutionId,
                    agent: 'auditor',
                    error: 'Auditor returned no evaluation.',
                  });
                }
              } catch {
                updateVerificationStateForChat(chatId, (state) =>
                  recordVerificationGateResult(
                    state,
                    'auditor',
                    'inconclusive',
                    'Auditor evaluation failed.',
                  ),
                );
                appendRunEvent(chatId, {
                  type: 'subagent.failed',
                  executionId: auditorExecutionId,
                  agent: 'auditor',
                  error: 'Evaluation failed.',
                });
                // Fail-open: if evaluation fails, Coder result stands as-is
              }

              // Append evaluation verdict to summaries
              if (coderEvalResult) {
                const evalLine = `\n[Evaluation: ${coderEvalResult.verdict.toUpperCase()}] ${coderEvalResult.summary}`;
                const gapLines = coderEvalResult.gaps.length > 0
                  ? coderEvalResult.gaps.map(g => `  - ${g}`).join('\n')
                  : '';
                summaries.push(evalLine + (gapLines ? `\n${gapLines}` : ''));
              }
            }

            // --- Build structured DelegationOutcome for coder ---
            const coderOutcome: DelegationOutcome = (() => {
              // Derive status
              let status: DelegationStatus;
              if (coderEvalResult) {
                status = coderEvalResult.verdict === 'complete' ? 'complete' : 'incomplete';
              } else if (allCriteriaResults.length > 0) {
                status = allCriteriaResults.every(r => r.passed) ? 'complete' : 'incomplete';
              } else {
                status = 'inconclusive';
              }

              // Build evidence
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

              // Build checks
              const checks: DelegationCheck[] = allCriteriaResults.map(cr => ({
                id: cr.id,
                passed: cr.passed,
                exitCode: cr.exitCode,
                output: cr.output,
              }));

              // Build gate verdicts
              const gateVerdicts: DelegationGateVerdict[] = [];
              if (coderEvalResult) {
                gateVerdicts.push({
                  gate: 'auditor',
                  outcome: coderEvalResult.verdict === 'complete' ? 'passed' : 'failed',
                  summary: coderEvalResult.summary,
                });
              }

              // Missing requirements
              const missingRequirements: string[] = coderEvalResult?.gaps ?? allCriteriaResults
                .filter(cr => !cr.passed)
                .map(cr => `Check failed: ${cr.id}`);

              // Next required action
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
                  verificationCommandsById: verificationCommandsById.size > 0
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

        } catch (err) {
          const isAbort = err instanceof DOMException && err.name === 'AbortError';
          if (isAbort || abortRef.current) {
            const abortOutcome: DelegationOutcome = {
              agent: 'coder',
              status: 'inconclusive',
              summary: 'Coder cancelled by user.',
              evidence: [],
              checks: [],
              gateVerdicts: [],
              missingRequirements: [],
              nextRequiredAction: null,
              rounds: 0,
              checkpoints: 0,
              elapsedMs: Date.now() - coderStartMs,
            };
            toolExecResult = {
              text: formatCompactDelegationToolResult({
                agent: 'coder',
                outcome: abortOutcome,
              }),
              card: buildDelegationResultCard({
                agent: 'coder',
                outcome: abortOutcome,
              }),
              delegationOutcome: abortOutcome,
            };
            appendRunEvent(chatId, {
              type: 'subagent.completed',
              executionId,
              agent: 'coder',
              summary: 'Cancelled by user.',
              delegationOutcome: abortOutcome,
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
    } else if (toolCall.call.tool === 'plan_tasks') {
      // --- Task Graph Execution ---
      const executionId = createId();
      const graphArgs = toolCall.call.args;

      emitRunEngineEvent({
        type: 'DELEGATION_STARTED',
        timestamp: Date.now(),
        agent: 'task_graph',
      });

      try {
        // Validate the graph
        const validationErrors = validateTaskGraph(graphArgs.tasks);
        if (validationErrors.length > 0) {
          const errorMessages = validationErrors.map((e) => `- ${e.message}`).join('\n');
          toolExecResult = {
            text: `[Tool Error] Invalid task graph:\n${errorMessages}`,
          };
        } else {
          const currentSandboxId = sandboxIdRef.current;
          const hasCoderTasks = graphArgs.tasks.some((task) => task.agent === 'coder');
          if (hasCoderTasks && !currentSandboxId) {
            toolExecResult = { text: '[Tool Error] No sandbox available for task graph execution.' };
          } else {
            appendRunEvent(chatId, {
              type: 'subagent.started',
              executionId,
              agent: 'task_graph',
              detail: `Task graph: ${graphArgs.tasks.length} tasks`,
            });

            if (hasCoderTasks) {
              updateVerificationStateForChat(chatId, (state) =>
                activateVerificationGate(
                  state,
                  'auditor',
                  'Task graph started; auditor evaluation pending.',
                ),
              );
              lastCoderStateRef.current = null;
            }

            const harnessProvider = lockedProviderForChat || getActiveProvider();
            const harnessModelId = resolvedModelForChat || undefined;
            const harnessSettings = hasCoderTasks
              ? resolveHarnessSettings(harnessProvider, harnessModelId)
              : null;
            const verificationCriteria = hasCoderTasks
              ? buildVerificationAcceptanceCriteria(verificationPolicy, 'always')
              : [];
            const graphNodeById = new Map(graphArgs.tasks.map((task) => [task.id, task] as const));
            let latestGraphDiffPaths: string[] | undefined;

            // Track which tasks are active for aggregated status
            const activeTasks = new Map<string, string>();

            // Shared memory scope for this graph run. Records from earlier
            // nodes can be retrieved by later nodes via `taskGraphId` match.
            const graphMemoryScope = buildMemoryScope(
              chatId,
              repoRef.current,
              branchInfoRef.current?.currentBranch,
              { taskGraphId: executionId },
            );

            // Build the task executor that bridges to existing agent runners
            const taskExecutor: TaskExecutor = async (node, enrichedContext, taskSignal) => {
              const nodeMemoryLine = await retrieveMemoryKnownContextLine(
                graphMemoryScope,
                node.agent,
                node.task,
                node.files,
                { taskGraphId: executionId, taskId: node.id },
              );
              const memoryEnrichedContext = withMemoryContext(enrichedContext, nodeMemoryLine) ?? enrichedContext;
              if (node.agent === 'explorer') {
                const explorerStartMs = Date.now();
                let explorerResult;
                try {
                  explorerResult = await withActiveSpan('taskgraph.explorer', {
                    scope: 'push.delegation',
                    kind: SpanKind.INTERNAL,
                    attributes: {
                      'push.agent.role': 'explorer',
                      'push.taskgraph.node_id': node.id,
                      'push.provider': lockedProviderForChat,
                      'push.model': resolvedModelForChat,
                    },
                  }, async (span) => {
                    const result = await runExplorerAgent(
                      {
                        task: node.task,
                        files: node.files ?? [],
                        deliverable: node.deliverable,
                        knownContext: memoryEnrichedContext,
                        constraints: node.constraints,
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
                      currentSandboxId,
                      repoRef.current || '',
                      {
                        onStatus: (phase) => {
                          activeTasks.set(node.id, phase);
                          const taskLabels = [...activeTasks.entries()].map(([id, p]) => `${id}: ${p}`).join(' | ');
                          updateAgentStatus(
                            { active: true, phase: 'Task graph', detail: taskLabels },
                            { chatId, source: 'explorer' },
                          );
                        },
                        signal: taskSignal,
                      },
                    );
                    setSpanAttributes(span, { 'push.round_count': result.rounds });
                    span.setStatus({ code: SpanStatusCode.OK });
                    return result;
                  });
                } finally {
                  activeTasks.delete(node.id);
                }

                appendInlineDelegationCards(setConversations, chatId, explorerResult.cards);

                const explorerOutcome: DelegationOutcome = {
                  agent: 'explorer',
                  status: explorerResult.rounds > 0 && explorerResult.summary.trim()
                    ? 'complete'
                    : 'inconclusive',
                  summary: explorerResult.summary,
                  evidence: explorerResult.summary.trim()
                    ? [{ kind: 'observation', label: 'Investigation findings' }]
                    : [],
                  checks: [],
                  gateVerdicts: [],
                  missingRequirements: [],
                  nextRequiredAction: null,
                  rounds: explorerResult.rounds,
                  checkpoints: 0,
                  elapsedMs: Date.now() - explorerStartMs,
                };
                updateVerificationStateForChat(chatId, (state) =>
                  recordVerificationArtifact(
                    state,
                    `Explorer produced evidence: ${summarizeToolResultPreview(explorerResult.summary)}`,
                  ),
                );

                return {
                  summary: explorerResult.summary,
                  delegationOutcome: explorerOutcome,
                  rounds: explorerResult.rounds,
                };
              } else {
                // Coder agent
                const nodeStartMs = Date.now();
                const effectiveAcceptanceCriteria = mergeAcceptanceCriteria(
                  node.acceptanceCriteria,
                  verificationCriteria,
                );
                const criteriaCommandById = new Map(
                  effectiveAcceptanceCriteria.map((criterion) => [criterion.id, criterion.check]),
                );
                let coderResult;
                try {
                  coderResult = await withActiveSpan('taskgraph.coder', {
                    scope: 'push.delegation',
                    kind: SpanKind.INTERNAL,
                    attributes: {
                      'push.agent.role': 'coder',
                      'push.taskgraph.node_id': node.id,
                      'push.provider': lockedProviderForChat,
                      'push.model': resolvedModelForChat,
                    },
                  }, async (span) => {
                    const result = await runCoderAgent(
                      node.task,
                      currentSandboxId!,
                      node.files ?? [],
                      (phase) => {
                        activeTasks.set(node.id, phase);
                        const taskLabels = [...activeTasks.entries()].map(([id, p]) => `${id}: ${p}`).join(' | ');
                        updateAgentStatus(
                          { active: true, phase: 'Task graph', detail: taskLabels },
                          { chatId, source: 'coder' },
                        );
                      },
                      agentsMdRef.current || undefined,
                      taskSignal,
                      undefined,
                      effectiveAcceptanceCriteria,
                      (state) => { lastCoderStateRef.current = state; },
                      lockedProviderForChat,
                      resolvedModelForChat || undefined,
                      {
                        deliverable: node.deliverable,
                        knownContext: memoryEnrichedContext,
                        constraints: node.constraints,
                        branchContext: branchInfoRef.current?.currentBranch ? {
                          activeBranch: branchInfoRef.current.currentBranch,
                          defaultBranch: branchInfoRef.current.defaultBranch || 'main',
                          protectMain: isMainProtectedRef.current,
                        } : undefined,
                        instructionFilename: instructionFilenameRef.current || undefined,
                        harnessSettings: harnessSettings || undefined,
                        verificationPolicy,
                      },
                    );
                    setSpanAttributes(span, {
                      'push.round_count': result.rounds,
                      'push.card_count': result.cards.length,
                      'push.checkpoint_count': result.checkpoints,
                      'push.criteria_count': result.criteriaResults?.length,
                    });
                    span.setStatus({ code: SpanStatusCode.OK });
                    return result;
                  });
                } finally {
                  activeTasks.delete(node.id);
                }

                appendInlineDelegationCards(setConversations, chatId, coderResult.cards);

                let taskDiff: string | null = null;
                try {
                  const diffResult = await getSandboxDiff(currentSandboxId!);
                  taskDiff = diffResult.diff || null;
                } catch {
                  // Verification state can still update from summaries/checks.
                }
                if (taskDiff) {
                  const touchedPaths = extractChangedPathsFromDiff(taskDiff);
                  latestGraphDiffPaths = touchedPaths;
                  updateVerificationStateForChat(chatId, (state) =>
                    recordVerificationMutation(
                      state,
                      {
                        source: 'coder',
                        touchedPaths,
                        detail: `Task graph node "${node.id}" mutated the workspace.`,
                      },
                    ),
                  );
                }
                updateVerificationStateForChat(chatId, (state) =>
                  recordVerificationArtifact(
                    state,
                    `Coder produced evidence: ${summarizeToolResultPreview(coderResult.summary)}`,
                  ),
                );
                for (const result of coderResult.criteriaResults ?? []) {
                  const command = criteriaCommandById.get(result.id);
                  if (!command) continue;
                  updateVerificationStateForChat(chatId, (state) =>
                    recordVerificationCommandResult(
                      state,
                      command,
                      {
                        exitCode: result.exitCode,
                        detail: `${result.id} exited with code ${result.exitCode}.`,
                      },
                    ),
                  );
                }

                const status: DelegationStatus = !coderResult.criteriaResults?.length
                  ? 'inconclusive'
                  : coderResult.criteriaResults.every((result) => result.passed)
                    ? 'complete'
                    : 'incomplete';
                const checks: DelegationCheck[] = (coderResult.criteriaResults ?? []).map((result) => ({
                  id: result.id,
                  passed: result.passed,
                  exitCode: result.exitCode,
                  output: result.output,
                }));
                const evidence: DelegationEvidence[] = [];
                if (taskDiff) {
                  evidence.push({
                    kind: 'diff',
                    label: 'Workspace diff',
                    detail: summarizeToolResultPreview(taskDiff),
                  });
                }
                for (const check of checks) {
                  evidence.push({
                    kind: 'test',
                    label: check.id,
                    detail: check.output,
                  });
                }
                const missingRequirements = checks
                  .filter((check) => !check.passed)
                  .map((check) => `Check failed: ${check.id}`);
                const coderOutcome: DelegationOutcome = {
                  agent: 'coder',
                  status,
                  summary: coderResult.summary,
                  evidence,
                  checks,
                  gateVerdicts: [],
                  missingRequirements,
                  nextRequiredAction: status === 'incomplete' ? 'Fix failing checks' : null,
                  rounds: coderResult.rounds,
                  checkpoints: coderResult.checkpoints,
                  elapsedMs: Date.now() - nodeStartMs,
                };

                return {
                  summary: coderResult.summary,
                  delegationOutcome: coderOutcome,
                  rounds: coderResult.rounds,
                };
              }
            };

            // Execute the task graph
            const graphResult = await withActiveSpan('taskgraph.execute', {
              scope: 'push.delegation',
              kind: SpanKind.INTERNAL,
              attributes: {
                'push.taskgraph.node_count': graphArgs.tasks.length,
                'push.provider': lockedProviderForChat,
                'push.model': resolvedModelForChat,
              },
            }, async (span) => {
              const result = await executeTaskGraph(
                graphArgs.tasks,
                taskExecutor,
                {
                  maxParallelExplorers: 3,
                  signal: abortControllerRef.current?.signal,
                  onProgress: (event) => {
                    const node = event.taskId ? graphNodeById.get(event.taskId) : undefined;
                    switch (event.type) {
                      case 'task_ready':
                        if (event.taskId && node) {
                          appendRunEvent(chatId, {
                            type: 'task_graph.task_ready',
                            executionId,
                            taskId: event.taskId,
                            agent: node.agent,
                            detail: event.detail,
                          });
                        }
                        break;
                      case 'task_started':
                        updateAgentStatus(
                          { active: true, phase: `Task graph: starting ${event.taskId}`, detail: event.detail },
                          { chatId, source: 'coder' },
                        );
                        if (event.taskId && node) {
                          appendRunEvent(chatId, {
                            type: 'task_graph.task_started',
                            executionId,
                            taskId: event.taskId,
                            agent: node.agent,
                            detail: event.detail,
                          });
                        }
                        break;
                      case 'task_completed':
                        if (event.taskId && node) {
                          appendRunEvent(chatId, {
                            type: 'task_graph.task_completed',
                            executionId,
                            taskId: event.taskId,
                            agent: node.agent,
                            summary: summarizeToolResultPreview(event.detail ?? ''),
                            elapsedMs: event.elapsedMs,
                          });
                        }
                        break;
                      case 'task_failed':
                        if (event.taskId && node) {
                          appendRunEvent(chatId, {
                            type: 'task_graph.task_failed',
                            executionId,
                            taskId: event.taskId,
                            agent: node.agent,
                            error: summarizeToolResultPreview(event.detail ?? 'Task failed.'),
                            elapsedMs: event.elapsedMs,
                          });
                        }
                        break;
                      case 'task_cancelled':
                        if (event.taskId && node) {
                          appendRunEvent(chatId, {
                            type: 'task_graph.task_cancelled',
                            executionId,
                            taskId: event.taskId,
                            agent: node.agent,
                            reason: summarizeToolResultPreview(event.detail ?? 'Task cancelled.'),
                            elapsedMs: event.elapsedMs,
                          });
                        }
                        break;
                      case 'graph_complete':
                        break;
                    }
                  },
                },
              );
              setSpanAttributes(span, {
                'push.taskgraph.success': result.success,
                'push.taskgraph.total_rounds': result.totalRounds,
                'push.taskgraph.wall_time_ms': result.wallTimeMs,
              });
              span.setStatus({ code: SpanStatusCode.OK });
              return result;
            });
            appendRunEvent(chatId, {
              type: 'task_graph.graph_completed',
              executionId,
              summary: graphResult.aborted
                ? 'Task graph cancelled by user.'
                : graphResult.success
                  ? 'All tasks completed successfully.'
                  : summarizeToolResultPreview(graphResult.summary),
              success: graphResult.success,
              aborted: graphResult.aborted,
              nodeCount: graphResult.nodeStates.size,
              totalRounds: graphResult.totalRounds,
              wallTimeMs: graphResult.wallTimeMs,
            });

            if (graphMemoryScope && latestGraphDiffPaths && latestGraphDiffPaths.length > 0) {
              await runContextMemoryBestEffort('invalidating task-graph memory after file changes', () =>
                invalidateMemoryForChangedFiles({
                  scope: {
                    repoFullName: graphMemoryScope.repoFullName,
                    branch: graphMemoryScope.branch,
                    chatId: graphMemoryScope.chatId,
                  },
                  changedPaths: latestGraphDiffPaths!,
                  reason: 'Task graph coder nodes updated file-backed context.',
                }),
              );
            }

            // Persist typed memory records for every completed node so
            // later (out-of-graph) delegations can retrieve them.
            if (graphMemoryScope) {
              for (const nodeState of graphResult.nodeStates.values()) {
                await runContextMemoryBestEffort(`persisting task-graph memory for ${nodeState.node.id}`, () =>
                  writeTaskGraphNodeMemory({
                    scope: graphMemoryScope,
                    nodeState,
                  }),
                );
              }
            }

            let graphAuditResult: EvaluationResult | null = null;
            if (hasCoderTasks) {
              const coderNodeStates = [...graphResult.nodeStates.entries()].filter(
                ([, state]) => state.node.agent === 'coder',
              );

              if (graphResult.aborted || abortRef.current) {
                updateVerificationStateForChat(chatId, (state) =>
                  recordVerificationGateResult(
                    state,
                    'auditor',
                    'inconclusive',
                    'Task graph cancelled by user.',
                  ),
                );
              } else if (coderNodeStates.length > 0) {
                const auditorExecutionId = createId();
                try {
                  appendRunEvent(chatId, {
                    type: 'subagent.started',
                    executionId: auditorExecutionId,
                    agent: 'auditor',
                    detail: 'Evaluating task graph output',
                  });
                  updateAgentStatus(
                    { active: true, phase: 'Evaluating task graph output...' },
                    { chatId, source: 'coder' },
                  );

                  let evalDiff: string | null = null;
                  try {
                    const diffResult = await getSandboxDiff(currentSandboxId!);
                    evalDiff = diffResult.diff || null;
                  } catch {
                    // Evaluation can still proceed without a diff snapshot.
                  }

                  const combinedTask = coderNodeStates
                    .map(([id, state]) => `[${id}] ${state.node.task}`)
                    .join('\n\n');
                  const combinedSummary = coderNodeStates
                    .map(([id, state]) => `[${id}] ${state.result ?? state.error ?? ''}`)
                    .join('\n');
                  const aggregatedChecks = coderNodeStates.flatMap(([id, state]) =>
                    (state.delegationOutcome?.checks ?? []).map((check) => ({
                      id: `${id}:${check.id}`,
                      passed: check.passed,
                      output: check.output ?? '',
                    })),
                  );
                  const totalCoderRounds = coderNodeStates.reduce(
                    (sum, [, state]) => sum + (state.delegationOutcome?.rounds ?? 0),
                    0,
                  );
                  const evalWorkingMemory = coderNodeStates.length <= 1
                    ? lastCoderStateRef.current
                    : null;
                  graphAuditResult = await withActiveSpan('subagent.auditor', {
                    scope: 'push.delegation',
                    kind: SpanKind.INTERNAL,
                    attributes: {
                      'push.agent.role': 'auditor',
                      'push.execution_id': auditorExecutionId,
                      'push.provider': lockedProviderForChat,
                      'push.model': resolvedModelForChat,
                      'push.criteria_count': aggregatedChecks.length,
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
                        coderRounds: totalCoderRounds,
                        coderMaxRounds: (harnessSettings?.maxCoderRounds ?? 0) * Math.max(coderNodeStates.length, 1),
                        criteriaResults: aggregatedChecks.length > 0 ? aggregatedChecks : undefined,
                        verificationPolicy,
                        memoryScope: buildMemoryScope(
                          chatId,
                          repoRef.current,
                          branchInfoRef.current?.currentBranch,
                          { taskGraphId: graphMemoryScope?.taskGraphId ?? executionId },
                        ),
                      },
                    );
                    setSpanAttributes(span, {
                      'push.auditor.verdict': result.verdict,
                      'push.auditor.gap_count': result.gaps.length,
                    });
                    span.setStatus({ code: SpanStatusCode.OK });
                    return result;
                  });

                  updateVerificationStateForChat(chatId, (state) =>
                    recordVerificationGateResult(
                      state,
                      'auditor',
                      graphAuditResult?.verdict === 'complete' ? 'passed' : 'failed',
                      graphAuditResult?.summary ?? 'Auditor evaluation returned no result.',
                    ),
                  );
                  appendRunEvent(chatId, {
                    type: 'subagent.completed',
                    executionId: auditorExecutionId,
                    agent: 'auditor',
                    summary: summarizeToolResultPreview(graphAuditResult.summary),
                  });
                } catch {
                  updateVerificationStateForChat(chatId, (state) =>
                    recordVerificationGateResult(
                      state,
                      'auditor',
                      'inconclusive',
                      'Auditor evaluation failed.',
                    ),
                  );
                  appendRunEvent(chatId, {
                    type: 'subagent.failed',
                    executionId: auditorExecutionId,
                    agent: 'auditor',
                    error: 'Evaluation failed.',
                  });
                }
              }
            }

            // Aggregate per-node delegation outcomes into a graph-level outcome
            const graphOutcome: DelegationOutcome = (() => {
              const nodeOutcomes = [...graphResult.nodeStates.values()]
                .filter((s) => s.delegationOutcome)
                .map((s) => s.delegationOutcome!);
              const evidence: DelegationEvidence[] = nodeOutcomes.flatMap((o) => o.evidence);
              const checks: DelegationCheck[] = nodeOutcomes.flatMap((o) => o.checks);
              const gateVerdicts: DelegationGateVerdict[] = nodeOutcomes.flatMap((o) => o.gateVerdicts);
              if (graphAuditResult) {
                gateVerdicts.push({
                  gate: 'auditor',
                  outcome: graphAuditResult.verdict === 'complete' ? 'passed' : 'failed',
                  summary: graphAuditResult.summary,
                });
              }
              const status: DelegationStatus = graphResult.aborted
                ? 'inconclusive'
                : graphAuditResult
                  ? graphAuditResult.verdict === 'complete' ? 'complete' : 'incomplete'
                  : graphResult.success
                    ? 'complete'
                    : 'incomplete';
              const missingRequirements = graphResult.aborted
                ? []
                : graphAuditResult?.gaps?.length
                  ? graphAuditResult.gaps
                  : [...graphResult.nodeStates.values()]
                      .filter((s) => s.status === 'failed' || s.status === 'cancelled')
                      .map((s) => `[${s.node.id}] ${s.error ?? 'failed'}`);
              const evaluationSummary = graphAuditResult
                ? `\n[Evaluation: ${graphAuditResult.verdict.toUpperCase()}] ${graphAuditResult.summary}`
                : '';

              // Tag the outcome agent based on what actually ran, not a static default
              const ranCoder = [...graphResult.nodeStates.values()].some(
                (s) => s.node.agent === 'coder' && (s.status === 'completed' || s.status === 'failed'),
              );

              return {
                agent: ranCoder ? 'coder' as const : 'explorer' as const,
                status,
                summary: `${graphResult.summary}${evaluationSummary}`,
                evidence,
                checks,
                gateVerdicts,
                missingRequirements,
                nextRequiredAction: graphResult.aborted
                  ? null
                  : status === 'incomplete'
                    ? graphAuditResult?.gaps?.length
                      ? 'Address gaps identified by auditor'
                      : 'Address failed tasks in the graph'
                    : null,
                rounds: graphResult.totalRounds,
                checkpoints: 0,
                elapsedMs: graphResult.wallTimeMs,
              };
            })();

            toolExecResult = {
              text: formatCompactDelegationToolResult({
                agent: 'task_graph',
                outcome: graphOutcome,
                taskCount: graphResult.nodeStates.size,
              }),
              card: buildDelegationResultCard({
                agent: 'task_graph',
                outcome: graphOutcome,
                taskCount: graphResult.nodeStates.size,
              }),
              delegationOutcome: graphOutcome,
            };
            appendRunEvent(chatId, {
              type: 'subagent.completed',
              executionId,
              agent: 'task_graph',
              summary: summarizeToolResultPreview(toolExecResult.text),
              delegationOutcome: graphOutcome,
            });
          }
        }
      } catch (err) {
        const isAbort = err instanceof DOMException && err.name === 'AbortError';
        if (isAbort || abortRef.current) {
          toolExecResult = {
            text: '[Tool Result — plan_tasks]\nTask graph execution cancelled by user.',
          };
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          toolExecResult = { text: `[Tool Error] Task graph execution failed: ${msg}` };
          appendRunEvent(chatId, {
            type: 'subagent.failed',
            executionId,
            agent: 'task_graph',
            error: summarizeToolResultPreview(msg),
          });
        }
      }
    }

    return toolExecResult;
  }, [abortControllerRef, abortRef, agentsMdRef, appendRunEvent, branchInfoRef, emitRunEngineEvent, getVerificationPolicyForChat, instructionFilenameRef, isMainProtectedRef, lastCoderStateRef, mergeAcceptanceCriteria, repoRef, sandboxIdRef, setConversations, updateAgentStatus, updateVerificationStateForChat]);

  return { executeDelegateCall };
}
