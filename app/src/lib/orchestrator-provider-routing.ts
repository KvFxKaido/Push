import type { ChatMessage, WorkspaceContext } from '@/types';
import type {
  AdapterTelemetry,
  AdapterTelemetryEndResult,
  AdapterTelemetryStartContext,
  AdapterTimeoutConfig,
  PreCompactEvent,
  ProviderStreamFn,
} from '@push/lib/provider-contract';
import { createProviderStreamAdapter } from '@push/lib/provider-contract';
import { normalizeReasoning } from '@push/lib/reasoning-tokens';
import {
  getPushTracer,
  recordSpanError,
  setSpanAttributes,
  SpanKind,
  SpanStatusCode,
} from './tracing';
import { openRouterModelSupportsReasoning, getReasoningEffort } from './model-catalog';
import { getOpenRouterSessionId, buildOpenRouterTrace } from './openrouter-session';
import { openrouterStream } from './openrouter-stream';
import { zenStream } from './zen-stream';
import { kilocodeStream } from './kilocode-stream';
import type { PushStream } from '@push/lib/provider-contract';
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
  todoContent?: string,
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
    todoContent,
  );
}

// ---------------------------------------------------------------------------
// Thin wrappers preserving existing exports
// ---------------------------------------------------------------------------

export type StreamChatFn = ProviderStreamFn<ChatMessage, WorkspaceContext>;

/**
 * Build the OTEL telemetry hook for a PushStream-adapted provider. Mirrors
 * the span shape the legacy `streamSSEChatOnce` emits
 * (`push.model.stream` / `model.stream`) so dashboards keyed on those
 * attributes keep working for adapted providers.
 *
 * Uses `startActiveSpan` so downstream child spans (the gateway's own
 * fetch) inherit this span as parent via W3C traceparent propagation —
 * `injectTraceHeaders` pulls from `context.active()` at the call site.
 */
function buildAdapterTelemetry(): AdapterTelemetry {
  const tracer = getPushTracer('push.model');
  return {
    wrap: async (
      ctx: AdapterTelemetryStartContext,
      run: (finalize: (result: AdapterTelemetryEndResult) => void) => Promise<void>,
    ) => {
      await tracer.startActiveSpan(
        'model.stream',
        {
          kind: SpanKind.CLIENT,
          attributes: {
            'push.provider': ctx.provider,
            'push.model': ctx.model,
            'push.message_count': ctx.messageCount,
            ...(typeof ctx.hasSandbox === 'boolean' ? { 'push.has_sandbox': ctx.hasSandbox } : {}),
            ...(ctx.workspaceMode ? { 'push.workspace_mode': ctx.workspaceMode } : {}),
          },
        },
        async (span) => {
          // Holder object — TS 6 narrows a `let captured = null` to `null`
          // even when a closure writes to it across an `await`, so the
          // post-await `if (captured)` branch ends up typed `never`. A
          // property write on a const-bound object side-steps the narrowing.
          const captured: { result: AdapterTelemetryEndResult | null } = { result: null };
          try {
            await run((result) => {
              captured.result = result;
            });
          } finally {
            const result = captured.result;
            if (result) {
              setSpanAttributes(span, {
                'push.abort_reason': result.abortReason ?? undefined,
                'push.stream.chunk_count': result.eventCount,
                'push.stream.content_chars': result.textChars,
                'push.stream.thinking_chars': result.reasoningChars,
                'push.usage.input_tokens': result.usage?.inputTokens,
                'push.usage.output_tokens': result.usage?.outputTokens,
                'push.usage.total_tokens': result.usage?.totalTokens,
              });
              if (result.error) {
                recordSpanError(span, result.error);
              } else if (result.abortReason === 'user') {
                span.setAttribute('push.cancelled', true);
              } else {
                span.setStatus({ code: SpanStatusCode.OK });
              }
            }
            span.end();
          }
        },
      );
    },
  };
}

export const streamOllamaChat: StreamChatFn = (...args) => streamProviderChat('ollama', ...args);

