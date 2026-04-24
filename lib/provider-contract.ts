/**
 * Shared provider-contract types.
 *
 * Canonical home for the minimum surface an agent role needs to stream
 * tokens from a provider without importing Web shell state. Lives in `lib/`
 * so CLI (pushd, push-runtime-v2) and Web share one definition.
 */

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Minimum portable message shape understood by all lib/-side agent roles.
 */
export interface LlmMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export type AIProviderType =
  | 'ollama'
  | 'openrouter'
  | 'cloudflare'
  | 'zen'
  | 'nvidia'
  | 'blackbox'
  | 'azure'
  | 'kilocode'
  | 'openadapter'
  | 'bedrock'
  | 'vertex'
  | 'demo';

// ---------------------------------------------------------------------------
// Streaming envelope
// ---------------------------------------------------------------------------

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ChunkMetadata {
  chunkIndex: number;
}

/** Emitted before the orchestrator summarizes or drops old messages. */
export interface PreCompactEvent {
  /** Estimated total tokens before compaction. */
  totalTokens: number;
  /** Token threshold that triggered compaction. */
  budgetThreshold: number;
  /** Number of messages in the window before compaction. */
  messageCount: number;
}

/**
 * Stream a chat completion from a provider.
 */
export type ProviderStreamFn<M extends LlmMessage = LlmMessage, W = unknown> = (
  messages: M[],
  onToken: (token: string, meta?: ChunkMetadata) => void,
  onDone: (usage?: StreamUsage) => void,
  onError: (error: Error) => void,
  onThinkingToken?: (token: string | null) => void,
  workspaceContext?: W,
  hasSandbox?: boolean,
  modelOverride?: string,
  systemPromptOverride?: string,
  scratchpadContent?: string,
  signal?: AbortSignal,
  onPreCompact?: (event: PreCompactEvent) => void,
  todoContent?: string,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Gateway Abstraction (New Wire Model)
// ---------------------------------------------------------------------------

export type PushStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'reasoning_end' }
  | {
      type: 'done';
      finishReason: 'stop' | 'length' | 'tool_calls' | 'aborted' | 'unknown';
      usage?: StreamUsage;
    };

