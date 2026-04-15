/**
 * tool-call-metrics.ts — per-session counters for malformed tool calls.
 *
 * Counters are scoped per `sessionId` so that multiple concurrent sessions
 * in the same process (e.g., under `pushd`) do not leak signals into each
 * other. Callers that omit `sessionId` read/write an aggregate view across
 * every tracked session (used by the end-of-run CLI stats summary).
 */

const malformedBySession = new Map<string, Map<string, number>>();

function getOrCreate(sessionId: string): Map<string, number> {
  let m = malformedBySession.get(sessionId);
  if (!m) {
    m = new Map<string, number>();
    malformedBySession.set(sessionId, m);
  }
  return m;
}

export function recordMalformedToolCall(reason: unknown, sessionId: string = '__global__'): void {
  const bucket = getOrCreate(sessionId);
  const key = String(reason || 'unknown');
  bucket.set(key, (bucket.get(key) || 0) + 1);
}

export function getToolCallMetrics(sessionId?: string): { malformed: Record<string, number> } {
  if (sessionId !== undefined) {
    const bucket = malformedBySession.get(sessionId);
    return { malformed: bucket ? Object.fromEntries(bucket.entries()) : {} };
  }
  const aggregated: Record<string, number> = {};
  for (const bucket of malformedBySession.values()) {
    for (const [key, value] of bucket.entries()) {
      aggregated[key] = (aggregated[key] || 0) + value;
    }
  }
  return { malformed: aggregated };
}

export function resetToolCallMetrics(sessionId?: string): void {
  if (sessionId === undefined) {
    malformedBySession.clear();
    return;
  }
  malformedBySession.delete(sessionId);
}
