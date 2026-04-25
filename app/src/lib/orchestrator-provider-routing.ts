import type { ChatMessage, WorkspaceContext } from '@/types';
import type { PreCompactEvent, PushStream, PushStreamEvent } from '@push/lib/provider-contract';
import { normalizeReasoning } from '@push/lib/reasoning-tokens';
import { openRouterModelSupportsReasoning, getReasoningEffort } from './model-catalog';
import { getOpenRouterSessionId, buildOpenRouterTrace } from './openrouter-session';
import { openrouterStream } from './openrouter-stream';
import { zenStream } from './zen-stream';
import { kilocodeStream } from './kilocode-stream';
import { nvidiaStream } from './nvidia-stream';
import { blackboxStream } from './blackbox-stream';
import { openadapterStream } from './openadapter-stream';
import { iterateChatStream, type IterateChatStreamTimeouts } from './iterate-chat-stream';
import { getOllamaKey } from '@/hooks/useOllamaConfig';
import { getOpenRouterKey } from '@/hooks/useOpenRouterConfig';
import { getZenKey } from '@/hooks/useZenConfig';
import { getNvidiaKey } from '@/hooks/useNvidiaConfig';
import { getBlackboxKey } from '@/hooks/useBlackboxConfig';
import { getKilocodeKey } from '@/hooks/useKilocodeConfig';
import { getOpenAdapterKey } from '@/hooks/useOpenAdapterConfig';
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
  PROVIDER_URLS,
  ZEN_GO_URLS,
  getZenGoMode,
} from './providers';
import type { PreferredProvider } from './providers';
import {
  buildExperimentalProxyHeaders,
  normalizeExperimentalBaseUrl,
} from './experimental-providers';
import { encodeVertexServiceAccountHeader, normalizeVertexRegion } from './vertex-provider';
import { streamSSEChat, createChunkedEmitter } from './orchestrator';
import { parseProviderError, hasFinishReason } from './orchestrator-streaming';
import type { StreamProviderConfig, StreamUsage, ChunkMetadata } from './orchestrator-streaming';

// ---------------------------------------------------------------------------
// Error / helper functions
// ---------------------------------------------------------------------------

/** Build a standard set of timeout error messages for a provider. */
function buildErrorMessages(
  name: string,
  connectHint = 'server may be down.',
): StreamProviderConfig['errorMessages'] {
  return {
    keyMissing: `${name} API key not configured`,
    connect: (s) => `${name} API didn't respond within ${s}s — ${connectHint}`,
    idle: (s) => `${name} API stream stalled — no data for ${s}s.`,
    progress: (s) =>
      `${name} API stream stalled — data is arriving but no model progress for ${s}s.`,
    stall: (s) =>
      `${name} API stream stalled — receiving data but no content for ${s}s. The model may be stuck.`,
    total: (s) => `${name} API response exceeded ${s}s total time limit.`,
    network: `Cannot reach ${name} — network error. Check your connection.`,
  };
}

/** Standard timeout config used by most providers. */
const STANDARD_TIMEOUTS = {
  connectTimeoutMs: 30_000,
  idleTimeoutMs: 60_000,
  progressTimeoutMs: 60_000,
  stallTimeoutMs: 60_000,
  totalTimeoutMs: 180_000,
} as const;

interface ProviderStreamEntry {
  getKey: () => string | null;
  buildConfig: (
    apiKey: string,
    modelOverride?: string,
  ) => Promise<StreamProviderConfig> | StreamProviderConfig;
}

// ---------------------------------------------------------------------------
// Experimental provider config builders
// ---------------------------------------------------------------------------

function buildExperimentalStreamConfig(
  provider: 'azure' | 'bedrock' | 'vertex',
  name: string,
  apiKey: string,
  baseUrl: string,
  model: string,
): StreamProviderConfig {
  const headers = buildExperimentalProxyHeaders(provider, baseUrl);
  if (!headers['X-Push-Upstream-Base']) {
    throw new Error(`${name} base URL is missing or invalid`);
  }

  return {
    name,
    apiUrl: PROVIDER_URLS[provider].chat,
    apiKey,
    model,
    ...STANDARD_TIMEOUTS,
    errorMessages: buildErrorMessages(name),
    parseError: (p, f) => parseProviderError(p, f, true),
    checkFinishReason: (c) =>
      hasFinishReason(c, ['stop', 'length', 'end_turn', 'tool_calls', 'function_call']),
    providerType: provider,
    extraHeaders: headers,
    shouldResetStallOnReasoning: true,
  };
}

