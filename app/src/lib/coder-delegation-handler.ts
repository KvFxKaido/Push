/**
 * Sequential Coder delegation handler — Phase 3 of the
 * useAgentDelegation extraction track (see
 * `docs/decisions/useAgentDelegation Coupling Recon.md`, §"Recommended
 * Extraction Order — Phase 3: Sequential Coder Handler"). The Planner
 * pre-pass this handler once ran was removed once usage telemetry showed
 * it was never exercised; the lead now drives the Coder arc directly.
 *
 * ## Design — Option B (mid-flight handoff)
 *
 * Unlike the Explorer handler (Phase 2), the Coder seam has a
 * downstream consumer — the Sequential Auditor — that runs *inline in
 * the hook* until Phase 4. The final `DelegationOutcome` emitted as
 * `subagent.completed` must fold in the Auditor's verdict, so the
 * handler cannot own the whole arc.
 *
 * Instead, the handler runs from DELEGATION_STARTED through the end of
 * the multi-task loop and returns a discriminated union:
 *
 *   - `tool-error`   → early exit (no sandbox, empty tasks). No events
 *                      emitted beyond DELEGATION_STARTED + the gate
 *                      activation. Hook assigns `toolExecResult`
 *                      directly.
 *   - `aborted`      → user cancelled. Handler has emitted
 *                      `subagent.completed` with an abort outcome.
 *                      Hook assigns `toolExecResult` directly.
 *   - `failed`       → runCoderAgent threw. Handler has
 *                      emitted `subagent.failed`. Hook assigns
 *                      `toolExecResult` directly.
 *   - `ok`           → Coder arc succeeded through the loop. Handler
 *                      returns `auditorInput` — the aggregated state
 *                      the hook uses to (a) gate + invoke the inline
 *                      Auditor span, (b) assemble the final
 *                      `DelegationOutcome`, (c) emit the terminal
 *                      `subagent.completed` event. The field name
 *                      `auditorInput` is load-bearing: it signals
 *                      "mid-flight, not terminal" so a reader does not
 *                      assume the handler owns the full lifecycle.
 *
 * ## Fitness rules
 *
 *   - **Boundary:** imports from `@/lib/*`, `@/hooks/chat-persistence`,
 *     `@push/lib/correlation-context`, and type-only from
 *     `@/lib/tool-dispatch` / `@/lib/orchestrator` / `@/lib/run-engine`
 *     / `@/lib/verification-policy` / `@/lib/model-capabilities`.
 *     Never imports `useAgentDelegation.ts` or any other hook.
 *   - **API:** exports the `CoderHandlerContext` + `CoderToolCall` +
 *     `CoderAuditorInput` + `CoderHandlerResult` types, the
 *     `handleCoderDelegation` async handler, and the pure
 *     `mergeAcceptanceCriteria` helper. The build-context helper lives
 *     in the dispatcher (hook) so the one-way extraction boundary
 *     holds.
 *   - **Policy stays in the hook:** final outcome assembly (folds in
 *     Auditor verdict) and the terminal `subagent.completed` emission
 *     remain in the hook, which also invokes the shared Auditor gate
 *     (`runCoderAuditorGate` in `inline-coder-run.ts` — the
 *     `evaluateAfterCoder` rule lives there so the inline lane shares
 *     it). The handler is reactive, not gated.
 *   - **Latest Coder state stays hook-owned.** The handler's context
 *     carries an `onCoderStateUpdate` callback; the hook decides how to
 *     persist that state (today: runtimeContext, with a legacy ref mirror).
 *     The carrier itself is never passed in, so the handler has no awareness
 *     of the persistence mechanism its updates feed into.
 *   - **Behavior preservation:** the delegated Coder arc is gated by the
 *     characterization tests in `hooks/useAgentDelegation.test.ts`.
 */

