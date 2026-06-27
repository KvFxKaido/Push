import process from 'node:process';
import {
  ANTHROPIC_DEFAULT_MODEL,
  BLACKBOX_DEFAULT_MODEL,
  DEEPSEEK_DEFAULT_MODEL,
  FIREWORKS_DEFAULT_MODEL,
  GOOGLE_DEFAULT_MODEL,
  KILOCODE_DEFAULT_MODEL,
  NVIDIA_DEFAULT_MODEL,
  OLLAMA_DEFAULT_MODEL,
  OPENADAPTER_DEFAULT_MODEL,
  OPENAI_DEFAULT_MODEL,
  OPENROUTER_DEFAULT_MODEL,
  SAKANA_DEFAULT_MODEL,
  ZEN_DEFAULT_MODEL,
} from '../lib/provider-models.ts';
import type {
  AIProviderType,
  LlmMessage,
  PushStream,
  PushStreamEvent,
  ReasoningBlock,
  UrlCitation,
} from '../lib/provider-contract.ts';
import { formatNativeToolCallFenced } from '../lib/openai-sse-pump.ts';
import { normalizeReasoning } from '../lib/reasoning-tokens.ts';
import { CliProviderError, createCliProviderStream } from './openai-stream.ts';
import { createCliOpenAIResponsesStream } from './openai-responses-stream.ts';
import { createCliAnthropicStream } from './anthropic-stream.ts';
import { createCliGeminiStream } from './gemini-stream.ts';

export const DEFAULT_TIMEOUT_MS: number = 120_000;
export const MAX_RETRIES: number = 3;
const RETRY_BASE_DELAY_MS: number = 1_000;

/** Wire shape for streaming + request bodies. Mirrors
 *  `ProviderStreamShape` in `lib/provider-definition.ts` so the CLI's
 *  per-provider dispatch stays aligned with the canonical scaffold.
 *
 *  - `openai-compat`: OpenAI Chat Completions schema; consume via
 *    `cli/openai-stream.ts`. Default for generic gateways.
 *  - `openai-responses`: OpenAI Responses schema; consume via
 *    `cli/openai-responses-stream.ts`. Direct OpenAI only.
 *  - `anthropic`: Anthropic Messages API; consume via
 *    `cli/anthropic-stream.ts` (translates via `lib/anthropic-bridge`).
 *  - `gemini`: Google Generative Language API; consume via
 *    `cli/gemini-stream.ts` (translates via `lib/gemini-bridge`).
 */
export type CliProviderStreamShape = 'openai-compat' | 'openai-responses' | 'anthropic' | 'gemini';

export interface ProviderConfig {
  id: string;
  url: string;
  defaultModel: string;
  apiKeyEnv: string[];
  requiresKey: boolean;
  /** Optional. Omitting it defaults to `openai-compat` for backwards
   *  compatibility with every pre-existing entry. */
  streamShape?: CliProviderStreamShape;
}

export interface ProviderListEntry {
  id: string;
  url: string;
  defaultModel: string;
  requiresKey: boolean;
  hasKey: boolean;
}

interface ChatMessage {
  role: string;
  content: string;
  /** Optional signed-reasoning sidecar carried on prior assistant turns.
   *  Forwarded through to `LlmMessage.reasoningBlocks` and onward into the
   *  Anthropic bridge. The OpenAI-compat adapter ignores the field on the
   *  wire — see `cli/openai-stream.ts` for the rationale. */
  reasoningBlocks?: ReasoningBlock[];
}

