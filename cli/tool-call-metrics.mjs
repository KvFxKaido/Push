const malformedByReason = new Map();

export function recordMalformedToolCall(reason) {
  const key = String(reason || 'unknown');
  malformedByReason.set(key, (malformedByReason.get(key) || 0) + 1);
}

export function getToolCallMetrics() {
  return {
    malformed: Object.fromEntries(malformedByReason.entries()),
  };
}

export function resetToolCallMetrics() {
  malformedByReason.clear();
}
