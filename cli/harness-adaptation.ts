/**
 * harness-adaptation.ts — adaptive round-budget shrinking for the CLI engine.
 *
 * Mirrors the adaptation slice of `app/src/lib/harness-profiles.ts`. Reads
 * session metrics (malformed calls, context pressure, edit error/stale
 * rates) and proposes a reduced max-rounds value when signals escalate
 * beyond thresholds.
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

export const THRESHOLDS = {
  MALFORMED_CALL_ESCALATION: 3,
  EDIT_ERROR_RATE_ESCALATION: 0.25,
} as const;

export function collectAdaptationSignals(): AdaptationSignals {
  const toolMetrics = getToolCallMetrics();
  const contextMetrics = getContextMetrics();
  const writeMetrics = getWriteFileMetrics();

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
 * Compute a possibly-reduced max-rounds value based on in-session signals.
 * Never raises the current ceiling — only shrinks it when signals degrade.
 */
export function computeAdaptation(currentMaxRounds: number): AdaptationResult {
  const signals = collectAdaptationSignals();
  const reasons: string[] = [];
  let adjusted = currentMaxRounds;

  // Rule 1: high malformed call rate → floor at 20.
  if (signals.malformedCallCount >= THRESHOLDS.MALFORMED_CALL_ESCALATION) {
    if (adjusted > 20) {
      adjusted = 20;
      reasons.push(`Reduce max rounds to 20: ${signals.malformedCallCount} malformed tool calls`);
    }
  }

  // Rule 2: high edit error rate → shrink by 5, floor at 15.
  if (signals.editErrorRate >= THRESHOLDS.EDIT_ERROR_RATE_ESCALATION) {
    const reduced = Math.max(15, adjusted - 5);
    if (reduced < adjusted) {
      adjusted = reduced;
      reasons.push(
        `Reduce max rounds to ${reduced}: ${(signals.editErrorRate * 100).toFixed(0)}% edit error rate`,
      );
    }
  }

  return {
    adjustedMaxRounds: adjusted,
    wasAdapted: reasons.length > 0,
    reasons,
    signals,
  };
}
