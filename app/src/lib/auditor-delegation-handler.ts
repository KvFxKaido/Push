/**
 * Sequential Auditor delegation handler — Phase 4 of the
 * useAgentDelegation extraction track (see
 * `docs/decisions/useAgentDelegation Coupling Recon.md`, §"Recommended
 * Extraction Order — Phase 4: Sequential Auditor Handler").
 *
 * ## Design — boring leaf handler
 *
 * Unlike Phase 3 (Coder), the Auditor is a leaf seam with a single
 * semantic job: produce an evaluation verdict, or explain why it
 * couldn't. The hook gates whether the handler fires, then consumes
 * the handler's return value for final outcome assembly. Because the
 * fail-open catch is internal, the handler's return shape can stay
 * flat — no discriminated union needed:
 *
 *   - `evalResult: EvaluationResult | null` — the Auditor's verdict
 *     (`complete` or `incomplete`) with summary and gaps, or null if
 *     the Auditor returned no result or the underlying call threw.
 *   - `auditorSummaryLine: string | null` — a pre-formatted
 *     "[Evaluation: VERDICT] summary" line the hook can push onto
 *     its `summaries` array. Null when `evalResult` is null.
 *
 * The Auditor-summary formatting lives here (not in the hook)
 * because it encodes Auditor semantics — verdict uppercase, gap
 * bullets — that belong with the role kernel's output shape.
 * Splitting the formatting across files would leak Auditor
 * presentation concerns into the hook.
 *
 * ## Fitness rules
 *
 *   - **Boundary:** imports from `@/lib/*`, `@/hooks/chat-persistence`,
 *     `@push/lib/correlation-context`, and type-only from
 *     `@/lib/orchestrator` / `@/lib/verification-policy` /
 *     `./coder-delegation-handler`. Never imports the hook or other
 *     handlers.
 *   - **API:** exports `AuditorHandlerContext`,
 *     `HandleCoderAuditorInput`, `AuditorHandlerResult`, and the
 *     `handleCoderAuditor` async handler. The build-context helper
 *     lives in the dispatcher (hook) so the one-way extraction
 *     boundary holds.
 *   - **Gating stays in the hook.** The handler is reactive — it
 *     assumes its caller already decided the Auditor should fire.
 *     No internal `shouldRun` branch. The recon's containment rule
 *     is explicit on this: "policy decisions stay in the hook;
 *     handlers are reactive, not gated."
 *   - **`lastCoderStateRef` stays hook-owned.** The handler reads
 *     the latest coder working memory through a bound
 *     `readLatestCoderState` getter — called exactly once, near the
 *     working-memory decision point, so the ref's read semantics
 *     don't leak across the handler's body.
 *   - **Behavior preservation:** byte-for-byte equivalent to the
 *     inline seam (lines 271–411 pre-extraction). Four
 *     characterization tests (commit 296ff1a) gate the regression:
 *     null return, thrown error, verdict=incomplete, and the
 *     single-task-vs-multi-task `evalWorkingMemory` policy.
 */

import type React from 'react';
import { runAuditorEvaluation, type EvaluationResult } from '@/lib/auditor-agent';
import { getSandboxDiff } from '@/lib/sandbox-client';
import { buildMemoryScope } from '@/lib/memory-context-helpers';
import { recordVerificationGateResult } from '@/lib/verification-runtime';
import { summarizeToolResultPreview } from '@/lib/chat-run-events';
import { setSpanAttributes, withActiveSpan, SpanKind, SpanStatusCode } from '@/lib/tracing';
import {
  correlationToSpanAttributes,
  extendCorrelation,
  type CorrelationContext,
} from '@push/lib/correlation-context';
import { createId } from '@/hooks/chat-persistence';
import type { ActiveProvider } from '@/lib/orchestrator';
import type { VerificationPolicy } from '@/lib/verification-policy';
import type { CoderAuditorInput } from '@/lib/coder-delegation-handler';
import type {
  AgentStatus,
  AgentStatusSource,
  CoderWorkingMemory,
  RunEventInput,
  VerificationRuntimeState,
} from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The ambient context passed to {@link handleCoderAuditor}. All refs
 * and callbacks the handler reaches for are enumerated here so the
 * seam has zero implicit reach into the hook's closure.
 * `readLatestCoderState` is a getter — the handler reads it once
 * internally and stores the value near the working-memory decision
 * point so the call semantics don't leak into the rest of the body.
 */
export interface AuditorHandlerContext {
  repoRef: React.MutableRefObject<string | null>;
  branchInfoRef: React.RefObject<
    { currentBranch?: string; defaultBranch?: string } | undefined | null
  >;
  /**
   * Returns the latest Coder working memory. Hook binds this to
   * `lastCoderStateRef.current`. The handler never touches the ref
   * directly — it only depends on this read API.
   */
  readLatestCoderState: () => CoderWorkingMemory | null;

  appendRunEvent: (chatId: string, event: RunEventInput) => void;
  updateAgentStatus: (
    status: AgentStatus,
    meta?: { chatId?: string; source?: AgentStatusSource; log?: boolean },
  ) => void;
  updateVerificationStateForChat: (
    chatId: string,
    updater: (state: VerificationRuntimeState) => VerificationRuntimeState,
  ) => void;
}

export interface HandleCoderAuditorInput {
  chatId: string;
  baseCorrelation: CorrelationContext;
  lockedProviderForChat: ActiveProvider;
  resolvedModelForChat: string | undefined;
  verificationPolicy: VerificationPolicy;
  /** Aggregated Coder-arc state produced by `handleCoderDelegation`. */
  auditorInput: CoderAuditorInput;
}

