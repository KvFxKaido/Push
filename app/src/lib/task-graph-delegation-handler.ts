/**
 * Task-Graph delegation handler — Phase 5 of the useAgentDelegation
 * extraction track (see
 * `docs/decisions/useAgentDelegation Coupling Recon.md`, §"Recommended
 * Extraction Order — Phase 5: Task-Graph Handler").
 *
 * ## Design — end-to-end owner of the plan_tasks branch
 *
 * Unlike Phase 3 (Coder, which hands off mid-flight to an inline auditor
 * in the hook), Phase 5 owns the entire `plan_tasks` lifecycle: graph
 * validation, the taskExecutor closure (with TG Explorer + TG Coder
 * sub-seams), executeTaskGraph wiring, memory persistence, TG Auditor
 * evaluation, outcome aggregation, and the terminal `subagent.completed`
 * emission. The hook collapses to a single `handleTaskGraphDelegation`
 * call because the TG Auditor reads state that lives in the handler
 * (`graphResult.nodeStates`), so there's no reason to slice the arc.
 *
 * ## The `lastCoderStateRef` contract (Option A)
 *
 * The Phase 5 design spike (docs/decisions/Phase 5 Handoff - Task-Graph
 * Extraction.md) picked Option A: preserve the current
 * single-coder-node-vs-multi-node `evalWorkingMemory` policy byte-for-
 * byte. The ref stays hook-owned; this handler reaches the ref only
 * through three context callbacks:
 *
 *   - `resetCoderState()` — called once on entry when the graph has
 *     coder tasks, so a prior delegation's memory doesn't leak in.
 *   - `onCoderStateUpdate(state)` — passed into each TG Coder node's
 *     runCoderAgent invocation; the hook writes `lastCoderStateRef.current
 *     = state`.
 *   - `readLatestCoderState()` — called once in the TG Auditor branch
 *     near the `evalWorkingMemory` decision point.
 *
 * The TG Auditor still applies `coderNodeStates.length <= 1 ? ref : null`
 * (recon §Coupling Hazards #3). Multi-coder-node graphs pass null to
 * avoid misleading the evaluator with only the last-completing node's
 * state. Test 4 in useAgentDelegation.test.ts pins this invariant; any
 * incidental regression during extraction breaks that test.
 *
 * A future Option B may replace the ref with `Map<nodeId, CoderState>`
 * accumulation and propagate a new auditor-kernel signature. Until that
 * design lands, this handler deliberately preserves the lossy-but-
 * correct current behavior.
 *
 * ## Fitness rules
 *
 *   - **Boundary:** imports from `@/lib/*`, `@/hooks/chat-persistence`,
 *     `@push/lib/correlation-context`, and type-only from
 *     `@/lib/tool-dispatch` / `@/lib/orchestrator` /
 *     `@/lib/run-engine` / `@/lib/verification-policy`. Never imports
 *     `useAgentDelegation.ts` or any other hook. Re-uses
 *     `mergeAcceptanceCriteria` from `./coder-delegation-handler` (the
 *     Phase 3 home for that pure helper).
 *   - **API:** exports `TaskGraphHandlerContext`, `TaskGraphToolCall`,
 *     `HandleTaskGraphDelegationInput`, and the
 *     `handleTaskGraphDelegation` async handler. The build-context
 *     helper stays in the dispatcher (hook) so the one-way boundary
 *     holds.
 *   - **Policy stays in the hook:** the hook still decides which
 *     delegation branch to take (plan_tasks vs. coder vs. explorer).
 *     The handler is reactive within the plan_tasks branch.
 *   - **Behavior preservation:** byte-for-byte equivalent to the
 *     inline seam (lines 437–1185 pre-extraction). Four
 *     characterization tests (commit eb18e55) gate the regression:
 *     graph_completed envelope, per-node memory persistence, TG
 *     Auditor aggregated-inputs firing, and the single-vs-multi-node
 *     `evalWorkingMemory` policy.
 */

