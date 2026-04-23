import type { ChatMessage, WorkspaceContext } from '@/types';
import type { PreCompactEvent, ProviderStreamFn } from '@push/lib/provider-contract';
import { openRouterModelSupportsReasoning, getReasoningEffort } from './model-catalog';
import { getOpenRouterSessionId, buildOpenRouterTrace } from './openrouter-session';
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
import { streamSSEChat } from './orchestrator';
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
// Provider stream dispatch
// ---------------------------------------------------------------------------

/** Core streaming function — looks up provider config and delegates to streamSSEChat. */
async function streamProviderChat(
  providerType: string,
  messages: ChatMessage[],
  onToken: (token: string, meta?: ChunkMetadata) => void,
  onDone: (usage?: StreamUsage) => void,
  onError: (error: Error) => void,
  onThinkingToken?: (token: string | null) => void,
  workspaceContext?: WorkspaceContext,
  hasSandbox?: boolean,
  modelOverride?: string,
  systemPromptOverride?: string,
  scratchpadContent?: string,
  signal?: AbortSignal,
  onPreCompact?: (event: PreCompactEvent) => void,
): Promise<void> {
  const entry = PROVIDER_STREAM_CONFIGS[providerType];
  if (!entry) {
    onError(new Error(`Unknown provider: ${providerType}`));
    return;
  }

  const apiKey = entry.getKey();
  if (!apiKey) {
    onError(
      new Error(
        `${providerType.charAt(0).toUpperCase() + providerType.slice(1)} API key not configured`,
      ),
    );
    return;
  }

  let config: StreamProviderConfig;
  try {
    config = await entry.buildConfig(apiKey, modelOverride);
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  return streamSSEChat(
    config,
    messages,
    onToken,
    onDone,
    onError,
    onThinkingToken,
    workspaceContext,
    hasSandbox,
    systemPromptOverride,
    scratchpadContent,
    signal,
    undefined,
    onPreCompact,
  );
}

// ---------------------------------------------------------------------------
// Thin wrappers preserving existing exports
// ---------------------------------------------------------------------------

export type StreamChatFn = ProviderStreamFn<ChatMessage, WorkspaceContext>;

export const streamOllamaChat: StreamChatFn = (...args) => streamProviderChat('ollama', ...args);
export const streamOpenRouterChat: StreamChatFn = (...args) =>
  streamProviderChat('openrouter', ...args);
export const streamCloudflareChat: StreamChatFn = (...args) =>
  streamProviderChat('cloudflare', ...args);
export const streamZenChat: StreamChatFn = (...args) => streamProviderChat('zen', ...args);
export const streamNvidiaChat: StreamChatFn = (...args) => streamProviderChat('nvidia', ...args);
export const streamBlackboxChat: StreamChatFn = (...args) =>
  streamProviderChat('blackbox', ...args);
export const streamKilocodeChat: StreamChatFn = (...args) =>
  streamProviderChat('kilocode', ...args);
export const streamOpenAdapterChat: StreamChatFn = (...args) =>
  streamProviderChat('openadapter', ...args);
export const streamAzureChat: StreamChatFn = (...args) => streamProviderChat('azure', ...args);
export const streamBedrockChat: StreamChatFn = (...args) => streamProviderChat('bedrock', ...args);
export const streamVertexChat: StreamChatFn = (...args) => streamProviderChat('vertex', ...args);

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
 * Map an active provider to its stream function and provider type.
 * Centralises the provider → function routing used by Coder / Auditor agents.
 */
export function getProviderStreamFn(provider: ActiveProvider) {
  switch (provider) {
    case 'ollama':
      return { providerType: 'ollama' as const, streamFn: streamOllamaChat };
    case 'openrouter':
      return { providerType: 'openrouter' as const, streamFn: streamOpenRouterChat };
    case 'cloudflare':
      return { providerType: 'cloudflare' as const, streamFn: streamCloudflareChat };
    case 'zen':
      return { providerType: 'zen' as const, streamFn: streamZenChat };
    case 'nvidia':
      return { providerType: 'nvidia' as const, streamFn: streamNvidiaChat };
    case 'blackbox':
      return { providerType: 'blackbox' as const, streamFn: streamBlackboxChat };
    case 'kilocode':
      return { providerType: 'kilocode' as const, streamFn: streamKilocodeChat };
    case 'openadapter':
      return { providerType: 'openadapter' as const, streamFn: streamOpenAdapterChat };
    case 'azure':
      return { providerType: 'azure' as const, streamFn: streamAzureChat };
    case 'bedrock':
      return { providerType: 'bedrock' as const, streamFn: streamBedrockChat };
    case 'vertex':
      return { providerType: 'vertex' as const, streamFn: streamVertexChat };
    default:
      return { providerType: 'ollama' as const, streamFn: streamOllamaChat };
  }
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
): Promise<void> {
  const provider = providerOverride || getActiveProvider();
  const { streamFn } = getProviderStreamFn(provider);

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
  return streamFn(
    messages,
    onToken,
    onDone,
    onError,
    onThinkingToken,
    workspaceContext,
    hasSandbox,
    modelOverride,
    undefined,
    scratchpadContent,
    signal,
    onPreCompact,
  );
}
