/**
 * Shared streaming + JSON helpers for lib/-side agent roles.
 *
 * Canonical home for the subset of utilities that reviewer/auditor/coder/
 * explorer agents reach for while driving a provider stream. Web's
 * `app/src/lib/utils.ts` re-exports these so existing call sites don't churn.
 */

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : null;
}

// ---------------------------------------------------------------------------
// Streaming timeout helper
// ---------------------------------------------------------------------------

/**
 * Wrap a streaming call with an activity-based timeout. The timer resets on
 * every token so actively-streaming responses aren't killed; it only fires
 * after `timeoutMs` of silence. Returns an error envelope if the stream
 * timed out or errored, otherwise null.
 */
export function streamWithTimeout(
  timeoutMs: number,
  timeoutMessage: string,
  run: (
    onToken: (token: string) => void,
    onDone: () => void,
    onError: (err: Error) => void,
  ) => void | Promise<void>,
): { promise: Promise<Error | null>; getAccumulated: () => string } {
  let accumulated = '';
  const promise = new Promise<Error | null>((resolve) => {
    let settled = false;
    const settle = (v: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let timer = setTimeout(() => settle(new Error(timeoutMessage)), timeoutMs);
    // Catch unhandled rejections from async run callbacks (e.g. if streamFn
    // rejects its promise without calling onDone/onError). Without this,
    // the promise would only settle after the timeout fires.
    const maybePromise = run(
      (token) => {
        accumulated += token;
        clearTimeout(timer);
        timer = setTimeout(() => settle(new Error(timeoutMessage)), timeoutMs);
      },
      () => settle(null),
      (error) => settle(error),
    );
    if (maybePromise && typeof (maybePromise as Promise<void>).catch === 'function') {
      (maybePromise as Promise<void>).catch((err) => {
        settle(err instanceof Error ? err : new Error(String(err)));
      });
    }
  });
  return { promise, getAccumulated: () => accumulated };
}
