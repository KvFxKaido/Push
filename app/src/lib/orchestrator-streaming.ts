import { extractProviderErrorDetail } from './provider-error-utils';
import { asRecord } from './utils';
export type { ChunkMetadata, StreamUsage } from '@push/lib/provider-contract';

// ---------------------------------------------------------------------------
// Types shared across orchestrator modules
// ---------------------------------------------------------------------------

export interface StreamProviderConfig {
  name: string;
  apiUrl: string;
  apiKey: string;
  authHeader?: string | null;
  model: string;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  /**
   * Abort when bytes are still arriving but no parseable model progress
   * occurs. Armed on the first successfully-parsed SSE frame, not on the
   * HTTP response itself — that way a response that yields no body bytes
   * falls through to `idleTimeoutMs` instead of reporting "data is arriving".
   */
  progressTimeoutMs?: number;
  /**
   * Abort when the streaming response is active but still emits no
   * user-visible content (content tokens, reasoning tokens, or native
   * tool-call argument deltas). Started right after the HTTP response
   * lands, so "active" here means the connection is open — not that any
   * parseable frame has been seen yet.
   */
  stallTimeoutMs?: number;
  totalTimeoutMs?: number;
  errorMessages: {
    connect: (seconds: number) => string;
    idle: (seconds: number) => string;
    progress?: (seconds: number) => string;
    stall?: (seconds: number) => string;
    total?: (seconds: number) => string;
    network: string;
  };
  parseError: (parsed: unknown, fallback: string) => string;
  checkFinishReason: (choice: unknown) => boolean;
  shouldResetStallOnReasoning?: boolean;
  /** Provider identity — used to conditionally inject provider-specific tool protocols */
  providerType?:
    | 'ollama'
    | 'openrouter'
    | 'cloudflare'
    | 'zen'
    | 'nvidia'
    | 'blackbox'
    | 'kilocode'
    | 'openadapter'
    | 'azure'
    | 'bedrock'
    | 'vertex';
  /** Extra headers required by proxy adapters. */
  extraHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Shared helper functions
// ---------------------------------------------------------------------------

export function parseProviderError(
  parsed: unknown,
  fallback: string,
  includeTopLevelMessage = false,
): string {
  return extractProviderErrorDetail(parsed, fallback, includeTopLevelMessage);
}

export function hasFinishReason(choice: unknown, reasons: string[]): boolean {
  const record = asRecord(choice);
  const finishReason = record?.finish_reason;
  return typeof finishReason === 'string' && reasons.includes(finishReason);
}

// ---------------------------------------------------------------------------
// Timeout-message selection
// ---------------------------------------------------------------------------

export type TimeoutAbortReason = 'connect' | 'idle' | 'progress' | 'stall' | 'total';

export interface TimeoutDurations {
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  progressTimeoutMs?: number;
  stallTimeoutMs?: number;
  totalTimeoutMs?: number;
}

/**
 * Pick the user-facing error message for a timeout abort, walking the
 * fallback chain when the provider config doesn't supply a specific
 * message for the given reason.
 *
 * Fallback chains:
 *   connect  → `connect` (always defined)
 *   progress → `progress` → `stall` → `idle`
 *   stall    → `stall` → `idle`
 *   total    → `total` → `idle`
 *   idle     → `idle` (always defined)
 *
 * Pure helper — extracted from `streamSSEChatOnce` so the message
 * selection is testable without a full mocked HTTP stream.
 */
export function selectTimeoutMessage(
  abortReason: TimeoutAbortReason,
  errorMessages: StreamProviderConfig['errorMessages'],
  timeouts: TimeoutDurations,
): string {
  const toSeconds = (ms: number) => Math.round(ms / 1000);
  const idleSeconds = toSeconds(timeouts.idleTimeoutMs);

  switch (abortReason) {
    case 'connect':
      return errorMessages.connect(toSeconds(timeouts.connectTimeoutMs));
    case 'progress': {
      const progressMs = timeouts.progressTimeoutMs ?? timeouts.idleTimeoutMs;
      const stallMs = timeouts.stallTimeoutMs ?? timeouts.idleTimeoutMs;
      return (
        errorMessages.progress?.(toSeconds(progressMs)) ??
        errorMessages.stall?.(toSeconds(stallMs)) ??
        errorMessages.idle(idleSeconds)
      );
    }
    case 'stall': {
      const stallMs = timeouts.stallTimeoutMs ?? timeouts.idleTimeoutMs;
      return errorMessages.stall?.(toSeconds(stallMs)) ?? errorMessages.idle(idleSeconds);
    }
    case 'total': {
      const totalMs = timeouts.totalTimeoutMs ?? timeouts.idleTimeoutMs;
      return errorMessages.total?.(toSeconds(totalMs)) ?? errorMessages.idle(idleSeconds);
    }
    default:
      return errorMessages.idle(idleSeconds);
  }
}
