/**
 * harness-profiles.ts
 *
 * Adaptive harness profile computation for Track E of the Harness Runtime
 * Evolution Plan.
 *
 * Makes the harness shape itself to provider/model behavior and task risk.
 * Applies conservative profile adjustments based on observed reliability
 * signals while still logging each adaptation for visibility.
 */

import { getMalformedToolCallMetrics } from './tool-call-metrics';
import { getContextMetrics } from './context-metrics';
import { getWriteFileMetrics } from './edit-metrics';
import type { HarnessProfileSettings } from '@/types';

// ---------------------------------------------------------------------------
// Adaptation signals
// ---------------------------------------------------------------------------

/** Signals collected from session metrics for profile adaptation. */
export interface AdaptationSignals {
  /** Total malformed tool calls for this provider/model. */
  malformedCallCount: number;
  /** Breakdown by failure reason. */
  malformedReasons: {
    truncated: number;
    validationFailed: number;
    malformedJson: number;
    naturalLanguageIntent: number;
  };
  /** Context pressure: total compression/trim events. */
  contextPressureEvents: number;
  /** Total tokens saved by compression. */
  contextTokensSaved: number;
  /** File edit error rate (0-1). */
  editErrorRate: number;
  /** File edit stale rate (0-1, hashline stale conflicts). */
  editStaleRate: number;
}