export interface PushStreamRequest<M extends LlmMessage = LlmMessage> {
  provider: AIProviderType;
  model: string;
  messages: M[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  signal?: AbortSignal;
  systemPromptOverride?: string;
  scratchpadContent?: string;
  todoContent?: string;
  /**
   * Runtime context passed through unchanged by the adapter. Opaque at the
   * contract level — different runtimes carry different shapes (Web's
   * `WorkspaceContext`, CLI's `SessionContext`, etc.). Gateways that need
   * workspace-aware prompt assembly narrow this with a local cast.
   */
  workspaceContext?: unknown;
  /** Forwarded through the adapter for gateways that compose sandbox-aware prompts. */
  hasSandbox?: boolean;
  /** Forwarded through the adapter so gateways can signal context compaction. */
  onPreCompact?: (event: PreCompactEvent) => void;
}

export type PushStream<M extends LlmMessage = LlmMessage> = (
  req: PushStreamRequest<M>,
) => AsyncIterable<PushStreamEvent>;

/**
 * Per-abort-reason error messages. Callers supply renderers that take the
 * timeout duration in seconds and return a user-facing string. Each field
 * is optional — when missing, the adapter falls back to a generic message.
 */
export interface AdapterTimeoutErrorMessages {
  /** Rendered when `eventTimeoutMs` elapses (no event arrived at all). */
  event?: (seconds: number) => string;
  /** Rendered when `contentTimeoutMs` elapses (events arrived but none user-visible). */
  content?: (seconds: number) => string;
  /** Rendered when `totalTimeoutMs` elapses (wall-clock cap hit). */
  total?: (seconds: number) => string;
}

/**
 * Timer machinery for `createProviderStreamAdapter`. Collapses the legacy
 * connect/idle/progress/stall/total model into three reasons that the
 * adapter can actually observe from the event stream:
 *
 * - `eventTimeoutMs` — no event arrived in this window. Resets on any
 *   event (including `reasoning_end`). Subsumes the legacy connect+idle
 *   +progress timers — from the adapter's point of view, all three
 *   manifest identically as "no event."
 * - `contentTimeoutMs` — no user-visible event arrived. Resets only on
 *   `text_delta` and `reasoning_delta`. Maps to the legacy stall timer.
 * - `totalTimeoutMs` — wall-clock cap on the entire stream.
 */
export interface AdapterTimeoutConfig {
  eventTimeoutMs?: number;
  contentTimeoutMs?: number;
  totalTimeoutMs?: number;
  errorMessages?: AdapterTimeoutErrorMessages;
}

type AdapterTimeoutReason = 'event' | 'content' | 'total';

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/**
 * Context handed to the telemetry wrapper at stream start. Stable shape so
 * callers can build span attributes without case-matching every field.
 */
export interface AdapterTelemetryStartContext {
  provider: AIProviderType;
  model: string;
  messageCount: number;
}

/**
 * Outcome summary reported to the telemetry wrapper at stream settlement.
 * One of `abortReason` or `error` is populated on abnormal termination;
 * both are `null`/`undefined` on clean completion via a `done` event or
 * natural stream close.
 */
export interface AdapterTelemetryEndResult {
  abortReason: AdapterTimeoutReason | 'user' | null;
  eventCount: number;
  textChars: number;
  reasoningChars: number;
  usage?: StreamUsage;
  error?: Error;
}

/**
 * Observability hook for `createProviderStreamAdapter`. `lib/` stays
 * dependency-free (no OpenTelemetry import); callers that wire OTEL
 * implement this hook with their own tracer.
 *
 * The `wrap` function runs the adapter's async body inside whatever
 * observability scope the caller wants (typically
 * `tracer.startActiveSpan(...)` so downstream fetches inherit the span
 * as parent via W3C traceparent propagation). The adapter calls
 * `finalize(result)` exactly once before the wrapped promise resolves
 * so the hook can fold the outcome into the span before closing it.
 */
export interface AdapterTelemetry {
  wrap?: (
    ctx: AdapterTelemetryStartContext,
    run: (finalize: (result: AdapterTelemetryEndResult) => void) => Promise<void>,
  ) => Promise<void>;
}

function renderAdapterTimeoutMessage(
  reason: AdapterTimeoutReason,
  timeouts: AdapterTimeoutConfig,
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
 * Bridge an async-iterable PushStream back to the legacy callback shape.
 * Helps migrate call sites incrementally.
 *
 * Legacy parameters forwarded into `PushStreamRequest`:
 * - `modelOverride` → `model`, falling back to `options.defaultModel`. If
 *   neither is supplied, the adapter fails fast via `onError` and never
 *   invokes `gatewayStream`, so misconfiguration surfaces at the adapter
 *   boundary instead of as an opaque downstream error.
 * - `systemPromptOverride`, `scratchpadContent`, `todoContent` — passed
 *   through for the gateway to honor.
 * - `workspaceContext`, `hasSandbox`, `onPreCompact` — passed through
 *   opaquely so gateways that need workspace-aware prompt assembly or
 *   compaction signals can consume them. Earlier iterations of this
 *   adapter dropped them on a "runtime concerns stay in runtime"
 *   principle, but in Push's actual topology the gateway *is* where
 *   prompt assembly happens, so the adapter must carry them through.
 * - `signal` — composed with internal timer aborts via a merged
 *   `AbortController`; external aborts settle via `onDone()` while
 *   timer-fired aborts settle via `onError()` with a per-reason message.
 *
 * Optional `options.timeouts` enables the adapter's internal timer
 * machinery — see `AdapterTimeoutConfig`. Without it, the adapter still
 * composes `signal` with a no-timer controller so the gateway receives
 * a consistent signal shape.
 */
export function createProviderStreamAdapter<M extends LlmMessage = LlmMessage>(
  gatewayStream: PushStream<M>,
  provider: AIProviderType,
  options?: {
    defaultModel?: string;
    timeouts?: AdapterTimeoutConfig;
    telemetry?: AdapterTelemetry;
  },
): ProviderStreamFn<M> {
  return async (
    messages,
    onToken,
    onDone,
    onError,
    onThinkingToken,
    workspaceContext,
    hasSandbox,
    modelOverride,
    systemPromptOverride,
    scratchpadContent,
    signal,
    onPreCompact,
    todoContent,
  ) => {
    if (signal?.aborted) {
      onDone();
      return;
    }

    // Internal controller composes external signal with timer-fired aborts.
    // Downstream gatewayStream receives controller.signal so it cleans up
    // regardless of which side triggered the abort.
    const controller = new AbortController();
    let abortReason: AdapterTimeoutReason | 'user' | null = null;

    const onExternalAbort = () => {
      abortReason = 'user';
      controller.abort();
    };
    signal?.addEventListener('abort', onExternalAbort);

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

    const settleTimeout = (reason: AdapterTimeoutReason) => {
      onError(new Error(renderAdapterTimeoutMessage(reason, timeouts ?? {})));
    };

    // Telemetry counters — tallied during iteration, handed to the
    // telemetry hook at settlement via `finalize()`.
    let eventCount = 0;
    let textChars = 0;
    let reasoningChars = 0;
    let doneUsage: StreamUsage | undefined;
    let terminalError: Error | undefined;

    const runBody = async (finalize: (result: AdapterTelemetryEndResult) => void) => {
      try {
        const model = modelOverride || options?.defaultModel;
        if (!model) {
          throw new Error(
            'createProviderStreamAdapter: no model provided — supply modelOverride at call time or defaultModel via adapter options',
          );
        }
        const stream = gatewayStream({
          provider,
          model,
          messages,
          signal: controller.signal,
          systemPromptOverride,
          scratchpadContent,
          todoContent,
          workspaceContext,
          hasSandbox,
          onPreCompact,
        });

        // Arm both windows before iteration. `resetEventTimer` catches the
        // "no events ever" case. `resetContentTimer` covers streams that
        // stay structurally active but never emit a user-visible delta —
        // matches the legacy `stallTimeoutMs` which armed at response-landing,
        // not on the first content token.
        resetEventTimer();
        resetContentTimer();

        for await (const event of stream) {
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
              // Structural signal — doesn't reset content timer because it
              // isn't progress toward user-visible output.
              onThinkingToken?.(null);
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
          const msg = renderAdapterTimeoutMessage(abortReason, timeouts ?? {});
          terminalError = new Error(msg);
          settleTimeout(abortReason);
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
          const msg = renderAdapterTimeoutMessage(abortReason, timeouts ?? {});
          terminalError = new Error(msg);
          settleTimeout(abortReason);
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
        signal?.removeEventListener('abort', onExternalAbort);
        finalize({
          abortReason,
          eventCount,
          textChars,
          reasoningChars,
          usage: doneUsage,
          error: terminalError,
        });
      }
    };

    const telemetry = options?.telemetry;
    if (telemetry?.wrap) {
      const telemetryCtx: AdapterTelemetryStartContext = {
        provider,
        model: modelOverride || options?.defaultModel || 'unknown',
        messageCount: messages.length,
      };
      await telemetry.wrap(telemetryCtx, runBody);
    } else {
      await runBody(() => {
        /* no-op when no telemetry hook is wired */
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Review result types
// ---------------------------------------------------------------------------

export interface ReviewComment {
  file: string;
  severity: 'critical' | 'warning' | 'suggestion' | 'note';
  comment: string;
  /** Line number in the new file (RIGHT side) — present when the model targeted a specific added line */
  line?: number;
}

export interface ReviewResult {
  summary: string;
  comments: ReviewComment[];
  /** Files included in the diff that was actually sent to the model */
  filesReviewed: number;
  /** Total files in the full diff (may exceed filesReviewed when truncated) */
  totalFiles: number;
  /** True when the diff was sliced before review — coverage is partial */
  truncated: boolean;
  provider: string;
  model: string;
  reviewedAt: number;
}
