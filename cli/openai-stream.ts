/**
 * CLI native OpenAI-compatible Chat Completions PushStream.
 *
 * Legacy/generic CLI providers (ollama, zen, plus
 * OpenRouter when `PUSH_OPENROUTER_TRANSPORT=chat`) speak the same
 * OpenAI-shaped `chat/completions` wire format, so they share one stream
 * parameterized by `ProviderConfig`. Per-provider extensions (OpenRouter's
 * `HTTP-Referer`, `X-Title`, `session_id`, `trace`) branch on `config.id`.
 *
 * Shape mirrors `app/src/lib/openrouter-stream.ts` on the web side: build
 * body, fetch, then `yield* openAISSEPump(...)`. The shared pump in
 * `lib/openai-sse-pump.ts` handles `data:` framing, `[DONE]` sentinel,
 * `choices[0].delta` parsing, native `tool_calls` accumulation/flush, usage
 * capture, and `finish_reason` mapping.
 *
 * Non-2xx HTTP responses throw `CliProviderError` carrying the upstream
 * status so `streamCompletion`'s retry policy can decide whether to back off
 * and try again. Transport, abort, or parse failures propagate verbatim as
 * non-`CliProviderError` exceptions; the retry policy treats every
 * non-AbortError as transport-level and retries it.
 */

import process from 'node:process';
import type {
  LlmMessage,
  PushStream,
  PushStreamEvent,
  PushStreamRequest,
} from '../lib/provider-contract.ts';
import { openAISSEPump } from '../lib/openai-sse-pump.ts';
import {
  OPENROUTER_PARAMETER_EVENTS,
  fetchOpenRouterWithStructuredOutputFallback,
  scopeOpenRouterRequiredParameters,
} from '../lib/openrouter-parameters.ts';
import { OPENROUTER_MAX_SESSION_ID_LENGTH } from '../lib/provider-models.ts';
import { toOpenAIChat } from '../lib/openai-chat-serializer.ts';
import { isGeminiModelId } from '../lib/gemini-thought-signature.ts';
import { kimiSamplingRule } from '../lib/kimi-sampling.ts';
import type { ProviderConfig } from './provider.ts';

const OPENROUTER_WEB_SEARCH_TOOL = { type: 'openrouter:web_search' } as const;

export class CliProviderError extends Error {
  /** Upstream HTTP status from the non-2xx response. */
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CliProviderError';
    this.status = status;
  }
}

export interface CliProviderStreamOptions {
  /** OpenRouter session_id for grouping related requests. Truncated to 256 chars. */
  sessionId?: string;
}

/** Per-request flag wins; otherwise OpenRouter's native `openrouter:web_search`
 *  server tool defaults ON so CLI chats search the web without an opt-in step
 *  (parity with the web app's `'auto'` web-search mode). Set
 *  `PUSH_OPENROUTER_WEB_SEARCH=0` (or `false`/`no`/`off`) to disable.
 *  https://openrouter.ai/docs/guides/features/server-tools/web-search */
function resolveOpenRouterWebSearch(req: PushStreamRequest<LlmMessage>): boolean {
  if (typeof req.openrouterWebSearch === 'boolean') return req.openrouterWebSearch;
  const env = process.env.PUSH_OPENROUTER_WEB_SEARCH?.trim().toLowerCase();
  if (!env) return true;
  return !(env === '0' || env === 'false' || env === 'no' || env === 'off');
}

/**
 * Build a PushStream for a CLI provider. The returned function is a
 * `PushStream<LlmMessage>` — invoking it returns an async iterable that
 * yields parsed events.
 *
 * `apiKey` may be empty: the Authorization header is omitted in that case so
 * proxy preflight checks (`standardAuth`) can fire their configured
 * key-missing 401 instead of being bypassed by an empty `Bearer ` value.
 */
