import type { ChatMessage, WorkspaceContext } from '@/types';
import type {
  NativeToolCall,
  PreCompactEvent,
  PushStream,
  PushStreamEvent,
  ReasoningBlock,
  UrlCitation,
} from '@push/lib/provider-contract';
import { normalizeReasoning } from '@push/lib/reasoning-tokens';
import {
  getAdapterRoutedProviderIds,
  getFailoverProviderOrder,
  getProviderStreamShape,
  getProviderTimeoutDisplayName,
  type RealProviderId,
  type ProviderStreamShape,
} from '@push/lib/provider-definition';
import { ollamaStream } from './ollama-stream';
import { cloudflareStream } from './cloudflare-stream';
import { openrouterStream } from './openrouter-stream';
import { zenStream } from './zen-stream';
import { kilocodeStream } from './kilocode-stream';
import { fireworksStream } from './fireworks-stream';
import { sakanaStream } from './sakana-stream';
import { nvidiaStream } from './nvidia-stream';
import { deepseekStream } from './deepseek-stream';
import { azureStream } from './azure-stream';
import { bedrockStream } from './bedrock-stream';
import { vertexStream } from './vertex-stream';
import { anthropicStream } from './anthropic-stream';
import { openaiStream } from './openai-stream';
import { geminiStream } from './gemini-stream';
import { iterateChatStream, type IterateChatStreamTimeouts } from './iterate-chat-stream';
import { getAzureModelName, getBedrockModelName } from '@/hooks/useExperimentalProviderConfig';
import { getVertexModelName } from '@/hooks/useVertexConfig';
import { resolvePushCapabilityProfile } from './model-catalog';
import {
  getCloudflareModelName,
  getOllamaModelName,
  getOpenRouterModelName,
  getZenModelName,
  getNvidiaModelName,
  getKiloCodeModelName,
  getFireworksModelName,
  getDeepSeekModelName,
  getSakanaModelName,
  getAnthropicModelName,
  getOpenAIModelName,
  getGoogleModelName,
} from './providers';
import { getActiveProvider, isProviderAvailable, type ActiveProvider } from './active-provider';
import {
  createChunkedEmitter,
  type StreamUsage,
  type ChunkMetadata,
} from './orchestrator-streaming';

export { getActiveProvider, isProviderAvailable, type ActiveProvider } from './active-provider';

// ---------------------------------------------------------------------------
// Standard timeouts shared with `buildChatTimeouts` below.
// ---------------------------------------------------------------------------

const STANDARD_TIMEOUTS = {
  eventTimeoutMs: 60_000,
  contentTimeoutMs: 60_000,
  totalTimeoutMs: 180_000,
} as const;

// Sakana Fugu is a multi-agent orchestration router — `fugu-ultra` coordinates a
// deeper agent pool and can run silent for long stretches before emitting, so the
// standard 60s no-event / 60s no-content / 180s total bucket aborts valid
// long-running turns mid-flight. Give the Sakana route a wider window.
const SAKANA_TIMEOUTS = {
  eventTimeoutMs: 180_000,
  contentTimeoutMs: 180_000,
  totalTimeoutMs: 600_000,
} as const;

// ---------------------------------------------------------------------------
// Provider failover candidate resolution
// ---------------------------------------------------------------------------

/**
 * Native wire shape per provider lives in `lib/provider-definition.ts`. It
 * drives same-shape failover candidate selection so a round never fails over
 * across an incompatible reasoning contract. This is the *provider's* contract,
 * not the client SSE parser — every provider streams OpenAI-compatible SSE back
 * to the browser after server-side translation, but the reasoning round-trip
 * compatibility that matters for failover follows the native contract.
 *
 * Some routes are Anthropic-transport *per model* (Vertex Claude, Zen Go
 * MiniMax/Qwen), which a provider-id registry cannot express. Those are
 * handled by the `routesThroughAnthropicBridge` guard in
 * `resolveFailoverCandidates`.
 */
export type ProviderWireShape = ProviderStreamShape;

/**
 * Whether a provider+model pair speaks the Anthropic Messages transport (and so
 * round-trips signed reasoning blocks). Single source of truth shared with
 * `orchestrator.ts`'s reasoning-block emission gate. Model-aware: `zen` and
 * `vertex` route through the bridge only for specific models.
 */
