/**
 * context-metrics.ts — per-session counters for context compression events.
 *
 * Mirrors the substrate that `app/src/lib/context-metrics.ts` provides on
 * the web side. Read by `cli/harness-adaptation.ts` via `getContextMetrics()`
 * to detect sustained context pressure.
 *
 * Counters are scoped per `sessionId` so that multiple concurrent sessions
 * in the same process (e.g., under `pushd`) do not leak signals into each
 * other. Callers that omit `sessionId` read an aggregate view across every
 * tracked session.
 */

interface ContextMetrics {
  totalEvents: number;
  totalTokensSaved: number;
}

const metricsBySession = new Map<string, ContextMetrics>();

function zero(): ContextMetrics {
  return { totalEvents: 0, totalTokensSaved: 0 };
}

function getOrCreate(sessionId: string): ContextMetrics {
  let m = metricsBySession.get(sessionId);
  if (!m) {
    m = zero();
    metricsBySession.set(sessionId, m);
  }
  return m;
}

interface TrimResultLike {
  trimmed: boolean;
  beforeTokens?: number;
  afterTokens?: number;
}

export function recordContextTrim(sessionId: string, result: TrimResultLike): void {
  if (!result.trimmed) return;
  const m = getOrCreate(sessionId);
  m.totalEvents += 1;
  const before = result.beforeTokens ?? 0;
  const after = result.afterTokens ?? 0;
  if (before > after) {
    m.totalTokensSaved += before - after;
  }
}

export function getContextMetrics(sessionId?: string): ContextMetrics {
  if (sessionId !== undefined) {
    return { ...(metricsBySession.get(sessionId) ?? zero()) };
  }
  const total = zero();
  for (const m of metricsBySession.values()) {
    total.totalEvents += m.totalEvents;
    total.totalTokensSaved += m.totalTokensSaved;
  }
  return total;
}

export function resetContextMetrics(sessionId?: string): void {
  if (sessionId === undefined) {
    metricsBySession.clear();
    return;
  }
  metricsBySession.delete(sessionId);
}
