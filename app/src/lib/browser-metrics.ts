/**
 * Lightweight in-memory observability for browser tool operations.
 *
 * Tracks latency, error rates, and retry behavior for
 * sandbox_browser_screenshot and sandbox_browser_extract.
 *
 * Zero external dependencies. Metrics reset on page reload.
 * Shape is designed for future export to a /api/metrics endpoint.
 */

// --- Types ---

export interface OperationMetrics {
  count: number;
  errorCount: number;
  retryCount: number;
  /** Total cumulative latency in ms (divide by count for average). */
  totalLatencyMs: number;
  /** Min observed latency in ms. Infinity when count === 0. */
  minLatencyMs: number;
  /** Max observed latency in ms. 0 when count === 0. */
  maxLatencyMs: number;
  /** Error counts broken down by error code. */
  errorsByCode: Record<string, number>;
}

export interface BrowserMetrics {
  screenshot: OperationMetrics;
  extract: OperationMetrics;
}

// --- Internal state ---

function emptyOperationMetrics(): OperationMetrics {
  return {
    count: 0,
    errorCount: 0,
    retryCount: 0,
    totalLatencyMs: 0,
    minLatencyMs: Infinity,
    maxLatencyMs: 0,
    errorsByCode: {},
  };
}

let metrics: BrowserMetrics = {
  screenshot: emptyOperationMetrics(),
  extract: emptyOperationMetrics(),
};

// --- Public API ---

export type BrowserOperation = 'screenshot' | 'extract';

export interface BrowserMetricResult {
  durationMs: number;
  success: boolean;
  errorCode?: string;
  retries: number;
}

/**
 * Record a completed browser operation.
 * Call this after every screenshot/extract attempt (success or failure).
 */
export function recordBrowserMetric(
  operation: BrowserOperation,
  result: BrowserMetricResult,
): void {
  const bucket = metrics[operation];

  bucket.count++;
  bucket.totalLatencyMs += result.durationMs;
  bucket.retryCount += result.retries;

  if (result.durationMs < bucket.minLatencyMs) {
    bucket.minLatencyMs = result.durationMs;
  }
  if (result.durationMs > bucket.maxLatencyMs) {
    bucket.maxLatencyMs = result.durationMs;
  }

  if (!result.success) {
    bucket.errorCount++;
    const code = result.errorCode || 'UNKNOWN';
    bucket.errorsByCode[code] = (bucket.errorsByCode[code] || 0) + 1;
  }

  // Compact console.debug line
  const status = result.success ? 'ok' : `error ${result.errorCode || 'UNKNOWN'}`;
  console.debug(
    `[browser] ${operation} ${status} ${result.durationMs}ms retries=${result.retries}`,
  );
}

/**
 * Get a snapshot of current metrics.
 * Returns a deep copy so callers cannot mutate internal state.
 */
export function getBrowserMetrics(): BrowserMetrics {
  return {
    screenshot: { ...metrics.screenshot, errorsByCode: { ...metrics.screenshot.errorsByCode } },
    extract: { ...metrics.extract, errorsByCode: { ...metrics.extract.errorsByCode } },
  };
}

/**
 * Reset all metrics to zero. Useful for testing.
 */
export function resetBrowserMetrics(): void {
  metrics = {
    screenshot: emptyOperationMetrics(),
    extract: emptyOperationMetrics(),
  };
}