import type React from 'react';
import { type ActiveProvider } from '@/lib/orchestrator';
import { getSandboxDiff } from '@/lib/sandbox-client';
import { runCoderAgent } from '@/lib/coder-agent';
import { runExplorerAgent } from '@/lib/explorer-agent';
import { runAuditorEvaluation, type EvaluationResult } from '@/lib/auditor-agent';
import { resolveHarnessSettings } from '@/lib/model-capabilities';
import {
  validateTaskGraph,
  validateTaskGraphAgainstGoal,
  formatGoalRejection,
  executeTaskGraph,
  type TaskExecutor,
} from '@/lib/task-graph';
import type { UserGoalAnchor } from '@push/lib/user-goal-anchor';
import { summarizeToolResultPreview } from '@/lib/chat-run-events';
import {
  buildDelegationResultCard,
  formatCompactDelegationToolResult,
} from '@/lib/delegation-result';
import { writeTaskGraphNodeMemory, invalidateMemoryForChangedFiles } from '@/lib/context-memory';
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
import { setSpanAttributes, withActiveSpan, SpanKind, SpanStatusCode } from '@/lib/tracing';
import {
  correlationToSpanAttributes,
  extendCorrelation,
  type CorrelationContext,
} from '@push/lib/correlation-context';
import { createId } from '@/hooks/chat-persistence';
import { mergeAcceptanceCriteria } from '@/lib/coder-delegation-handler';
import type { AnyToolCall } from '@/lib/tool-dispatch';
import type { RunEngineEvent } from '@/lib/run-engine';
import type { VerificationPolicy } from '@/lib/verification-policy';
import type {
  AgentStatus,
  AgentStatusSource,
  ChatCard,
  CoderWorkingMemory,
  DelegationCheck,
  DelegationEvidence,
  DelegationGateVerdict,
  DelegationOutcome,
  DelegationStatus,
  RunEventInput,
  ToolExecutionResult,
  VerificationRuntimeState,
} from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Narrow tool-call shape for `plan_tasks` dispatch. */
export type TaskGraphToolCall = Extract<AnyToolCall, { call: { tool: 'plan_tasks' } }>;

/**
 * The ambient context passed to {@link handleTaskGraphDelegation}. All
 * refs and callbacks the handler reaches for are enumerated here so the
 * seam has zero implicit reach into the hook's closure. The three
 * coder-state hooks (`resetCoderState`, `onCoderStateUpdate`,
 * `readLatestCoderState`) bridge the hook's `lastCoderStateRef`
 * ownership into the handler's execution path without handing the ref
 * itself across the seam — see Phase 5 Handoff doc §"Open Design
 * Question" for the rationale.
 */
export interface TaskGraphHandlerContext {
  sandboxIdRef: React.MutableRefObject<string | null>;
  repoRef: React.MutableRefObject<string | null>;
  branchInfoRef: React.RefObject<
    { currentBranch?: string; defaultBranch?: string } | undefined | null
  >;
  isMainProtectedRef: React.MutableRefObject<boolean>;
  agentsMdRef: React.MutableRefObject<string | null>;
  instructionFilenameRef: React.MutableRefObject<string | null>;
  abortControllerRef: React.MutableRefObject<AbortController | null>;
  abortRef: React.MutableRefObject<boolean>;

  emitRunEngineEvent: (event: RunEngineEvent) => void;
  appendRunEvent: (chatId: string, event: RunEventInput) => void;
  updateAgentStatus: (
    status: AgentStatus,
    meta?: { chatId?: string; source?: AgentStatusSource; log?: boolean },
  ) => void;
  updateVerificationStateForChat: (
    chatId: string,
    updater: (state: VerificationRuntimeState) => VerificationRuntimeState,
  ) => void;
  /**
   * Append inline delegation cards to the latest tool-call message.
   * Hook binds this to a closure over `setConversations` so the handler
   * never touches React state directly.
   */
  appendInlineDelegationCards: (chatId: string, cards: readonly ChatCard[]) => void;

  /**
   * Clear any prior Coder working memory before starting a new graph
   * run that contains coder tasks. Hook binds to
   * `lastCoderStateRef.current = null`.
   */
  resetCoderState: () => void;
  /**
   * Called with each working-memory update from `runCoderAgent` in a TG
   * Coder node. Hook binds to `lastCoderStateRef.current = state`.
   */
  onCoderStateUpdate: (state: CoderWorkingMemory) => void;
  /**
   * Read the latest Coder working memory. Used once, inside the TG
   * Auditor branch, at the `evalWorkingMemory` decision point. The
   * multi-vs-single-coder-node policy stays here to preserve Option A
   * (recon §Coupling Hazards #3).
   */
  readLatestCoderState: () => CoderWorkingMemory | null;
}

