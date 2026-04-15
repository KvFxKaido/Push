/**
 * edit-metrics.ts — per-session counters for file-edit reliability.
 *
 * Mirrors the substrate that `app/src/lib/edit-metrics.ts` provides on the
 * web side. Read by `cli/harness-adaptation.ts` via `getWriteFileMetrics()`
 * to compute edit error and stale rates.
 */

interface EditMetrics {
  count: number;
  errorCount: number;
  staleCount: number;
}

const metrics: EditMetrics = {
  count: 0,
  errorCount: 0,
  staleCount: 0,
};

export function recordWriteFile(result: { error: boolean; stale: boolean }): void {
  metrics.count += 1;
  if (result.error) metrics.errorCount += 1;
  if (result.stale) metrics.staleCount += 1;
}

export function getWriteFileMetrics(): EditMetrics {
  return { ...metrics };
}

export function resetWriteFileMetrics(): void {
  metrics.count = 0;
  metrics.errorCount = 0;
  metrics.staleCount = 0;
}