export interface AuditorHandlerResult {
  evalResult: EvaluationResult | null;
  /**
   * Pre-formatted Auditor-summary line to push onto the hook's
   * `summaries` array. Null when `evalResult` is null (the hook
   * skips the push, preserving the "no auditor line on failure"
   * invariant the characterization tests pin).
   */
  auditorSummaryLine: string | null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleCoderAuditor(
  ctx: AuditorHandlerContext,
  input: HandleCoderAuditorInput,
): Promise<AuditorHandlerResult> {
  const {
    chatId,
    baseCorrelation,
    lockedProviderForChat,
    resolvedModelForChat,
    verificationPolicy,
    auditorInput,
  } = input;

  const auditorExecutionId = createId();
  try {
    ctx.appendRunEvent(chatId, {
      type: 'subagent.started',
      executionId: auditorExecutionId,
      agent: 'auditor',
      detail: 'Evaluating coder output',
    });
    ctx.updateAgentStatus(
      { active: true, phase: 'Evaluating output...' },
      { chatId, source: 'coder' },
    );

    let evalDiff: string | null = null;
    try {
      const diffResult = await getSandboxDiff(auditorInput.currentSandboxId);
      evalDiff = diffResult.diff || null;
    } catch {
      /* no diff available — evaluation proceeds without it */
    }

    const combinedTask = auditorInput.taskList.join('\n\n');
    const combinedSummary = auditorInput.summaries.join('\n');
    // For multi-task delegations, only the last task's working memory is
    // available — pass null to avoid misleading the evaluator. Read the
    // coder state once, here, so the ref-access semantics don't leak
    // elsewhere in the body.
    const evalWorkingMemory = auditorInput.taskList.length <= 1 ? ctx.readLatestCoderState() : null;
    // Scale max rounds by task count so multi-task totals don't falsely
    // trigger the "hit round cap" signal.
    const evalMaxRounds =
      auditorInput.harnessSettings.maxCoderRounds * Math.max(auditorInput.taskList.length, 1);
    const auditorCorrelation = extendCorrelation(baseCorrelation, {
      executionId: auditorExecutionId,
    });

    const evalResult = await withActiveSpan(
      'subagent.auditor',
      {
        scope: 'push.delegation',
        kind: SpanKind.INTERNAL,
        attributes: {
          ...correlationToSpanAttributes(auditorCorrelation),
          'push.agent.role': 'auditor',
          'push.provider': lockedProviderForChat,
          'push.model': resolvedModelForChat,
          'push.criteria_count': auditorInput.allCriteriaResults.length,
        },
      },
      async (span) => {
        const result = await runAuditorEvaluation(
          combinedTask,
          combinedSummary,
          evalWorkingMemory,
          evalDiff,
          (phase) => ctx.updateAgentStatus({ active: true, phase }, { chatId, source: 'coder' }),
          {
            providerOverride: lockedProviderForChat,
            modelOverride: resolvedModelForChat || undefined,
            coderRounds: auditorInput.totalRounds,
            coderMaxRounds: evalMaxRounds,
            criteriaResults:
              auditorInput.allCriteriaResults.length > 0
                ? auditorInput.allCriteriaResults
                : undefined,
            verificationPolicy,
            memoryScope: buildMemoryScope(
              chatId,
              ctx.repoRef.current,
              ctx.branchInfoRef.current?.currentBranch,
            ),
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
      },
    );

    if (evalResult) {
      const completedEvaluation = evalResult;
      ctx.updateVerificationStateForChat(chatId, (state) =>
        recordVerificationGateResult(
          state,
          'auditor',
          completedEvaluation.verdict === 'complete' ? 'passed' : 'failed',
          completedEvaluation.summary,
        ),
      );
      ctx.appendRunEvent(chatId, {
        type: 'subagent.completed',
        executionId: auditorExecutionId,
        agent: 'auditor',
        summary: summarizeToolResultPreview(evalResult.summary),
      });
      return {
        evalResult,
        auditorSummaryLine: formatAuditorSummaryLine(evalResult),
      };
    }

    ctx.updateVerificationStateForChat(chatId, (state) =>
      recordVerificationGateResult(
        state,
        'auditor',
        'inconclusive',
        'Auditor evaluation returned no result.',
      ),
    );
    ctx.appendRunEvent(chatId, {
      type: 'subagent.failed',
      executionId: auditorExecutionId,
      agent: 'auditor',
      error: 'Auditor returned no evaluation.',
    });
    return { evalResult: null, auditorSummaryLine: null };
  } catch {
    ctx.updateVerificationStateForChat(chatId, (state) =>
      recordVerificationGateResult(state, 'auditor', 'inconclusive', 'Auditor evaluation failed.'),
    );
    ctx.appendRunEvent(chatId, {
      type: 'subagent.failed',
      executionId: auditorExecutionId,
      agent: 'auditor',
      error: 'Evaluation failed.',
    });
    // Fail-open: if evaluation fails, Coder result stands as-is.
    return { evalResult: null, auditorSummaryLine: null };
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function formatAuditorSummaryLine(evalResult: EvaluationResult): string {
  const evalLine = `\n[Evaluation: ${evalResult.verdict.toUpperCase()}] ${evalResult.summary}`;
  const gapLines =
    evalResult.gaps.length > 0 ? evalResult.gaps.map((g) => `  - ${g}`).join('\n') : '';
  return evalLine + (gapLines ? `\n${gapLines}` : '');
}
