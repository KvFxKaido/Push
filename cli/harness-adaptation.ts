/**
 * harness-adaptation.ts — adaptive round-budget tuning for the CLI lead turn.
 *
 * Wired into the shared kernel via the `adaptMaxRounds` hook on
 * `runCoderAgent` (see `cli/lead-turn.ts`): the kernel calls it at the top of
 * every round, and this module returns the (possibly adjusted) cap. The
 * kernel stays portable — it never imports this CLI module.
 *
 * Mirrors the adaptation slice of `app/src/lib/harness-profiles.ts`. Reads
 * session metrics (malformed calls, context pressure, edit error/stale
 * rates) and proposes a reduced max-rounds value when signals escalate
 * beyond thresholds.
 *
 * It can also *raise* the budget for long-running / big-refactor sessions:
 * when the agent is working close to the current ceiling with healthy
 * signals (no malformed-call or edit-error degradation), Rule 3 grants more
 * rounds up to an absolute ceiling. Growth is opt-in — it only fires when the
 * caller passes `currentRound` + `maxAllowedRounds` (the lead turn does),
 * so two-arg callers keep the shrink-only contract. A session that has ever
 * tripped a reduction rule never grows again.
 *
 * Intentionally narrower than the web version:
 *
 * - The CLI has no `plannerRequired` or `contextResetsEnabled` profile
 *   flags, so web's Adaptation 1 (enable planner) and Adaptation 3
 *   (enable context resets) are omitted. Only round-reduction branches
 *   are ported.
 * - The CLI's `detectAllToolCalls` does not break malformed tool calls
 *   down into a `truncated` reason (it emits `json_parse_error`,
 *   `invalid_shape`, `missing_tool`, `missing_args_object`), so the
 *   web-side truncation-specific rule is omitted. Truncated model output
 *   still counts toward the total malformed count because it surfaces as
 *   `json_parse_error`, which triggers Rule 1 below.
 * - Context pressure and edit stale rate are collected as diagnostic
 *   signals but do not currently trigger round reduction on the CLI.
 *
 * Each adaptation rule is one-shot per session: once a rule applies, it
 * does not fire again for the same session, even if `computeAdaptation`
 * is called every round and the signal remains above threshold. State is
 * scoped by `sessionId` so that multiple concurrent sessions in the same
 * process (e.g., under `pushd`) do not interfere.
 */

import { getToolCallMetrics } from './tool-call-metrics.js';
import { getContextMetrics } from './context-metrics.js';
import { getWriteFileMetrics } from './edit-metrics.js';

export interface AdaptationSignals {
  malformedCallCount: number;
  contextPressureEvents: number;
  contextTokensSaved: number;
  editErrorRate: number;
  editStaleRate: number;
}

export interface AdaptationResult {
  adjustedMaxRounds: number;
  wasAdapted: boolean;
  reasons: string[];
  signals: AdaptationSignals;
}

interface AdaptationState {
  malformedRuleApplied: boolean;
  editErrorRuleApplied: boolean;
}

const stateBySession = new Map<string, AdaptationState>();

function getOrCreateState(sessionId: string): AdaptationState {
  let s = stateBySession.get(sessionId);
  if (!s) {
    s = { malformedRuleApplied: false, editErrorRuleApplied: false };
    stateBySession.set(sessionId, s);
  }
  return s;
}

export const THRESHOLDS = {
  MALFORMED_CALL_ESCALATION: 3,
  EDIT_ERROR_RATE_ESCALATION: 0.25,
} as const;

// Rule 3 (growth) tuning. When the agent reaches within GROWTH_TRIGGER_MARGIN
// rounds of the current ceiling with healthy signals, grant GROWTH_INCREMENT
// more rounds (capped at the caller's maxAllowedRounds). Self-limiting: each
// grant pushes the ceiling away, so it only re-fires once the agent has worked
// back up to the new margin.
const GROWTH_TRIGGER_MARGIN = 3;
const GROWTH_INCREMENT = 15;

export interface AdaptationOptions {
  /** Current round number in the engine loop. Required to enable growth. */
  currentRound?: number;
  /** Absolute ceiling the budget may grow to. Required to enable growth. */
  maxAllowedRounds?: number;
}