function buildVertexStreamConfig(modelOverride?: string): StreamProviderConfig {
  const mode = getVertexMode();
  const model = modelOverride || getVertexModelName();

  if (mode === 'legacy') {
    const legacyKey = getVertexKey();
    if (!legacyKey) {
      throw new Error('Google Vertex credentials are missing');
    }
    return buildExperimentalStreamConfig(
      'vertex',
      'Google Vertex',
      legacyKey,
      getVertexBaseUrl(),
      model,
    );
  }

  const serviceAccount = getVertexKey();
  if (!serviceAccount) {
    throw new Error('Google Vertex service account is missing');
  }
  const encodedServiceAccount = encodeVertexServiceAccountHeader(serviceAccount);
  if (!encodedServiceAccount) {
    throw new Error('Google Vertex service account is invalid');
  }

  const region = getVertexRegion();
  const normalizedRegion = normalizeVertexRegion(region);
  if (!normalizedRegion.ok) {
    throw new Error(normalizedRegion.error);
  }

  return {
    name: 'Google Vertex',
    apiUrl: PROVIDER_URLS.vertex.chat,
    apiKey: '',
    authHeader: null,
    model,
    ...STANDARD_TIMEOUTS,
    errorMessages: buildErrorMessages('Google Vertex'),
    parseError: (p, f) => parseProviderError(p, f, true),
    checkFinishReason: (c) =>
      hasFinishReason(c, ['stop', 'length', 'end_turn', 'tool_calls', 'function_call']),
    providerType: 'vertex',
    extraHeaders: {
      'X-Push-Vertex-Service-Account': encodedServiceAccount,
      'X-Push-Vertex-Region': normalizedRegion.normalized,
    },
  };
}

// ---------------------------------------------------------------------------
// Provider stream config registry
// ---------------------------------------------------------------------------