export interface HandleTaskGraphDelegationInput {
  chatId: string;
  toolCall: TaskGraphToolCall;
  baseCorrelation: CorrelationContext;
  lockedProviderForChat: ActiveProvider;
  resolvedModelForChat: string | undefined;
  verificationPolicy: VerificationPolicy;
  /**
   * The user-goal anchor derived from the conversation's first user turn.
   * When present, every task node is required to carry an `addresses`
   * field; emissions that don't comply receive a structured tool-result
   * error sent back to the model on its next turn (mirrors the existing
   * `formatRoleCapabilityDenial` rejection pattern). When absent (no
   * usable first-user-turn seed), validation is skipped — the layering
   * only activates when a real goal exists.
   */
  userGoalAnchor?: UserGoalAnchor;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleTaskGraphDelegation(
  ctx: TaskGraphHandlerContext,
  input: HandleTaskGraphDelegationInput,
): Promise<ToolExecutionResult> {
  const {
    chatId,
    toolCall,
    baseCorrelation,
    lockedProviderForChat,
    resolvedModelForChat,
    verificationPolicy,
    userGoalAnchor,
  } = input;

  const executionId = createId();
  const graphArgs = toolCall.call.args;
  // Capture the foreground branch at dispatch — see R11 in the slice 2
  // design doc. Bound to this delegation's result for its lifetime.
  const originBranch = ctx.branchInfoRef.current?.currentBranch;

  ctx.emitRunEngineEvent({
    type: 'DELEGATION_STARTED',
    timestamp: Date.now(),
    agent: 'task_graph',
  });

  try {
    const validationErrors = validateTaskGraph(graphArgs.tasks);
    if (validationErrors.length > 0) {
      const errorMessages = validationErrors.map((e) => `- ${e.message}`).join('\n');
      return { text: `[Tool Error] Invalid task graph:\n${errorMessages}`, originBranch };
    }

    // Goal-alignment gate: when the conversation has a user goal, every
    // task must reference which part of it the task advances. Structured
    // rejection routes back to the model so it re-emits with `addresses`
    // populated, without an extra runtime LLM call. Mirrors the
    // `formatRoleCapabilityDenial` shape used by capability denials.
    if (userGoalAnchor) {
      const goalErrors = validateTaskGraphAgainstGoal(graphArgs.tasks, {
        anchor: userGoalAnchor,
      });
      if (goalErrors.length > 0) {
        return { text: formatGoalRejection(goalErrors, userGoalAnchor), originBranch };
      }
    }

    const currentSandboxId = ctx.sandboxIdRef.current;
    const hasCoderTasks = graphArgs.tasks.some((task) => task.agent === 'coder');
    if (hasCoderTasks && !currentSandboxId) {
      return {
        text: '[Tool Error] No sandbox available for task graph execution.',
        originBranch,
      };
    }

    ctx.appendRunEvent(chatId, {
      type: 'subagent.started',
      executionId,
      agent: 'task_graph',
      detail: `Task graph: ${graphArgs.tasks.length} tasks`,
    });

    if (hasCoderTasks) {
      ctx.updateVerificationStateForChat(chatId, (state) =>
        activateVerificationGate(
          state,
          'auditor',
          'Task graph started; auditor evaluation pending.',
        ),
      );
      ctx.resetCoderState();
    }

    const harnessSettings = hasCoderTasks
      ? resolveHarnessSettings(lockedProviderForChat, resolvedModelForChat)
      : null;
    const verificationCriteria = hasCoderTasks
      ? buildVerificationAcceptanceCriteria(verificationPolicy, 'always')
      : [];
    const graphNodeById = new Map(graphArgs.tasks.map((task) => [task.id, task] as const));
    let latestGraphDiffPaths: string[] | undefined;

    // Track which tasks are active for aggregated status.
    const activeTasks = new Map<string, string>();

    // Shared memory scope for this graph run. Records from earlier nodes
    // can be retrieved by later nodes via `taskGraphId` match.
    const graphMemoryScope = buildMemoryScope(
      chatId,
      ctx.repoRef.current,
      ctx.branchInfoRef.current?.currentBranch,
      { taskGraphId: executionId },
    );

    // Build the task executor that bridges to existing agent runners.
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
                  userGoal: userGoalAnchor,
                  addresses: node.addresses,
                  branchContext: ctx.branchInfoRef.current?.currentBranch
                    ? {
                        activeBranch: ctx.branchInfoRef.current.currentBranch,
                        defaultBranch: ctx.branchInfoRef.current.defaultBranch || 'main',
                        protectMain: ctx.isMainProtectedRef.current,
                      }
                    : undefined,
                  provider: lockedProviderForChat,
                  model: resolvedModelForChat || undefined,
                  projectInstructions: ctx.agentsMdRef.current || undefined,
                  instructionFilename: ctx.instructionFilenameRef.current || undefined,
                },
                currentSandboxId,
                ctx.repoRef.current || '',
                {
                  onStatus: (phase) => {
                    activeTasks.set(node.id, phase);
                    const taskLabels = [...activeTasks.entries()]
                      .map(([id, p]) => `${id}: ${p}`)
                      .join(' | ');
                    ctx.updateAgentStatus(
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

        ctx.appendInlineDelegationCards(chatId, explorerResult.cards);

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
        ctx.updateVerificationStateForChat(chatId, (state) =>
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
                // Non-null: if hasCoderTasks, currentSandboxId was checked above.
                currentSandboxId!,
                node.files ?? [],
                (phase) => {
                  activeTasks.set(node.id, phase);
                  const taskLabels = [...activeTasks.entries()]
                    .map(([id, p]) => `${id}: ${p}`)
                    .join(' | ');
                  ctx.updateAgentStatus(
                    { active: true, phase: 'Task graph', detail: taskLabels },
                    { chatId, source: 'coder' },
                  );
                },
                ctx.agentsMdRef.current || undefined,
                taskSignal,
                undefined,
                effectiveAcceptanceCriteria,
                (state) => {
                  ctx.onCoderStateUpdate(state);
                },
                lockedProviderForChat,
                resolvedModelForChat || undefined,
                {
                  deliverable: node.deliverable,
                  knownContext: memoryEnrichedContext,
                  constraints: node.constraints,
                  userGoal: userGoalAnchor,
                  addresses: node.addresses,
                  branchContext: ctx.branchInfoRef.current?.currentBranch
                    ? {
                        activeBranch: ctx.branchInfoRef.current.currentBranch,
                        defaultBranch: ctx.branchInfoRef.current.defaultBranch || 'main',
                        protectMain: ctx.isMainProtectedRef.current,
                      }
                    : undefined,
                  instructionFilename: ctx.instructionFilenameRef.current || undefined,
                  harnessSettings: harnessSettings || undefined,
                  verificationPolicy,
                  correlation: nodeCorrelation,
                  onRunEvent: (event) => ctx.appendRunEvent(chatId, event),
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

        ctx.appendInlineDelegationCards(chatId, coderResult.cards);

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
          ctx.updateVerificationStateForChat(chatId, (state) =>
            recordVerificationMutation(state, {
              source: 'coder',
              touchedPaths,
              detail: `Task graph node "${node.id}" mutated the workspace.`,
            }),
          );
        }
        ctx.updateVerificationStateForChat(chatId, (state) =>
          recordVerificationArtifact(
            state,
            `Coder produced evidence: ${summarizeToolResultPreview(coderResult.summary)}`,
          ),
        );
        for (const result of coderResult.criteriaResults ?? []) {
          const command = criteriaCommandById.get(result.id);
          if (!command) continue;
          ctx.updateVerificationStateForChat(chatId, (state) =>
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

    // Execute the task graph.
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
          signal: ctx.abortControllerRef.current?.signal,
          onProgress: (event) => {
            const node = event.taskId ? graphNodeById.get(event.taskId) : undefined;
            switch (event.type) {
              case 'task_ready':
                if (event.taskId && node) {
                  ctx.appendRunEvent(chatId, {
                    type: 'task_graph.task_ready',
                    executionId,
                    taskId: event.taskId,
                    agent: node.agent,
                    detail: event.detail,
                  });
                }
                break;
              case 'task_started':
                ctx.updateAgentStatus(
                  {
                    active: true,
                    phase: `Task graph: starting ${event.taskId}`,
                    detail: event.detail,
                  },
                  { chatId, source: 'coder' },
                );
                if (event.taskId && node) {
                  ctx.appendRunEvent(chatId, {
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
                  ctx.appendRunEvent(chatId, {
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
                  ctx.appendRunEvent(chatId, {
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
                  ctx.appendRunEvent(chatId, {
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
    ctx.appendRunEvent(chatId, {
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

    // Persist typed memory records for every completed node so later
    // (out-of-graph) delegations can retrieve them.
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

      if (graphResult.aborted || ctx.abortRef.current) {
        ctx.updateVerificationStateForChat(chatId, (state) =>
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
          ctx.appendRunEvent(chatId, {
            type: 'subagent.started',
            executionId: auditorExecutionId,
            agent: 'auditor',
            detail: 'Evaluating task graph output',
          });
          ctx.updateAgentStatus(
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
          // Option A contract pin: single-coder-node graphs get the last-
          // written ref state; multi-coder-node graphs get null. Any
          // regression of this policy fails Test 4 in
          // useAgentDelegation.test.ts. See recon §Coupling Hazards #3
          // and Phase 5 Handoff §"Open Design Question" for context.
          const evalWorkingMemory = coderNodeStates.length <= 1 ? ctx.readLatestCoderState() : null;
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
                  ctx.updateAgentStatus({ active: true, phase }, { chatId, source: 'coder' }),
                {
                  providerOverride: lockedProviderForChat,
                  modelOverride: resolvedModelForChat || undefined,
                  coderRounds: totalCoderRounds,
                  coderMaxRounds:
                    (harnessSettings?.maxCoderRounds ?? 0) * Math.max(coderNodeStates.length, 1),
                  criteriaResults: aggregatedChecks.length > 0 ? aggregatedChecks : undefined,
                  verificationPolicy,
                  memoryScope: buildMemoryScope(
                    chatId,
                    ctx.repoRef.current,
                    ctx.branchInfoRef.current?.currentBranch,
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

          ctx.updateVerificationStateForChat(chatId, (state) =>
            recordVerificationGateResult(
              state,
              'auditor',
              graphAuditResult?.verdict === 'complete' ? 'passed' : 'failed',
              graphAuditResult?.summary ?? 'Auditor evaluation returned no result.',
            ),
          );
          ctx.appendRunEvent(chatId, {
            type: 'subagent.completed',
            executionId: auditorExecutionId,
            agent: 'auditor',
            summary: summarizeToolResultPreview(graphAuditResult.summary),
          });
        } catch {
          ctx.updateVerificationStateForChat(chatId, (state) =>
            recordVerificationGateResult(
              state,
              'auditor',
              'inconclusive',
              'Auditor evaluation failed.',
            ),
          );
          ctx.appendRunEvent(chatId, {
            type: 'subagent.failed',
            executionId: auditorExecutionId,
            agent: 'auditor',
            error: 'Evaluation failed.',
          });
        }
      }
    }

    // Aggregate per-node delegation outcomes into a graph-level outcome.
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

      // Tag the outcome agent based on what actually ran, not a static default.
      const ranCoder = [...graphResult.nodeStates.values()].some(
        (s) => s.node.agent === 'coder' && (s.status === 'completed' || s.status === 'failed'),
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

    const toolExecResult: ToolExecutionResult = {
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
      originBranch,
    };
    ctx.appendRunEvent(chatId, {
      type: 'subagent.completed',
      executionId,
      agent: 'task_graph',
      summary: summarizeToolResultPreview(toolExecResult.text),
      delegationOutcome: graphOutcome,
    });
    return toolExecResult;
  } catch (err) {
    const isAbort = err instanceof DOMException && err.name === 'AbortError';
    if (isAbort || ctx.abortRef.current) {
      return {
        text: '[Tool Result — plan_tasks]\nTask graph execution cancelled by user.',
        originBranch,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendRunEvent(chatId, {
      type: 'subagent.failed',
      executionId,
      agent: 'task_graph',
      error: summarizeToolResultPreview(msg),
    });
    return { text: `[Tool Error] Task graph execution failed: ${msg}`, originBranch };
  }
}
