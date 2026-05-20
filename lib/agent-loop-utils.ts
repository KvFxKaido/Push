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

/**
 * Mutation failure tracker — detects repeated failures on same tool+args.
 *
 * Also tracks CONSECUTIVE repetitions of any tool call (success or error)
 * so the orchestrator can break out of "model keeps re-running the same
 * read with no progress" loops that the failure-only path misses. The
 * consecutive semantics (not total-session) keep legitimate iterative
 * patterns alive: re-reading a file after an edit is fine because the
 * edit breaks the same-key streak; re-reading the same directory four
 * turns in a row with nothing between is a loop. See PR #602.
 */
export interface MutationFailureTracker {
  /** Increment the persistent failure count for `key`. Used for the
   *  "this mutation has errored N times across the session" breaker. */
  recordFailure(key: string): void;
  /** Was `key` the failure target at least `limit` times this session? */
  isRepeatedFailure(key: string, limit: number): boolean;
  /** Track every tool invocation (success OR failure). Resets the
   *  consecutive counter if `key` differs from the previous call. */
  recordCall(key: string): void;
  /**
   * Was this the `limit`-th (or later) consecutive identical call?
   * Returns true when `key` matches the last recorded key and the
   * consecutive count is `>= limit`. Use BEFORE execution so the next
   * round can refuse to run a call we've already seen repeat with no
   * other tool between.
   */
  isRepeatedCall(key: string, limit: number): boolean;
  clear(): void;
}

export function createMutationFailureTracker(): MutationFailureTracker {
  const failures = new Map<string, number>();
  let lastCallKey: string | null = null;
  let consecutiveCallCount = 0;
  return {
    recordFailure(key: string) {
      failures.set(key, (failures.get(key) ?? 0) + 1);
    },
    isRepeatedFailure(key: string, limit: number) {
      return (failures.get(key) ?? 0) >= limit;
    },
    recordCall(key: string) {
      if (key === lastCallKey) {
        consecutiveCallCount++;
      } else {
        lastCallKey = key;
        consecutiveCallCount = 1;
      }
    },
    isRepeatedCall(key: string, limit: number) {
      return key === lastCallKey && consecutiveCallCount >= limit;
    },
    clear() {
      failures.clear();
      lastCallKey = null;
      consecutiveCallCount = 0;
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