const PROVIDER_STREAM_CONFIGS: Record<string, ProviderStreamEntry> = {
  ollama: {
    getKey: getOllamaKey,
    buildConfig: (apiKey, modelOverride) => ({
      name: 'Ollama Cloud',
      apiUrl: PROVIDER_URLS.ollama.chat,
      apiKey,
      model: modelOverride || getOllamaModelName(),
      connectTimeoutMs: 30_000,
      idleTimeoutMs: 45_000,
      progressTimeoutMs: 60_000,
      stallTimeoutMs: 60_000,
      totalTimeoutMs: 180_000,
      errorMessages: buildErrorMessages('Ollama Cloud', 'server may be cold-starting.'),
      parseError: (p, f) => parseProviderError(p, f),
      checkFinishReason: (c) =>
        hasFinishReason(c, ['stop', 'end_turn', 'length', 'tool_calls', 'function_call']),
      shouldResetStallOnReasoning: true,
      providerType: 'ollama',
    }),
  },
  openrouter: {
    getKey: getOpenRouterKey,
    buildConfig: (apiKey, modelOverride) => {
      const model = modelOverride || getOpenRouterModelName();
      const supportsReasoning = openRouterModelSupportsReasoning(model);
      const effort = getReasoningEffort('openrouter');
      const useReasoning = supportsReasoning && effort !== 'off';
      const sessionId = getOpenRouterSessionId();
      const trace = buildOpenRouterTrace();
      return {
        name: 'OpenRouter',
        apiUrl: PROVIDER_URLS.openrouter.chat,
        apiKey,
        model,
        ...STANDARD_TIMEOUTS,
        errorMessages: buildErrorMessages('OpenRouter'),
        parseError: (p, f) => parseProviderError(p, f, true),
        checkFinishReason: (c) =>
          hasFinishReason(c, ['stop', 'length', 'end_turn', 'tool_calls', 'function_call']),
        providerType: 'openrouter',
        shouldResetStallOnReasoning: useReasoning,
        bodyTransform: (body) => ({
          ...body,
          ...(useReasoning ? { reasoning: { effort } } : {}),
          ...(sessionId ? { session_id: sessionId } : {}),
          trace,
        }),
      };
    },
  },
  cloudflare: {
    getKey: () => 'cloudflare-worker-binding',
    buildConfig: (_apiKey, modelOverride) => {
      if (!getCloudflareWorkerConfigured()) {
        throw new Error('Cloudflare Workers AI is not configured on this Worker');
      }
      return {
        name: 'Cloudflare Workers AI',
        apiUrl: PROVIDER_URLS.cloudflare.chat,
        apiKey: '',
        authHeader: null,
        model: modelOverride || getCloudflareModelName(),
        ...STANDARD_TIMEOUTS,
        // Workers AI can emit keepalive/data frames before textual deltas arrive.
        // Keep no-content guard slightly looser than generic providers.
        stallTimeoutMs: 90_000,
        // Reasoning models hosted on Workers AI (Kimi K2.6 especially)
        // can spend minutes in an extended thinking prelude before their
        // first visible token. Those chunks arrive as `reasoning_content`
        // SSE frames through the worker-providers.ts translation layer;
        // resetting the stall clock on them keeps a long-but-healthy
        // think from false-positiving against the 90s stall timer.
        shouldResetStallOnReasoning: true,
        errorMessages: {
          keyMissing: 'Cloudflare Workers AI is not configured on this Worker',
          connect: (s) =>
            `Cloudflare Workers AI didn't respond within ${s}s — the Worker may be cold-starting.`,
          idle: (s) => `Cloudflare Workers AI stream stalled — no data for ${s}s.`,
          progress: (s) =>
            `Cloudflare Workers AI stream stalled — data is arriving but no model progress for ${s}s.`,
          stall: (s) =>
            `Cloudflare Workers AI stream stalled — receiving data but no content for ${s}s.`,
          total: (s) => `Cloudflare Workers AI response exceeded ${s}s total time limit.`,
          network: 'Cannot reach Cloudflare Workers AI — network error. Check your connection.',
        },
        parseError: (p, f) => parseProviderError(p, f, true),
        checkFinishReason: (c) =>
          hasFinishReason(c, ['stop', 'length', 'end_turn', 'tool_calls', 'function_call']),
        providerType: 'cloudflare',
      };
    },
  },
  zen: {
    getKey: getZenKey,
    buildConfig: (apiKey, modelOverride) => ({
      name: 'OpenCode Zen',
      apiUrl: getZenGoMode() ? ZEN_GO_URLS.chat : PROVIDER_URLS.zen.chat,
      apiKey,
      model: modelOverride || getZenModelName(),
      ...STANDARD_TIMEOUTS,
      errorMessages: buildErrorMessages('OpenCode Zen'),
      parseError: (p, f) => parseProviderError(p, f, true),
      checkFinishReason: (c) =>
        hasFinishReason(c, ['stop', 'length', 'end_turn', 'tool_calls', 'function_call']),
      providerType: 'zen',
    }),
  },
  nvidia: {
    getKey: getNvidiaKey,
    buildConfig: (apiKey, modelOverride) => ({
      name: 'Nvidia NIM',
      apiUrl: PROVIDER_URLS.nvidia.chat,
      apiKey,
      model: modelOverride || getNvidiaModelName(),
      ...STANDARD_TIMEOUTS,
      errorMessages: buildErrorMessages('Nvidia NIM'),
      parseError: (p, f) => parseProviderError(p, f, true),
      checkFinishReason: (c) =>
        hasFinishReason(c, ['stop', 'length', 'end_turn', 'tool_calls', 'function_call']),
      providerType: 'nvidia',
    }),
  },
  blackbox: {
    getKey: getBlackboxKey,
    buildConfig: (apiKey, modelOverride) => ({
      name: 'Blackbox AI',
      apiUrl: PROVIDER_URLS.blackbox.chat,
      apiKey,
      model: modelOverride || getBlackboxModelName(),
      ...STANDARD_TIMEOUTS,
      errorMessages: buildErrorMessages('Blackbox AI'),
      parseError: (p, f) => parseProviderError(p, f, true),
      checkFinishReason: (c) =>
        hasFinishReason(c, ['stop', 'length', 'end_turn', 'tool_calls', 'function_call']),
      shouldResetStallOnReasoning: true,
      providerType: 'blackbox',
    }),
  },
  kilocode: {
    getKey: getKilocodeKey,
    buildConfig: (apiKey, modelOverride) => ({
      name: 'Kilo Code',
      apiUrl: PROVIDER_URLS.kilocode.chat,
      apiKey,
      model: modelOverride || getKiloCodeModelName(),
      ...STANDARD_TIMEOUTS,
      errorMessages: buildErrorMessages('Kilo Code'),
      parseError: (p, f) => parseProviderError(p, f, true),
      checkFinishReason: (c) =>
        hasFinishReason(c, ['stop', 'length', 'end_turn', 'tool_calls', 'function_call']),
      providerType: 'kilocode',
    }),
  },
  openadapter: {
    getKey: getOpenAdapterKey,
    buildConfig: (apiKey, modelOverride) => ({
      name: 'OpenAdapter',
      apiUrl: PROVIDER_URLS.openadapter.chat,
      apiKey,
      model: modelOverride || getOpenAdapterModelName(),
      ...STANDARD_TIMEOUTS,
      errorMessages: buildErrorMessages('OpenAdapter'),
      parseError: (p, f) => parseProviderError(p, f, true),
      checkFinishReason: (c) =>
        hasFinishReason(c, ['stop', 'length', 'end_turn', 'tool_calls', 'function_call']),
      providerType: 'openadapter',
    }),
  },
  azure: {
    getKey: getAzureKey,
    buildConfig: (apiKey, modelOverride) =>
      buildExperimentalStreamConfig(
        'azure',
        'Azure OpenAI',
        apiKey,
        getAzureBaseUrl(),
        modelOverride || getAzureModelName(),
      ),
  },
  bedrock: {
    getKey: getBedrockKey,
    buildConfig: (apiKey, modelOverride) =>
      buildExperimentalStreamConfig(
        'bedrock',
        'AWS Bedrock',
        apiKey,
        getBedrockBaseUrl(),
        modelOverride || getBedrockModelName(),
      ),
  },
  vertex: {
    getKey: getVertexKey,
    buildConfig: (_apiKey, modelOverride) => buildVertexStreamConfig(modelOverride),
  },
};

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
 * Wrap legacy `streamSSEChat`-based providers (ollama / cloudflare / azure /
 * bedrock / vertex) in a native `PushStream` interface. These providers
 * haven't been ported to per-provider native PushStream implementations yet,
 * so the gateway returns this thin queue/wake adapter that drives
 * `streamSSEChat` with callbacks and yields `PushStreamEvent`s. Exists at
 * the app-side seam so `lib/` stays free of legacy callback code; once each
 * legacy provider is ported (a future sweep), this helper deletes alongside
 * the matching `PROVIDER_STREAM_CONFIGS` entries.
 *
 * Mirrors the queue/wake pattern used in `cli/delegation-entry.ts`'s
 * planner stream — small enough to inline rather than extracting a shared
 * helper that would couple `lib/` to `streamSSEChat`.
 */
