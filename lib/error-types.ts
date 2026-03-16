/**
 * Shared error taxonomy for structured tool errors.
 *
 * Unified module used by both the web app and CLI.
 * Extracted from app/src/types/index.ts and app/src/lib/sandbox-tools.ts
 * during Track 2 convergence.
 */

/** Canonical error types for all tool failures. */
export type ToolErrorType =
  | 'FILE_NOT_FOUND'
  | 'EXEC_TIMEOUT'
  | 'EXEC_NON_ZERO_EXIT'
  | 'SANDBOX_UNREACHABLE'
  | 'WORKSPACE_CHANGED'
  | 'EDIT_HASH_MISMATCH'
  | 'EDIT_CONTENT_NOT_FOUND'
  | 'AUTH_FAILURE'
  | 'RATE_LIMITED'
  | 'STALE_FILE'
  | 'EDIT_GUARD_BLOCKED'
  | 'WRITE_FAILED'
  | 'UNKNOWN';

/** Structured error attached to tool results when something goes wrong. */
export interface StructuredToolError {
  type: ToolErrorType;
  retryable: boolean;
  message: string;
  detail?: string;
}

/**
 * Classify an error message into a structured ToolErrorType.
 * Pattern-matches common error text from both sandbox and local tool operations.
 *
 * Covers both web (sandbox) and CLI (local filesystem) error patterns.
 */
export function classifyError(error: string, context?: string): StructuredToolError {
  const lower = error.toLowerCase();

  // EDIT_CONTENT_NOT_FOUND must be checked before FILE_NOT_FOUND because both
  // contain "not found", but "search string not found" is an edit error.
  if (lower.includes('content not found') || lower.includes('search string not found')) {
    return { type: 'EDIT_CONTENT_NOT_FOUND', retryable: false, message: error, detail: context };
  }
  if (lower.includes('no such file') || lower.includes('enoent') || lower.includes('not found') || lower.includes('does not exist')) {
    return { type: 'FILE_NOT_FOUND', retryable: false, message: error, detail: context };
  }
  // Health-check failures must be matched before the generic timeout check so
  // "health check timed out" is classified as SANDBOX_UNREACHABLE, not EXEC_TIMEOUT.
  if (lower.includes('sandbox_unreachable') || lower.includes('modal_network_error') || lower.includes('cannot connect') || lower.includes('modal_error') || lower.includes('sandbox unavailable') || lower.includes('container error') || lower.includes('container_error') || lower.includes('no longer reachable') || lower.includes('internal server error') || lower.includes('health check failed') || lower.includes('health check timed out')) {
    const transient = lower.includes('internal server error') || lower.includes('container error') || lower.includes('container_error') || lower.includes('modal_network_error') || lower.includes('modal_error') || lower.includes('health check');
    return { type: 'SANDBOX_UNREACHABLE', retryable: transient, message: error, detail: context };
  }
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('modal_timeout')) {
    return { type: 'EXEC_TIMEOUT', retryable: true, message: error, detail: context };
  }
  if (lower.includes('workspace changed') || lower.includes('workspace_changed')) {
    return { type: 'WORKSPACE_CHANGED', retryable: false, message: error, detail: context };
  }
  if (lower.includes('stale') || lower.includes('stale_file') || lower.includes('stale write')) {
    return { type: 'STALE_FILE', retryable: false, message: error, detail: context };
  }
  if (lower.includes('edit guard') || lower.includes('edit_guard_blocked')) {
    return { type: 'EDIT_GUARD_BLOCKED', retryable: false, message: error, detail: context };
  }
  if (lower.includes('hash mismatch') || lower.includes('hash_mismatch')) {
    return { type: 'EDIT_HASH_MISMATCH', retryable: false, message: error, detail: context };
  }
  if (lower.includes('permission denied') || lower.includes('eacces')) {
    return { type: 'AUTH_FAILURE', retryable: false, message: error, detail: context };
  }
  if (lower.includes('rate limit') || lower.includes('429') || lower.includes('rate_limited')) {
    return { type: 'RATE_LIMITED', retryable: true, message: error, detail: context };
  }
  if (lower.includes('write failed') || lower.includes('write_failed')) {
    return { type: 'WRITE_FAILED', retryable: true, message: error, detail: context };
  }
  // CLI-specific: path escape and argument validation (mapped to existing types)
  if (lower.includes('path escapes workspace root')) {
    return { type: 'AUTH_FAILURE', retryable: false, message: error, detail: context };
  }
  if (lower.includes('non-zero exit') || lower.includes('exit code')) {
    return { type: 'EXEC_NON_ZERO_EXIT', retryable: false, message: error, detail: context };
  }

  return { type: 'UNKNOWN', retryable: false, message: error, detail: context };
}

/**
 * Format a structured error into the text block injected into tool results.
 */
export function formatStructuredError(err: StructuredToolError, baseText: string): string {
  return [
    baseText,
    `error_type: ${err.type}`,
    `retryable: ${err.retryable}`,
  ].join('\n');
}
