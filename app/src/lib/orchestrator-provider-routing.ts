import type { ChatMessage, WorkspaceContext } from '@/types';
import type {
  PreCompactEvent,
  PushStream,
  PushStreamEvent,
  ReasoningBlock,
} from '@push/lib/provider-contract';
import { normalizeReasoning } from '@push/lib/reasoning-tokens';
import { ollamaStream } from './ollama-stream';
import { cloudflareStream } from './cloudflare-stream';
import { openrouterStream } from './openrouter-stream';
import { zenStream } from './zen-stream';
import { kilocodeStream } from './kilocode-stream';
import { nvidiaStream } from './nvidia-stream';
import { blackboxStream } from './blackbox-stream';
import { openadapterStream } from './openadapter-stream';
import { azureStream } from './azure-stream';
import { bedrockStream } from './bedrock-stream';
import { vertexStream } from './vertex-stream';
import { anthropicStream } from './anthropic-stream';
import { iterateChatStream, type IterateChatStreamTimeouts } from './iterate-chat-stream';
import { getOllamaKey } from '@/hooks/useOllamaConfig';
import { getOpenRouterKey } from '@/hooks/useOpenRouterConfig';
import { getZenKey } from '@/hooks/useZenConfig';
import { getNvidiaKey } from '@/hooks/useNvidiaConfig';
import { getBlackboxKey } from '@/hooks/useBlackboxConfig';
import { getKilocodeKey } from '@/hooks/useKilocodeConfig';
import { getOpenAdapterKey } from '@/hooks/useOpenAdapterConfig';
import { getAnthropicKey } from '@/hooks/useAnthropicConfig';
import {
  getAzureBaseUrl,
  getAzureKey,
  getAzureModelName,
  getBedrockBaseUrl,
  getBedrockKey,
  getBedrockModelName,
} from '@/hooks/useExperimentalProviderConfig';
import {
  getVertexKey,
  getVertexModelName,
  getVertexBaseUrl,
  getVertexMode,
  getVertexRegion,
} from '@/hooks/useVertexConfig';
import {
  getCloudflareModelName,
  getCloudflareWorkerConfigured,
  getOllamaModelName,
  getPreferredProvider,
  getLastUsedProvider,
  getOpenRouterModelName,
  getZenModelName,
  getNvidiaModelName,
  getBlackboxModelName,
  getKiloCodeModelName,
  getOpenAdapterModelName,
  getAnthropicModelName,
} from './providers';
import type { PreferredProvider } from './providers';
import { normalizeExperimentalBaseUrl } from './experimental-providers';
import { normalizeVertexRegion } from './vertex-provider';
import { createChunkedEmitter } from './orchestrator';
import type { StreamUsage, ChunkMetadata } from './orchestrator-streaming';

// ---------------------------------------------------------------------------
// Standard timeouts shared with `buildChatTimeouts` below.
// ---------------------------------------------------------------------------

const STANDARD_TIMEOUTS = {
  eventTimeoutMs: 60_000,
  contentTimeoutMs: 60_000,
  totalTimeoutMs: 180_000,
} as const;

// ---------------------------------------------------------------------------
// Active provider detection
// ---------------------------------------------------------------------------

export type ActiveProvider =
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
  | 'anthropic'
  | 'demo';

const PROVIDER_READY_CHECKS: Record<PreferredProvider, () => boolean> = {
  ollama: () => Boolean(getOllamaKey()),
  openrouter: () => Boolean(getOpenRouterKey()),
  cloudflare: () => getCloudflareWorkerConfigured(),
  zen: () => Boolean(getZenKey()),
  nvidia: () => Boolean(getNvidiaKey()),
  blackbox: () => Boolean(getBlackboxKey()),
  kilocode: () => Boolean(getKilocodeKey()),
  openadapter: () => Boolean(getOpenAdapterKey()),
  azure: () =>
    Boolean(
      getAzureKey() &&
        normalizeExperimentalBaseUrl('azure', getAzureBaseUrl()).ok &&
        getAzureModelName(),
    ),
  bedrock: () =>
    Boolean(
      getBedrockKey() &&
        normalizeExperimentalBaseUrl('bedrock', getBedrockBaseUrl()).ok &&
        getBedrockModelName(),
    ),
  vertex: () => {
    const mode = getVertexMode();
    if (mode === 'native') {
      return Boolean(
        getVertexKey() && normalizeVertexRegion(getVertexRegion()).ok && getVertexModelName(),
      );
    }
    return Boolean(
      getVertexKey() &&
        normalizeExperimentalBaseUrl('vertex', getVertexBaseUrl()).ok &&
        getVertexModelName(),
    );
  },
  anthropic: () => Boolean(getAnthropicKey() && getAnthropicModelName()),
};

/**
 * Fallback order when no preference or last-used provider is available.
 * Neutral ordering — no provider is favoured.
 */
const PROVIDER_FALLBACK_ORDER: PreferredProvider[] = [
  'ollama',
  'openrouter',
  'cloudflare',
  'zen',
  'nvidia',
  'blackbox',
  'kilocode',
  'openadapter',
  'anthropic',
];

/**
 * Check whether a provider is fully configured (has credentials / required fields).
 * Returns false for 'demo' since it's not a real provider.
 */
export function isProviderAvailable(provider: ActiveProvider): boolean {
  if (provider === 'demo') return false;
  const check = PROVIDER_READY_CHECKS[provider as PreferredProvider];
  return check ? check() : false;
}