export function createCliProviderStream(
  config: ProviderConfig,
  apiKey: string,
  options: CliProviderStreamOptions = {},
): PushStream<LlmMessage> {
  return (req: PushStreamRequest<LlmMessage>): AsyncIterable<PushStreamEvent> =>
    cliProviderStream(config, apiKey, options, req);
}

async function* cliProviderStream(
  config: ProviderConfig,
  apiKey: string,
  options: CliProviderStreamOptions,
  req: PushStreamRequest<LlmMessage>,
): AsyncIterable<PushStreamEvent> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (config.id === 'openrouter') {
    // See: https://openrouter.ai/docs/api-reference/overview#headers
    headers['HTTP-Referer'] = process.env.PUSH_OPENROUTER_REFERER || 'https://push.local';
    headers['X-Title'] = 'Push CLI';
  }

  // Two callers feed messages differently:
  //   - The legacy CLI path (`engine.ts`) packs the system prompt as the
  //     first message and leaves `systemPromptOverride` undefined.
  //   - lib-side agent roles (consumed via `daemon-provider-stream.ts`)
  //     pass the system prompt as `systemPromptOverride` and start
  //     `messages` at the user turn.
  // Honour both: prepend the override only when present.
  const model = req.model && req.model.trim() ? req.model : config.defaultModel;

  // Build the OpenAI Chat Completions body directly from the neutral request via
  // the shared `toOpenAIChat` serializer — system prepend, multimodal
  // contentParts, sampling, and the Hermes `system_and_3` cache tagging. Two
  // callers feed messages differently (legacy `engine.ts` packs the system
  // prompt as messages[0]; lib-side roles pass `systemPromptOverride`);
  // `toOpenAIChat` honours both. Temperature defaults to 0.1 (the CLI's
  // deterministic bias) and remains present on constrained OpenRouter requests.
  // reasoning_blocks are dropped:
  // every provider here is a strict OpenAI-compat endpoint that may reject the
  // Push-private field — it only round-trips on the Anthropic-bridge surface.
  // Resumed CLI reasoning history already arrives as
  // `LlmMessage.reasoningContent`; `toOpenAIChat` echoes it as
  // `reasoning_content`, matching in-run replay without teaching this leaf
  // adapter about session persistence.
  //
  // Cache markers are tagged only for OpenRouter, the one CLI provider known to
  // route to Anthropic models (other gateways ignore them harmlessly, but are
  // conservative pass-throughs until parity is verified).
  const kimiRule = config.id === 'kimi' ? kimiSamplingRule(model) : null;
  const baseBody = toOpenAIChat(req, {
    modelOverride: model,
    temperatureDefault: kimiRule?.mode === 'pinned' ? kimiRule.temperature : 0.1,
    maxTokensField: config.id === 'openai' ? 'max_completion_tokens' : 'max_tokens',
    tagCacheBreakpoints: config.id === 'openrouter',
    // A Gemini-fronting compat route (e.g. OpenRouter `google/gemini-*`) 400s on
    // the replay turn unless the prior call's first functionCall carries a
    // thought_signature; backfill the documented placeholder when none was
    // captured. Gated on the model id so non-Gemini routes stay byte-identical.
    geminiThoughtSignatureFallback: isGeminiModelId(model),
  });
  if (kimiRule?.mode === 'pinned') {
    baseBody.temperature = kimiRule.temperature;
    baseBody.top_p = kimiRule.topP;
  } else if (kimiRule?.mode === 'omit') {
    // K3 fixes sampling server-side and the docs say to omit the fields —
    // sending the CLI's 0.1 deterministic default violates that contract.
    delete baseBody.temperature;
    delete baseBody.top_p;
  }
  const nativeTools = Array.isArray(baseBody.tools) ? baseBody.tools : [];
  const openRouterWebSearch = config.id === 'openrouter' && resolveOpenRouterWebSearch(req);
  const openRouterTools = [
    ...nativeTools,
    ...(openRouterWebSearch ? [OPENROUTER_WEB_SEARCH_TOOL] : []),
  ];
  // The shared scoper preserves sampling and the native tools/schema requirement,
  // omitting only redundant `tool_choice: 'auto'` from OpenRouter's all-or-
  // nothing provider eligibility filter.
  const openRouterRequireParameters = nativeTools.length > 0 || Boolean(baseBody.response_format);

  const body =
    config.id === 'openrouter'
      ? scopeOpenRouterRequiredParameters(
          {
            ...baseBody,
            ...(options.sessionId
              ? { session_id: options.sessionId.slice(0, OPENROUTER_MAX_SESSION_ID_LENGTH) }
              : {}),
            // OpenRouter executes `openrouter:web_search` server-side (engine
            // `auto`) and feeds grounded, cited results back to the model.
            // The text-based dispatcher never sees it as a client tool call.
            ...(openRouterTools.length > 0 ? { tools: openRouterTools } : {}),
            ...(nativeTools.length > 0 ? { tool_choice: req.toolChoice ?? 'auto' } : {}),
            // See: https://openrouter.ai/docs/guides/features/broadcast/overview
            trace: { generation_name: 'push-cli-chat', trace_name: 'push-cli' },
          },
          openRouterRequireParameters,
        )
      : baseBody;

  // Network failures (fetch throws) and aborts propagate verbatim. The
  // caller's retry policy treats every non-AbortError as transport-level
  // failure worth a retry, matching the legacy `streamCompletion` shape.
  // `keepalive` is intentionally not set: it is browser-only (allows requests
  // to outlive the page) and Node's undici enforces a 64KiB request-body cap
  // when it's true, which long chat histories would routinely exceed.
  let response: Response;
  let errorBody: string | null = null;
  if (config.id === 'openrouter') {
    const result = await fetchOpenRouterWithStructuredOutputFallback({
      body: body as Record<string, unknown>,
      transport: 'chat',
      requireParameters: openRouterRequireParameters,
      requireParametersAfterRelaxation: nativeTools.length > 0,
      attempt: (attemptBody) =>
        fetch(config.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(attemptBody),
          signal: req.signal,
        }),
      onRelaxed: () => {
        // stderr: CLI stdout is the user/--json channel.
        console.error(
          JSON.stringify({
            level: 'warn',
            event: OPENROUTER_PARAMETER_EVENTS.structuredOutputRelaxed,
            reason: 'routing_constraint',
            model,
            transport: 'chat',
            droppedParameter: 'response_format',
            wireField: 'response_format',
          }),
        );
      },
    });
    response = result.response;
    errorBody = result.errorBody;
  } else {
    response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });
  }

  if (!response.ok) {
    const errBody = errorBody ?? (await response.text().catch(() => '(no body)'));
    throw new CliProviderError(
      `Provider error ${response.status} [provider=${config.id} model=${model} url=${config.url}]: ${errBody.slice(0, 400)}`,
      response.status,
    );
  }

  if (!response.body) {
    // Some providers return a single-shot JSON body even when `stream: true`
    // was requested. Fall back to the non-streaming shape and synthesize the
    // events the consumer would have seen on a normal stream.
    type FallbackBody = { choices?: { message?: { content?: string } }[] } | null;
    let fallback: FallbackBody = null;
    try {
      fallback = (await response.json()) as FallbackBody;
    } catch {
      /* empty / non-JSON body */
    }
    const text = fallback?.choices?.[0]?.message?.content ?? '';
    if (text) {
      yield { type: 'text_delta', text };
    }
    yield { type: 'done', finishReason: 'stop' };
    return;
  }

  // CLI doesn't have a known-tool registry exposed at the lib boundary, so
  // every accumulated native tool call is flushed; the text-based dispatcher
  // then validates names against the runtime registry on its own.
  yield* openAISSEPump({ body: response.body, signal: req.signal });
}
