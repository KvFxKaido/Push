import type React from 'react';
import { useCallback } from 'react';
import { getActiveProvider, type ActiveProvider } from '@/lib/orchestrator';
import { getSandboxDiff } from '@/lib/sandbox-client';
import { runCoderAgent } from '@/lib/coder-agent';
import { runExplorerAgent } from '@/lib/explorer-agent';
import {
  handleExplorerDelegation,
  type ExplorerHandlerContext,
  type ExplorerToolCall,
} from '@/lib/explorer-delegation-handler';
import {
  handleCoderDelegation,
  mergeAcceptanceCriteria,
  type CoderHandlerContext,
  type CoderToolCall,
} from '@/lib/coder-delegation-handler';
import { handleCoderAuditor, type AuditorHandlerContext } from '@/lib/auditor-delegation-handler';
import { type AnyToolCall } from '@/lib/tool-dispatch';
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
  writeTaskGraphNodeMemory,
  writeCoderMemory,
  invalidateMemoryForChangedFiles,
} from '@/lib/context-memory';
import {
  buildMemoryScope,
  retrieveMemoryKnownContextLine,
  runContextMemoryBestEffort,
  withMemoryContext,
} from '@/lib/memory-context-helpers';
import {
  activateVerificationGate,
  buildVerificationAcceptanceCriteria,
  extractChangedPathsFromDiff,
  recordVerificationArtifact,
  recordVerificationCommandResult,
  recordVerificationGateResult,
  recordVerificationMutation,
} from '@/lib/verification-runtime';
import { createId } from '@/hooks/chat-persistence';
import { setSpanAttributes, withActiveSpan, SpanKind, SpanStatusCode } from '@/lib/tracing';
import {
  correlationToSpanAttributes,
  extendCorrelation,
  type CorrelationContext,
} from '@push/lib/correlation-context';
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
              toolExecResult = {
                text: '[Tool Error] No sandbox available for task graph execution.',
              };
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
              const graphNodeById = new Map(
                graphArgs.tasks.map((task) => [task.id, task] as const),
              );
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
                const memoryEnrichedContext =
                  withMemoryContext(enrichedContext, nodeMemoryLine) ?? enrichedContext;
                if (node.agent === 'explorer') {
                  const explorerStartMs = Date.now();
                  let explorerResult;
                  try {
                    const nodeCorrelation = extendCorrelation(baseCorrelation, {
                      executionId,
                      taskGraphId: executionId,
                      taskId: node.id,
                    });
                    explorerResult = await withActiveSpan(
                      'taskgraph.explorer',
                      {
                        scope: 'push.delegation',
                        kind: SpanKind.INTERNAL,
                        attributes: {
                          ...correlationToSpanAttributes(nodeCorrelation),
                          'push.agent.role': 'explorer',
                          'push.taskgraph.node_id': node.id,
                          'push.provider': lockedProviderForChat,
                          'push.model': resolvedModelForChat,
                        },
                      },
                      async (span) => {
                        const result = await runExplorerAgent(
                          {
                            task: node.task,
                            files: node.files ?? [],
                            deliverable: node.deliverable,
                            knownContext: memoryEnrichedContext,
                            constraints: node.constraints,
                            branchContext: branchInfoRef.current?.currentBranch
                              ? {
                                  activeBranch: branchInfoRef.current.currentBranch,
                                  defaultBranch: branchInfoRef.current.defaultBranch || 'main',
                                  protectMain: isMainProtectedRef.current,
                                }
                              : undefined,
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
                              const taskLabels = [...activeTasks.entries()]
                                .map(([id, p]) => `${id}: ${p}`)
                                .join(' | ');
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
                      },
                    );
                  } finally {
                    activeTasks.delete(node.id);
                  }

                  appendInlineDelegationCards(setConversations, chatId, explorerResult.cards);

                  const explorerOutcome: DelegationOutcome = {
                    agent: 'explorer',
                    status:
                      explorerResult.rounds > 0 && explorerResult.summary.trim()
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
                    const nodeCorrelation = extendCorrelation(baseCorrelation, {
                      executionId,
                      taskGraphId: executionId,
                      taskId: node.id,
                    });
                    coderResult = await withActiveSpan(
                      'taskgraph.coder',
                      {
                        scope: 'push.delegation',
                        kind: SpanKind.INTERNAL,
                        attributes: {
                          ...correlationToSpanAttributes(nodeCorrelation),
                          'push.agent.role': 'coder',
                          'push.taskgraph.node_id': node.id,
                          'push.provider': lockedProviderForChat,
                          'push.model': resolvedModelForChat,
                        },
                      },
                      async (span) => {
                        const result = await runCoderAgent(
                          node.task,
                          currentSandboxId!,
                          node.files ?? [],
                          (phase) => {
                            activeTasks.set(node.id, phase);
                            const taskLabels = [...activeTasks.entries()]
                              .map(([id, p]) => `${id}: ${p}`)
                              .join(' | ');
                            updateAgentStatus(
                              { active: true, phase: 'Task graph', detail: taskLabels },
                              { chatId, source: 'coder' },
                            );
                          },
                          agentsMdRef.current || undefined,
                          taskSignal,
                          undefined,
                          effectiveAcceptanceCriteria,
                          (state) => {
                            lastCoderStateRef.current = state;
                          },
                          lockedProviderForChat,
                          resolvedModelForChat || undefined,
                          {
                            deliverable: node.deliverable,
                            knownContext: memoryEnrichedContext,
                            constraints: node.constraints,
                            branchContext: branchInfoRef.current?.currentBranch
                              ? {
                                  activeBranch: branchInfoRef.current.currentBranch,
                                  defaultBranch: branchInfoRef.current.defaultBranch || 'main',
                                  protectMain: isMainProtectedRef.current,
                                }
                              : undefined,
                            instructionFilename: instructionFilenameRef.current || undefined,
                            harnessSettings: harnessSettings || undefined,
                            verificationPolicy,
                            correlation: nodeCorrelation,
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
                      },
                    );
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
                      recordVerificationMutation(state, {
                        source: 'coder',
                        touchedPaths,
                        detail: `Task graph node "${node.id}" mutated the workspace.`,
                      }),
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
                      recordVerificationCommandResult(state, command, {
                        exitCode: result.exitCode,
                        detail: `${result.id} exited with code ${result.exitCode}.`,
                      }),
                    );
                  }

                  const status: DelegationStatus = !coderResult.criteriaResults?.length
                    ? 'inconclusive'
                    : coderResult.criteriaResults.every((result) => result.passed)
                      ? 'complete'
                      : 'incomplete';
                  const checks: DelegationCheck[] = (coderResult.criteriaResults ?? []).map(
                    (result) => ({
                      id: result.id,
                      passed: result.passed,
                      exitCode: result.exitCode,
                      output: result.output,
                    }),
                  );
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
              const graphCorrelation = extendCorrelation(baseCorrelation, {
                executionId,
                taskGraphId: executionId,
              });
              const graphResult = await withActiveSpan(
                'taskgraph.execute',
                {
                  scope: 'push.delegation',
                  kind: SpanKind.INTERNAL,
                  attributes: {
                    ...correlationToSpanAttributes(graphCorrelation),
                    'push.taskgraph.node_count': graphArgs.tasks.length,
                    'push.provider': lockedProviderForChat,
                    'push.model': resolvedModelForChat,
                  },
                },
                async (span) => {
                  const result = await executeTaskGraph(graphArgs.tasks, taskExecutor, {
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
                            {
                              active: true,
                              phase: `Task graph: starting ${event.taskId}`,
                              detail: event.detail,
                            },
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
                  });
                  setSpanAttributes(span, {
                    'push.taskgraph.success': result.success,
                    'push.taskgraph.total_rounds': result.totalRounds,
                    'push.taskgraph.wall_time_ms': result.wallTimeMs,
                  });
                  span.setStatus({ code: SpanStatusCode.OK });
                  return result;
                },
              );
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
                await runContextMemoryBestEffort(
                  'invalidating task-graph memory after file changes',
                  () =>
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
                  await runContextMemoryBestEffort(
                    `persisting task-graph memory for ${nodeState.node.id}`,
                    () =>
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
                    const evalWorkingMemory =
                      coderNodeStates.length <= 1 ? lastCoderStateRef.current : null;
                    const graphAuditorCorrelation = extendCorrelation(baseCorrelation, {
                      executionId: auditorExecutionId,
                      taskGraphId: executionId,
                    });
                    graphAuditResult = await withActiveSpan(
                      'subagent.auditor',
                      {
                        scope: 'push.delegation',
                        kind: SpanKind.INTERNAL,
                        attributes: {
                          ...correlationToSpanAttributes(graphAuditorCorrelation),
                          'push.agent.role': 'auditor',
                          'push.provider': lockedProviderForChat,
                          'push.model': resolvedModelForChat,
                          'push.criteria_count': aggregatedChecks.length,
                        },
                      },
                      async (span) => {
                        const result = await runAuditorEvaluation(
                          combinedTask,
                          combinedSummary,
                          evalWorkingMemory,
                          evalDiff,
                          (phase) =>
                            updateAgentStatus({ active: true, phase }, { chatId, source: 'coder' }),
                          {
                            providerOverride: lockedProviderForChat,
                            modelOverride: resolvedModelForChat || undefined,
                            coderRounds: totalCoderRounds,
                            coderMaxRounds:
                              (harnessSettings?.maxCoderRounds ?? 0) *
                              Math.max(coderNodeStates.length, 1),
                            criteriaResults:
                              aggregatedChecks.length > 0 ? aggregatedChecks : undefined,
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
                      },
                    );

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
                const gateVerdicts: DelegationGateVerdict[] = nodeOutcomes.flatMap(
                  (o) => o.gateVerdicts,
                );
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
                    ? graphAuditResult.verdict === 'complete'
                      ? 'complete'
                      : 'incomplete'
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
                  (s) =>
                    s.node.agent === 'coder' && (s.status === 'completed' || s.status === 'failed'),
                );

                return {
                  agent: ranCoder ? ('coder' as const) : ('explorer' as const),
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
    },
    [
      abortControllerRef,
      abortRef,
      agentsMdRef,
      appendRunEvent,
      branchInfoRef,
      buildAuditorContext,
      buildCoderContext,
      buildExplorerContext,
      emitRunEngineEvent,
      getVerificationPolicyForChat,
      instructionFilenameRef,
      isMainProtectedRef,
      lastCoderStateRef,
      repoRef,
      sandboxIdRef,
      setConversations,
      updateAgentStatus,
      updateVerificationStateForChat,
    ],
  );

  return { executeDelegateCall };
}