export function routesThroughAnthropicBridge(
  provider: Exclude<ActiveProvider, 'demo'> | undefined,
  model: string | undefined,
): boolean {
  if (!provider || !model) return false;
  return resolvePushCapabilityProfile(provider, model).reasoningBlocks;
}

/**
 * Whether a provider+model pair requires plain unsigned reasoning text to be
 * replayed on prior assistant turns. DeepSeek thinking mode through
 * OpenAI-compatible transports rejects round 2 unless the exact
 * `reasoning_content` string is echoed back; other OpenAI-transport models may
 * reject the field, so this stays provider+DeepSeek-specific.
 */
export function routeReplaysReasoningContent(
  provider: Exclude<ActiveProvider, 'demo'> | undefined,
  model: string | undefined,
): boolean {
  if (!provider || !model) return false;
  return (provider === 'zen' || provider === 'openrouter') && /deepseek/i.test(model);
}

function getProviderFailoverShape(provider: Exclude<ActiveProvider, 'demo'>): ProviderWireShape {
  if (routesThroughAnthropicBridge(provider, resolveChatDefaultModel(provider))) {
    return 'anthropic';
  }
  return getProviderStreamShape(provider);
}

/**
 * Ordered failover candidates for a round that failed on the locked
 * provider+model: configured providers of the SAME wire shape, excluding any
 * already tried this round and the demo provider.
 *
 * Reasoning-block safety (decision #13): if the LOCKED route is
 * Anthropic-transport — direct `anthropic`, or a model-dependent bridge route
 * (`vertex` Claude, `zen` Go MiniMax/Qwen) — the history carries signed
 * thinking blocks bound to that route's account, so we **never** fail over
 * (signatures can't be replayed elsewhere). Candidate routes are checked with
 * their configured model too, so a non-Anthropic lock cannot fail over into a
 * model-dependent Anthropic target. Pure modulo the `isProviderAvailable`
 * credential reads, so the actual pick stays in `lib/`'s `decideStreamFailover`.
 */
export function resolveFailoverCandidates(
  locked: ActiveProvider,
  model: string | undefined,
  tried: ReadonlySet<string>,
): ActiveProvider[] {
  if (locked === 'demo') return [];
  // Isolate every Anthropic-transport route, including the model-dependent
  // ones the static shape table can't see.
  if (routesThroughAnthropicBridge(locked, model)) return [];
  const shape = getProviderStreamShape(locked);
  return getFailoverProviderOrder().filter(
    (p) => !tried.has(p) && isProviderAvailable(p) && getProviderFailoverShape(p) === shape,
  );
}

/**
 * Return a native `PushStream` for the given provider. This is the
 * gateway-to-consumer seam every agent role (Auditor / Reviewer / Planner /
 * Explorer / DeepReviewer / Coder) consumes via `iteratePushStreamText`.
 *
 * Every real provider returns its native `<provider>Stream` composed with
 * `normalizeReasoning` so inline
 * `<think>…</think>` tags split into the reasoning channel — same
 * composition the legacy `streamXChat` callback exports applied internally.
 *
 * Phase 9 of the PushStream gateway migration replaced the consumer-side
 * `providerStreamFnToPushStream` reverse bridge with this gateway: every
 * agent role + the CLI daemon + the worker's coder-job stream adapter now
 * receive a native PushStream instead of a `ProviderStreamFn` they then
 * had to bridge themselves.
 *
 * Per-provider memoization preserves the lib-side coalescing semantics —
 * `lib/reviewer-agent.ts` and `lib/auditor-agent.ts` key concurrent-run
 * deduplication on PushStream identity (`WeakMap<PushStream, number>`). A
 * fresh closure per call would defeat the dedupe; we cache the resolved
 * PushStream in a module-scoped map so repeated `getProviderPushStream(p)`
 * calls return the same object.
 */
const PROVIDER_PUSH_STREAM_FACTORIES = {
  ollama: ollamaStream,
  cloudflare: cloudflareStream,
  openrouter: openrouterStream,
  zen: zenStream,
  kilocode: kilocodeStream,
  fireworks: fireworksStream,
  sakana: sakanaStream,
  deepseek: deepseekStream,
  nvidia: nvidiaStream,
  azure: azureStream,
  bedrock: bedrockStream,
  vertex: vertexStream,
  anthropic: anthropicStream,
  openai: openaiStream,
  google: geminiStream,
} satisfies Record<RealProviderId, PushStream<ChatMessage>>;