/** The result of an adaptive profile computation. */
export interface AdaptiveProfileResult {
  /** The base profile from static resolution. */
  baseProfile: HarnessProfileSettings;
  /** The adapted profile (may differ from base). */
  adaptedProfile: HarnessProfileSettings;
  /** Whether any adaptation was applied. */
  wasAdapted: boolean;
  /** Human-readable reasons for each adaptation. */
  adaptationReasons: string[];
  /** The raw signals used for the decision. */
  signals: AdaptationSignals;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Thresholds for triggering adaptations. Kept explicit and tunable.
 * These are intentionally conservative for the initial shadow rollout.
 */
export const THRESHOLDS = {
  /** Malformed calls before considering stricter scaffolding. */
  MALFORMED_CALL_ESCALATION: 3,
  /** Truncation-specific threshold (indicates model hitting output limits). */
  TRUNCATION_ESCALATION: 2,
  /** Context pressure events before reducing verbosity. */
  CONTEXT_PRESSURE_ESCALATION: 5,
  /** Edit error rate before tightening retry posture. */
  EDIT_ERROR_RATE_ESCALATION: 0.25,
  /** Edit stale rate before recommending re-reads. */
  EDIT_STALE_RATE_ESCALATION: 0.2,
} as const;

// ---------------------------------------------------------------------------
// Signal collection
// ---------------------------------------------------------------------------

/**
 * Collect adaptation signals from in-memory metrics for a given provider/model.
 * Returns zero-value signals if no metrics are available.
 */
export function collectAdaptationSignals(provider: string, modelId?: string): AdaptationSignals {
  const toolMetrics = getMalformedToolCallMetrics();
  const contextMetrics = getContextMetrics();
  const writeMetrics = getWriteFileMetrics();

  // Drill into provider/model-specific tool call metrics
  let malformedCallCount = 0;
  const malformedReasons = {
    truncated: 0,
    validationFailed: 0,
    malformedJson: 0,
    naturalLanguageIntent: 0,
  };

  const providerMetrics = toolMetrics.byProvider[provider];
  if (providerMetrics) {
    if (modelId) {
      const modelMetrics = providerMetrics.byModel[modelId];
      if (modelMetrics) {
        malformedCallCount = modelMetrics.count;
        malformedReasons.truncated = modelMetrics.reasons.truncated;
        malformedReasons.validationFailed = modelMetrics.reasons.validation_failed;
        malformedReasons.malformedJson = modelMetrics.reasons.malformed_json;
        malformedReasons.naturalLanguageIntent = modelMetrics.reasons.natural_language_intent;
      }
    } else {
      malformedCallCount = providerMetrics.count;
      malformedReasons.truncated = providerMetrics.reasons.truncated;
      malformedReasons.validationFailed = providerMetrics.reasons.validation_failed;
      malformedReasons.malformedJson = providerMetrics.reasons.malformed_json;
      malformedReasons.naturalLanguageIntent = providerMetrics.reasons.natural_language_intent;
    }
  }

  // Context pressure
  const contextPressureEvents = contextMetrics.totalEvents;
  const contextTokensSaved = contextMetrics.totalTokensSaved;

  // Edit reliability
  const totalEdits = writeMetrics.count;
  const editErrorRate = totalEdits > 0 ? writeMetrics.errorCount / totalEdits : 0;
  const editStaleRate = totalEdits > 0 ? writeMetrics.staleCount / totalEdits : 0;

  return {
    malformedCallCount,
    malformedReasons,
    contextPressureEvents,
    contextTokensSaved,
    editErrorRate,
    editStaleRate,
  };
}

// ---------------------------------------------------------------------------
// Profile adaptation
// ---------------------------------------------------------------------------

/**
 * Compute an adaptive harness profile based on session metrics.
 *
 * This is the core adaptation logic. It takes the base profile (from static
 * resolution) and adjusts settings based on observed behavior signals.
 *
 * Current adaptations:
 * 1. High malformed calls -> enable planner, reduce max rounds
 * 2. High truncation rate -> reduce max rounds (model hitting output limits)
 * 3. High context pressure -> enable context resets
 * 4. High edit error/stale rate -> reduce max rounds (unreliable edits)
 */
export function computeAdaptiveProfile(
  baseProfile: HarnessProfileSettings,
  provider: string,
  modelId?: string,
): AdaptiveProfileResult {
  const signals = collectAdaptationSignals(provider, modelId);
  const adaptedProfile = { ...baseProfile };
  const adaptationReasons: string[] = [];

  // --- Adaptation 1: High malformed call rate ---
  if (signals.malformedCallCount >= THRESHOLDS.MALFORMED_CALL_ESCALATION) {
    if (!adaptedProfile.plannerRequired) {
      adaptedProfile.plannerRequired = true;
      adaptationReasons.push(`Enable planner: ${signals.malformedCallCount} malformed tool calls`);
    }
    if (adaptedProfile.maxCoderRounds > 20) {
      adaptedProfile.maxCoderRounds = 20;
      adaptationReasons.push(`Reduce max rounds to 20: high malformed call rate`);
    }
  }

  // --- Adaptation 2: High truncation rate ---
  if (signals.malformedReasons.truncated >= THRESHOLDS.TRUNCATION_ESCALATION) {
    const reducedRounds = Math.max(15, adaptedProfile.maxCoderRounds - 5);
    if (reducedRounds < adaptedProfile.maxCoderRounds) {
      adaptedProfile.maxCoderRounds = reducedRounds;
      adaptationReasons.push(
        `Reduce max rounds to ${reducedRounds}: ${signals.malformedReasons.truncated} truncated outputs`,
      );
    }
  }

  // --- Adaptation 3: High context pressure ---
  if (signals.contextPressureEvents >= THRESHOLDS.CONTEXT_PRESSURE_ESCALATION) {
    if (!adaptedProfile.contextResetsEnabled) {
      adaptedProfile.contextResetsEnabled = true;
      adaptationReasons.push(
        `Enable context resets: ${signals.contextPressureEvents} compression events`,
      );
    }
  }

  // --- Adaptation 4: High edit error/stale rate ---
  if (signals.editErrorRate >= THRESHOLDS.EDIT_ERROR_RATE_ESCALATION) {
    const reducedRounds = Math.max(15, adaptedProfile.maxCoderRounds - 5);
    if (reducedRounds < adaptedProfile.maxCoderRounds) {
      adaptedProfile.maxCoderRounds = reducedRounds;
      adaptationReasons.push(
        `Reduce max rounds to ${reducedRounds}: ${(signals.editErrorRate * 100).toFixed(0)}% edit error rate`,
      );
    }
  }

  if (signals.editStaleRate >= THRESHOLDS.EDIT_STALE_RATE_ESCALATION) {
    if (!adaptedProfile.contextResetsEnabled) {
      adaptedProfile.contextResetsEnabled = true;
      adaptationReasons.push(
        `Enable context resets: ${(signals.editStaleRate * 100).toFixed(0)}% edit stale rate`,
      );
    }
  }

  const wasAdapted = adaptationReasons.length > 0;

  return {
    baseProfile,
    adaptedProfile,
    wasAdapted,
    adaptationReasons,
    signals,
  };
}

/**
 * Log an adaptive profile result for diagnostics.
 * Only logs when adaptation was triggered, to avoid noise.
 */
export function logAdaptiveProfile(
  result: AdaptiveProfileResult,
  provider: string,
  modelId?: string,
): void {
  if (!result.wasAdapted) return;

  console.log('[HarnessProfile] Shadow adaptation computed', {
    provider,
    model: modelId,
    baseProfile: result.baseProfile.profile,
    adaptations: result.adaptationReasons,
    signals: {
      malformedCalls: result.signals.malformedCallCount,
      truncations: result.signals.malformedReasons.truncated,
      contextPressure: result.signals.contextPressureEvents,
      editErrorRate: (result.signals.editErrorRate * 100).toFixed(1) + '%',
      editStaleRate: (result.signals.editStaleRate * 100).toFixed(1) + '%',
    },
  });
}
