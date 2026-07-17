/** CLI-shell session storage for the shared malformed-tool metric reducer. */

import {
  createMalformedToolCallMetrics,
  mergeMalformedToolCallMetrics,
  reduceMalformedToolCallMetric,
  type MalformedToolCallMetrics,
} from '../lib/malformed-tool-metrics.js';

const malformedBySession = new Map<string, MalformedToolCallMetrics<string>>();

function getOrCreate(sessionId: string): MalformedToolCallMetrics<string> {
  const current = malformedBySession.get(sessionId);
  if (current) return current;
  const created = createMalformedToolCallMetrics<string>();
  malformedBySession.set(sessionId, created);
  return created;
}

export function recordMalformedToolCall(reason: unknown, sessionId: string = '__global__'): void {
  const key = String(reason || 'unknown');
  malformedBySession.set(
    sessionId,
    reduceMalformedToolCallMetric(getOrCreate(sessionId), { reason: key }),
  );
}

export function getToolCallMetrics(sessionId?: string): { malformed: Record<string, number> } {
  const snapshot =
    sessionId === undefined
      ? mergeMalformedToolCallMetrics([...malformedBySession.values()])
      : (malformedBySession.get(sessionId) ?? createMalformedToolCallMetrics<string>());
  return { malformed: { ...snapshot.reasons } };
}

export function resetToolCallMetrics(sessionId?: string): void {
  if (sessionId === undefined) malformedBySession.clear();
  else malformedBySession.delete(sessionId);
}