/**
 * Determine which provider is active.
 *
 * 1. If the user set a preference AND that provider has a key → use it.
 * 2. Use the last provider the user picked (if still configured).
 * 3. Otherwise, use whichever provider has a key (first available wins).
 * 4. No keys → demo.
 */
export function getActiveProvider(): ActiveProvider {
  const preferred = getPreferredProvider();

  // Honour explicit preference when the provider is fully configured.
  if (preferred && PROVIDER_READY_CHECKS[preferred]()) return preferred;

  // No preference — use the last provider the user picked, if still ready.
  const lastUsed = getLastUsedProvider();
  if (lastUsed && PROVIDER_READY_CHECKS[lastUsed]()) return lastUsed;

  // Fall back to any available provider.
  for (const p of PROVIDER_FALLBACK_ORDER) {
    if (PROVIDER_READY_CHECKS[p]()) return p;
  }
  return 'demo';
}

/**
 * Return a native `PushStream` for the given provider. This is the
 * gateway-to-consumer seam every agent role (Auditor / Reviewer / Planner /
 * Explorer / DeepReviewer / Coder) consumes via `iteratePushStreamText`.
 *
 * Every provider (ollama / cloudflare / openrouter / zen / kilocode /
 * openadapter / nvidia / blackbox / azure / bedrock / vertex) returns the
 * native `<provider>Stream` composed with `normalizeReasoning` so inline
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
const PROVIDER_PUSH_STREAM_CACHE = new Map<ActiveProvider, PushStream<ChatMessage>>();
export function getProviderPushStream(provider: ActiveProvider): PushStream<ChatMessage> {
  const cached = PROVIDER_PUSH_STREAM_CACHE.get(provider);
  if (cached) return cached;

  let stream: PushStream<ChatMessage>;
  switch (provider) {
    case 'ollama':
      stream = (req) => normalizeReasoning(ollamaStream(req));
      break;
    case 'cloudflare':
      stream = (req) => normalizeReasoning(cloudflareStream(req));
      break;
    case 'openrouter':
      stream = (req) => normalizeReasoning(openrouterStream(req));
      break;
    case 'zen':
      stream = (req) => normalizeReasoning(zenStream(req));
      break;
    case 'kilocode':
      stream = (req) => normalizeReasoning(kilocodeStream(req));
      break;
    case 'openadapter':
      stream = (req) => normalizeReasoning(openadapterStream(req));
      break;
    case 'nvidia':
      stream = (req) => normalizeReasoning(nvidiaStream(req));
      break;
    case 'blackbox':
      stream = (req) => normalizeReasoning(blackboxStream(req));
      break;
    case 'azure':
      stream = (req) => normalizeReasoning(azureStream(req));
      break;
    case 'bedrock':
      stream = (req) => normalizeReasoning(bedrockStream(req));
      break;
    case 'vertex':
      stream = (req) => normalizeReasoning(vertexStream(req));
      break;
    case 'anthropic':
      stream = (req) => normalizeReasoning(anthropicStream(req));
      break;
    case 'demo': {
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
      break;
    }
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unhandled provider in getProviderPushStream: ${String(exhaustive)}`);
    }
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
 * Display name per provider — used to build per-provider timeout error
 * messages so a Worker / fetch error mentions "OpenRouter" rather than
 * "openrouter". Mirrors the names the legacy `streamXChat` exports passed
 * into `buildErrorMessages` before Phase 9b.
 */
const PROVIDER_DISPLAY_NAMES: Record<ActiveProvider, string> = {
  ollama: 'Ollama Cloud',
  openrouter: 'OpenRouter',
  cloudflare: 'Cloudflare Workers AI',
  zen: 'OpenCode Zen',
  nvidia: 'Nvidia NIM',
  blackbox: 'Blackbox AI',
  kilocode: 'Kilo Code',
  openadapter: 'OpenAdapter',
  azure: 'Azure',
  bedrock: 'Bedrock',
  vertex: 'Google Vertex',
  anthropic: 'Anthropic',
  demo: 'Demo',
};

/**
 * Adapter-routed providers (those on a native PushStream + the SSE pump)
 * get the full timer wrap at the iteration layer — same machinery the
 * deleted `createProviderStreamAdapter` applied per-call. After Phase 10c
 * every non-demo provider is on a native PushStream, so the set covers
 * every real provider and the only exclusion is `demo`.
 */
const ADAPTER_ROUTED_PROVIDERS: ReadonlySet<ActiveProvider> = new Set<ActiveProvider>([
  'ollama',
  'cloudflare',
  'openrouter',
  'zen',
  'kilocode',
  'openadapter',
  'nvidia',
  'blackbox',
  'azure',
  'bedrock',
  'vertex',
  'anthropic',
]);

function buildChatTimeouts(provider: ActiveProvider): IterateChatStreamTimeouts | undefined {
  if (!ADAPTER_ROUTED_PROVIDERS.has(provider)) return undefined;
  const name = PROVIDER_DISPLAY_NAMES[provider] ?? provider;
  return {
    ...STANDARD_TIMEOUTS,
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
    case 'blackbox':
      return getBlackboxModelName();
    case 'kilocode':
      return getKiloCodeModelName();
    case 'openadapter':
      return getOpenAdapterModelName();
    case 'azure':
      return getAzureModelName();
    case 'bedrock':
      return getBedrockModelName();
    case 'vertex':
      return getVertexModelName();
    case 'anthropic':
      return getAnthropicModelName();
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
    },
    {
      timeouts: buildChatTimeouts(provider),
      telemetry: useOuterWrap ? 'enabled' : 'disabled',
    },
  );
}