import type React from 'react';
import { getActiveProvider, type ActiveProvider } from '@/lib/orchestrator';
import { getSandboxDiff } from '@/lib/sandbox-client';
import { runCoderAgent } from '@/lib/coder-agent';
import { capturePreCoderSnapshot, createCoderCheckpointAnswerer } from '@/lib/inline-coder-run';
import { resolveHarnessSettings } from '@/lib/model-capabilities';
import { getRunTokenBudgetPref } from '@/lib/run-token-budget-pref';
import type { HarnessProfileSettings } from '@/types';
import {
  buildMemoryScope,
  retrieveMemoryKnownContextLine,
  withMemoryContext,
} from '@/lib/memory-context-helpers';
import {
  buildDelegationResultCard,
  formatCompactDelegationToolResult,
} from '@/lib/delegation-result';
import {
  activateVerificationGate,
  buildVerificationAcceptanceCriteria,
  extractChangedPathsFromDiff,
  recordVerificationArtifact,
  recordVerificationCommandResult,
  recordVerificationMutation,
} from '@/lib/verification-runtime';
import { summarizeToolResultPreview, utf8ByteLength } from '@/lib/chat-run-events';
import { setSpanAttributes, withActiveSpan, SpanKind, SpanStatusCode } from '@/lib/tracing';
import {
  correlationToSpanAttributes,
  extendCorrelation,
  type CorrelationContext,
} from '@push/lib/correlation-context';
import { createId } from '@/hooks/chat-persistence';
import { formatElapsedTime } from '@/lib/utils';
import type { AnyToolCall } from '@/lib/tool-dispatch';
import type { RunEngineEvent } from '@/lib/run-engine';
import type { VerificationPolicy } from '@/lib/verification-policy';
import type {
  AcceptanceCriterion,
  AgentStatus,
  AgentStatusSource,
  ChatCard,
  ChatMessage,
  CoderWorkingMemory,
  CriterionResult,
  DelegationOutcome,
  MemoryScope,
  RunEventInput,
  ToolExecutionResult,
  VerificationRuntimeState,
} from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Narrow tool-call shape for `delegate_coder` dispatch. */
export type CoderToolCall = Extract<AnyToolCall, { call: { tool: 'delegate_coder' } }>;

/**
 * The ambient context passed to {@link handleCoderDelegation}. All refs
 * and callbacks the handler reaches for are enumerated here so the seam
 * has zero implicit reach into the hook's closure. `onCoderStateUpdate`
 * is the load-bearing escape hatch — the handler emits coder-working-
 * memory updates through this callback; the hook writes them into the
 * active runtimeContext while keeping ownership on the hook side where
 * Auditor (still inline in Phase 3) reads it.
 */
export interface CoderHandlerContext {
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
   * Clear any prior Coder working memory before starting a new arc.
   * Hook binds this to its runtimeContext-backed state reset.
   */
  resetCoderState: () => void;
  /**
   * Called with each working-memory update from `runCoderAgent`. The
   * handler has no awareness of where the hook persists the value.
   */
  onCoderStateUpdate: (state: CoderWorkingMemory) => void;
  /**
   * Access to the latest coder working memory for the interactive
   * checkpoint callback. Read-only from the handler's perspective —
   * the hook exposes the current ref value through this getter.
   */
  readLatestCoderState: () => CoderWorkingMemory | null;
}

export interface HandleCoderDelegationInput {
  chatId: string;
  toolCall: CoderToolCall;
  /** Recent chat history, sliced for the checkpoint-answer context. */
  apiMessages: ChatMessage[];
  baseCorrelation: CorrelationContext;
  lockedProviderForChat: ActiveProvider;
  resolvedModelForChat: string | undefined;
  verificationPolicy: VerificationPolicy;
}

/**
 * Aggregated Coder-arc state handed back to the hook for Auditor
 * gating + final outcome assembly. The field name is deliberate —
 * `auditorInput` signals "mid-flight, not terminal" so Phase 4's
 * `handleCoderAuditor` can consume this type directly as its input
 * contract.
 */