export function collectAdaptationSignals(sessionId: string): AdaptationSignals {
  const toolMetrics = getToolCallMetrics(sessionId);
  const contextMetrics = getContextMetrics(sessionId);
  const writeMetrics = getWriteFileMetrics(sessionId);

  let malformedCallCount = 0;
  for (const value of Object.values(toolMetrics.malformed || {})) {
    malformedCallCount += value;
  }

  const totalEdits = writeMetrics.count;
  const editErrorRate = totalEdits > 0 ? writeMetrics.errorCount / totalEdits : 0;
  const editStaleRate = totalEdits > 0 ? writeMetrics.staleCount / totalEdits : 0;

  return {
    malformedCallCount,
    contextPressureEvents: contextMetrics.totalEvents,
    contextTokensSaved: contextMetrics.totalTokensSaved,
    editErrorRate,
    editStaleRate,
  };
}

/**
 * Compute an adjusted max-rounds value based on in-session signals.
 *
 * Reduction rules (1 & 2) shrink the budget when signals degrade and are
 * one-shot per session. The growth rule (3) raises the budget on healthy
 * progress near the ceiling, but only when the caller supplies
 * `currentRound` + `maxAllowedRounds`; without those it stays shrink-only,
 * never raising above the provided `currentMaxRounds`. Calling this every
 * round is safe — reductions don't re-fire and growth is self-limiting.
 */
export function computeAdaptation(
  sessionId: string,
  currentMaxRounds: number,
  options?: AdaptationOptions,
): AdaptationResult {
  const signals = collectAdaptationSignals(sessionId);
  const state = getOrCreateState(sessionId);
  const reasons: string[] = [];
  let adjusted = currentMaxRounds;

  // Rule 1: high malformed call rate → floor at 20. Fires at most once.
  if (
    !state.malformedRuleApplied &&
    signals.malformedCallCount >= THRESHOLDS.MALFORMED_CALL_ESCALATION
  ) {
    if (adjusted > 20) {
      adjusted = 20;
      state.malformedRuleApplied = true;
      reasons.push(`Reduce max rounds to 20: ${signals.malformedCallCount} malformed tool calls`);
    }
  }

  // Rule 2: high edit error rate → shrink by 5, floor at 15. Fires at most once.
  if (
    !state.editErrorRuleApplied &&
    signals.editErrorRate >= THRESHOLDS.EDIT_ERROR_RATE_ESCALATION
  ) {
    const reduced = Math.max(15, adjusted - 5);
    if (reduced < adjusted) {
      adjusted = reduced;
      state.editErrorRuleApplied = true;
      reasons.push(
        `Reduce max rounds to ${reduced}: ${(signals.editErrorRate * 100).toFixed(0)}% edit error rate`,
      );
    }
  }

  // Rule 3: healthy progress near the ceiling → extend the budget. Opt-in via
  // currentRound + maxAllowedRounds. Gated on (a) no prior reduction this
  // session (reductions are one-shot and persist) AND (b) current signals below
  // the escalation thresholds. So a session that has ever tripped a reduction —
  // or is currently breaching a threshold — never grows; sub-threshold noise
  // (e.g. 1–2 malformed calls) still allows growth.
  const { currentRound, maxAllowedRounds } = options ?? {};
  if (
    currentRound !== undefined &&
    maxAllowedRounds !== undefined &&
    !state.malformedRuleApplied &&
    !state.editErrorRuleApplied &&
    signals.malformedCallCount < THRESHOLDS.MALFORMED_CALL_ESCALATION &&
    signals.editErrorRate < THRESHOLDS.EDIT_ERROR_RATE_ESCALATION &&
    adjusted < maxAllowedRounds &&
    currentRound >= adjusted - GROWTH_TRIGGER_MARGIN
  ) {
    const grown = Math.min(maxAllowedRounds, adjusted + GROWTH_INCREMENT);
    if (grown > adjusted) {
      reasons.push(`Extend max rounds to ${grown}: healthy progress near round ${adjusted} cap`);
      adjusted = grown;
    }
  }

  return {
    adjustedMaxRounds: adjusted,
    wasAdapted: reasons.length > 0,
    reasons,
    signals,
  };
}

export function resetAdaptationState(sessionId?: string): void {
  if (sessionId === undefined) {
    stateBySession.clear();
    return;
  }
  stateBySession.delete(sessionId);
}
