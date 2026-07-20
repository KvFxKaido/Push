import process from 'node:process';
import type {
  AIProviderType,
  LlmMessage,
  PushStream,
  PushStreamEvent,
  ReasoningBlock,
  ResponsesReasoningItem,
  UrlCitation,
} from '../lib/provider-contract.ts';
import {
  getCliProviderDefinitions,
  type ProviderDefinition,
  type ProviderStreamShape,
} from '../lib/provider-definition.ts';
import { formatNativeToolCallFenced } from '../lib/openai-sse-pump.ts';
import { normalizeReasoning } from '../lib/reasoning-tokens.ts';
import { streamResponsesWithChatFallback } from '../lib/responses-chat-fallback.ts';
import { CliProviderError, createCliProviderStream } from './openai-stream.ts';
import { createCliOpenAIResponsesStream } from './openai-responses-stream.ts';
import { createCliAnthropicStream } from './anthropic-stream.ts';
import { createCliGeminiStream } from './gemini-stream.ts';
import { resolveCliPushCapabilityProfile } from './native-tool-gate.ts';

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
 *    `cli/openai-responses-stream.ts`. Used by OpenRouter, direct OpenAI,
 *    Sakana, and Fireworks.
 *  - `anthropic`: Anthropic Messages API; consume via
 *    `cli/anthropic-stream.ts` (translates via `lib/anthropic-bridge`).
 *  - `gemini`: Google Generative Language API; consume via
 *    `cli/gemini-stream.ts` (translates via `lib/gemini-bridge`).
 */
export type CliProviderStreamShape = ProviderStreamShape;

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

const OPENROUTER_LEGACY_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

