/**
 * Inlined PushStream → callback adapter for the chat UI's primary
 * streaming path. This is what Phase 9b of the PushStream gateway
 * migration replaced `createProviderStreamAdapter` (lib/-side) + the six
 * per-provider `streamXChat` exports with: `streamChat` now iterates a
 * `PushStream<ChatMessage>` directly via `iterateChatStream`, applying
 * timer machinery + OpenTelemetry spans inline.
 *
 * The contract is identical to the deleted `createProviderStreamAdapter`
 * — the inlined body owns:
 *
 * - **Timer machinery.** Three timers (`eventTimeoutMs`,
 *   `contentTimeoutMs`, `totalTimeoutMs`) collapse the legacy
 *   connect/idle/progress/stall/total quintet into the three reasons the
 *   consumer can actually observe from the event stream. Each fires by
 *   aborting the internal `AbortController`, which both stops upstream
 *   work and decouples the timer reason from the upstream's own error.
 * - **Telemetry.** A `tracer.startActiveSpan` wrap matches the
 *   `model.stream` span shape the legacy `streamSSEChatOnce` path
 *   recorded, so dashboards keyed on `push.provider` / `push.model` /
 *   `push.stream.chunk_count` / `push.usage.*` keep working.
 * - **Single-Error-on-timeout.** Telemetry's `terminalError` and the
 *   caller's `onError` receive the same `Error` instance — matters for
 *   downstream `instanceof` checks and stack-trace inspection.
 * - **Wrap-failure fallback.** If `tracer.startActiveSpan` rejects
 *   before the inner run begins, we fall back to the no-telemetry path.
 *   If it rejects after the inner run already settled, we swallow the
 *   error rather than surfacing a second settlement.
 *
 * This module was historically `createProviderStreamAdapter` in
 * `lib/provider-contract.ts`. It moved app-side because every lib-side
 * consumer is on PushStream now and the chat UI's callback shape is the
 * only remaining caller — keeping the adapter in `lib/` would just
 * pull legacy callback machinery into a layer that doesn't need it.
 */

import type {
  AIProviderType,
  LlmMessage,
  PreCompactEvent,
  PushStream,
  ReasoningBlock,
  StreamUsage,
} from '@push/lib/provider-contract';
import {
  recordSpanError,
  setSpanAttributes,
  getPushTracer,
  SpanKind,
  SpanStatusCode,
} from './tracing';

type IterateChatStreamTimeoutReason = 'event' | 'content' | 'total' | 'user';

export interface IterateChatStreamTimeoutErrorMessages {
  /** Rendered when `eventTimeoutMs` elapses (no event arrived at all). */
  event?: (seconds: number) => string;
  /** Rendered when `contentTimeoutMs` elapses (events arrived but none user-visible). */
  content?: (seconds: number) => string;
  /** Rendered when `totalTimeoutMs` elapses (wall-clock cap hit). */
  total?: (seconds: number) => string;
}

export interface IterateChatStreamTimeouts {
  eventTimeoutMs?: number;
  contentTimeoutMs?: number;
  totalTimeoutMs?: number;
  errorMessages?: IterateChatStreamTimeoutErrorMessages;
}

export interface IterateChatStreamRequest<M extends LlmMessage> {
  provider: AIProviderType;
  model: string;
  messages: M[];
  systemPromptOverride?: string;
  scratchpadContent?: string;
  todoContent?: string;
  workspaceContext?: unknown;
  hasSandbox?: boolean;
  onPreCompact?: (event: PreCompactEvent) => void;
  /** External cancellation signal (e.g. user hit cancel). Composed with internal timer aborts. */
  signal?: AbortSignal;
  /** Pre-fetched memory records for the session-digest stage. Forwarded
   *  verbatim to `PushStreamRequest.sessionDigestRecords`. */
  sessionDigestRecords?: ReadonlyArray<import('@push/lib/runtime-contract').MemoryRecord>;
  /** Last-turn digest, persisted by the caller. Forwarded verbatim. */
  priorSessionDigest?: import('@push/lib/session-digest').SessionDigest;
  /** Persistence sink for the digest emitted this turn. Forwarded verbatim. */
  onSessionDigestEmitted?: (
    digest: import('@push/lib/session-digest').SessionDigest | null,
  ) => void;
}

export interface IterateChatStreamCallbacks {
  onToken: (token: string) => void;
  onDone: (usage?: StreamUsage) => void;
  onError: (error: Error) => void;
  onThinkingToken?: (token: string | null) => void;
  /** Fired once per complete signed reasoning block (Anthropic-only
   *  today). Independent of `onThinkingToken`: the text channel drives
   *  display, this carries the cryptographic signature that the next
   *  turn's request body must echo back. Consumers persist these on the
   *  assistant message so chained turns survive. */
  onReasoningBlock?: (block: ReasoningBlock) => void;
}

