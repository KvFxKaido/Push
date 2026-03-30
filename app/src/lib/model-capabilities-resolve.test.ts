import { beforeEach, describe, expect, it, vi } from 'vitest';

const metricsState = vi.hoisted(() => ({
  toolCallMetrics: {
    count: 0,
    reasons: { truncated: 0, validation_failed: 0, malformed_json: 0, natural_language_intent: 0 },
    byProvider: {},
  },
  contextMetrics: {
    totalEvents: 0,
    totalTokensSaved: 0,
    largestReduction: 0,
    maxContextSeen: 0,
    summarization: { count: 0, totalBefore: 0, totalAfter: 0, messagesDropped: 0 },
    digestDrop: { count: 0, totalBefore: 0, totalAfter: 0, messagesDropped: 0 },
    hardTrim: { count: 0, totalBefore: 0, totalAfter: 0, messagesDropped: 0 },
    summarizationCauses: { tool_output: 0, long_message: 0, mixed: 0 },
    byProvider: {},
  },
  writeMetrics: {
    count: 0,
    successCount: 0,
    staleCount: 0,
    errorCount: 0,
    totalLatencyMs: 0,
    minLatencyMs: Infinity,
    maxLatencyMs: 0,
    errorsByCode: {},
  },
}));

vi.mock('./tool-call-metrics', () => ({
  getMalformedToolCallMetrics: () => metricsState.toolCallMetrics,
}));

vi.mock('./context-metrics', () => ({
  getContextMetrics: () => metricsState.contextMetrics,
}));

vi.mock('./edit-metrics', () => ({
  getWriteFileMetrics: () => metricsState.writeMetrics,
}));

import { resolveHarnessSettings } from './model-capabilities';

describe('resolveHarnessSettings', () => {
  beforeEach(() => {
    metricsState.toolCallMetrics = {
      count: 0,
      reasons: { truncated: 0, validation_failed: 0, malformed_json: 0, natural_language_intent: 0 },
      byProvider: {},
    };
    metricsState.contextMetrics = {
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
    metricsState.writeMetrics = {
      count: 0,
      successCount: 0,
      staleCount: 0,
      errorCount: 0,
      totalLatencyMs: 0,
      minLatencyMs: Infinity,
      maxLatencyMs: 0,
      errorsByCode: {},
    };
  });

  it('returns adapted settings instead of the base profile when thresholds are hit', () => {
    metricsState.toolCallMetrics = {
      count: 3,
      reasons: { truncated: 0, validation_failed: 3, malformed_json: 0, natural_language_intent: 0 },
      byProvider: {
        openrouter: {
          count: 3,
          reasons: { truncated: 0, validation_failed: 3, malformed_json: 0, natural_language_intent: 0 },
          byModel: {
            'openai/gpt-4o': {
              count: 3,
              reasons: { truncated: 0, validation_failed: 3, malformed_json: 0, natural_language_intent: 0 },
              byTool: {},
            },
          },
        },
      },
    };

    const settings = resolveHarnessSettings('openrouter', 'openai/gpt-4o');

    expect(settings.profile).toBe('standard');
    expect(settings.plannerRequired).toBe(true);
    expect(settings.maxCoderRounds).toBe(20);
  });
});
