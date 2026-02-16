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

export interface ReadFileMetrics {
  count: number;
  successCount: number;
  errorCount: number;
  fullReadCount: number;
  rangeReadCount: number;
  truncatedCount: number;
  emptyRangeCount: number;
  totalPayloadChars: number;
  minPayloadChars: number;
  maxPayloadChars: number;
  errorsByCode: Record<string, number>;
}

export type ReadOutcome = 'success' | 'error';

export interface ReadMetricResult {
  outcome: ReadOutcome;
  payloadChars: number;
  isRangeRead: boolean;
  truncated?: boolean;
  emptyRange?: boolean;
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
let readMetrics: ReadFileMetrics = emptyReadMetrics();

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

function emptyReadMetrics(): ReadFileMetrics {
  return {
    count: 0,
    successCount: 0,
    errorCount: 0,
    fullReadCount: 0,
    rangeReadCount: 0,
    truncatedCount: 0,
    emptyRangeCount: 0,
    totalPayloadChars: 0,
    minPayloadChars: Infinity,
    maxPayloadChars: 0,
    errorsByCode: {},
  };
}

/**
 * Record a completed sandbox_read_file operation.
 */
export function recordReadFileMetric(result: ReadMetricResult): void {
  const payloadChars = Number.isFinite(result.payloadChars)
    ? Math.max(0, Math.floor(result.payloadChars))
    : 0;

  readMetrics.count++;
  if (result.isRangeRead) readMetrics.rangeReadCount++;
  else readMetrics.fullReadCount++;

  readMetrics.totalPayloadChars += payloadChars;
  readMetrics.minPayloadChars = Math.min(readMetrics.minPayloadChars, payloadChars);
  readMetrics.maxPayloadChars = Math.max(readMetrics.maxPayloadChars, payloadChars);

  if (result.outcome === 'success') {
    readMetrics.successCount++;
    if (result.truncated) readMetrics.truncatedCount++;
    if (result.emptyRange) readMetrics.emptyRangeCount++;
  } else {
    readMetrics.errorCount++;
    const code = result.errorCode || 'UNKNOWN';
    readMetrics.errorsByCode[code] = (readMetrics.errorsByCode[code] || 0) + 1;
  }

  const readType = result.isRangeRead ? 'range' : 'full';
  const outcome = result.outcome;
  const flags = [
    result.truncated ? 'truncated' : '',
    result.emptyRange ? 'empty_range' : '',
    result.errorCode ? result.errorCode : '',
  ].filter(Boolean).join(' ');
  console.debug(`[edit] read_file ${readType} ${outcome} chars=${payloadChars}${flags ? ` ${flags}` : ''}`);
}

export function getReadFileMetrics(): ReadFileMetrics {
  return {
    ...readMetrics,
    errorsByCode: { ...readMetrics.errorsByCode },
  };
}

export function resetReadFileMetrics(): void {
  readMetrics = emptyReadMetrics();
}