function legacyChatPushStream(providerType: string): PushStream<ChatMessage> {
  return (req) =>
    (async function* () {
      const entry = PROVIDER_STREAM_CONFIGS[providerType];
      if (!entry) {
        throw new Error(`Unknown provider: ${providerType}`);
      }

      const apiKey = entry.getKey();
      if (!apiKey) {
        throw new Error(
          `${providerType.charAt(0).toUpperCase() + providerType.slice(1)} API key not configured`,
        );
      }

      const config = await entry.buildConfig(apiKey, req.model);

      const queue: PushStreamEvent[] = [];
      let done = false;
      let error: Error | null = null;
      let wake: (() => void) | undefined;
      const notify = () => {
        if (wake) {
          const w = wake;
          wake = undefined;
          w();
        }
      };

      const onToken = (token: string) => {
        if (token.length > 0) queue.push({ type: 'text_delta', text: token });
        notify();
      };
      const onDone = (usage?: StreamUsage) => {
        queue.push({ type: 'done', finishReason: 'stop', usage });
        done = true;
        notify();
      };
      const onError = (err: Error) => {
        error = err;
        done = true;
        notify();
      };
      const onThinkingToken = (token: string | null) => {
        if (token === null) queue.push({ type: 'reasoning_end' });
        else if (token.length > 0) queue.push({ type: 'reasoning_delta', text: token });
        notify();
      };

      const signal = req.signal;
      const onAbort = () => {
        if (!done) {
          queue.push({ type: 'done', finishReason: 'aborted' });
          done = true;
          notify();
        }
      };
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener('abort', onAbort, { once: true });
      }

      const run = (async () => {
        try {
          await streamSSEChat(
            config,
            req.messages as ChatMessage[],
            onToken,
            onDone,
            onError,
            onThinkingToken,
            req.workspaceContext as WorkspaceContext | undefined,
            req.hasSandbox,
            req.systemPromptOverride,
            req.scratchpadContent,
            req.signal,
            undefined,
            req.onPreCompact,
            req.todoContent,
          );
          if (!done) onDone();
        } catch (err) {
          if (!done) onError(err instanceof Error ? err : new Error(String(err)));
        }
      })();

      try {
        while (true) {
          while (queue.length === 0 && !done) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          while (queue.length > 0) {
            const event = queue.shift()!;
            yield event;
            if (event.type === 'done') return;
          }
          if (done) {
            if (error) throw error;
            return;
          }
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
        void run.catch(() => {
          /* error already surfaced via onError */
        });
      }
    })();
}