export interface StreamCompletionOptions {
  onThinkingToken?: ((token: string | null) => void) | null;
  /** Per-block callback for signed-reasoning. Fires once per
   *  `reasoning_block` event the provider emits (Anthropic emits one at
   *  every `content_block_stop` for `thinking` / `redacted_thinking`).
   *  Callers persist these onto the assistant `Message` so the next turn
   *  can round-trip them through the Anthropic bridge — without that
   *  capture, extended-thinking + tool-use chains 400 on the second turn
   *  with `invalid_request_error`. Adapters that don't surface signed
   *  reasoning (every OpenAI-compat path today) never call this. */
  onReasoningBlock?: ((block: ReasoningBlock) => void) | null;
  /** Fires when a provider's native web search returns `url_citation`
   *  annotations (OpenRouter's `openrouter:web_search`). Display-only —
   *  callers accumulate these (deduped by url) and render a "Sources"
   *  footer; they're never sent back to the model. May fire more than once
   *  per turn. */
  onCitations?: ((citations: UrlCitation[]) => void) | null;
  /** OpenRouter session_id for grouping related requests. */
  sessionId?: string;
  /**
   * Indices into `messages` to tag with `cache_control: ephemeral` (from
   * `transformContextBeforeLLM`'s `cacheBreakpointIndices`). The wire adapter
   * pairs these with a system-message marker for the Hermes `system_and_3`
   * shape — up to 4 cached prefixes per request. An empty array or `undefined`
   * disables tail caching for the call (the system message may still be cached
   * separately depending on provider gating).
   */
  cacheBreakpointIndices?: number[];
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof CliProviderError) {
    return err.status === 429 || err.status >= 500;
  }
  if (err instanceof Error && err.name === 'AbortError') return false;
  // Anything else (network failure, TypeError from a misbehaving fetch shim)
  // is treated as transport-level — matches the legacy parser that returned
  // `true` whenever there was no `Response` object on the catch.
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `url` and `defaultModel` are live getters, not spawn-time snapshots: pushd's
// `reload_config` verb rotates provider env (`reapplyProviderConfigToEnv`) on
// the running process, and these must observe the new values on the next
// request — the same live-resolution contract `resolveApiKey` already follows
// for keys. Converting an entry back to a plain property silently re-breaks
// TUI url/model edits against a running daemon (the bug class behind #858).
export const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  ollama: {
    id: 'ollama',
    get url() {
      return (
        process.env.PUSH_OLLAMA_URL ||
        process.env.OLLAMA_API_URL ||
        'https://ollama.com/v1/chat/completions'
      );
    },
    get defaultModel() {
      return process.env.PUSH_OLLAMA_MODEL || OLLAMA_DEFAULT_MODEL;
    },
    apiKeyEnv: ['PUSH_OLLAMA_API_KEY', 'OLLAMA_API_KEY', 'VITE_OLLAMA_API_KEY'],
    requiresKey: true,
  },
  openrouter: {
    id: 'openrouter',
    get url() {
      return process.env.PUSH_OPENROUTER_URL || 'https://openrouter.ai/api/v1/chat/completions';
    },
    get defaultModel() {
      return process.env.PUSH_OPENROUTER_MODEL || OPENROUTER_DEFAULT_MODEL;
    },
    apiKeyEnv: ['PUSH_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY', 'VITE_OPENROUTER_API_KEY'],
    requiresKey: true,
  },
  zen: {
    id: 'zen',
    get url() {
      return process.env.PUSH_ZEN_URL || 'https://opencode.ai/zen/v1/chat/completions';
    },
    get defaultModel() {
      return process.env.PUSH_ZEN_MODEL || ZEN_DEFAULT_MODEL;
    },
    apiKeyEnv: [
      'PUSH_ZEN_API_KEY',
      'ZEN_API_KEY',
      'OPENCODE_API_KEY',
      'VITE_ZEN_API_KEY',
      'VITE_OPENCODE_API_KEY',
    ],
    requiresKey: true,
  },
  nvidia: {
    id: 'nvidia',
    get url() {
      return process.env.PUSH_NVIDIA_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';
    },
    get defaultModel() {
      return process.env.PUSH_NVIDIA_MODEL || NVIDIA_DEFAULT_MODEL;
    },
    apiKeyEnv: ['PUSH_NVIDIA_API_KEY', 'NVIDIA_API_KEY', 'VITE_NVIDIA_API_KEY'],
    requiresKey: true,
  },
  kilocode: {
    id: 'kilocode',
    get url() {
      return process.env.PUSH_KILOCODE_URL || 'https://api.kilo.ai/api/gateway/chat/completions';
    },
    get defaultModel() {
      return process.env.PUSH_KILOCODE_MODEL || KILOCODE_DEFAULT_MODEL;
    },
    apiKeyEnv: ['PUSH_KILOCODE_API_KEY', 'KILOCODE_API_KEY', 'VITE_KILOCODE_API_KEY'],
    requiresKey: true,
  },
  fireworks: {
    id: 'fireworks',
    get url() {
      return (
        process.env.PUSH_FIREWORKS_URL || 'https://api.fireworks.ai/inference/v1/chat/completions'
      );
    },
    get defaultModel() {
      return process.env.PUSH_FIREWORKS_MODEL || FIREWORKS_DEFAULT_MODEL;
    },
    apiKeyEnv: ['PUSH_FIREWORKS_API_KEY', 'FIREWORKS_API_KEY', 'VITE_FIREWORKS_API_KEY'],
    requiresKey: true,
  },
  blackbox: {
    id: 'blackbox',
    // `api.blackbox.ai` is the JSON API host. `www.blackbox.ai` is the marketing
    // frontend and returns HTML, which breaks /models fetch (and chat) silently.
    get url() {
      return process.env.PUSH_BLACKBOX_URL || 'https://api.blackbox.ai/chat/completions';
    },
    get defaultModel() {
      return process.env.PUSH_BLACKBOX_MODEL || BLACKBOX_DEFAULT_MODEL;
    },
    apiKeyEnv: ['PUSH_BLACKBOX_API_KEY', 'BLACKBOX_API_KEY', 'VITE_BLACKBOX_API_KEY'],
    requiresKey: true,
  },
  openadapter: {
    id: 'openadapter',
    get url() {
      return process.env.PUSH_OPENADAPTER_URL || 'https://api.openadapter.in/v1/chat/completions';
    },
    get defaultModel() {
      return process.env.PUSH_OPENADAPTER_MODEL || OPENADAPTER_DEFAULT_MODEL;
    },
    apiKeyEnv: ['PUSH_OPENADAPTER_API_KEY', 'OPENADAPTER_API_KEY', 'VITE_OPENADAPTER_API_KEY'],
    requiresKey: true,
  },
  deepseek: {
    id: 'deepseek',
    // Direct DeepSeek API — OpenAI-compatible Chat Completions. Reasoning models
    // (thinking mode) stream `reasoning_content`, which the shared OpenAI SSE pump
    // already handles; unlike the Zen Go gateway, the direct API rejects
    // `reasoning_content` echoed back on input, so it is never replayed.
    get url() {
      return process.env.PUSH_DEEPSEEK_URL || 'https://api.deepseek.com/chat/completions';
    },
    get defaultModel() {
      return process.env.PUSH_DEEPSEEK_MODEL || DEEPSEEK_DEFAULT_MODEL;
    },
    apiKeyEnv: ['PUSH_DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY', 'VITE_DEEPSEEK_API_KEY'],
    requiresKey: true,
  },
  sakana: {
    id: 'sakana',
    // Sakana Fugu speaks the provider-native Responses API (`/v1/responses`),
    // like direct OpenAI — not Chat Completions.
    get url() {
      return process.env.PUSH_SAKANA_URL || 'https://api.sakana.ai/v1/responses';
    },
    get defaultModel() {
      return process.env.PUSH_SAKANA_MODEL || SAKANA_DEFAULT_MODEL;
    },
    apiKeyEnv: ['PUSH_SAKANA_API_KEY', 'SAKANA_API_KEY', 'VITE_SAKANA_API_KEY'],
    requiresKey: true,
    streamShape: 'openai-responses',
  },
  openai: {
    id: 'openai',
    // Direct OpenAI uses the provider-native Responses API. OpenAI-compatible
    // gateways stay on their own Chat Completions entries above.
    get url() {
      return process.env.PUSH_OPENAI_URL || 'https://api.openai.com/v1/responses';
    },
    get defaultModel() {
      return process.env.PUSH_OPENAI_MODEL || OPENAI_DEFAULT_MODEL;
    },
    apiKeyEnv: ['PUSH_OPENAI_API_KEY', 'OPENAI_API_KEY', 'VITE_OPENAI_API_KEY'],
    requiresKey: true,
    streamShape: 'openai-responses',
  },
  anthropic: {
    id: 'anthropic',
    // Direct Anthropic Messages API. The CLI adapter translates the
    // OpenAI-shaped body via `lib/anthropic-bridge` and pipes the
    // response back through the same OpenAI SSE pump every other CLI
    // provider uses, so consumers see one event surface.
    get url() {
      return process.env.PUSH_ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages';
    },
    get defaultModel() {
      return process.env.PUSH_ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL;
    },
    apiKeyEnv: ['PUSH_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'VITE_ANTHROPIC_API_KEY'],
    requiresKey: true,
    streamShape: 'anthropic',
  },
  google: {
    id: 'google',
    // Direct Google Generative Language API. The CLI adapter appends
    // `/models/{model}:streamGenerateContent?alt=sse` onto this base URL
    // (the model name varies per request, so it can't be baked in here).
    // If a caller pre-bakes a full URL with `:streamGenerateContent`, the
    // adapter uses it verbatim — supports regional mirrors and proxies.
    get url() {
      return process.env.PUSH_GOOGLE_URL || 'https://generativelanguage.googleapis.com/v1beta';
    },
    get defaultModel() {
      return process.env.PUSH_GOOGLE_MODEL || GOOGLE_DEFAULT_MODEL;
    },
    apiKeyEnv: ['PUSH_GOOGLE_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'VITE_GOOGLE_API_KEY'],
    requiresKey: true,
    streamShape: 'gemini',
  },
};

/** Build the right `PushStream` for a provider based on its wire shape.
 *  Centralized so callers (legacy `streamCompletion` here, plus the
 *  daemon provider stream) don't each branch on `streamShape` themselves. */
export function createProviderStream(
  config: ProviderConfig,
  apiKey: string,
  options: { sessionId?: string } = {},
): PushStream<LlmMessage> {
  switch (config.streamShape) {
    case 'openai-responses':
      return createCliOpenAIResponsesStream(config, apiKey);
    case 'anthropic':
      return createCliAnthropicStream(config, apiKey);
    case 'gemini':
      return createCliGeminiStream(config, apiKey);
    case 'openai-compat':
    case undefined:
      return createCliProviderStream(config, apiKey, { sessionId: options.sessionId });
  }
}

export function resolveApiKey(config: ProviderConfig): string {
  for (const key of config.apiKeyEnv) {
    const value: string | undefined = process.env[key];
    if (value && value.trim()) return value.trim();
  }
  if (config.requiresKey) {
    throw new Error(`Missing API key for ${config.id}. Set one of: ${config.apiKeyEnv.join(', ')}`);
  }
  return '';
}

/** Same-provider retry backoff (1s, 2s, 4s…) for the lead-turn failover
 *  wrapper. Mirrors the legacy `streamCompletion` backoff. */
export function cliStreamRetryDelayMs(attempt: number): number {
  return RETRY_BASE_DELAY_MS * 2 ** attempt;
}

/** Structured classification of a CLI provider stream failure, shaped for
 *  `decideStreamFailover` (`lib/provider-failover.ts`). Reads
 *  `CliProviderError.status`; a transport-level failure (no HTTP `Response`) is
 *  treated as transient — matching the legacy `isRetryableError`. Must not be
 *  called for an `AbortError` (the caller guards aborts first). */
export function classifyCliStreamError(err: unknown): { retryable: boolean; status?: number } {
  if (err instanceof CliProviderError) {
    const status = err.status;
    return {
      retryable: status === 408 || status === 425 || status === 429 || status >= 500,
      status,
    };
  }
  return { retryable: true };
}

function cliProviderShape(config: ProviderConfig): CliProviderStreamShape {
  return config.streamShape ?? 'openai-compat';
}

/**
 * Ordered failover candidates for a lead turn whose locked provider failed:
 * other configured providers (a key resolves) of the SAME wire shape, excluding
 * any already tried this round. Order follows `PROVIDER_CONFIGS` declaration.
 *
 * `anthropic` and `gemini` are single-member buckets in the CLI registry, so a
 * turn locked on either never fails over — the same reasoning-block safety the
 * web resolver provides (a history with Anthropic signed thinking must not be
 * replayed to a provider that can't echo the signatures). See decision #13.
 */
export function resolveCliFailoverCandidates(
  lockedId: string,
  tried: ReadonlySet<string>,
): Array<{ config: ProviderConfig; apiKey: string }> {
  const locked = PROVIDER_CONFIGS[lockedId];
  if (!locked) return [];
  const shape = cliProviderShape(locked);
  const out: Array<{ config: ProviderConfig; apiKey: string }> = [];
  for (const config of Object.values(PROVIDER_CONFIGS)) {
    if (config.id === lockedId || tried.has(config.id)) continue;
    if (cliProviderShape(config) !== shape) continue;
    let apiKey = '';
    try {
      apiKey = resolveApiKey(config);
    } catch {
      continue; // no key configured for this provider
    }
    if (config.requiresKey && !apiKey) continue;
    out.push({ config, apiKey });
  }
  return out;
}

/**
 * Return enriched metadata for all providers.
 * hasKey probes resolveApiKey without throwing.
 */
export function getProviderList(): ProviderListEntry[] {
  return Object.values(PROVIDER_CONFIGS).map((cfg: ProviderConfig) => {
    let hasKey: boolean = false;
    try {
      resolveApiKey(cfg);
      hasKey = true;
    } catch {
      /* key missing */
    }
    return {
      id: cfg.id,
      url: cfg.url,
      defaultModel: cfg.defaultModel,
      requiresKey: cfg.requiresKey,
      hasKey,
    };
  });
}

/**
 * Stream a chat completion through the shared PushStream gateway and drive
 * the legacy callback API on top of the parsed event stream.
 *
 * SSE parsing lives in `lib/openai-sse-pump.ts`; `<think>` ↔ native-reasoning
 * normalization lives in `lib/reasoning-tokens.ts#normalizeReasoning`. Both
 * are shared with the web orchestrator. This wrapper preserves the CLI's
 * retry policy (3 attempts, exponential backoff for 429 / 5xx / network),
 * activity-blind total-call timeout, and abort handling.
 */
export async function streamCompletion(
  config: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: ((token: string) => void) | null,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  externalSignal: AbortSignal | null = null,
  options: StreamCompletionOptions | undefined = undefined,
): Promise<string> {
  const onThinkingToken = options?.onThinkingToken ?? null;
  const onReasoningBlock = options?.onReasoningBlock ?? null;
  const onCitations = options?.onCitations ?? null;
  let lastError: Error | undefined;

  for (let attempt: number = 1; attempt <= MAX_RETRIES; attempt++) {
    if (externalSignal?.aborted) {
      const err: Error = new Error('Request aborted.');
      err.name = 'AbortError';
      throw err;
    }

    const timeoutController: AbortController = new AbortController();
    const timeout: ReturnType<typeof setTimeout> = setTimeout(
      () => timeoutController.abort(),
      timeoutMs,
    );
    const signals: AbortSignal[] = [timeoutController.signal];
    if (externalSignal) signals.push(externalSignal);
    const compositeSignal: AbortSignal = AbortSignal.any(signals);

    const stream = createProviderStream(config, apiKey, {
      sessionId: options?.sessionId,
    });

    let accumulated: string = '';
    let yieldedAny: boolean = false;
    // Set when the post-loop abort handler raises so the catch below knows
    // the error has already been translated and must propagate without
    // going through the retry policy.
    let postLoopAbort: boolean = false;

    try {
      // Map the lib-side message shape onto LlmMessage. The CLI doesn't
      // populate `id` / `timestamp`, but `LlmMessage` requires them — fill
      // with placeholders that the gateway never reads. The role validator
      // narrows `string` to the union explicitly: a stray 'tool' or empty
      // string would otherwise be forwarded to the upstream and rejected.
      const llmMessages: LlmMessage[] = messages.map((m, idx) => {
        const role: LlmMessage['role'] =
          m.role === 'user' || m.role === 'assistant' || m.role === 'system' ? m.role : 'user';
        const out: LlmMessage = {
          id: `cli-${idx}`,
          role,
          content: m.content,
          timestamp: 0,
        };
        // Forward signed-reasoning blocks when the caller's message carries
        // them. The Anthropic CLI adapter consumes these via the bridge;
        // OpenAI-compat adapters drop the field at their wire boundary.
        if (m.reasoningBlocks && m.reasoningBlocks.length > 0) {
          out.reasoningBlocks = m.reasoningBlocks;
        }
        return out;
      });

      const events: AsyncIterable<PushStreamEvent> = normalizeReasoning(
        stream({
          provider: (config.id as AIProviderType) ?? 'openrouter',
          model,
          messages: llmMessages,
          signal: compositeSignal,
          cacheBreakpointIndices: options?.cacheBreakpointIndices,
        }),
      );

      for await (const event of events) {
        yieldedAny = true;
        switch (event.type) {
          case 'text_delta':
            accumulated += event.text;
            onToken?.(event.text);
            break;
          case 'reasoning_delta':
            onThinkingToken?.(event.text);
            break;
          case 'reasoning_end':
            onThinkingToken?.(null);
            break;
          case 'reasoning_block':
            // Anthropic emits one of these at every content_block_stop for
            // thinking / redacted_thinking. The caller is responsible for
            // persisting them onto the assistant Message so the next turn
            // round-trips signed thinking through the bridge. Without this
            // capture, extended-thinking + tool-use chains 400 on the
            // second turn.
            onReasoningBlock?.(event.block);
            break;
          case 'tool_call_delta':
            // Structural progress signal — not surfaced through the legacy
            // callback API.
            break;
          case 'native_tool_call': {
            // Legacy callback consumers only receive text. Downgrade at this
            // boundary so old callers keep working; PushStream kernels consume
            // the structured event before this adapter.
            const text = formatNativeToolCallFenced(
              event.call.name,
              JSON.stringify(event.call.args ?? {}),
            );
            accumulated += text;
            onToken?.(text);
            break;
          }
          case 'citations':
            // Native web-search sources (OpenRouter `openrouter:web_search`).
            // Hand off to the caller, which dedupes + renders a "Sources"
            // footer. The grounded answer already streamed as `text_delta`.
            onCitations?.(event.citations);
            break;
          case 'done':
            // Loop exits naturally when the iterator returns after `done`.
            break;
        }
      }

      // The shared SSE pump exits cleanly (no throw) when its `signal`
      // aborts mid-read, so the for-await above can return normally even
      // though the request was cancelled. Translate the abort here so the
      // caller still sees AbortError/timeout instead of a truncated success.
      if (compositeSignal.aborted) {
        postLoopAbort = true;
        if (externalSignal?.aborted) {
          const abortErr: Error = new Error('Request aborted.');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        throw new Error(
          `Request timed out after ${Math.floor(timeoutMs / 1000)}s [provider=${config.id} model=${model} url=${config.url}]`,
        );
      }

      clearTimeout(timeout);
      return accumulated;
    } catch (err) {
      clearTimeout(timeout);

      // Already translated by the post-loop abort handler — propagate
      // without consulting the retry policy (an aborted/timed-out request
      // shouldn't fire another attempt).
      if (postLoopAbort) throw err;

      const isAbort: boolean =
        (err instanceof DOMException || err instanceof Error) &&
        (err as Error).name === 'AbortError';

      if (isAbort) {
        if (externalSignal?.aborted) {
          const abortErr: Error = new Error('Request aborted.');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        throw new Error(
          `Request timed out after ${Math.floor(timeoutMs / 1000)}s [provider=${config.id} model=${model} url=${config.url}]`,
        );
      }

      // Mid-stream failures (after the first event) cannot be retried — the
      // consumer has already observed partial output and a fresh attempt
      // would duplicate it.
      if (!yieldedAny && attempt < MAX_RETRIES && isRetryableError(err)) {
        lastError = err as Error;
        await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
        continue;
      }

      throw err;
    }
  }

  throw lastError || new Error('Provider request failed after retries');
}
