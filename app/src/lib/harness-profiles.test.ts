import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MalformedToolCallMetrics } from './tool-call-metrics';
import type { ContextMetrics } from './context-metrics';
import type { WriteFileMetrics } from './edit-metrics';
import type { HarnessProfileSettings } from '@/types';

// ---------------------------------------------------------------------------
// Mocks — provide controlled metric values for each test
// ---------------------------------------------------------------------------

function emptyToolCallMetrics(): MalformedToolCallMetrics {
  return {
    count: 0,
    reasons: { truncated: 0, validation_failed: 0, malformed_json: 0, natural_language_intent: 0 },
    byProvider: {},
  };
}

function emptyContextMetrics(): ContextMetrics {
  return {
    totalEvents: 0,
    totalTokensSaved: 0,
    largestReduction: 0,
    maxContextSeen: 0,
    summarization: { count: 0, totalBefore: 0, totalAfter: 0, messagesDropped: 0 },
    digestDrop: { count: 0, totalBefore: 0, totalAfter: 0, messagesDropped: 0 },
    hardTrim: { count: 0, totalBefore: 0, totalAfter: 0, messagesDropped: 0 },
    summarizationCauses: { tool_output: 0, long_message: 0, mixed: 0 },
    byProvider: {},
  };
}

function emptyWriteMetrics(): WriteFileMetrics {
  return {
    count: 0,
    successCount: 0,
    staleCount: 0,
    errorCount: 0,
    totalLatencyMs: 0,
    minLatencyMs: Infinity,
    maxLatencyMs: 0,
    errorsByCode: {},
  };
}

let mockToolCallMetrics = emptyToolCallMetrics();
let mockContextMetrics = emptyContextMetrics();
let mockWriteMetrics = emptyWriteMetrics();

vi.mock('./tool-call-metrics', () => ({
  getMalformedToolCallMetrics: () => mockToolCallMetrics,
}));

vi.mock('./context-metrics', () => ({
  getContextMetrics: () => mockContextMetrics,
}));

vi.mock('./edit-metrics', () => ({
  getWriteFileMetrics: () => mockWriteMetrics,
}));

// Import under test after mocks are in place
import {
  collectAdaptationSignals,
  computeAdaptiveProfile,
  logAdaptiveProfile,
  THRESHOLDS,
} from './harness-profiles';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STANDARD_BASE: HarnessProfileSettings = {
  profile: 'standard',
  maxCoderRounds: 30,
  plannerRequired: false,
  contextResetsEnabled: false,
  evaluateAfterCoder: true,
};