const PROVIDER_PUSH_STREAM_CACHE = new Map<ActiveProvider, PushStream<ChatMessage>>();
export function getProviderPushStream(provider: ActiveProvider): PushStream<ChatMessage> {
  const cached = PROVIDER_PUSH_STREAM_CACHE.get(provider);
  if (cached) return cached;

  let stream: PushStream<ChatMessage>;
  if (provider === 'demo') {
    // Callers should guard demo before reaching here. If one slips through,
    // surface an explicit error rather than falling back to ollama and
    // emitting a confusing "Ollama API key not configured" message.
    // Hand-rolled iterator (instead of `async function*` with a `throw`)
    // sidesteps the `require-yield` lint rule for yield-less generators.
    const thrower: AsyncIterable<PushStreamEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<PushStreamEvent>> {
            return Promise.reject(
              new Error(
                'Demo provider has no PushStream — guard with a demo check before calling getProviderPushStream.',
              ),
            );
          },
        };
      },
    };
    stream = () => thrower;
  } else {
    const factory = PROVIDER_PUSH_STREAM_FACTORIES[provider];
    stream = (req) => normalizeReasoning(factory(req));
  }

  PROVIDER_PUSH_STREAM_CACHE.set(provider, stream);
  return stream;
}

// ---------------------------------------------------------------------------
// Public router — picks the right provider at runtime
// ---------------------------------------------------------------------------

const DEMO_WELCOME = `Welcome to **Push** — your AI coding agent with direct repo access.

Here's what I can help with:

- **Review PRs** — paste a GitHub PR link and I'll analyze it
- **Explore repos** — ask about any repo's structure, recent changes, or open issues
- **Ship changes** — describe what you want changed and I'll draft the code
- **Monitor pipelines** — check CI/CD status and deployment health

Connect your GitHub account in settings to get started, or just ask me anything about code.`;

/**
 * Adapter-routed providers (those on a native PushStream + the SSE pump)
 * get the full timer wrap at the iteration layer — same machinery the
 * deleted `createProviderStreamAdapter` applied per-call. After Phase 10c
 * every non-demo provider is on a native PushStream, so the set covers
 * every real provider and the only exclusion is `demo`.
 */
const ADAPTER_ROUTED_PROVIDERS: ReadonlySet<ActiveProvider> = new Set<ActiveProvider>(
  getAdapterRoutedProviderIds(),
);

function buildChatTimeouts(provider: ActiveProvider): IterateChatStreamTimeouts | undefined {
  if (!ADAPTER_ROUTED_PROVIDERS.has(provider)) return undefined;
  const name = getProviderTimeoutDisplayName(provider);
  const timeouts = provider === 'sakana' ? SAKANA_TIMEOUTS : STANDARD_TIMEOUTS;
  return {
    ...timeouts,
    errorMessages: {
      event: (s) => `${name} API stream stalled — no data for ${s}s.`,
      content: (s) =>
        `${name} API stream stalled — receiving data but no content for ${s}s. The model may be stuck.`,
      total: (s) => `${name} API response exceeded ${s}s total time limit.`,
    },
  };
}

/**
 * Resolve the configured default model for a provider. Mirrors the
 * `defaultModel` resolution each `streamXChat` export did before Phase 9b.
 */
function resolveChatDefaultModel(provider: ActiveProvider): string {
  switch (provider) {
    case 'ollama':
      return getOllamaModelName();
    case 'openrouter':
      return getOpenRouterModelName();
    case 'cloudflare':
      return getCloudflareModelName();
    case 'zen':
      return getZenModelName();
    case 'nvidia':
      return getNvidiaModelName();
    case 'kilocode':
      return getKiloCodeModelName();
    case 'fireworks':
      return getFireworksModelName();
    case 'sakana':
      return getSakanaModelName();
    case 'deepseek':
      return getDeepSeekModelName();
    case 'azure':
      return getAzureModelName();
    case 'bedrock':
      return getBedrockModelName();
    case 'vertex':
      return getVertexModelName();
    case 'anthropic':
      return getAnthropicModelName();
    case 'openai':
      return getOpenAIModelName();
    case 'google':
      return getGoogleModelName();
    case 'demo':
      return '';
  }
}

