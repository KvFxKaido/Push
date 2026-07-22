/**
 * Provider stream adapter — returns a `PushStream<ChatMessage>` that runs
 * inside the CoderJob DO by calling the existing Worker provider handler
 * (e.g. `handleOpenRouterChat`) directly. Same architecture decision as
 * the executor adapter: skip HTTP self-loop, skip origin validation round
 * trip, reuse the exact upstream-proxy behaviour the browser path already
 * gets.
 *
 * Scope note (Phase 1):
 *   PR #3a wires the direct Worker handlers currently validated for
 *   background jobs: openrouter, ollama, cloudflare, zen,
 *   fireworks, openai, xai, and sakana. Providers that still require
 *   extra runtime setup or are intentionally unsupported here return
 *   `null` from `resolveProviderHandler` so the caller can surface an
 *   explicit diagnostic and fail fast instead of silently hanging.
 *
 * SSE parsing:
 *   Most providers proxy OpenAI-compatible SSE. We normalize CRLF to LF so
 *   providers that frame events with `\r\n\r\n` still split on the
 *   blank-line delimiter, parse `data: {...}` events, and yield
 *   `text_delta` events for `choices[0].delta.content`. Malformed chunks
 *   are skipped silently (providers interleave heartbeats that aren't
 *   always valid JSON); `[DONE]` sentinels close the stream cleanly.
 *   Two exceptions: `openrouter`, `openai`, `xai`, `sakana`, and `fireworks` use the
 *   Responses-API pump, and the
 *   Anthropic-transport Zen-Go models (MiniMax / Qwen on `/v1/messages`)
 *   now stream raw Anthropic Messages SSE — the Worker stopped translating
 *   that route to OpenAI SSE — so they parse via `anthropicEventStream`.
 */

import type {
  AIProviderType,
  LlmContentPart,
  LlmMessage,
  PushStream,
  PushStreamEvent,
  StreamUsage,
} from '@push/lib/provider-contract';
import { toOpenAIResponses } from '@push/lib/openai-responses-serializer';
import { openAIResponsesSSEPump } from '@push/lib/openai-responses-sse-pump';
import { resolvePushCapabilityProfile } from '@push/lib/capability-profile';
import {
  OPENROUTER_FALLBACK_EVENTS,
  isOpenRouterRoutingConstraintError,
  streamResponsesWithChatFallback,
} from '@push/lib/responses-chat-fallback';
import { anthropicEventStream } from '@push/lib/anthropic-bridge';
import { completeAnthropicStreamWithoutPause } from '@push/lib/anthropic-pause-continuation';
import type { ChatMessage } from '@/types';
import { getZenGoTransport } from '../lib/zen-go';
import { getUserProviderKey } from './user-secrets';
import type { Env } from './worker-middleware';
import {
  handleAnthropicChat,
  handleCloudflareChat,
  handleDeepSeekChat,
  handleFireworksChat,
  handleGoogleChat,
  handleOllamaChat,
  handleOpenAIChat,
  handleOpenRouterChat,
  handleSakanaChat,
  handleXAIChat,
  handleZaiChat,
  handleKimiChat,
  handleHuggingFaceChat,
  handleZenChat,
  handleZenGoChat,
} from './worker-providers';

export interface CoderJobStreamAdapterArgs {
  env: Env;
  origin: string;
  provider: AIProviderType;
  modelId: string | undefined;
  /** Unique per-job id — used to produce a stable rate-limit bucket
   * (`X-Forwarded-For: job:<jobId>`) so background-job traffic doesn't
   * collapse into the global `'unknown'` IP bucket and spuriously 429
   * other jobs. */
  jobId: string;
  /** Route the `zen` provider through the OpenCode Zen "Go" endpoint
   * (`/zen/go/v1/...`) instead of the regular `/zen/v1/...`. The browser
   * path selects Go via a `localStorage` flag (`getZenGoMode`), which the
   * Worker can't read — so server-side callers (the PR-review DO) opt in
   * explicitly. Ignored for non-`zen` providers. */
  zenGo?: boolean;
  /** Server-stamped identity of the run/job owner. When set, the adapter
   * resolves the owner's stored provider key (user-secrets KV) per dispatch
   * and injects it as the synthetic request's Authorization header — the
   * same slot a browser-forwarded Settings key occupies on the foreground
   * path, so `standardAuth`'s precedence (Worker env secret first, then this
   * header) is unchanged. Absent (e.g. the PR-review DO's webhook path) the
   * dispatch is env-credentials-only, exactly as before. */
  ownerUserId?: string;
}

