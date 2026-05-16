/**
 * CLI native OpenAI-compatible PushStream.
 *
 * Every CLI provider in `PROVIDER_CONFIGS` (ollama, openrouter, zen, nvidia,
 * kilocode, blackbox, openadapter) speaks the same OpenAI-shaped
 * `chat/completions` wire format, so they share one stream parameterized by
 * `ProviderConfig`. Per-provider extensions (OpenRouter's `HTTP-Referer`,
 * `X-Title`, `session_id`, `trace`) branch on `config.id`.
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
import { OPENROUTER_MAX_SESSION_ID_LENGTH } from '../lib/provider-models.ts';
import { MAX_ROLLING_CACHE_BREAKPOINTS } from '../lib/context-transformer.ts';
import type { ProviderConfig } from './provider.ts';

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
  type WireContent =
    | string
    | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[];
  const messages: { role: string; content: WireContent }[] = [];
  const systemPrependOffset =
    typeof req.systemPromptOverride === 'string' && req.systemPromptOverride ? 1 : 0;
  if (systemPrependOffset === 1) {
    messages.push({ role: 'system', content: req.systemPromptOverride as string });
  }
  // `reasoningBlocks` on `LlmMessage` is intentionally NOT forwarded on the
  // wire here. Every CLI provider in `PROVIDER_CONFIGS` is a strict
  // OpenAI-compatible endpoint (Ollama, OpenRouter, Zen, NVIDIA, etc.); a
  // Push-private `reasoning_blocks` field would be an unknown message
  // parameter and the upstream may reject it. Persistence on `Message`
  // still survives so a future CLI provider that fronts the Anthropic
  // bridge can opt in here.
  for (const m of req.messages) {
    messages.push({ role: m.role, content: m.content });
  }

  // Prompt caching: Hermes `system_and_3` strategy. Tag the system message
  // plus up to 3 rolling-tail messages (`cacheBreakpointIndices`) with
  // Anthropic-style `cache_control: ephemeral`. Anthropic caps a request at
  // 4 cache breakpoints; the transformer caps its tail emission at 3, so
  // `system + indices` stays within the limit. The slice below enforces that
  // cap at the wire layer too — defense in depth against a caller that
  // bypasses the transformer and passes a longer indices array directly.
  //
  // OpenRouter forwards the marker to Claude models; non-Anthropic routes
  // ignore it harmlessly. We gate on `config.id === 'openrouter'` because
  // that's the only CLI provider known to route to Anthropic — other gateway
  // providers (zen / kilocode / openadapter) are conservative pass-throughs
  // until parity is verified. Mirrors `app/src/lib/orchestrator.ts` (wire-side
  // rolling-tail loop near the end of `buildLLMMessages`).
  const rawBreakpoints = req.cacheBreakpointIndices;
  const cacheable =
    config.id === 'openrouter' && Array.isArray(rawBreakpoints) && rawBreakpoints.length > 0;
  if (cacheable) {
    if (messages[0]?.role === 'system' && typeof messages[0].content === 'string') {
      messages[0] = {
        role: 'system',
        content: [
          { type: 'text', text: messages[0].content, cache_control: { type: 'ephemeral' } },
        ],
      };
    }
    // Hard cap at MAX_ROLLING_CACHE_BREAKPOINTS — slice the most recent N if
    // the caller provided more. The contract says ≤3; this enforces the
    // invariant at the wire boundary so we cannot exceed Anthropic's
    // per-request limit of 4 cache markers even when the contract is violated.
    const breakpoints = rawBreakpoints!.slice(-MAX_ROLLING_CACHE_BREAKPOINTS);
    for (const reqIndex of breakpoints) {
      const wireIndex = reqIndex + systemPrependOffset;
      const target = messages[wireIndex];
      if (!target) continue;
      // The system at wire index 0 already got its own marker above; skip
      // duplicate tagging if a transformer ever emits 0 in the rolling tail.
      // The role check matters when there's NO system at wire index 0 (e.g.
      // a user-first transcript): in that case the rolling tail legitimately
      // includes index 0 and must be tagged.
      if (wireIndex === 0 && messages[0]?.role === 'system') continue;
      if (typeof target.content === 'string') {
        messages[wireIndex] = {
          role: target.role,
          content: [{ type: 'text', text: target.content, cache_control: { type: 'ephemeral' } }],
        };
      } else if (Array.isArray(target.content)) {
        // Already an array (e.g. multimodal or attachment-bearing message
        // forwarded by a future CLI surface). Tag the last text part — mirrors
        // the web orchestrator's behavior so multi-part messages don't lose
        // their cache slot.
        const lastPart = target.content[target.content.length - 1];
        if (lastPart && lastPart.type === 'text') {
          lastPart.cache_control = { type: 'ephemeral' };
        }
      }
    }
  }

  const model = req.model && req.model.trim() ? req.model : config.defaultModel;

  // Match the legacy `streamCompletion` body shape. Temperature defaults to
  // 0.1 when the request doesn't override it — preserves the deterministic
  // bias the CLI has always used for tool-driven turns.
  const baseBody: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    temperature: req.temperature ?? 0.1,
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
  };

  const body =
    config.id === 'openrouter'
      ? {
          ...baseBody,
          ...(options.sessionId
            ? { session_id: options.sessionId.slice(0, OPENROUTER_MAX_SESSION_ID_LENGTH) }
            : {}),
          // See: https://openrouter.ai/docs/guides/features/broadcast/overview
          trace: { generation_name: 'push-cli-chat', trace_name: 'push-cli' },
        }
      : baseBody;

  // Network failures (fetch throws) and aborts propagate verbatim. The
  // caller's retry policy treats every non-AbortError as transport-level
  // failure worth a retry, matching the legacy `streamCompletion` shape.
  // `keepalive` is intentionally not set: it is browser-only (allows requests
  // to outlive the page) and Node's undici enforces a 64KiB request-body cap
  // when it's true, which long chat histories would routinely exceed.
  const response = await fetch(config.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '(no body)');
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
