import { beforeEach, describe, expect, it } from 'vitest';
import {
  getReadFileMetrics,
  getWriteFileMetrics,
  recordReadFileMetric,
  recordWriteFileMetric,
  resetReadFileMetrics,
  resetWriteFileMetrics,
} from './edit-metrics';

describe('edit-metrics', () => {
  beforeEach(() => {
    resetWriteFileMetrics();
    resetReadFileMetrics();
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

  it('records read payload and truncation metrics', () => {
    recordReadFileMetric({
      outcome: 'success',
      payloadChars: 120,
      isRangeRead: false,
      truncated: false,
    });
    recordReadFileMetric({
      outcome: 'success',
      payloadChars: 40,
      isRangeRead: true,
      truncated: true,
      emptyRange: false,
    });

    const snapshot = getReadFileMetrics();
    expect(snapshot.count).toBe(2);
    expect(snapshot.successCount).toBe(2);
    expect(snapshot.errorCount).toBe(0);
    expect(snapshot.fullReadCount).toBe(1);
    expect(snapshot.rangeReadCount).toBe(1);
    expect(snapshot.truncatedCount).toBe(1);
    expect(snapshot.emptyRangeCount).toBe(0);
    expect(snapshot.totalPayloadChars).toBe(160);
    expect(snapshot.minPayloadChars).toBe(40);
    expect(snapshot.maxPayloadChars).toBe(120);
  });

  it('records read errors by code', () => {
    recordReadFileMetric({
      outcome: 'error',
      payloadChars: 0,
      isRangeRead: false,
      errorCode: 'READ_ERROR',
    });

    const snapshot = getReadFileMetrics();
    expect(snapshot.count).toBe(1);
    expect(snapshot.successCount).toBe(0);
    expect(snapshot.errorCount).toBe(1);
    expect(snapshot.errorsByCode.READ_ERROR).toBe(1);
  });
});
