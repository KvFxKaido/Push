const malformedByReason = new Map<string, number>();

export function recordMalformedToolCall(reason: unknown): void {
  const key = String(reason || 'unknown');
  malformedByReason.set(key, (malformedByReason.get(key) || 0) + 1);
}

export function getToolCallMetrics(): { malformed: Record<string, number> } {
  return {
    malformed: Object.fromEntries(malformedByReason.entries()),
  };
}

export function resetToolCallMetrics(): void {
  malformedByReason.clear();
}