interface ChatMessage {
  role: string;
  content: string;
  /** Optional signed-reasoning sidecar carried on prior assistant turns.
   *  Forwarded through to `LlmMessage.reasoningBlocks` and onward into the
   *  Anthropic bridge. The OpenAI-compat adapter ignores the field on the
   *  wire — see `cli/openai-stream.ts` for the rationale. */
  reasoningBlocks?: ReasoningBlock[];
  reasoningContent?: string;
  responsesReasoningItems?: ResponsesReasoningItem[];
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
  /** Replay metadata emitted by stateless Responses providers. */
  onResponsesReasoningItem?: ((item: ResponsesReasoningItem) => void) | null;
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
function firstLiveEnv(envVars: readonly string[]): string | undefined {
  for (const envVar of envVars) {
    const value = process.env[envVar]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** All-models transport override for OpenRouter, in either direction:
 *  `chat`/`chat-completions`/`legacy` forces Chat Completions everywhere;
 *  `responses` forces the /responses beta everywhere (e.g. to trial a model
 *  before its capability is known). `null` (unset/unknown value) means
 *  per-model dispatch via `PushCapabilityProfile.openaiWire`. */
function openRouterTransportOverride(): 'chat' | 'responses' | null {
  const raw = process.env.PUSH_OPENROUTER_TRANSPORT?.trim().toLowerCase();
  if (raw === 'chat' || raw === 'chat-completions' || raw === 'legacy') return 'chat';
  if (raw === 'responses') return 'responses';
  return null;
}

function useOpenRouterLegacyChatTransport(): boolean {
  return openRouterTransportOverride() === 'chat';
}

function openRouterWireUrl(url: string, wire: 'responses' | 'chat'): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return wire === 'responses'
      ? 'https://openrouter.ai/api/v1/responses'
      : OPENROUTER_LEGACY_CHAT_URL;
  }
  if (wire === 'responses') {
    return trimmed.replace(/\/chat\/completions\/?$/, '/responses');
  }
  return trimmed.replace(/\/responses\/?$/, '/chat/completions');
}

/** A wire-specific OpenRouter config. The URL stays live across daemon
 * `reload_config`, and recognized endpoint suffixes are swapped so an automatic
 * fallback never sends a Chat body to `/responses` (or vice versa). */
function openRouterResponsesConfig(config: ProviderConfig): ProviderConfig {
  return {
    ...config,
    get url() {
      return openRouterWireUrl(config.url, 'responses');
    },
    get defaultModel() {
      return config.defaultModel;
    },
    streamShape: 'openai-responses',
  };
}

function openRouterLegacyChatConfig(config: ProviderConfig): ProviderConfig {
  return {
    ...config,
    get url() {
      return openRouterWireUrl(config.url, 'chat');
    },
    get defaultModel() {
      return config.defaultModel;
    },
    streamShape: 'openai-compat',
  };
}

function resolveEffectiveProviderConfig(config: ProviderConfig): ProviderConfig {
  if (config.id !== 'openrouter' || !useOpenRouterLegacyChatTransport()) {
    return config;
  }
  return openRouterLegacyChatConfig(config);
}

function buildProviderConfig(def: ProviderDefinition): ProviderConfig {
  const cli = def.cli;
  if (!cli) {
    throw new Error(`Provider "${def.id}" is not enabled for the CLI.`);
  }
  if (!def.defaultModel) {
    throw new Error(`CLI provider "${def.id}" is missing defaultModel in provider-definition.ts.`);
  }
  const apiKeyEnv = cli.apiKeyEnvVars ?? def.apiKeyEnvVars;
  if (!apiKeyEnv || apiKeyEnv.length === 0) {
    throw new Error(`CLI provider "${def.id}" is missing apiKeyEnvVars in provider-definition.ts.`);
  }

  const config: ProviderConfig = {
    id: def.id,
    get url() {
      return firstLiveEnv(cli.urlEnvVars) ?? cli.defaultUrl;
    },
    get defaultModel() {
      return process.env[cli.modelEnvVar]?.trim() || def.defaultModel || '';
    },
    apiKeyEnv: [...apiKeyEnv],
    requiresKey: true,
  };

  if (def.streamShape !== 'openai-compat') {
    config.streamShape = def.streamShape;
  }
  return config;
}

export const PROVIDER_CONFIGS: Record<string, ProviderConfig> = Object.fromEntries(
  getCliProviderDefinitions().map((def) => [def.id, buildProviderConfig(def)]),
);

// Removed providers redirect to a working replacement instead of crashing
// whatever surface reads them — CLI flags/env (`parseProvider` in cli.ts),
// TUI startup/resume, daemon session starts, and persisted session state
// (`loadSessionState` coerces on read). One canonical map here so no surface
// can miss a retirement (Codex P2, PR #1382). `google` was previously a
// deprecated alias for `openrouter`; it now resolves natively, so it's not
// in this table.
export const DEPRECATED_PROVIDERS: Record<string, string> = {
  mistral: 'openrouter',
  minimax: 'openrouter',
  azure: 'openrouter',
  bedrock: 'openrouter',
  vertex: 'openrouter',
  // kilocode was removed from the roster (its origin discriminates against
  // AI Gateway egress, and its router role duplicates openrouter's).
  kilocode: 'openrouter',
  // nvidia (Nvidia NIM) was removed from the roster.
  nvidia: 'openrouter',
};

/** Replacement id for a removed provider, or null when the id isn't retired. */
export function redirectDeprecatedProvider(provider: string): string | null {
  return DEPRECATED_PROVIDERS[provider] ?? null;
}

/** Build the right `PushStream` for a provider based on its wire shape.
 *  Centralized so callers (legacy `streamCompletion` here, plus the
 *  daemon provider stream) don't each branch on `streamShape` themselves. */
export function createProviderStream(
  config: ProviderConfig,
  apiKey: string,
  options: { sessionId?: string } = {},
): PushStream<LlmMessage> {
  // Unless Chat is explicitly forced, OpenRouter decides the primary wire per
  // request and wraps every Responses attempt in the same pre-output fallback
  // policy as web/Worker. A `responses` override forces the primary wire but
  // does not silently remove the safety net.
  const openRouterOverride = openRouterTransportOverride();
  if (config.id === 'openrouter' && openRouterOverride !== 'chat') {
    const responsesStream = createCliOpenAIResponsesStream(
      openRouterResponsesConfig(config),
      apiKey,
      {
        sessionId: options.sessionId,
      },
    );
    const chatStream = createCliProviderStream(openRouterLegacyChatConfig(config), apiKey, {
      sessionId: options.sessionId,
    });
    return (req) => {
      const model = req.model?.trim() || config.defaultModel;
      if (
        openRouterOverride !== 'responses' &&
        resolveCliPushCapabilityProfile('openrouter', model).openaiWire !== 'responses'
      ) {
        return chatStream(req);
      }
      // Responses-first with a Chat Completions fallback: OpenRouter's /responses
      // beta serves every live model, but if a given model fails BEFORE producing
      // output (a transient provider error, an unforeseen incompatibility), retry
      // the turn on chat rather than fail it. A user abort is never a fallback.
      return streamResponsesWithChatFallback({
        responses: () => responsesStream(req),
        chat: () => chatStream(req),
        shouldFallback: () => !req.signal?.aborted,
        onFallback: (error) => {
          console.error(
            JSON.stringify({
              level: 'warn',
              event: 'openrouter_responses_fallback_to_chat',
              model,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        },
      });
    };
  }

  const effectiveConfig = resolveEffectiveProviderConfig(config);
  switch (effectiveConfig.streamShape) {
    case 'openai-responses':
      return createCliOpenAIResponsesStream(effectiveConfig, apiKey, {
        sessionId: options.sessionId,
      });
    case 'anthropic':
      return createCliAnthropicStream(effectiveConfig, apiKey);
    case 'gemini':
      return createCliGeminiStream(effectiveConfig, apiKey);
    case 'openai-compat':
    case undefined:
      return createCliProviderStream(effectiveConfig, apiKey, { sessionId: options.sessionId });
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
  if (err && typeof err === 'object') {
    const status = (err as { status?: unknown }).status;
    const retryable = (err as { retryable?: unknown }).retryable;
    if (typeof status === 'number' || typeof retryable === 'boolean') {
      const numericStatus = typeof status === 'number' ? status : undefined;
      return {
        retryable:
          typeof retryable === 'boolean'
            ? retryable
            : numericStatus === 408 ||
              numericStatus === 425 ||
              numericStatus === 429 ||
              (numericStatus !== undefined && numericStatus >= 500),
        ...(numericStatus !== undefined ? { status: numericStatus } : {}),
      };
    }
  }
  return { retryable: true };
}

function cliProviderShape(config: ProviderConfig): CliProviderStreamShape {
  const effectiveConfig = resolveEffectiveProviderConfig(config);
  return effectiveConfig.streamShape ?? 'openai-compat';
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
    const effectiveCfg = resolveEffectiveProviderConfig(cfg);
    let hasKey: boolean = false;
    try {
      resolveApiKey(effectiveCfg);
      hasKey = true;
    } catch {
      /* key missing */
    }
    return {
      id: effectiveCfg.id,
      url: effectiveCfg.url,
      defaultModel: effectiveCfg.defaultModel,
      requiresKey: effectiveCfg.requiresKey,
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
  const onResponsesReasoningItem = options?.onResponsesReasoningItem ?? null;
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
        if (m.reasoningContent) out.reasoningContent = m.reasoningContent;
        if (m.responsesReasoningItems && m.responsesReasoningItems.length > 0) {
          out.responsesReasoningItems = m.responsesReasoningItems;
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
          case 'responses_reasoning_item':
            onResponsesReasoningItem?.(event.item);
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