/**
 * Wrap a `StreamChatFn`'s `onToken`/`onDone`/`onError` so visible content is
 * batched through `createChunkedEmitter` before reaching the UI callback.
 * Mirrors the legacy `streamSSEChatOnce` path which fed `onToken` through a
 * chunker to collapse character/sub-word fragments into per-word emissions.
 *
 * Adapter-routed providers (OpenRouter / Zen / Kilo Code) bypass that legacy
 * path, so without this wrapper sub-word streaming would hammer React with a
 * `setState` per character on slow mobile devices. `onThinkingToken` is left
 * unbatched — the legacy path didn't batch reasoning either.
 *
 * Flushes on terminal callbacks (onDone / onError) so the trailing buffer
 * never gets stuck behind the 50ms scheduled flush.
 */
export function withChunkedEmitter(args: Parameters<StreamChatFn>): Parameters<StreamChatFn> {
  const [
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
  ] = args;
  const chunker = createChunkedEmitter(onToken);
  const wrappedOnToken: typeof onToken = (text) => chunker.push(text);
  const wrappedOnDone: typeof onDone = (usage) => {
    chunker.flush();
    onDone(usage);
  };
  const wrappedOnError: typeof onError = (err) => {
    chunker.flush();
    onError(err);
  };
  return [
    messages,
    wrappedOnToken,
    wrappedOnDone,
    wrappedOnError,
    onThinkingToken,
    workspaceContext,
    hasSandbox,
    modelOverride,
    systemPromptOverride,
    scratchpadContent,
    signal,
    onPreCompact,
    todoContent,
  ];
}

/**
 * OpenRouter ships via the PushStream abstraction: `openrouterStream` handles
 * SSE parsing + reasoning channel normalization, `createProviderStreamAdapter`
 * provides timer/abort safety parity with the legacy `streamSSEChatOnce` path
 * (connect/idle/progress collapse into `eventTimeoutMs`; stall maps to
 * `contentTimeoutMs`; total is wall-clock).
 *
 * The adapter is built per-call so `defaultModel` tracks the current
 * `getOpenRouterModelName()` setting.
 */
export const streamOpenRouterChat: StreamChatFn = async (...args) => {
  const apiKey = getOpenRouterKey();
  if (!apiKey) {
    // Match legacy behavior — surface a clear error before touching network.
    // The Worker can still have its own server-side key, but dev (Vite
    // passthrough) and unconfigured-Worker paths need a client-side key.
    const [, , , onError] = args;
    onError(new Error('OpenRouter API key not configured'));
    return;
  }

  const modelOverride = args[7];
  const openRouterErrorMessages = buildErrorMessages('OpenRouter');
  const timeouts: AdapterTimeoutConfig = {
    eventTimeoutMs: STANDARD_TIMEOUTS.idleTimeoutMs,
    contentTimeoutMs: STANDARD_TIMEOUTS.stallTimeoutMs,
    totalTimeoutMs: STANDARD_TIMEOUTS.totalTimeoutMs,
    errorMessages: {
      event: openRouterErrorMessages.idle,
      content: openRouterErrorMessages.stall,
      total: openRouterErrorMessages.total,
    },
  };

  // Compose openrouterStream with normalizeReasoning so inline `<think>…</think>`
  // tags in `delta.content` are split into the reasoning channel — parity with
  // the legacy path where `streamSSEChatOnce` routed content through
  // `createThinkTokenParser`. `openrouterStream` stays focused on SSE parsing
  // and field-name normalization; reasoning-tag splitting lives here in the
  // composition layer.
  const openrouterWithReasoning: PushStream<ChatMessage> = (req) =>
    normalizeReasoning(openrouterStream(req));

  const adapted = createProviderStreamAdapter<ChatMessage>(openrouterWithReasoning, 'openrouter', {
    defaultModel: modelOverride || getOpenRouterModelName(),
    timeouts,
    // Telemetry closes the observability gap noted in PR #384: OpenRouter
    // traffic now emits `push.model.stream` spans with the same attribute
    // vocabulary as the legacy `streamSSEChatOnce` path.
    telemetry: buildAdapterTelemetry(),
  });

  return adapted(...withChunkedEmitter(args));
};
export const streamCloudflareChat: StreamChatFn = (...args) =>
  streamProviderChat('cloudflare', ...args);

