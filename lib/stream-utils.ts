/**
 * Shared streaming + JSON helpers for lib/-side agent roles.
 *
 * Canonical home for the subset of utilities that reviewer/auditor/coder/
 * explorer agents reach for while driving a provider stream. Web's
 * `app/src/lib/utils.ts` re-exports these so existing call sites don't churn.
 */

import type {
  LlmMessage,
  NativeToolCall,
  PushStream,
  PushStreamRequest,
  ReasoningBlock,
  ResponsesReasoningItem,
  StreamUsage,
} from './provider-contract.js';

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
 * The activity timer resets only on `text_delta` events by default — matches
 * the legacy `streamWithTimeout` + `onToken` path the migrated roles came
 * from (Coder/Reviewer/Planner/Explorer/DeepReviewer all uniformly passed
 * `undefined` for `onThinkingToken`, so reasoning tokens never counted as
 * activity at the consumer-side timer). Non-content events
 * (`reasoning_delta`, `reasoning_end`, `tool_call_delta`) are ignored for
 * timer purposes too: a model that emits only reasoning indefinitely should
 * trip the per-role round timeout exactly as it did before the migration.
 *
 * `opts.reasoningResetsActivityTimer` opts a caller out of that default for
 * heavy-reasoner models (glm-5.1 legitimately streams reasoning for >60s
 * before its first text token on large-transcript rounds — observed killing
 * an actively-progressing deep-review round, PR #907). Only opt in when a
 * `wallClockTimeoutMs` backstop is ALSO set: with reasoning counting as
 * activity, the wall-clock cap is what bounds a model that reasons forever.
 *
 * Optional `wallClockTimeoutMs` adds a separate non-resetting backstop. The
 * activity timer alone is the wrong shape of failsafe for verbose-but-
 * progressing models that emit text every few seconds for many minutes —
 * each chunk legitimately resets the activity timer, so a 5–8 minute
 * unproductive loop never trips it. Wall-clock fires once `wallClockTimeoutMs`
 * elapses from the start of the call regardless of activity.
 *
 * Optional `opts.firstTokenGraceMs` gives the activity timer a more generous
 * window until the first activity event, then tightens to `timeoutMs` for
 * inter-token gaps. Workers AI models routinely have a 20–30s time-to-first-
 * token, so a single tight window kills a stream that is merely slow to START
 * as "unresponsive". Omitting it preserves the legacy single-window behaviour.
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
 * `reasoning_delta` events are accumulated separately as `reasoningText`.
 * Complete `native_tool_call` events are accumulated separately too, so native
 * provider tool dispatch can skip the fenced-text round-trip while legacy text
 * parsing still reads the helper's `text` result.
 */
export async function iteratePushStreamText<M extends LlmMessage>(
  stream: PushStream<M>,
  request: Omit<PushStreamRequest<M>, 'signal'>,
  timeoutMs: number,
  timeoutMessage: string,
  wallClockTimeoutMs?: number,
  wallClockTimeoutMessage?: string,
  opts?: { reasoningResetsActivityTimer?: boolean; firstTokenGraceMs?: number },
): Promise<{
  error: Error | null;
  text: string;
  reasoningText: string;
  /** Signed reasoning blocks (Anthropic-transport `thinking`). Captured so the
   *  kernel can carry them onto the assistant turn for replay — DeepSeek on its
   *  Anthropic endpoint 400s the tool-result continuation if a thinking-mode
   *  turn's `content[].thinking` isn't passed back. Empty on OpenAI-compat
   *  routes (which emit `reasoning_delta` only). */
  reasoningBlocks: ReasoningBlock[];
  responsesReasoningItems: ResponsesReasoningItem[];
  nativeToolCalls: NativeToolCall[];
  usage?: StreamUsage;
}> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wallClockTimer: ReturnType<typeof setTimeout> | undefined;
  // Single source of truth for which timer fired. The first callback to run
  // claims the slot and clears the other timer; subsequent callbacks (if
  // they were already in the macrotask queue) see a non-null value and bail.
  let timeoutKind: 'activity' | 'wallClock' | null = null;
  let text = '';
  let reasoningText = '';
  const reasoningBlocks: ReasoningBlock[] = [];
  const responsesReasoningItems: ResponsesReasoningItem[] = [];
  const nativeToolCalls: NativeToolCall[] = [];
  let error: Error | null = null;
  let usage: StreamUsage | undefined;

  // Until the first activity event the timer uses `firstTokenGraceMs` (when
  // provided); after it, the tighter `timeoutMs`. Workers AI models routinely
  // have a 20–30s time-to-first-token, so a single tight activity window kills a
  // stream that is merely slow to START as "unresponsive" even though it is
  // about to respond. A mid-stream stall still trips quickly once tokens flow.
  // `firstTokenGraceMs ?? timeoutMs` preserves the legacy single-window
  // behaviour when no grace is configured.
  let sawActivity = false;
  const resetTimer = () => {
    clearTimeout(timer);
    const ms = sawActivity ? timeoutMs : (opts?.firstTokenGraceMs ?? timeoutMs);
    timer = setTimeout(() => {
      if (timeoutKind !== null) return;
      timeoutKind = 'activity';
      clearTimeout(wallClockTimer);
      controller.abort();
    }, ms);
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
        // Only `text_delta` resets the activity timer by default. Mirrors the
        // legacy `onToken`-only reset semantics — a stream stuck emitting
        // reasoning or tool-call fragments without any user-visible text
        // should still trip the per-role round timeout.
        sawActivity = true;
        resetTimer();
        text += event.text;
      } else if (event.type === 'reasoning_delta') {
        reasoningText += event.text;
        if (opts?.reasoningResetsActivityTimer) {
          // Heavy-reasoner opt-in: thinking IS progress for this caller; the
          // wall-clock backstop bounds a model that reasons forever.
          sawActivity = true;
          resetTimer();
        }
      } else if (event.type === 'reasoning_block') {
        // Signed thinking block (emitted at content_block_stop on the Anthropic
        // transport). Capture for replay; the live `reasoning_delta` events
        // already drove the activity timer, so no reset needed here.
        reasoningBlocks.push(event.block);
      } else if (event.type === 'responses_reasoning_item') {
        responsesReasoningItems.push(event.item);
      } else if (event.type === 'native_tool_call') {
        sawActivity = true;
        resetTimer();
        nativeToolCalls.push(event.call);
      } else if (event.type === 'done') {
        // Capture usage if the adapter reported it. Absent on most non-final
        // events; the terminal `done` is the only place it arrives.
        if (event.usage) usage = event.usage;
        break;
      }
      // reasoning_end / tool_call_delta (and reasoning_delta without the
      // opt-in) intentionally do NOT reset the timer — see the doc comment.
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

  return {
    error,
    text,
    reasoningText,
    reasoningBlocks,
    responsesReasoningItems,
    nativeToolCalls,
    usage,
  };
}

// Re-export event type for callers that want to narrow.
export type { PushStreamEvent } from './provider-contract.js';
