/**
 * Lightweight in-memory observability for sandbox file-edit operations.
 *
 * Tracks baseline metrics for sandbox_write_file so we can compare
 * against future edit tools without adding external dependencies.
 */

export interface WriteFileMetrics {
  count: number;
  successCount: number;
  staleCount: number;
  errorCount: number;
  totalLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  errorsByCode: Record<string, number>;
}

export type WriteOutcome = 'success' | 'stale' | 'error';

export interface WriteMetricResult {
  durationMs: number;
  outcome: WriteOutcome;
  errorCode?: string;
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

let metrics: WriteFileMetrics = emptyWriteMetrics();

/**
 * Record a completed sandbox_write_file operation.
 */
export function recordWriteFileMetric(result: WriteMetricResult): void {
  metrics.count++;
  metrics.totalLatencyMs += result.durationMs;
  metrics.minLatencyMs = Math.min(metrics.minLatencyMs, result.durationMs);
  metrics.maxLatencyMs = Math.max(metrics.maxLatencyMs, result.durationMs);

  if (result.outcome === 'success') {
    metrics.successCount++;
  } else if (result.outcome === 'stale') {
    metrics.staleCount++;
    const code = result.errorCode || 'STALE_FILE';
    metrics.errorsByCode[code] = (metrics.errorsByCode[code] || 0) + 1;
  } else {
    metrics.errorCount++;
    const code = result.errorCode || 'UNKNOWN';
    metrics.errorsByCode[code] = (metrics.errorsByCode[code] || 0) + 1;
  }

  const codeSuffix = result.errorCode ? ` ${result.errorCode}` : '';
  console.debug(`[edit] write_file ${result.outcome}${codeSuffix} ${result.durationMs}ms`);
}

export function getWriteFileMetrics(): WriteFileMetrics {
  return {
    ...metrics,
    errorsByCode: { ...metrics.errorsByCode },
  };
}

export function resetWriteFileMetrics(): void {
  metrics = emptyWriteMetrics();
}

