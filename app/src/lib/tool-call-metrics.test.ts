import { beforeEach, describe, expect, it } from 'vitest';
import {
  getMalformedToolCallMetrics,
  recordMalformedToolCallMetric,
  resetMalformedToolCallMetrics,
} from './tool-call-metrics';

describe('tool-call-metrics', () => {
  beforeEach(() => {
    resetMalformedToolCallMetrics();
  });

  it('records malformed calls by provider/model/reason', () => {
    recordMalformedToolCallMetric({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
      reason: 'malformed_json',
      toolName: 'sandbox_exec',
    });
    recordMalformedToolCallMetric({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
      reason: 'validation_failed',
      toolName: 'sandbox_read_file',
    });

    const snapshot = getMalformedToolCallMetrics();
    expect(snapshot.count).toBe(2);
    expect(snapshot.reasons.malformed_json).toBe(1);
    expect(snapshot.reasons.validation_failed).toBe(1);
    expect(snapshot.byProvider.openrouter.count).toBe(2);
    expect(snapshot.byProvider.openrouter.byModel['anthropic/claude-sonnet-4.5'].count).toBe(2);
    expect(snapshot.byProvider.openrouter.byModel['anthropic/claude-sonnet-4.5'].byTool.sandbox_exec).toBe(1);
    expect(snapshot.byProvider.openrouter.byModel['anthropic/claude-sonnet-4.5'].byTool.sandbox_read_file).toBe(1);
  });

  it('falls back to unknown labels when provider/model/tool are missing', () => {
    recordMalformedToolCallMetric({
      reason: 'truncated',
    });

    const snapshot = getMalformedToolCallMetrics();
    expect(snapshot.count).toBe(1);
    expect(snapshot.reasons.truncated).toBe(1);
    expect(snapshot.byProvider['unknown-provider'].byModel['unknown-model'].byTool['unknown-tool']).toBe(1);
  });

  it('returns a defensive copy from getMalformedToolCallMetrics', () => {
    recordMalformedToolCallMetric({
      provider: 'mistral',
      model: 'devstral-small-latest',
      reason: 'validation_failed',
      toolName: 'sandbox_write_file',
    });

    const snapshot = getMalformedToolCallMetrics();
    snapshot.byProvider.mistral.count = 99;
    snapshot.byProvider.mistral.byModel['devstral-small-latest'].byTool.sandbox_write_file = 42;

    const fresh = getMalformedToolCallMetrics();
    expect(fresh.byProvider.mistral.count).toBe(1);
    expect(fresh.byProvider.mistral.byModel['devstral-small-latest'].byTool.sandbox_write_file).toBe(1);
  });
});