/**
 * Return a native `PushStream` for the given provider. This is the
 * gateway-to-consumer seam every agent role (Auditor / Reviewer / Planner /
 * Explorer / DeepReviewer / Coder) consumes via `iteratePushStreamText`.
 *
 * For the six adapter-routed providers (openrouter / zen / kilocode /
 * openadapter / nvidia / blackbox), the returned PushStream is the existing
 * native `<provider>Stream` composed with `normalizeReasoning` so inline
 * `<think>…</think>` tags split into the reasoning channel — same composition
 * the legacy `streamXChat` callback exports applied internally.
 *
 * For legacy providers (ollama / cloudflare / azure / bedrock / vertex) the
 * gateway returns `legacyChatPushStream(provider)` which wraps the existing
 * `streamSSEChat` callback path into a PushStream. The reasoning channel is
 * surfaced via `onThinkingToken`; no extra `normalizeReasoning` wrap is
 * needed because the legacy SSE path's existing `createThinkTokenParser`
 * already feeds `<think>` tokens through that callback.
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
    case 'ollama':
    case 'cloudflare':
    case 'azure':
    case 'bedrock':
    case 'vertex':
      stream = legacyChatPushStream(provider);
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
  demo: 'Demo',
};

/**
 * Adapter-routed providers (the six on a native PushStream + the SSE
 * pump) get the full timer wrap at the iteration layer — same machinery
 * the deleted `createProviderStreamAdapter` applied per-call. Legacy
 * providers (ollama / cloudflare / azure / bedrock / vertex) skip the
 * outer wrap because `streamSSEChat` already owns timer machinery
 * internally; doubling up would duplicate timeout error rendering.
 */
const ADAPTER_ROUTED_PROVIDERS: ReadonlySet<ActiveProvider> = new Set<ActiveProvider>([
  'openrouter',
  'zen',
  'kilocode',
  'openadapter',
  'nvidia',
  'blackbox',
]);

function buildChatTimeouts(provider: ActiveProvider): IterateChatStreamTimeouts | undefined {
  if (!ADAPTER_ROUTED_PROVIDERS.has(provider)) return undefined;
  const name = PROVIDER_DISPLAY_NAMES[provider] ?? provider;
  return {
    eventTimeoutMs: STANDARD_TIMEOUTS.idleTimeoutMs,
    contentTimeoutMs: STANDARD_TIMEOUTS.stallTimeoutMs,
    totalTimeoutMs: STANDARD_TIMEOUTS.totalTimeoutMs,
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
    case 'demo':
      return '';
  }
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

  // Adapter-routed providers (the six on a native PushStream + SSE pump)
  // need the outer chunker + OTEL span wrap because their `<provider>Stream`
  // implementations don't apply either internally — the deleted
  // `withChunkedEmitter` + `createProviderStreamAdapter` used to give them
  // both. Legacy SSE providers (ollama / cloudflare / azure / bedrock /
  // vertex) skip the outer wrap entirely: `streamSSEChatOnce` already
  // chunks `onToken` via `createChunkedEmitter` and opens its own
  // `model.stream` span, so wrapping again here would double-chunk
  // (changing token cadence) and emit nested spans (skewing dashboards).
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
    },
    {
      onToken: wrappedOnToken,
      onDone: wrappedOnDone,
      onError: wrappedOnError,
      onThinkingToken,
    },
    {
      timeouts: buildChatTimeouts(provider),
      telemetry: useOuterWrap ? 'enabled' : 'disabled',
    },
  );
}