export interface CoderAuditorInput {
  taskList: string[];
  allCards: ChatCard[];
  summaries: string[];
  /**
   * Evaluating the inline lead's own turn (not a delegated Coder). Threads to
   * the Evaluator so its user-facing verdict says "the assistant", not "the
   * Coder". The delegated arc leaves it unset.
   */
  leadMode?: boolean;
  allCriteriaResults: CriterionResult[];
  totalRounds: number;
  totalCheckpoints: number;
  lastTaskDiff: string | null;
  latestDiffPaths: string[] | undefined;
  coderMemoryScope: MemoryScope | null;
  verificationCommandsById: Map<string, string>;
  harnessSettings: HarnessProfileSettings;
  currentSandboxId: string;
  /** Foreground branch captured at delegation dispatch. Forwarded to the
   *  result envelope by the hook so the result message stamps the launch
   *  branch even if the foreground has since forked. See R11 in the slice
   *  2 design doc. */
  originBranch: string | undefined;
  /**
   * HEAD SHA captured BEFORE the Coder ran, when git was healthy. The
   * Auditor uses this to ask for `git diff <preCoderHead>..HEAD`, which
   * surfaces committed-but-no-longer-in-working-tree work and prevents
   * the post-commit false-positive in PR #601's deterministic
   * short-circuit. Undefined when the snapshot fetch failed (no commits
   * yet, git error, sandbox unreachable) — the Auditor falls back to
   * working-tree-only behavior. See PR #604.
   */
  preCoderHead: string | undefined;
  /**
   * Untracked file paths captured BEFORE the Coder ran (parsed from
   * `git status --porcelain`). The Auditor uses this baseline to
   * determine which `??` entries in the post-Coder status are NEW
   * (genuine work) vs pre-existing ambient gunk (node_modules, build
   * artifacts, untracked configs). Without this baseline, PR #606's
   * untracked-evidence signal false-positives on every workspace that
   * already contains any untracked files. Codex P1 review on PR #606.
   * Undefined when the pre-Coder fetch failed or omitted git_status —
   * the Auditor falls back to "treat all post-Coder untracked entries
   * as evidence" rather than regress to the pre-#606 false-negative.
   */
  preCoderUntrackedFiles: readonly string[] | undefined;
}

/**
 * Discriminated union covering all four control-flow exits from the
 * Coder arc. Each variant has different semantics — the hook switches
 * on `status` without having to decode a looser contract.
 */
export type CoderHandlerResult =
  | { status: 'tool-error'; toolExecResult: ToolExecutionResult }
  | {
      status: 'aborted' | 'failed';
      toolExecResult: ToolExecutionResult;
      executionId: string;
    }
  | {
      status: 'ok';
      executionId: string;
      coderStartMs: number;
      auditorInput: CoderAuditorInput;
    };

// ---------------------------------------------------------------------------
// Pure helpers (moved from useAgentDelegation.ts)
// ---------------------------------------------------------------------------

/**
 * Merge explicitly-declared acceptance criteria with verification-policy
 * criteria, deduplicated by (id, check) pair. Pure — safe to call
 * per-task.
 */
