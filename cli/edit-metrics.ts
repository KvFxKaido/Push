/**
 * edit-metrics.ts — per-session counters for file-edit reliability.
 *
 * Mirrors the substrate that `app/src/lib/edit-metrics.ts` provides on the
 * web side. Read by `cli/harness-adaptation.ts` via `getWriteFileMetrics()`
 * to compute edit error and stale rates.
 *
 * Counters are scoped per `sessionId` so that multiple concurrent sessions
 * in the same process (e.g., under `pushd`) do not leak signals into each
 * other. Callers that omit `sessionId` read/write an aggregate view across
 * every tracked session.
 */

interface EditMetrics {
  count: number;
  errorCount: number;
  staleCount: number;
}

const metricsBySession = new Map<string, EditMetrics>();

function zero(): EditMetrics {
  return { count: 0, errorCount: 0, staleCount: 0 };
}

function getOrCreate(sessionId: string): EditMetrics {
  let m = metricsBySession.get(sessionId);
  if (!m) {
    m = zero();
    metricsBySession.set(sessionId, m);
  }
  return m;
}

export function recordWriteFile(
  sessionId: string,
  result: { error: boolean; stale: boolean },
): void {
  const m = getOrCreate(sessionId);
  m.count += 1;
  if (result.error) m.errorCount += 1;
  if (result.stale) m.staleCount += 1;
}

export function getWriteFileMetrics(sessionId?: string): EditMetrics {
  if (sessionId !== undefined) {
    return { ...(metricsBySession.get(sessionId) ?? zero()) };
  }
  const total = zero();
  for (const m of metricsBySession.values()) {
    total.count += m.count;
    total.errorCount += m.errorCount;
    total.staleCount += m.staleCount;
  }
  return total;
}

export function resetWriteFileMetrics(sessionId?: string): void {
  if (sessionId === undefined) {
    metricsBySession.clear();
    return;
  }
  metricsBySession.delete(sessionId);
}
