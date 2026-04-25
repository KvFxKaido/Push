/**
 * Shared streaming + JSON helpers for lib/-side agent roles.
 *
 * Canonical home for the subset of utilities that reviewer/auditor/coder/
 * explorer agents reach for while driving a provider stream. Web's
 * `app/src/lib/utils.ts` re-exports these so existing call sites don't churn.
 */

import type { LlmMessage, PushStream, PushStreamRequest } from './provider-contract.js';

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

// ---------------------------------------------------------------------------
// PushStream iteration helper
// ---------------------------------------------------------------------------

/**
 * Consume a PushStream, accumulating `text_delta` into a single string with
 * an activity-reset idle timeout. Analogous to `streamWithTimeout` but for
 * the event-iteration shape used by agent roles that have migrated off the
 * legacy `ProviderStreamFn` callback.
 *
 * The timer resets on every event (including structural ones like
 * `reasoning_end`), so active streams aren't killed. On timeout, the
 * returned signal is aborted and an Error with `timeoutMessage` is returned
 * in the result's `error` field.
 *
 * `reasoning_delta` events are ignored — callers that use this helper
 * (Auditor) only consume the final JSON text.
 */
export async function iteratePushStreamText<M extends LlmMessage>(
  stream: PushStream<M>,
  request: Omit<PushStreamRequest<M>, 'signal'>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<{ error: Error | null; text: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let text = '';
  let error: Error | null = null;

  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };

  try {
    resetTimer();
    const iterable = stream({
      ...(request as PushStreamRequest<M>),
      signal: controller.signal,
    });
    for await (const event of iterable) {
      if (controller.signal.aborted) break;
      resetTimer();
      if (event.type === 'text_delta') {
        text += event.text;
      } else if (event.type === 'done') {
        break;
      }
      // reasoning_delta / reasoning_end / tool_call_delta ignored — auditor
      // only consumes final text. They still reset the activity timer above.
    }
  } catch (err) {
    if (!timedOut) {
      error = err instanceof Error ? err : new Error(String(err));
    }
  } finally {
    clearTimeout(timer);
  }

  if (timedOut && !error) {
    error = new Error(timeoutMessage);
  }

  return { error, text };
}

// Re-export event type for callers that want to narrow.
export type { PushStreamEvent } from './provider-contract.js';