/**
 * OpenCode Zen ships via the PushStream abstraction (Phase 8): `zenStream`
 * handles SSE parsing + reasoning/tool-call normalization,
 * `createProviderStreamAdapter` provides timer/abort safety parity with the
 * legacy `streamSSEChatOnce` path. Structure mirrors `streamOpenRouterChat`.
 *
 * The adapter is built per-call so `defaultModel` tracks the current
 * `getZenModelName()` setting.
 */
export const streamZenChat: StreamChatFn = async (...args) => {
  const apiKey = getZenKey();
  if (!apiKey) {
    const [, , , onError] = args;
    onError(new Error('OpenCode Zen API key not configured'));
    return;
  }

  const modelOverride = args[7];
  const zenErrorMessages = buildErrorMessages('OpenCode Zen');
  const timeouts: AdapterTimeoutConfig = {
    eventTimeoutMs: STANDARD_TIMEOUTS.idleTimeoutMs,
    contentTimeoutMs: STANDARD_TIMEOUTS.stallTimeoutMs,
    totalTimeoutMs: STANDARD_TIMEOUTS.totalTimeoutMs,
    errorMessages: {
      event: zenErrorMessages.idle,
      content: zenErrorMessages.stall,
      total: zenErrorMessages.total,
    },
  };

  // Compose zenStream with normalizeReasoning so inline `<think>…</think>`
  // tags in `delta.content` are split into the reasoning channel — parity
  // with the legacy path.
  const zenWithReasoning: PushStream<ChatMessage> = (req) => normalizeReasoning(zenStream(req));

  const adapted = createProviderStreamAdapter<ChatMessage>(zenWithReasoning, 'zen', {
    defaultModel: modelOverride || getZenModelName(),
    timeouts,
    telemetry: buildAdapterTelemetry(),
  });

  return adapted(...withChunkedEmitter(args));
};
export const streamNvidiaChat: StreamChatFn = (...args) => streamProviderChat('nvidia', ...args);
export const streamBlackboxChat: StreamChatFn = (...args) =>
  streamProviderChat('blackbox', ...args);

/**
 * Kilo Code ships via the PushStream abstraction (Phase 8 follow-up):
 * `kilocodeStream` handles SSE parsing + reasoning/tool-call normalization,
 * `createProviderStreamAdapter` provides timer/abort safety. Mirrors
 * `streamZenChat` and `streamOpenRouterChat`.
 */
export const streamKilocodeChat: StreamChatFn = async (...args) => {
  const apiKey = getKilocodeKey();
  if (!apiKey) {
    const [, , , onError] = args;
    onError(new Error('Kilo Code API key not configured'));
    return;
  }

  const modelOverride = args[7];
  const kilocodeErrorMessages = buildErrorMessages('Kilo Code');
  const timeouts: AdapterTimeoutConfig = {
    eventTimeoutMs: STANDARD_TIMEOUTS.idleTimeoutMs,
    contentTimeoutMs: STANDARD_TIMEOUTS.stallTimeoutMs,
    totalTimeoutMs: STANDARD_TIMEOUTS.totalTimeoutMs,
    errorMessages: {
      event: kilocodeErrorMessages.idle,
      content: kilocodeErrorMessages.stall,
      total: kilocodeErrorMessages.total,
    },
  };

  const kilocodeWithReasoning: PushStream<ChatMessage> = (req) =>
    normalizeReasoning(kilocodeStream(req));

  const adapted = createProviderStreamAdapter<ChatMessage>(kilocodeWithReasoning, 'kilocode', {
    defaultModel: modelOverride || getKiloCodeModelName(),
    timeouts,
    telemetry: buildAdapterTelemetry(),
  });

  return adapted(...withChunkedEmitter(args));
};
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
  todoContent?: string,
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
    todoContent,
  );
}
