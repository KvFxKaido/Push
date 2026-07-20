/**
 * Quota-exhaustion error markers — single source of truth for "this 429 (or
 * in-band provider error) means a DRAINED balance/quota, not transient
 * pressure". Retrying cannot succeed until a human tops up or a daily window
 * resets, so every retry/failover layer must treat these as terminal.
 *
 * Providers multiplex these onto the same HTTP 429 as their genuinely
 * retryable rate limits, so a status code alone cannot distinguish them:
 * - Moonshot/Kimi: `exceeded_current_quota_error` (balance drained or token
 *   quota depleted; their errors table marks it do-not-retry, unlike
 *   `engine_overloaded_error` / `rate_limit_reached_error`).
 * - OpenAI: `insufficient_quota` (billing hard-stop; also surfaces as an
 *   in-band Responses stream error with no HTTP status at all).
 *
 * Three consumers, one vocabulary (the #1555 review found the second and
 * third): the CLI's outer stream classifier (`classifyCliStreamError`), the
 * CLI's inner request retry loop (`isRetryableError` in `cli/provider.ts`),
 * and the shared Responses SSE pump's in-band error classification
 * (`OpenAIResponsesStreamError`).
 */

const QUOTA_EXHAUSTED_ERROR_MARKERS = [
  'exceeded_current_quota_error',
  'insufficient_quota',
] as const;

/** True when the error text (upstream body, code, or message) names a
 *  quota/balance-exhaustion error type. */
export function isQuotaExhaustedErrorMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  return QUOTA_EXHAUSTED_ERROR_MARKERS.some((marker) => text.includes(marker));
}