export type ProviderHandler = (request: Request, env: Env) => Promise<Response>;

/** Exported for reuse by other DO-side callers (RunHost latency spike) —
 * single source of truth for "which providers can a DO dispatch directly". */
export function resolveProviderHandler(
  provider: AIProviderType,
  zenGo: boolean,
): ProviderHandler | null {
  switch (provider) {
    case 'openrouter':
      return handleOpenRouterChat as unknown as ProviderHandler;
    case 'zai':
      return handleZaiChat as unknown as ProviderHandler;
    case 'kimi':
      return handleKimiChat as unknown as ProviderHandler;
    case 'huggingface':
      return handleHuggingFaceChat as unknown as ProviderHandler;
    case 'ollama':
      return handleOllamaChat as unknown as ProviderHandler;
    case 'cloudflare':
      return handleCloudflareChat as unknown as ProviderHandler;
    case 'zen':
      return (zenGo ? handleZenGoChat : handleZenChat) as unknown as ProviderHandler;
    case 'fireworks':
      return handleFireworksChat as unknown as ProviderHandler;
    case 'deepseek':
      return handleDeepSeekChat as unknown as ProviderHandler;
    case 'anthropic':
      return handleAnthropicChat as unknown as ProviderHandler;
    case 'openai':
      return handleOpenAIChat as unknown as ProviderHandler;
    case 'xai':
      return handleXAIChat as unknown as ProviderHandler;
    case 'sakana':
      return handleSakanaChat as unknown as ProviderHandler;
    case 'google':
      return handleGoogleChat as unknown as ProviderHandler;
    case 'demo':
      return null;
  }
  return null;
}

/**
 * Serialize kernel messages into the OpenAI-compatible `messages` payload the
 * Worker chat proxy accepts. A turn carrying multimodal `contentParts` (the
 * kernel's initial image turn) is forwarded as multipart content — the same
 * `content: string | parts[]` shape the web chat endpoint already takes.
 * Sending only `content` here would silently drop background attachments
 * (Codex P1, #937).
 */
export function toCoderJobPayloadMessages(
  messages: ReadonlyArray<{ role: string; content?: string; contentParts?: LlmContentPart[] }>,
): Array<{ role: string; content: string | LlmContentPart[] }> {
  return messages.map((m) =>
    m.contentParts && m.contentParts.length > 0
      ? { role: m.role, content: m.contentParts }
      : { role: m.role, content: m.content ?? '' },
  );
}

function toCoderJobLlmMessages(
  messages: ReadonlyArray<{ role: string; content?: string; contentParts?: LlmContentPart[] }>,
  systemPromptOverride?: string,
): LlmMessage[] {
  const out: LlmMessage[] = [];
  if (systemPromptOverride && !messages.some((message) => message.role === 'system')) {
    out.push({
      id: 'system',
      role: 'system',
      content: systemPromptOverride,
      timestamp: 0,
    });
  }
  messages.forEach((message, index) => {
    const role: LlmMessage['role'] =
      message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user';
    const text =
      message.contentParts && message.contentParts.length > 0
        ? message.contentParts
            .filter(
              (part): part is Extract<LlmContentPart, { type: 'text' }> => part.type === 'text',
            )
            .map((part) => part.text)
            .join('\n')
        : (message.content ?? '');
    out.push({
      id: `m${index}`,
      role,
      content: text,
      timestamp: 0,
      ...(message.contentParts && message.contentParts.length > 0
        ? { contentParts: message.contentParts }
        : {}),
    });
  });
  return out;
}

