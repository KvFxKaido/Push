/**
 * Shared pure helpers for read-only agent loops (deep-reviewer, explorer).
 *
 * Extracted from `app/src/lib/agent-loop-utils.ts` so role kernels in lib
 * can use them without pulling Web's tool-execution layer. Only the pure
 * string helpers live here — `executeReadOnlyTool` remains in Web because
 * it transitively depends on `WebToolExecutionRuntime`, default approval
 * gates, and OpenTelemetry tracing, none of which belong in lib.
 */

import { formatToolResultEnvelope } from './tool-call-recovery.js';

/** Mutation failure tracker — detects repeated failures on same tool+args */
export interface MutationFailureTracker {
  recordFailure(key: string): void;
  isRepeatedFailure(key: string, limit: number): boolean;
  clear(): void;
}

export function createMutationFailureTracker(): MutationFailureTracker {
  const failures = new Map<string, number>();
  return {
    recordFailure(key: string) {
      failures.set(key, (failures.get(key) ?? 0) + 1);
    },
    isRepeatedFailure(key: string, limit: number) {
      return (failures.get(key) ?? 0) >= limit;
    },
    clear() {
      failures.clear();
    },
  };
}

/** Canonical key for tool invocation tracking. Keys on tool name and stringified arguments. */
export function getToolInvocationKey(toolName: string, args: unknown): string {
  const argsStr = (() => {
    if (typeof args !== 'object' || args === null) return String(args);
    try {
      return JSON.stringify(args);
    } catch {
      // Circular references or non-serializable values — fall back to a stable-ish marker.
      return String(args);
    }
  })();
  return `${toolName}:${argsStr}`;
}

/** Max size before agent tool results get truncated (matches Web's limit). */
export const MAX_TOOL_RESULT_SIZE = 8_000;

/** Truncate content with a descriptive tail marker. */
export function truncateAgentContent(content: string, maxLen: number, label = 'content'): string {
  if (content.length <= maxLen) return content;
  return `${content.slice(0, maxLen)}\n\n[${label} truncated at ${maxLen.toLocaleString()} chars]`;
}

/** Wrap a tool result in the `[TOOL_RESULT]` envelope agents expect. */
export function formatAgentToolResult(result: string): string {
  return formatToolResultEnvelope(
    truncateAgentContent(result, MAX_TOOL_RESULT_SIZE, 'tool result'),
  );
}

/** Wrap a parse/dispatch error in the same envelope so it reaches the model cleanly. */
export function formatAgentParseError(message: string): string {
  return formatToolResultEnvelope(message);
}