const HEAVY_BASE: HarnessProfileSettings = {
  profile: 'heavy',
  maxCoderRounds: 20,
  plannerRequired: true,
  contextResetsEnabled: true,
  evaluateAfterCoder: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('collectAdaptationSignals', () => {
  beforeEach(() => {
    mockToolCallMetrics = emptyToolCallMetrics();
    mockContextMetrics = emptyContextMetrics();
    mockWriteMetrics = emptyWriteMetrics();
  });

  it('returns zero signals when no metrics exist', () => {
    const signals = collectAdaptationSignals('openrouter', 'some-model');

    expect(signals.malformedCallCount).toBe(0);
    expect(signals.malformedReasons.truncated).toBe(0);
    expect(signals.malformedReasons.validationFailed).toBe(0);
    expect(signals.malformedReasons.malformedJson).toBe(0);
    expect(signals.malformedReasons.naturalLanguageIntent).toBe(0);
    expect(signals.contextPressureEvents).toBe(0);
    expect(signals.contextTokensSaved).toBe(0);
    expect(signals.editErrorRate).toBe(0);
    expect(signals.editStaleRate).toBe(0);
  });

  it('drills into model-specific metrics when modelId is provided', () => {
    mockToolCallMetrics = {
      count: 5,
      reasons: { truncated: 2, validation_failed: 1, malformed_json: 1, natural_language_intent: 1 },
      byProvider: {
        openrouter: {
          count: 5,
          reasons: { truncated: 2, validation_failed: 1, malformed_json: 1, natural_language_intent: 1 },
          byModel: {
            'claude-sonnet': {
              count: 3,
              reasons: { truncated: 1, validation_failed: 1, malformed_json: 1, natural_language_intent: 0 },
              byTool: {},
            },
            'gpt-4o': {
              count: 2,
              reasons: { truncated: 1, validation_failed: 0, malformed_json: 0, natural_language_intent: 1 },
              byTool: {},
            },
          },
        },
      },
    };

    const signals = collectAdaptationSignals('openrouter', 'claude-sonnet');
    expect(signals.malformedCallCount).toBe(3);
    expect(signals.malformedReasons.truncated).toBe(1);
  });

  it('uses provider-level metrics when modelId is omitted', () => {
    mockToolCallMetrics = {
      count: 4,
      reasons: { truncated: 2, validation_failed: 1, malformed_json: 1, natural_language_intent: 0 },
      byProvider: {
        openrouter: {
          count: 4,
          reasons: { truncated: 2, validation_failed: 1, malformed_json: 1, natural_language_intent: 0 },
          byModel: {},
        },
      },
    };

    const signals = collectAdaptationSignals('openrouter');
    expect(signals.malformedCallCount).toBe(4);
    expect(signals.malformedReasons.truncated).toBe(2);
  });

  it('computes edit error and stale rates from write metrics', () => {
    mockWriteMetrics = {
      count: 10,
      successCount: 6,
      staleCount: 2,
      errorCount: 2,
      totalLatencyMs: 0,
      minLatencyMs: Infinity,
      maxLatencyMs: 0,
      errorsByCode: {},
    };

    const signals = collectAdaptationSignals('openrouter');
    expect(signals.editErrorRate).toBeCloseTo(0.2);
    expect(signals.editStaleRate).toBeCloseTo(0.2);
  });
});

describe('computeAdaptiveProfile', () => {
  beforeEach(() => {
    mockToolCallMetrics = emptyToolCallMetrics();
    mockContextMetrics = emptyContextMetrics();
    mockWriteMetrics = emptyWriteMetrics();
  });

  it('returns base profile unchanged when no thresholds are met', () => {
    const result = computeAdaptiveProfile({ ...STANDARD_BASE }, 'openrouter', 'claude-opus');

    expect(result.wasAdapted).toBe(false);
    expect(result.adaptationReasons).toHaveLength(0);
    expect(result.adaptedProfile).toEqual(STANDARD_BASE);
  });

  it('enables planner when malformed call count exceeds threshold', () => {
    mockToolCallMetrics = {
      count: THRESHOLDS.MALFORMED_CALL_ESCALATION,
      reasons: { truncated: 0, validation_failed: THRESHOLDS.MALFORMED_CALL_ESCALATION, malformed_json: 0, natural_language_intent: 0 },
      byProvider: {
        openrouter: {
          count: THRESHOLDS.MALFORMED_CALL_ESCALATION,
          reasons: { truncated: 0, validation_failed: THRESHOLDS.MALFORMED_CALL_ESCALATION, malformed_json: 0, natural_language_intent: 0 },
          byModel: {
            'some-model': {
              count: THRESHOLDS.MALFORMED_CALL_ESCALATION,
              reasons: { truncated: 0, validation_failed: THRESHOLDS.MALFORMED_CALL_ESCALATION, malformed_json: 0, natural_language_intent: 0 },
              byTool: {},
            },
          },
        },
      },
    };

    const result = computeAdaptiveProfile({ ...STANDARD_BASE }, 'openrouter', 'some-model');

    expect(result.wasAdapted).toBe(true);
    expect(result.adaptedProfile.plannerRequired).toBe(true);
    expect(result.adaptedProfile.maxCoderRounds).toBe(20);
    expect(result.adaptationReasons).toContainEqual(
      expect.stringContaining('Enable planner'),
    );
    expect(result.adaptationReasons).toContainEqual(
      expect.stringContaining('Reduce max rounds to 20'),
    );
  });

  it('does not re-enable planner on heavy profile (already enabled)', () => {
    mockToolCallMetrics = {
      count: 5,
      reasons: { truncated: 0, validation_failed: 5, malformed_json: 0, natural_language_intent: 0 },
      byProvider: {
        openrouter: {
          count: 5,
          reasons: { truncated: 0, validation_failed: 5, malformed_json: 0, natural_language_intent: 0 },
          byModel: {
            'some-model': {
              count: 5,
              reasons: { truncated: 0, validation_failed: 5, malformed_json: 0, natural_language_intent: 0 },
              byTool: {},
            },
          },
        },
      },
    };

    const result = computeAdaptiveProfile({ ...HEAVY_BASE }, 'openrouter', 'some-model');

    // Heavy already has planner=true and maxCoderRounds=20, so neither adaptation fires
    expect(result.wasAdapted).toBe(false);
    expect(result.adaptedProfile.plannerRequired).toBe(true);
    expect(result.adaptedProfile.maxCoderRounds).toBe(20);
  });

  it('reduces maxCoderRounds on high truncation', () => {
    mockToolCallMetrics = {
      count: 2,
      reasons: { truncated: THRESHOLDS.TRUNCATION_ESCALATION, validation_failed: 0, malformed_json: 0, natural_language_intent: 0 },
      byProvider: {
        zen: {
          count: 2,
          reasons: { truncated: THRESHOLDS.TRUNCATION_ESCALATION, validation_failed: 0, malformed_json: 0, natural_language_intent: 0 },
          byModel: {},
        },
      },
    };

    const result = computeAdaptiveProfile({ ...STANDARD_BASE }, 'zen');

    expect(result.wasAdapted).toBe(true);
    expect(result.adaptedProfile.maxCoderRounds).toBe(25); // 30 - 5
    expect(result.adaptationReasons).toContainEqual(
      expect.stringContaining('truncated outputs'),
    );
  });

  it('clamps maxCoderRounds to floor of 15 on truncation', () => {
    mockToolCallMetrics = {
      count: 3,
      reasons: { truncated: 3, validation_failed: 0, malformed_json: 0, natural_language_intent: 0 },
      byProvider: {
        zen: {
          count: 3,
          reasons: { truncated: 3, validation_failed: 0, malformed_json: 0, natural_language_intent: 0 },
          byModel: {},
        },
      },
    };

    // Start from a profile with maxCoderRounds at 18
    const base: HarnessProfileSettings = {
      profile: 'heavy',
      maxCoderRounds: 18,
      plannerRequired: true,
      contextResetsEnabled: true,
      evaluateAfterCoder: true,
    };

    const result = computeAdaptiveProfile(base, 'zen');
    // 18 - 5 = 13, clamped to 15
    expect(result.adaptedProfile.maxCoderRounds).toBe(15);
  });

  it('enables context resets on high context pressure', () => {
    mockContextMetrics = {
      ...emptyContextMetrics(),
      totalEvents: THRESHOLDS.CONTEXT_PRESSURE_ESCALATION,
      totalTokensSaved: 50000,
    };

    const result = computeAdaptiveProfile({ ...STANDARD_BASE }, 'openrouter', 'some-model');

    expect(result.wasAdapted).toBe(true);
    expect(result.adaptedProfile.contextResetsEnabled).toBe(true);
    expect(result.adaptationReasons).toContainEqual(
      expect.stringContaining('compression events'),
    );
  });

  it('does not re-enable context resets when already enabled', () => {
    mockContextMetrics = {
      ...emptyContextMetrics(),
      totalEvents: 10,
    };

    const result = computeAdaptiveProfile({ ...HEAVY_BASE }, 'openrouter');

    // contextResetsEnabled is already true on heavy, so no adaptation for this signal
    const contextResetReasons = result.adaptationReasons.filter(r => r.includes('context resets'));
    expect(contextResetReasons).toHaveLength(0);
  });

  it('reduces maxCoderRounds on high edit error rate', () => {
    mockWriteMetrics = {
      count: 8,
      successCount: 5,
      staleCount: 0,
      errorCount: 3,
      totalLatencyMs: 0,
      minLatencyMs: Infinity,
      maxLatencyMs: 0,
      errorsByCode: {},
    };
    // errorRate = 3/8 = 0.375, exceeds 0.25

    const result = computeAdaptiveProfile({ ...STANDARD_BASE }, 'openrouter');

    expect(result.wasAdapted).toBe(true);
    expect(result.adaptedProfile.maxCoderRounds).toBe(25); // 30 - 5
    expect(result.adaptationReasons).toContainEqual(
      expect.stringContaining('edit error rate'),
    );
  });

  it('enables context resets on high stale edit rate', () => {
    mockWriteMetrics = {
      count: 10,
      successCount: 7,
      staleCount: 3,
      errorCount: 0,
      totalLatencyMs: 0,
      minLatencyMs: Infinity,
      maxLatencyMs: 0,
      errorsByCode: {},
    };
    // staleRate = 3/10 = 0.30, exceeds 0.20

    const result = computeAdaptiveProfile({ ...STANDARD_BASE }, 'openrouter');

    expect(result.wasAdapted).toBe(true);
    expect(result.adaptedProfile.contextResetsEnabled).toBe(true);
    expect(result.adaptationReasons).toContainEqual(
      expect.stringContaining('edit stale rate'),
    );
  });

  it('applies multiple adaptations simultaneously', () => {
    // Trigger malformed calls + context pressure + edit errors at once
    mockToolCallMetrics = {
      count: 5,
      reasons: { truncated: 3, validation_failed: 2, malformed_json: 0, natural_language_intent: 0 },
      byProvider: {
        openrouter: {
          count: 5,
          reasons: { truncated: 3, validation_failed: 2, malformed_json: 0, natural_language_intent: 0 },
          byModel: {},
        },
      },
    };
    mockContextMetrics = {
      ...emptyContextMetrics(),
      totalEvents: 8,
    };
    mockWriteMetrics = {
      count: 4,
      successCount: 2,
      staleCount: 1,
      errorCount: 1,
      totalLatencyMs: 0,
      minLatencyMs: Infinity,
      maxLatencyMs: 0,
      errorsByCode: {},
    };

    const result = computeAdaptiveProfile({ ...STANDARD_BASE }, 'openrouter');

    expect(result.wasAdapted).toBe(true);
    expect(result.adaptedProfile.plannerRequired).toBe(true);
    expect(result.adaptedProfile.contextResetsEnabled).toBe(true);
    // maxCoderRounds should be reduced: first to 20 (malformed), then to 15 (truncation: 20-5=15)
    // edit error rate 0.25 would try 15-5=10 clamped to 15, but already 15 so no further reduction
    expect(result.adaptedProfile.maxCoderRounds).toBe(15);
    expect(result.adaptationReasons.length).toBeGreaterThanOrEqual(3);
  });

  it('preserves evaluateAfterCoder from base profile', () => {
    // No adaptations currently touch evaluateAfterCoder
    const base: HarnessProfileSettings = {
      profile: 'standard',
      maxCoderRounds: 30,
      plannerRequired: false,
      contextResetsEnabled: false,
      evaluateAfterCoder: false,
    };

    const result = computeAdaptiveProfile(base, 'openrouter');
    expect(result.adaptedProfile.evaluateAfterCoder).toBe(false);
  });
});

describe('logAdaptiveProfile', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('only logs when wasAdapted is true', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const noAdaptation: Parameters<typeof logAdaptiveProfile>[0] = {
      baseProfile: { ...STANDARD_BASE },
      adaptedProfile: { ...STANDARD_BASE },
      wasAdapted: false,
      adaptationReasons: [],
      signals: {
        malformedCallCount: 0,
        malformedReasons: { truncated: 0, validationFailed: 0, malformedJson: 0, naturalLanguageIntent: 0 },
        contextPressureEvents: 0,
        contextTokensSaved: 0,
        editErrorRate: 0,
        editStaleRate: 0,
      },
    };

    logAdaptiveProfile(noAdaptation, 'openrouter', 'some-model');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('logs shadow adaptation details when wasAdapted is true', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const adapted: Parameters<typeof logAdaptiveProfile>[0] = {
      baseProfile: { ...STANDARD_BASE },
      adaptedProfile: { ...STANDARD_BASE, plannerRequired: true },
      wasAdapted: true,
      adaptationReasons: ['Enable planner: 4 malformed tool calls'],
      signals: {
        malformedCallCount: 4,
        malformedReasons: { truncated: 0, validationFailed: 4, malformedJson: 0, naturalLanguageIntent: 0 },
        contextPressureEvents: 0,
        contextTokensSaved: 0,
        editErrorRate: 0,
        editStaleRate: 0,
      },
    };

    logAdaptiveProfile(adapted, 'openrouter', 'some-model');
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith(
      '[HarnessProfile] Shadow adaptation computed',
      expect.objectContaining({
        provider: 'openrouter',
        model: 'some-model',
        baseProfile: 'standard',
      }),
    );
  });
});
