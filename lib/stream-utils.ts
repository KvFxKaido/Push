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
 * The activity timer resets only on `text_delta` events — matches the
 * legacy `streamWithTimeout` + `onToken` path the migrated roles came from
 * (Coder/Reviewer/Planner/Explorer/DeepReviewer all uniformly passed
 * `undefined` for `onThinkingToken`, so reasoning tokens never counted as
 * activity at the consumer-side timer). Non-content events
 * (`reasoning_delta`, `reasoning_end`, `tool_call_delta`) are ignored for
 * timer purposes too: a model that emits only reasoning indefinitely should
 * trip the per-role round timeout exactly as it did before the migration.
 *
 * Optional `wallClockTimeoutMs` adds a separate non-resetting backstop. The
 * activity timer alone is the wrong shape of failsafe for verbose-but-
 * progressing models that emit text every few seconds for many minutes —
 * each chunk legitimately resets the activity timer, so a 5–8 minute
 * unproductive loop never trips it. Wall-clock fires once `wallClockTimeoutMs`
 * elapses from the start of the call regardless of activity.
 *
 * Whichever timer fires first wins, definitively: the firing callback claims
 * the single `timeoutKind` slot and clears the other timer in the same tick,
 * so a near-simultaneous wall-clock callback can't overwrite an
 * already-recorded activity timeout (or vice versa).
 *
 * On timeout, the returned signal is aborted and an Error with
 * `timeoutMessage` (or `wallClockTimeoutMessage` if set and applicable) is
 * returned in the result's `error` field.
 *
 * `reasoning_delta` events are ignored at the accumulation level too — the
 * helper's text result feeds JSON parsers that don't want reasoning prose
 * mixed in. Callers that need to surface reasoning to the UI should add a
 * dedicated handler when a real consumer requires it.
 */
export async function iteratePushStreamText<M extends LlmMessage>(
  stream: PushStream<M>,
  request: Omit<PushStreamRequest<M>, 'signal'>,
  timeoutMs: number,
  timeoutMessage: string,
  wallClockTimeoutMs?: number,
  wallClockTimeoutMessage?: string,
): Promise<{ error: Error | null; text: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wallClockTimer: ReturnType<typeof setTimeout> | undefined;
  // Single source of truth for which timer fired. The first callback to run
  // claims the slot and clears the other timer; subsequent callbacks (if
  // they were already in the macrotask queue) see a non-null value and bail.
  let timeoutKind: 'activity' | 'wallClock' | null = null;
  let text = '';
  let error: Error | null = null;

  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (timeoutKind !== null) return;
      timeoutKind = 'activity';
      clearTimeout(wallClockTimer);
      controller.abort();
    }, timeoutMs);
  };

  try {
    resetTimer();
    if (wallClockTimeoutMs !== undefined) {
      wallClockTimer = setTimeout(() => {
        if (timeoutKind !== null) return;
        timeoutKind = 'wallClock';
        clearTimeout(timer);
        controller.abort();
      }, wallClockTimeoutMs);
    }
    const iterable = stream({
      ...(request as PushStreamRequest<M>),
      signal: controller.signal,
    });
    for await (const event of iterable) {
      if (controller.signal.aborted) break;
      if (event.type === 'text_delta') {
        // Only `text_delta` resets the activity timer. Mirrors the legacy
        // `onToken`-only reset semantics — a stream stuck emitting reasoning
        // or tool-call fragments without any user-visible text should still
        // trip the per-role round timeout.
        resetTimer();
        text += event.text;
      } else if (event.type === 'done') {
        break;
      }
      // reasoning_delta / reasoning_end / tool_call_delta intentionally do
      // NOT reset the timer — see the doc comment above.
    }
  } catch (err) {
    if (timeoutKind === null) {
      error = err instanceof Error ? err : new Error(String(err));
    }
  } finally {
    clearTimeout(timer);
    clearTimeout(wallClockTimer);
  }

  if (timeoutKind === 'wallClock' && !error) {
    error = new Error(wallClockTimeoutMessage ?? timeoutMessage);
  } else if (timeoutKind === 'activity' && !error) {
    error = new Error(timeoutMessage);
  }

  return { error, text };
}

// Re-export event type for callers that want to narrow.
export type { PushStreamEvent } from './provider-contract.js';