export interface IterateChatStreamOptions {
  timeouts?: IterateChatStreamTimeouts;
  /** Provide an OTEL tracer — when omitted, no telemetry span is opened. */
  telemetry?: 'enabled' | 'disabled';
}

function renderTimeoutMessage(
  reason: 'event' | 'content' | 'total',
  timeouts: IterateChatStreamTimeouts,
): string {
  const toSeconds = (ms: number) => Math.round(ms / 1000);
  const msgs = timeouts.errorMessages;
  if (reason === 'event' && timeouts.eventTimeoutMs) {
    const seconds = toSeconds(timeouts.eventTimeoutMs);
    return msgs?.event?.(seconds) ?? `Stream stalled — no events for ${seconds}s.`;
  }
  if (reason === 'content' && timeouts.contentTimeoutMs) {
    const seconds = toSeconds(timeouts.contentTimeoutMs);
    return msgs?.content?.(seconds) ?? `Stream stalled — no user-visible content for ${seconds}s.`;
  }
  if (reason === 'total' && timeouts.totalTimeoutMs) {
    const seconds = toSeconds(timeouts.totalTimeoutMs);
    return msgs?.total?.(seconds) ?? `Stream exceeded ${seconds}s total time limit.`;
  }
  return `Stream timed out: ${reason}`;
}

/**
 * Iterate `stream(request)` and dispatch events to `callbacks` with the
 * legacy 12-arg `ProviderStreamFn` contract preserved (timer-on-stall,
 * single-`Error`-on-timeout, telemetry parity, abort composition).
 */
