import { beforeEach, describe, expect, it } from 'vitest';
import { getWriteFileMetrics, recordWriteFileMetric, resetWriteFileMetrics } from './edit-metrics';

describe('edit-metrics', () => {
  beforeEach(() => {
    resetWriteFileMetrics();
  });

  it('records success metrics', () => {
    recordWriteFileMetric({ durationMs: 50, outcome: 'success' });
    const snapshot = getWriteFileMetrics();
    expect(snapshot.count).toBe(1);
    expect(snapshot.successCount).toBe(1);
    expect(snapshot.errorCount).toBe(0);
    expect(snapshot.staleCount).toBe(0);
    expect(snapshot.totalLatencyMs).toBe(50);
    expect(snapshot.minLatencyMs).toBe(50);
    expect(snapshot.maxLatencyMs).toBe(50);
  });

  it('records stale and error codes', () => {
    recordWriteFileMetric({ durationMs: 25, outcome: 'stale', errorCode: 'STALE_FILE' });
    recordWriteFileMetric({ durationMs: 40, outcome: 'error', errorCode: 'WRITE_FAILED' });
    const snapshot = getWriteFileMetrics();
    expect(snapshot.count).toBe(2);
    expect(snapshot.staleCount).toBe(1);
    expect(snapshot.errorCount).toBe(1);
    expect(snapshot.errorsByCode.STALE_FILE).toBe(1);
    expect(snapshot.errorsByCode.WRITE_FAILED).toBe(1);
  });
});

