import { describe, expect, it } from 'vitest';

import {
  createMalformedToolCallMetrics,
  mergeMalformedToolCallMetrics,
  reduceMalformedToolCallMetric,
} from './malformed-tool-metrics.js';

describe('malformed tool metrics reducer', () => {
  it('records rich dimensions without mutating the prior state', () => {
    const initial = createMalformedToolCallMetrics(['malformed_json'] as const);
    const next = reduceMalformedToolCallMetric(initial, {
      reason: 'malformed_json',
      provider: 'openrouter',
      model: 'model-a',
      toolName: 'read_file',
    });
    expect(initial.count).toBe(0);
    expect(next).toMatchObject({ count: 1, reasons: { malformed_json: 1 } });
    expect(next.byProvider.openrouter.byModel['model-a'].byTool.read_file).toBe(1);
  });

  it('merges shell-local snapshots with reason and dimension counts intact', () => {
    const one = reduceMalformedToolCallMetric(createMalformedToolCallMetrics<string>(), {
      reason: 'truncated',
      provider: 'one',
    });
    const two = reduceMalformedToolCallMetric(createMalformedToolCallMetrics<string>(), {
      reason: 'validation_failed',
      provider: 'two',
    });
    const merged = mergeMalformedToolCallMetrics([one, two]);
    expect(merged.count).toBe(2);
    expect(merged.reasons).toMatchObject({ truncated: 1, validation_failed: 1 });
    expect(merged.byProvider.one.count).toBe(1);
    expect(merged.byProvider.two.count).toBe(1);
  });
});
