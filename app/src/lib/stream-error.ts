/**
 * Structured error for provider stream failures.
 *
 * Lets the chat round loop tell a *transient* (retryable) failure — gateway
 * 5xx, rate limit, a stall/timeout — apart from a *terminal* one (400/401/404,
 * invalid request) WITHOUT string-matching error message text, which is the
 * fragile HTTP-status-classification anti-pattern called out in CLAUDE.md.
 *
 * Producers attach `status` (provider HTTP errors) or `retryable` (the stream
 * iterator's stall/timeout errors); `isRetryableStreamError` reads only those
 * structured fields, never `.message`.
 */
export class ProviderStreamError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, opts?: { status?: number; retryable?: boolean; cause?: unknown }) {
    super(message);
    this.name = 'ProviderStreamError';
    this.status = opts?.status;
    this.retryable =
      opts?.retryable ?? (opts?.status != null ? isTransientHttpStatus(opts.status) : false);
    if (opts?.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

/**
 * HTTP statuses worth retrying: request timeout (408), too-early (425), rate
 * limit (429), and every 5xx (gateway/overload/internal). Other 4xx are
 * deterministic — retrying just burns a round-trip and input tokens.
 */
export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * True when a stream failure is worth retrying from scratch. Structured-only:
 * inspects `ProviderStreamError.retryable`/`.status` or a duck-typed
 * `.retryable === true` (so the stream iterator can flag its own timeout
 * Errors), and never the message string.
 */
export function isRetryableStreamError(err: unknown): boolean {
  if (err instanceof ProviderStreamError) return err.retryable;
  if (
    err != null &&
    typeof err === 'object' &&
    (err as { retryable?: unknown }).retryable === true
  ) {
    return true;
  }
  return false;
}

/** Max retries (in addition to the initial attempt) for a pre-output stream failure. */
export const STREAM_RETRY_MAX = 2;

/**
 * Whether a stream round should be re-attempted. Pure decision so the guard is
 * testable in isolation. Retries only when: there is an error, the user has not
 * aborted, NO output streamed yet this round (`hasOutput` — retrying after
 * partial output would duplicate/rewrite visible text), the retry budget isn't
 * spent, and the error is transient.
 */
export function shouldRetryStreamRound(params: {
  error: unknown;
  aborted: boolean;
  hasOutput: boolean;
  attempt: number;
}): boolean {
  if (!params.error || params.aborted || params.hasOutput) return false;
  if (params.attempt >= STREAM_RETRY_MAX) return false;
  return isRetryableStreamError(params.error);
}

/** Exponential backoff before the next stream retry: 500ms, 1s, 2s, capped at 4s. */
export function streamRetryDelayMs(attempt: number): number {
  return Math.min(4000, 500 * 2 ** attempt);
}