export interface SessionDigestPlumbing {
  /** Pre-fetched, scope-filtered `MemoryRecord` rows for the digest stage.
   *  Awaited by the caller (`store.list(predicate)` returns a Promise in
   *  the production IndexedDB-backed store). */
  records?: ReadonlyArray<import('@push/lib/runtime-contract').MemoryRecord>;
  /** Most-recent digest from the previous turn, persisted by the caller
   *  between turns. */
  prior?: import('@push/lib/session-digest').SessionDigest;
  /** Persistence sink for the digest emitted this turn. Caller stores it
   *  and passes it as `prior` on the next turn. */
  onEmit?: (digest: import('@push/lib/session-digest').SessionDigest | null) => void;
}

export async function streamChat(
  messages: ChatMessage[],
  onToken: (token: string, meta?: ChunkMetadata) => void,
  onDone: (usage?: StreamUsage) => void,
  onError: (error: Error) => void,
  onThinkingToken?: (token: string | null) => void,
  workspaceContext?: WorkspaceContext,
  hasSandbox?: boolean,
  scratchpadContent?: string,
  signal?: AbortSignal,
  providerOverride?: ActiveProvider,
  modelOverride?: string,
  onPreCompact?: (event: PreCompactEvent) => void,
  todoContent?: string,
  onReasoningBlock?: (block: ReasoningBlock) => void,
  sessionDigest?: SessionDigestPlumbing,
  linkedLibraryContent?: string,
  onCitations?: (citations: UrlCitation[]) => void,
  onNativeToolCall?: (call: NativeToolCall) => void,
): Promise<void> {
  const provider = providerOverride || getActiveProvider();

  // Demo mode: no API keys in dev → show welcome message
  if (provider === 'demo' && import.meta.env.DEV) {
    const words = DEMO_WELCOME.split(' ');
    let chunkIndex = 0;
    for (let i = 0; i < words.length; i++) {
      chunkIndex++;
      await new Promise((r) => setTimeout(r, 12));
      onToken(words[i] + (i < words.length - 1 ? ' ' : ''), { chunkIndex });
    }
    onDone();
    return;
  }

  if (provider === 'demo') {
    onError(new Error('No AI provider configured.'));
    return;
  }

  // Adapter-routed providers (those on a native PushStream + SSE pump)
  // need the outer chunker + OTEL span wrap because their `<provider>Stream`
  // implementations don't apply either internally — the deleted
  // `withChunkedEmitter` + `createProviderStreamAdapter` used to give them
  // both. After Phase 10c every non-demo provider is adapter-routed, so the
  // wrap applies uniformly; the early-return for `demo` above keeps it from
  // running on the demo welcome path.
  const useOuterWrap = ADAPTER_ROUTED_PROVIDERS.has(provider);
  const chunker = useOuterWrap ? createChunkedEmitter(onToken) : null;
  const wrappedOnToken = chunker ? (text: string) => chunker.push(text) : onToken;
  const wrappedOnDone = chunker
    ? (usage?: StreamUsage) => {
        chunker.flush();
        onDone(usage);
      }
    : onDone;
  const wrappedOnError = chunker
    ? (err: Error) => {
        chunker.flush();
        onError(err);
      }
    : onError;

  const stream = getProviderPushStream(provider);
  const model = modelOverride || resolveChatDefaultModel(provider);

  await iterateChatStream(
    stream,
    {
      provider,
      model,
      messages,
      systemPromptOverride: undefined,
      scratchpadContent,
      todoContent,
      linkedLibraryContent,
      workspaceContext,
      hasSandbox,
      onPreCompact,
      signal,
      sessionDigestRecords: sessionDigest?.records,
      priorSessionDigest: sessionDigest?.prior,
      onSessionDigestEmitted: sessionDigest?.onEmit,
    },
    {
      onToken: wrappedOnToken,
      onDone: wrappedOnDone,
      onError: wrappedOnError,
      onThinkingToken,
      onReasoningBlock,
      onCitations,
      onNativeToolCall,
    },
    {
      timeouts: buildChatTimeouts(provider),
      telemetry: useOuterWrap ? 'enabled' : 'disabled',
    },
  );
}
