/**
 * context-metrics.ts — per-session counters for context compression events.
 *
 * Mirrors the substrate that `app/src/lib/context-metrics.ts` provides on
 * the web side. Read by `cli/harness-adaptation.ts` via `getContextMetrics()`
 * to detect sustained context pressure.
 */

interface ContextMetrics {
  totalEvents: number;
  totalTokensSaved: number;
}

const metrics: ContextMetrics = {
  totalEvents: 0,
  totalTokensSaved: 0,
};

interface TrimResultLike {
  trimmed: boolean;
  beforeTokens?: number;
  afterTokens?: number;
}

export function recordContextTrim(result: TrimResultLike): void {
  if (!result.trimmed) return;
  metrics.totalEvents += 1;
  const before = result.beforeTokens ?? 0;
  const after = result.afterTokens ?? 0;
  if (before > after) {
    metrics.totalTokensSaved += before - after;
  }
}

export function getContextMetrics(): ContextMetrics {
  return { ...metrics };
}

export function resetContextMetrics(): void {
  metrics.totalEvents = 0;
  metrics.totalTokensSaved = 0;
}