export async function iterateChatStream<M extends LlmMessage>(
  stream: PushStream<M>,
  request: IterateChatStreamRequest<M>,
  callbacks: IterateChatStreamCallbacks,
  options?: IterateChatStreamOptions,
): Promise<void> {
  const { onToken, onDone, onError, onThinkingToken, onReasoningBlock } = callbacks;
  const externalSignal = request.signal;

  if (externalSignal?.aborted) {
    onDone();
    return;
  }

  // Internal controller composes the external signal with timer-fired
  // aborts. The downstream stream receives `controller.signal` so it
  // cleans up regardless of which side triggered the abort.
  const controller = new AbortController();
  let abortReason: IterateChatStreamTimeoutReason | null = null;

  const onExternalAbort = () => {
    abortReason = 'user';
    controller.abort();
  };
  externalSignal?.addEventListener('abort', onExternalAbort);

  const timeouts = options?.timeouts;
  let eventTimer: ReturnType<typeof setTimeout> | undefined;
  let contentTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;

  const resetEventTimer = () => {
    if (!timeouts?.eventTimeoutMs) return;
    clearTimeout(eventTimer);
    eventTimer = setTimeout(() => {
      abortReason = 'event';
      controller.abort();
    }, timeouts.eventTimeoutMs);
  };
  const resetContentTimer = () => {
    if (!timeouts?.contentTimeoutMs) return;
    clearTimeout(contentTimer);
    contentTimer = setTimeout(() => {
      abortReason = 'content';
      controller.abort();
    }, timeouts.contentTimeoutMs);
  };
  const clearAllTimers = () => {
    clearTimeout(eventTimer);
    clearTimeout(contentTimer);
    clearTimeout(totalTimer);
  };

  if (timeouts?.totalTimeoutMs) {
    totalTimer = setTimeout(() => {
      abortReason = 'total';
      controller.abort();
    }, timeouts.totalTimeoutMs);
  }

  // Build a single Error instance on timeout so telemetry's
  // `terminalError` and the caller's `onError` share stack + identity.
  const buildTimeoutError = (reason: 'event' | 'content' | 'total'): Error =>
    new Error(renderTimeoutMessage(reason, timeouts ?? {}));

  // Telemetry counters tallied during iteration.
  let eventCount = 0;
  let textChars = 0;
  let reasoningChars = 0;
  let doneUsage: StreamUsage | undefined;
  let terminalError: Error | undefined;

  const runBody = async (): Promise<void> => {
    try {
      const events = stream({
        provider: request.provider,
        model: request.model,
        messages: request.messages,
        signal: controller.signal,
        systemPromptOverride: request.systemPromptOverride,
        scratchpadContent: request.scratchpadContent,
        todoContent: request.todoContent,
        workspaceContext: request.workspaceContext,
        hasSandbox: request.hasSandbox,
        onPreCompact: request.onPreCompact,
        sessionDigestRecords: request.sessionDigestRecords,
        priorSessionDigest: request.priorSessionDigest,
        onSessionDigestEmitted: request.onSessionDigestEmitted,
      });

      // Arm both windows before iteration. `resetEventTimer` catches
      // the "no events ever" case. `resetContentTimer` covers streams
      // that stay structurally active but never emit a user-visible
      // delta — matches the legacy `stallTimeoutMs` which armed at
      // response-landing, not on the first content token.
      resetEventTimer();
      resetContentTimer();

      for await (const event of events) {
        if (controller.signal.aborted) break;

        eventCount++;
        resetEventTimer();

        switch (event.type) {
          case 'text_delta':
            textChars += event.text.length;
            resetContentTimer();
            onToken(event.text);
            break;
          case 'reasoning_delta':
            reasoningChars += event.text.length;
            resetContentTimer();
            onThinkingToken?.(event.text);
            break;
          case 'reasoning_end':
            // Structural signal — doesn't reset content timer because
            // it isn't progress toward user-visible output.
            onThinkingToken?.(null);
            break;
          case 'reasoning_block':
            // Structured signed-thinking block; persisted on the
            // assistant message so the next turn's request can echo it
            // back. Doesn't count as user-visible content.
            onReasoningBlock?.(event.block);
            break;
          case 'tool_call_delta':
            // Provider is mid-stream on a native tool-call payload.
            // Counts as content progress so the contentTimer doesn't
            // trip while a model is streaming a long tool-arg payload
            // that flushes as a single text_delta only on finish_reason.
            // Doesn't surface to the legacy callbacks — assembly stays
            // inside the stream.
            resetContentTimer();
            break;
          case 'done':
            clearAllTimers();
            doneUsage = event.usage;
            onDone(event.usage);
            return;
        }
      }

      // Loop exited without a `done` event. Resolve based on abortReason.
      clearAllTimers();
      if (abortReason === 'user') {
        onDone();
        return;
      }
      if (abortReason === 'event' || abortReason === 'content' || abortReason === 'total') {
        terminalError = buildTimeoutError(abortReason);
        onError(terminalError);
        return;
      }
      // Stream drained cleanly without a trailing `done` — treat as
      // completion to match the pre-timer behavior.
      onDone();
    } catch (err) {
      clearAllTimers();
      if (abortReason === 'user') {
        onDone();
        return;
      }
      if (abortReason === 'event' || abortReason === 'content' || abortReason === 'total') {
        terminalError = buildTimeoutError(abortReason);
        onError(terminalError);
        return;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        // Abort from an unknown source (upstream cleanup, etc). Settle
        // cleanly — if it were a timeout the reason would already be set.
        onDone();
        return;
      }
      terminalError = err instanceof Error ? err : new Error(String(err));
      onError(terminalError);
    } finally {
      clearAllTimers();
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  };

  const telemetryEnabled = options?.telemetry !== 'disabled';
  if (!telemetryEnabled) {
    await runBody();
    return;
  }

  // Telemetry — mirrors the legacy `model.stream` span shape so
  // dashboards keyed on `push.provider` / `push.model` / `push.stream.*` /
  // `push.usage.*` keep working when the chat UI streams.
  const tracer = getPushTracer('push.model');
  const workspaceRecord =
    request.workspaceContext && typeof request.workspaceContext === 'object'
      ? (request.workspaceContext as { mode?: unknown })
      : undefined;
  const workspaceMode =
    typeof workspaceRecord?.mode === 'string' ? workspaceRecord.mode : undefined;

  let runEntered = false;
  try {
    await tracer.startActiveSpan(
      'model.stream',
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'push.provider': request.provider,
          'push.model': request.model,
          'push.message_count': request.messages.length,
          ...(typeof request.hasSandbox === 'boolean'
            ? { 'push.has_sandbox': request.hasSandbox }
            : {}),
          ...(workspaceMode ? { 'push.workspace_mode': workspaceMode } : {}),
        },
      },
      async (span) => {
        try {
          runEntered = true;
          await runBody();
        } finally {
          setSpanAttributes(span, {
            'push.abort_reason': abortReason ?? undefined,
            'push.stream.chunk_count': eventCount,
            'push.stream.content_chars': textChars,
            'push.stream.thinking_chars': reasoningChars,
            'push.usage.input_tokens': doneUsage?.inputTokens,
            'push.usage.output_tokens': doneUsage?.outputTokens,
            'push.usage.total_tokens': doneUsage?.totalTokens,
          });
          if (terminalError) {
            recordSpanError(span, terminalError);
          } else if (abortReason === 'user') {
            span.setAttribute('push.cancelled', true);
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }
          span.end();
        }
      },
    );
  } catch (err) {
    // Telemetry failed. If `runBody` never entered, the chat UI's
    // callback contract was never honored — fall back to the
    // no-telemetry path so streaming still works. If `runBody` already
    // settled, swallow the post-settle telemetry error.
    if (!runEntered) {
      console.warn(
        '[Push] iterateChatStream telemetry wrap failed before runBody; falling back',
        err,
      );
      await runBody();
    } else {
      console.warn(
        '[Push] iterateChatStream telemetry wrap rejected after runBody settled; swallowing',
        err,
      );
    }
  }
}