export function createWebStreamAdapter(args: CoderJobStreamAdapterArgs): PushStream<ChatMessage> {
  // Strip trailing slash so URL construction can't produce double
  // slashes (`https://host//api/...`).
  const origin = args.origin.replace(/\/$/, '');
  const zenGo = args.provider === 'zen' && Boolean(args.zenGo);
  const handler = resolveProviderHandler(args.provider, zenGo);

  return (req) =>
    (async function* () {
      if (!handler) {
        throw new Error(
          `Background Coder jobs don't yet support provider "${args.provider}". ` +
            `Supported: openrouter, zai, kimi, huggingface, ollama, cloudflare, zen, fireworks, deepseek, anthropic, openai, xai, sakana, google.`,
        );
      }

      const signal = req.signal;
      if (signal?.aborted) {
        throw new Error('Stream aborted before provider dispatch');
      }

      // OpenRouter, OpenAI, xAI, Sakana Fugu, and Fireworks AI all speak the Responses API —
      // build the typed `input`-item body for any of them; everything else gets
      // the Chat Completions payload below.
      // OpenRouter is Responses-shaped only when the shared capability profile
      // selects that wire. One profile read drives both the body shape and SSE
      // pump below, so they can't disagree; replay-dependent reasoning routes get
      // a chat body that `handleOpenRouterChat` sends to /chat/completions.
      const modelId = req.model || args.modelId || '';
      const isResponsesProvider =
        (args.provider === 'openrouter' &&
          resolvePushCapabilityProfile('openrouter', modelId).openaiWire === 'responses') ||
        args.provider === 'openai' ||
        args.provider === 'xai' ||
        args.provider === 'sakana' ||
        args.provider === 'fireworks';
      // Owner's stored key, resolved fresh per dispatch (key rotation or
      // deletion mid-job takes effect on the next round; nothing is cached
      // in job state). `standardAuth` still prefers the Worker env secret,
      // so this only matters for providers without one.
      const userKey = await getUserProviderKey(args.env, args.ownerUserId, args.provider);
      // Anthropic-transport Zen-Go models (MiniMax / Qwen) stream raw Anthropic
      // Messages SSE; `deepseek` runs on its Anthropic-compatible endpoint. Both
      // parse natively; everything else is OpenAI-shaped.
      const isZenGoAnthropic =
        zenGo && getZenGoTransport(req.model || args.modelId || '') === 'anthropic';
      const isAnthropicTransport = args.provider === 'deepseek';

      // One dispatch attempt on a chosen wire. Factored so OpenRouter can run
      // responses-first with a chat fallback: a failure BEFORE any output throws
      // here (non-200, or an early pump error), which the combinator catches and
      // retries on chat. Non-OpenRouter providers run a single attempt on their
      // fixed wire.
      async function* attempt(wire: 'responses' | 'chat'): AsyncIterable<PushStreamEvent> {
        const body =
          wire === 'responses'
            ? JSON.stringify(
                toOpenAIResponses({
                  provider: args.provider,
                  model: modelId,
                  messages: toCoderJobLlmMessages(req.messages, req.systemPromptOverride),
                  signal: req.signal,
                }),
              )
            : (() => {
                // OpenAI-compatible chat payload. The Worker's proxy validates and
                // normalizes it before forwarding, so we only need the portable shape.
                const payloadMessages = toCoderJobPayloadMessages(req.messages);
                const systemPromptOverride = req.systemPromptOverride;
                if (systemPromptOverride && !payloadMessages.some((m) => m.role === 'system')) {
                  payloadMessages.unshift({ role: 'system', content: systemPromptOverride });
                }
                return JSON.stringify({
                  model: req.model || args.modelId,
                  messages: payloadMessages,
                  stream: true,
                  // Final usage chunk (`choices: []` + `usage`); unsupported upstreams ignore it.
                  stream_options: { include_usage: true },
                });
              })();

        const request = new Request(
          `${origin}/api/${zenGo ? 'zen/go' : providerSlug(args.provider)}/chat`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              Origin: origin,
              // Stable per-job rate-limit key — else synthetic internal Requests all
              // share the 'unknown' bucket and one burst 429s every other job.
              'X-Forwarded-For': `job:${args.jobId}`,
              ...(userKey ? { Authorization: `Bearer ${userKey}` } : {}),
            },
            body,
            signal,
          },
        );

        const response = (await handler!(
          request as unknown as Request,
          args.env as unknown as Env,
        )) as unknown as Response;

        if (!response.ok || !response.body) {
          const errText = await response.text().catch(() => '');
          throw new Error(
            `Provider ${args.provider} returned ${response.status}${errText ? `: ${errText.slice(0, 200)}` : ''}`,
          );
        }

        // Tap the terminal `done` so prompt-cache hit rate is observable in
        // `wrangler tail`. Server-side only — lands in Worker logs, never CLI stdout.
        let usageLogged = false;
        const events =
          wire === 'responses'
            ? openAIResponsesSSEPump({
                body: response.body as unknown as ReadableStream<Uint8Array>,
                signal,
              })
            : isZenGoAnthropic || isAnthropicTransport
              ? zenGoAnthropicEvents(response as unknown as Response, signal)
              : pumpSseBody(response.body as unknown as ReadableStream<Uint8Array>, signal);
        for await (const event of events) {
          if (event.type === 'done' && !usageLogged) {
            usageLogged = true;
            const u = event.usage;
            const cached = typeof u?.cachedInputTokens === 'number' ? u.cachedInputTokens : null;
            console.log(
              JSON.stringify({
                level: 'info',
                event: 'provider_stream_usage',
                provider: args.provider,
                model: req.model || args.modelId || null,
                inputTokens: u?.inputTokens ?? null,
                outputTokens: u?.outputTokens ?? null,
                cachedInputTokens: cached,
                cacheHitRatio:
                  cached !== null && u && u.inputTokens > 0
                    ? Number((cached / u.inputTokens).toFixed(3))
                    : null,
              }),
            );
          }
          yield event;
        }
      }

      if (args.provider === 'openrouter' && isResponsesProvider) {
        // OpenRouter responses-first with chat fallback (same policy as the web/CLI
        // lanes). A user abort is never a fallback.
        yield* streamResponsesWithChatFallback({
          responses: () => attempt('responses'),
          chat: () => attempt('chat'),
          shouldFallback: (error) => {
            if (signal?.aborted) return false;
            // Inert in THIS lane, and it takes two changes to wake it, not one:
            // `attempt()` builds payloads with no tools, no `response_format` and so no
            // `provider.require_parameters`, AND its error boundary above throws a plain
            // `Error` that never carries `openRouterRoutingConstraint`. Adding the
            // constraint to the payload alone would still always fall back — a producer
            // that classifies the body would have to be added here too. That is correct
            // for today (an unconstrained "no endpoints found" means the model lacks a
            // /responses endpoint, and chat is the recovery); it is not self-maintaining,
            // so treat both halves as a pair if this lane ever sends constraints.
            if (isOpenRouterRoutingConstraintError(error)) {
              console.warn(
                JSON.stringify({
                  level: 'warn',
                  event: OPENROUTER_FALLBACK_EVENTS.declined,
                  reason: 'routing_constraint',
                  model: modelId,
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
              return false;
            }
            return true;
          },
          onFallback: (error) => {
            console.warn(
              JSON.stringify({
                level: 'warn',
                event: OPENROUTER_FALLBACK_EVENTS.fellBackToChat,
                model: modelId,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          },
        });
      } else {
        yield* attempt(isResponsesProvider ? 'responses' : 'chat');
      }
    })();
}

// Provider slug for URL construction. Matches PROVIDER_URLS in
// `app/src/lib/providers.ts`. Only used for the Request URL — the
// handler does the actual routing once called.
function providerSlug(provider: AIProviderType): string {
  return provider;
}

// ---------------------------------------------------------------------------
// Native Anthropic event stream — used only for the Anthropic-transport Zen-Go
// models (MiniMax / Qwen), whose Worker route now proxies raw Anthropic SSE.
// Background coder jobs use text-dispatch tool calling (no native tool schemas
// are sent), so no `isKnownToolName` filter is needed and `tool_use` blocks
// aren't expected. These models don't enable Anthropic's server-side
// `web_search`, so `pause_turn` never arises — drain it defensively and ensure
// a terminal `done` so a pause-without-done can't leave the job loop hanging.
// ---------------------------------------------------------------------------

async function* zenGoAnthropicEvents(
  upstream: Response,
  signal?: AbortSignal,
): AsyncIterable<PushStreamEvent> {
  yield* completeAnthropicStreamWithoutPause(anthropicEventStream(upstream, signal));
}

// ---------------------------------------------------------------------------
// SSE pump — parses an OpenAI-compatible stream body into PushStream events.
// ---------------------------------------------------------------------------

async function* pumpSseBody(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<PushStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort);

  // Usage arrives in a trailing chunk (`choices: []` + `usage`) that an
  // OpenAI-compatible provider emits AFTER the `finish_reason` chunk and
  // before `[DONE]`. So we record finishReason/usage as we see them and only
  // terminate on `[DONE]` (or stream close) — bailing on the first
  // finish_reason, as the old loop did, dropped the usage chunk entirely.
  let pendingUsage: StreamUsage | undefined;
  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error('Stream aborted');
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let delimiterIdx = buffer.indexOf('\n\n');
      while (delimiterIdx !== -1) {
        const rawEvent = buffer.slice(0, delimiterIdx);
        buffer = buffer.slice(delimiterIdx + 2);
        const yielded = parseSseEvent(rawEvent);
        for (const ev of yielded.events) {
          yield ev;
        }
        if (yielded.usage) pendingUsage = yielded.usage;
        if (yielded.done) {
          yield {
            type: 'done',
            finishReason: 'stop',
            ...(pendingUsage && { usage: pendingUsage }),
          };
          return;
        }
        delimiterIdx = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim().length > 0) {
      const yielded = parseSseEvent(buffer);
      for (const ev of yielded.events) {
        yield ev;
      }
      if (yielded.usage) pendingUsage = yielded.usage;
    }
    yield { type: 'done', finishReason: 'stop', ...(pendingUsage && { usage: pendingUsage }) };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // releaseLock throws if the reader has already been closed —
      // harmless here, the stream is done either way.
    }
  }
}

function parseSseEvent(rawEvent: string): {
  events: PushStreamEvent[];
  done: boolean;
  usage?: StreamUsage;
} {
  const lines = rawEvent.split('\n');
  const dataParts: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      dataParts.push(trimmed.slice(5).trim());
    }
  }
  if (dataParts.length === 0) return { events: [], done: false };
  const data = dataParts.join('\n');
  // `[DONE]` is the only terminal sentinel. A `finish_reason` chunk is NOT
  // terminal here — the usage chunk follows it, so the pump keeps reading.
  if (data === '[DONE]') return { events: [], done: true };
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        prompt_cache_hit_tokens?: number;
      };
    };
    const events: PushStreamEvent[] = [];
    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      events.push({ type: 'text_delta', text: delta });
    }
    const usage = parseUsage(parsed.usage);
    return { events, done: false, ...(usage && { usage }) };
  } catch {
    // Malformed chunk — skip quietly. Don't surface errors: providers
    // occasionally interleave heartbeats and non-JSON control frames.
    return { events: [], done: false };
  }
}

/**
 * Map an OpenAI-shaped usage object to the portable `StreamUsage`. Returns
 * null when no usage fields are present (the common per-content chunk), so the
 * pump only records a value for the real usage chunk.
 */
function parseUsage(
  usage:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        prompt_cache_hit_tokens?: number;
      }
    | undefined,
): StreamUsage | null {
  if (!usage) return null;
  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const totalTokens =
    typeof usage.total_tokens === 'number' ? usage.total_tokens : inputTokens + outputTokens;
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return null;
  // See `StreamUsage.cachedInputTokens` — only set when upstream reports it, so
  // a cold-but-cache-capable turn (0) stays distinct from no-cache-support.
  const cachedInputTokens =
    usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(typeof cachedInputTokens === 'number' && { cachedInputTokens }),
  };
}
