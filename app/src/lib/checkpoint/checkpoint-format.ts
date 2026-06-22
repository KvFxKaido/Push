/** Deterministic relative age (`nowMs` injected so render tests are stable). */
export function formatCheckpointAge(nowMs: number, timestampMs: number): string {
  const diffMs = nowMs - timestampMs;
  if (diffMs < 60_000) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