export function mergeAcceptanceCriteria(
  explicitCriteria: AcceptanceCriterion[] | undefined,
  verificationCriteria: AcceptanceCriterion[],
): AcceptanceCriterion[] {
  const merged: AcceptanceCriterion[] = [];
  const seen = new Set<string>();

  for (const criterion of [...(explicitCriteria ?? []), ...verificationCriteria]) {
    const key = `${criterion.id}::${criterion.check}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(criterion);
  }

  return merged;
}

function getTaskStatusLabel(criteriaResults?: CriterionResult[]): string {
  if (!criteriaResults || criteriaResults.length === 0) return 'OK';
  const allPassed = criteriaResults.every((r) => r.passed);
  return allPassed ? 'OK' : 'CHECKS_FAILED';
}

/**
 * Emit the delegated-arc measurement for the Coder Delegation Collapse
 * step-1 A/B (see `docs/decisions/Coder Delegation Collapse — Component
 * Audit.md`). One structured line per terminal branch (ok / aborted /
 * failed / tool-error), paired by the shared `event` name and
 * distinguished by `outcome`, so the delegated path's latency + a quality
 * signal (rounds, checkpoints, acceptance-criteria pass rate) is comparable
 * to the engine arc's `coder_job_*` /
 * `delegation_engine_job_started` logs. Kept as an observability log, not
 * a protocol event — no `subagent.*` shape changes, so the category-3
 * drift pins are untouched.
 *
 * `level` is `error` for both terminal-failure outcomes (`failed` and
 * `tool-error` — missing sandbox / empty task list); `aborted` (a user
 * cancel) and `ok` stay `info`. This keeps the delegated arc's
 * error-level signal symmetric with the engine arc's launch-failure log
 * (glm + Kilo review, PR #773).
 */
function logDelegatedCoderMeasure(fields: {
  chatId: string;
  executionId: string;
  outcome: 'ok' | 'aborted' | 'failed' | 'tool-error';
  elapsedMs: number;
  totalRounds?: number;
  totalCheckpoints?: number;
  criteriaResults?: CriterionResult[];
}): void {
  const criteria = fields.criteriaResults ?? [];
  const criteriaPassRate =
    criteria.length > 0 ? criteria.filter((r) => r.passed).length / criteria.length : null;
  console.log(
    JSON.stringify({
      level: fields.outcome === 'failed' || fields.outcome === 'tool-error' ? 'error' : 'info',
      event: 'coder_delegation_measured',
      mode: 'delegated',
      chatId: fields.chatId,
      executionId: fields.executionId,
      outcome: fields.outcome,
      elapsedMs: fields.elapsedMs,
      totalRounds: fields.totalRounds ?? null,
      totalCheckpoints: fields.totalCheckpoints ?? null,
      criteriaCount: criteria.length,
      criteriaPassRate,
    }),
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleCoderDelegation(
  ctx: CoderHandlerContext,
  input: HandleCoderDelegationInput,
): Promise<CoderHandlerResult> {
  const {
    chatId,
    toolCall,
    apiMessages,
    baseCorrelation,
    lockedProviderForChat,
    resolvedModelForChat,
    verificationPolicy,
  } = input;

  const executionId = createId();
  const coderStartMs = Date.now();
  // Capture the foreground branch at dispatch. Bound to this delegation
  // for its lifetime — the result envelope carries it so the result
  // message stamps the launch branch, not whatever the foreground
  // happens to be on at completion time. See R11 in the slice 2 design
  // doc.
  const originBranch = ctx.branchInfoRef.current?.currentBranch;

  ctx.emitRunEngineEvent({
    type: 'DELEGATION_STARTED',
    timestamp: Date.now(),
    agent: 'coder',
  });
  ctx.updateVerificationStateForChat(chatId, (state) =>
    activateVerificationGate(
      state,
      'auditor',
      'Coder delegation started; auditor evaluation pending.',
    ),
  );
  // Hook's onCoderStateUpdate callback will populate working memory as
  // runCoderAgent reports it. Clear any prior value before a new arc.
  ctx.resetCoderState();

  const currentSandboxId = ctx.sandboxIdRef.current;
  if (!currentSandboxId) {
    logDelegatedCoderMeasure({
      chatId,
      executionId,
      outcome: 'tool-error',
      elapsedMs: Date.now() - coderStartMs,
    });
    return {
      status: 'tool-error',
      toolExecResult: {
        text: '[Tool Error] Failed to start sandbox automatically. Try again.',
        originBranch,
      },
    };
  }

  // Snapshot HEAD BEFORE the Coder runs so the Auditor can see committed
  // work after the working tree is clean. A successful `git commit`
  // inside the Coder leaves `git diff HEAD` empty and used to fire PR
  // #601's deterministic short-circuit as "no workspace changes" even
  // though real work landed. Auditor uses this as the `since_ref` for
  // the ranged-diff path. Best-effort: a fetch failure leaves it
  // undefined and the Auditor falls back to working-tree-only behavior.
  // See PR #604.
  //
  // Also snapshot the set of untracked file paths so the Auditor can
  // tell which `??` entries in the post-Coder porcelain status are NEW
  // (Coder created them) vs pre-existing (node_modules, build artifacts,
  // ambient gunk that was already lying around). Without this baseline,
  // PR #606's untracked-evidence signal false-positives on every
  // workspace that already has any untracked files. Codex P1 review on
  // PR #606. The snapshot is best-effort: if the pre-Coder fetch fails
  // or omits git_status, `preCoderUntrackedFiles` stays undefined and
  // the Auditor falls back to a more conservative path (defer to LLM
  // rather than risk a false-negative short-circuit).
  const { preCoderHead, preCoderUntrackedFiles } = await capturePreCoderSnapshot(currentSandboxId);

  try {
    const harnessProvider = lockedProviderForChat || getActiveProvider();
    const harnessModelId = resolvedModelForChat || undefined;
    const harnessSettings = resolveHarnessSettings(harnessProvider, harnessModelId, {
      runTokenBudget: getRunTokenBudgetPref(),
    });

    const delegateArgs = toolCall.call.args;
    const taskList = Array.isArray(delegateArgs.tasks)
      ? delegateArgs.tasks.filter((t: unknown): t is string => typeof t === 'string' && !!t.trim())
      : [];
    if (delegateArgs.task?.trim()) {
      taskList.unshift(delegateArgs.task.trim());
    }

    if (taskList.length === 0) {
      logDelegatedCoderMeasure({
        chatId,
        executionId,
        outcome: 'tool-error',
        elapsedMs: Date.now() - coderStartMs,
      });
      return {
        status: 'tool-error',
        toolExecResult: {
          text: '[Tool Error] delegate_coder requires "task" or non-empty "tasks" array.',
          originBranch,
        },
      };
    }

    ctx.appendRunEvent(chatId, {
      type: 'subagent.started',
      executionId,
      agent: 'coder',
      detail: taskList.length === 1 ? taskList[0] : `${taskList.length} tasks`,
    });

    const coderMemoryScope = buildMemoryScope(
      chatId,
      ctx.repoRef.current,
      ctx.branchInfoRef.current?.currentBranch,
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
    const allCriteriaResults: CriterionResult[] = [];
    const verificationCriteria = buildVerificationAcceptanceCriteria(verificationPolicy, 'always');
    const verificationCommandsById = new Map<string, string>();
    let lastTaskDiff: string | null = null;
    let latestDiffPaths: string[] | undefined;

    // --- Multi-task loop ---
    for (let taskIndex = 0; taskIndex < taskList.length; taskIndex++) {
      const task = taskList[taskIndex];

      // Interactive Checkpoint callback: when the Coder pauses to ask
      // the Orchestrator for guidance, this generates an answer using
      // the Orchestrator's LLM with recent chat history for context.
      // Shared with the inline lane via `createCoderCheckpointAnswerer`.
      const handleCheckpoint = createCoderCheckpointAnswerer({
        chatId,
        statusPrefix: taskList.length > 1 ? `[${taskIndex + 1}/${taskList.length}] ` : '',
        apiMessages,
        provider: lockedProviderForChat,
        model: resolvedModelForChat || undefined,
        memoryScope: coderMemoryScope,
        readLatestCoderState: ctx.readLatestCoderState,
        getSignal: () => ctx.abortControllerRef.current?.signal,
        updateAgentStatus: ctx.updateAgentStatus,
      });

      // Apply acceptance criteria to every task — validates each
      // independently. For sequential single-sandbox mode this also
      // catches regressions introduced by earlier tasks before they
      // compound.
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
      const seqBi = ctx.branchInfoRef.current;
      const coderCorrelation = extendCorrelation(baseCorrelation, { executionId });
      const coderResult = await withActiveSpan(
        'subagent.coder',
        {
          scope: 'push.delegation',
          kind: SpanKind.INTERNAL,
          attributes: {
            ...correlationToSpanAttributes(coderCorrelation),
            'push.agent.role': 'coder',
            'push.task_index': taskIndex,
            'push.task_count': taskList.length,
            'push.provider': lockedProviderForChat,
            'push.model': resolvedModelForChat,
            'push.has_acceptance_criteria': Boolean(effectiveAcceptanceCriteria.length),
          },
        },
        async (span) => {
          const result = await runCoderAgent(
            task,
            currentSandboxId,
            delegateArgs.files || [],
            (phase, detail) => {
              const prefix = taskList.length > 1 ? `[${taskIndex + 1}/${taskList.length}] ` : '';
              ctx.updateAgentStatus(
                { active: true, phase: `${prefix}${phase}`, detail },
                { chatId, source: 'coder' },
              );
            },
            ctx.agentsMdRef.current || undefined,
            ctx.abortControllerRef.current?.signal,
            handleCheckpoint,
            effectiveAcceptanceCriteria,
            (state) => {
              ctx.onCoderStateUpdate(state);
            },
            lockedProviderForChat,
            resolvedModelForChat || undefined,
            {
              intent: delegateArgs.intent,
              deliverable: delegateArgs.deliverable,
              knownContext: withMemoryContext(delegateArgs.knownContext, coderMemoryLine),
              constraints: delegateArgs.constraints,
              branchContext: seqBi?.currentBranch
                ? {
                    activeBranch: seqBi.currentBranch,
                    defaultBranch: seqBi.defaultBranch || 'main',
                    protectMain: ctx.isMainProtectedRef.current,
                  }
                : undefined,
              instructionFilename: ctx.instructionFilenameRef.current || undefined,
              harnessSettings,
              verificationPolicy,
              declaredCapabilities: delegateArgs.declaredCapabilities,
              // Memory read-scope for the delegated Coder (LCM) — from session
              // context, never the model. repoFullName comes from the active
              // repo ref; chatId bounds reads (chats are branch-scoped).
              repoFullName: ctx.repoRef.current || undefined,
              chatId,
              correlation: coderCorrelation,
              onRunEvent: (event) => ctx.appendRunEvent(chatId, event),
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
        },
      );
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
        ctx.updateVerificationStateForChat(chatId, (state) =>
          recordVerificationMutation(state, {
            source: 'coder',
            touchedPaths,
            detail: 'Coder delegation mutated the workspace.',
          }),
        );
      }
      if (taskList.length > 1) {
        summaries.push(
          `Task ${taskIndex + 1} [${seqStatus}, ${seqElapsed}]: ${coderResult.summary}`,
        );
      } else {
        summaries.push(`${coderResult.summary} (${seqElapsed})`);
      }
      ctx.updateVerificationStateForChat(chatId, (state) =>
        recordVerificationArtifact(
          state,
          `Coder produced evidence: ${summarizeToolResultPreview(coderResult.summary)}`,
        ),
      );
      if (coderResult.criteriaResults) {
        for (const result of coderResult.criteriaResults) {
          const command = criteriaCommandById.get(result.id);
          if (!command) continue;
          ctx.updateVerificationStateForChat(chatId, (state) =>
            recordVerificationCommandResult(state, command, {
              exitCode: result.exitCode,
              detail: `${result.id} exited with code ${result.exitCode}.`,
            }),
          );
        }
        allCriteriaResults.push(...coderResult.criteriaResults);
      }
      allCards.push(...coderResult.cards);
    }

    logDelegatedCoderMeasure({
      chatId,
      executionId,
      outcome: 'ok',
      elapsedMs: Date.now() - coderStartMs,
      totalRounds,
      totalCheckpoints,
      criteriaResults: allCriteriaResults,
    });
    return {
      status: 'ok',
      executionId,
      coderStartMs,
      auditorInput: {
        taskList,
        allCards,
        summaries,
        allCriteriaResults,
        totalRounds,
        totalCheckpoints,
        lastTaskDiff,
        latestDiffPaths,
        coderMemoryScope,
        verificationCommandsById,
        harnessSettings,
        currentSandboxId,
        originBranch,
        preCoderHead,
        preCoderUntrackedFiles,
      },
    };
  } catch (err) {
    const isAbort = err instanceof DOMException && err.name === 'AbortError';
    if (isAbort || ctx.abortRef.current) {
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
      const abortText = formatCompactDelegationToolResult({
        agent: 'coder',
        outcome: abortOutcome,
      });
      ctx.appendRunEvent(chatId, {
        type: 'subagent.completed',
        executionId,
        agent: 'coder',
        summary: 'Cancelled by user.',
        delegationOutcome: abortOutcome,
        orchestratorBytes: utf8ByteLength(abortText),
      });
      logDelegatedCoderMeasure({
        chatId,
        executionId,
        outcome: 'aborted',
        elapsedMs: Date.now() - coderStartMs,
      });
      return {
        status: 'aborted',
        executionId,
        toolExecResult: {
          text: abortText,
          card: buildDelegationResultCard({
            agent: 'coder',
            outcome: abortOutcome,
          }),
          delegationOutcome: abortOutcome,
          originBranch,
        },
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendRunEvent(chatId, {
      type: 'subagent.failed',
      executionId,
      agent: 'coder',
      error: summarizeToolResultPreview(msg),
    });
    logDelegatedCoderMeasure({
      chatId,
      executionId,
      outcome: 'failed',
      elapsedMs: Date.now() - coderStartMs,
    });
    return {
      status: 'failed',
      executionId,
      toolExecResult: { text: `[Tool Error] Coder failed: ${msg}`, originBranch },
    };
  }
}
