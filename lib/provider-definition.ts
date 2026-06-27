/**
 * Shared provider definitions.
 *
 * `ALL_PROVIDERS` in provider-contract.ts owns the id vocabulary. This module
 * owns provider metadata that should not be re-keyed by hand across web, CLI,
 * and Worker surfaces: display names, native wire shape, and fallback policy.
 *
 * Some provider behavior is still intentionally imperative. Stream factories
 * live next to their concrete adapters, and model-dependent transport splits
 * (Vertex Claude, Zen Go Anthropic routes) stay behind the capability/profile
 * gates that can inspect the selected model.
 */

import { ALL_PROVIDERS, type AIProviderType } from './provider-contract.ts';
import {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_MODELS,
  BLACKBOX_DEFAULT_MODEL,
  BLACKBOX_MODELS,
  CLOUDFLARE_DEFAULT_MODEL,
  CLOUDFLARE_MODELS,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_MODELS,
  FIREWORKS_DEFAULT_MODEL,
  FIREWORKS_MODELS,
  GOOGLE_DEFAULT_MODEL,
  GOOGLE_MODELS,
  KILOCODE_DEFAULT_MODEL,
  KILOCODE_MODELS,
  NVIDIA_DEFAULT_MODEL,
  NVIDIA_MODELS,
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_MODELS,
  OPENADAPTER_DEFAULT_MODEL,
  OPENADAPTER_MODELS,
  OPENAI_DEFAULT_MODEL,
  OPENAI_MODELS,
  OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_MODELS,
  SAKANA_DEFAULT_MODEL,
  SAKANA_MODELS,
  ZEN_DEFAULT_MODEL,
  ZEN_MODELS,
} from './provider-models.ts';

/**
 * Wire shape for streaming + request bodies.
 *
 * - `openai-compat`: OpenAI Chat Completions schema; consume via
 *   `lib/openai-sse-pump.ts`. Used by OpenAI-compatible providers
 *   (OpenRouter, NVIDIA, Zen, etc.).
 * - `openai-responses`: OpenAI Responses schema; consume via
 *   `lib/openai-responses-sse-pump.ts`.
 * - `anthropic`: Anthropic Messages API (`/v1/messages`); translate via
 *   `lib/anthropic-bridge.ts`. Signed reasoning blocks must round-trip with
 *   signatures intact when extended thinking is used.
 * - `gemini`: Google Generative Language API
 *   (`/v1beta/models/{model}:streamGenerateContent`). Distinct request body
 *   (`contents[].parts[]`, `systemInstruction` field) and auth shape.
 */
export type ProviderStreamShape = 'openai-compat' | 'openai-responses' | 'anthropic' | 'gemini';

export type RealProviderId = Exclude<AIProviderType, 'demo'>;
export type DirectProviderId = Extract<RealProviderId, 'openai' | 'anthropic' | 'google'>;

export interface ProviderDefinition {
  /** Stable provider id from `ALL_PROVIDERS`, excluding the non-network demo mode. */
  readonly id: RealProviderId;
  /** Human-readable Settings UI name. */
  readonly displayName: string;
  /** Optional legacy/runtime name where timeout copy historically differed. */
  readonly timeoutDisplayName?: string;
  /** SSE/request translator selector for the provider's default/native route. */
  readonly streamShape: ProviderStreamShape;
  /** Eligible for the initial automatic "first configured provider" pick. */
  readonly initialFallbackEligible: boolean;
  /** Eligible as a same-wire-shape backup after a provider fails mid-turn. */
  readonly failoverEligible: boolean;
  /** Uses a native PushStream adapter and outer iteration timeout/telemetry wrap. */
  readonly adapterRouted: boolean;
  /** Provider route consumes neutral content blocks by default. */
  readonly contentBlocksByDefault?: boolean;
  /** Provider route carries signed reasoning blocks by default. */
  readonly reasoningBlocksByDefault?: boolean;
  /**
   * Base URL for direct/shared adapters that have a stable upstream endpoint.
   * Private/external endpoint providers can leave this undefined because their
   * runtime base is user-configured or Worker-bound.
   */
  readonly baseUrl?: string;
  /** Default model for static catalog-backed providers. MUST appear in `models`. */
  readonly defaultModel?: string;
  /** Curated model id list for UI dropdowns. Free-text entry still allowed. */
  readonly models?: readonly string[];
  /**
   * Environment variable names to try, in order. The CLI consumes this from
   * `process.env`; the Worker consumes the first matching secret it supports.
   */
  readonly apiKeyEnvVars?: readonly string[];
  /** Worker proxy chat path used by the web app, e.g. `/api/openai/chat`. */
  readonly webProxyPath?: string;
  /** Worker proxy models path used by the web app, e.g. `/api/openai/models`. */
  readonly modelsProxyPath?: string;
}

/**
 * Registry order is policy order, not the raw id-vocabulary order. It preserves
 * the existing failover ordering and keeps experimental private connectors out
 * of the initial automatic provider fallback while still allowing them as
 * same-shape failover targets when explicitly configured.
 */
export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    id: 'ollama',
    displayName: 'Ollama',
    timeoutDisplayName: 'Ollama Cloud',
    streamShape: 'openai-compat',
    initialFallbackEligible: true,
    failoverEligible: true,
    adapterRouted: true,
    defaultModel: OLLAMA_DEFAULT_MODEL,
    models: OLLAMA_MODELS,
    apiKeyEnvVars: ['PUSH_OLLAMA_API_KEY', 'OLLAMA_API_KEY', 'VITE_OLLAMA_API_KEY'],
    webProxyPath: '/api/ollama/chat',
    modelsProxyPath: '/api/ollama/models',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    streamShape: 'openai-compat',
    initialFallbackEligible: true,
    failoverEligible: true,
    adapterRouted: true,
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: OPENROUTER_DEFAULT_MODEL,
    models: OPENROUTER_MODELS,
    apiKeyEnvVars: ['PUSH_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY', 'VITE_OPENROUTER_API_KEY'],
    webProxyPath: '/api/openrouter/chat',
    modelsProxyPath: '/api/openrouter/models',
  },
  {
    id: 'cloudflare',
    displayName: 'Cloudflare Workers AI',
    streamShape: 'openai-compat',
    initialFallbackEligible: true,
    failoverEligible: true,
    adapterRouted: true,
    defaultModel: CLOUDFLARE_DEFAULT_MODEL,
    models: CLOUDFLARE_MODELS,
    webProxyPath: '/api/cloudflare/chat',
    modelsProxyPath: '/api/cloudflare/models',
  },
  {
    id: 'zen',
    displayName: 'OpenCode Zen',
    streamShape: 'openai-compat',
    initialFallbackEligible: true,
    failoverEligible: true,
    adapterRouted: true,
    defaultModel: ZEN_DEFAULT_MODEL,
    models: ZEN_MODELS,
    apiKeyEnvVars: ['PUSH_ZEN_API_KEY', 'ZEN_API_KEY', 'VITE_ZEN_API_KEY'],
    webProxyPath: '/api/zen/chat',
    modelsProxyPath: '/api/zen/models',
  },
  {
    id: 'nvidia',
    displayName: 'Nvidia NIM',
    streamShape: 'openai-compat',
    initialFallbackEligible: true,
    failoverEligible: true,
    adapterRouted: true,
    baseUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    defaultModel: NVIDIA_DEFAULT_MODEL,
    models: NVIDIA_MODELS,
    apiKeyEnvVars: ['PUSH_NVIDIA_API_KEY', 'NVIDIA_API_KEY', 'VITE_NVIDIA_API_KEY'],
    webProxyPath: '/api/nvidia/chat',
    modelsProxyPath: '/api/nvidia/models',
  },
  {
    id: 'blackbox',
    displayName: 'Blackbox AI',
    streamShape: 'openai-compat',
    initialFallbackEligible: true,
    failoverEligible: true,
    adapterRouted: true,
    defaultModel: BLACKBOX_DEFAULT_MODEL,
    models: BLACKBOX_MODELS,
    apiKeyEnvVars: ['PUSH_BLACKBOX_API_KEY', 'BLACKBOX_API_KEY', 'VITE_BLACKBOX_API_KEY'],
    webProxyPath: '/api/blackbox/chat',
    modelsProxyPath: '/api/blackbox/models',
  },
  {
    id: 'kilocode',
    displayName: 'Kilo Code',
    streamShape: 'openai-compat',
    initialFallbackEligible: true,
    failoverEligible: true,
    adapterRouted: true,
    baseUrl: 'https://api.kilo.ai/api/gateway/chat/completions',
    defaultModel: KILOCODE_DEFAULT_MODEL,
    models: KILOCODE_MODELS,
    apiKeyEnvVars: ['PUSH_KILOCODE_API_KEY', 'KILOCODE_API_KEY', 'VITE_KILOCODE_API_KEY'],
    webProxyPath: '/api/kilocode/chat',
    modelsProxyPath: '/api/kilocode/models',
  },
  {
    id: 'fireworks',
    displayName: 'Fireworks AI',
    streamShape: 'openai-compat',
    initialFallbackEligible: true,
    failoverEligible: true,
    adapterRouted: true,
    baseUrl: 'https://api.fireworks.ai/inference/v1/chat/completions',
    defaultModel: FIREWORKS_DEFAULT_MODEL,
    models: FIREWORKS_MODELS,
    apiKeyEnvVars: ['PUSH_FIREWORKS_API_KEY', 'FIREWORKS_API_KEY', 'VITE_FIREWORKS_API_KEY'],
    webProxyPath: '/api/fireworks/chat',
    modelsProxyPath: '/api/fireworks/models',
  },
  {
    id: 'openadapter',
    displayName: 'OpenAdapter',
    streamShape: 'openai-compat',
    initialFallbackEligible: true,
    failoverEligible: true,
    adapterRouted: true,
    defaultModel: OPENADAPTER_DEFAULT_MODEL,
    models: OPENADAPTER_MODELS,
    apiKeyEnvVars: ['PUSH_OPENADAPTER_API_KEY', 'OPENADAPTER_API_KEY', 'VITE_OPENADAPTER_API_KEY'],
    webProxyPath: '/api/openadapter/chat',
    modelsProxyPath: '/api/openadapter/models',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    streamShape: 'anthropic',
    initialFallbackEligible: true,
    failoverEligible: true,
    adapterRouted: true,
    contentBlocksByDefault: true,
    reasoningBlocksByDefault: true,
    baseUrl: 'https://api.deepseek.com/anthropic/v1/messages',
    defaultModel: DEEPSEEK_DEFAULT_MODEL,
    models: DEEPSEEK_MODELS,
    apiKeyEnvVars: ['PUSH_DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY', 'VITE_DEEPSEEK_API_KEY'],
    webProxyPath: '/api/deepseek/chat',
    modelsProxyPath: '/api/deepseek/models',
  },
  {
    id: 'sakana',
    displayName: 'Sakana AI',
    streamShape: 'openai-responses',
    initialFallbackEligible: true,
    failoverEligible: true,
    adapterRouted: true,
    baseUrl: 'https://api.sakana.ai/v1/responses',
    defaultModel: SAKANA_DEFAULT_MODEL,
    models: SAKANA_MODELS,
    apiKeyEnvVars: ['PUSH_SAKANA_API_KEY', 'SAKANA_API_KEY', 'VITE_SAKANA_API_KEY'],
    webProxyPath: '/api/sakana/chat',
    modelsProxyPath: '/api/sakana/models',
  },
  {
    id: 'azure',
    displayName: 'Azure OpenAI',
    timeoutDisplayName: 'Azure',
    streamShape: 'openai-compat',
    initialFallbackEligible: false,
    failoverEligible: true,
    adapterRouted: true,
    apiKeyEnvVars: [
      'PUSH_AZURE_OPENAI_API_KEY',
      'AZURE_OPENAI_API_KEY',
      'VITE_AZURE_OPENAI_API_KEY',
    ],
    webProxyPath: '/api/azure/chat',
    modelsProxyPath: '/api/azure/models',
  },
  {
    id: 'bedrock',
    displayName: 'AWS Bedrock',
    timeoutDisplayName: 'Bedrock',
    streamShape: 'openai-compat',
    initialFallbackEligible: false,
    failoverEligible: true,
    adapterRouted: true,
    apiKeyEnvVars: ['PUSH_BEDROCK_API_KEY', 'BEDROCK_API_KEY', 'VITE_BEDROCK_API_KEY'],
    webProxyPath: '/api/bedrock/chat',
    modelsProxyPath: '/api/bedrock/models',
  },
  {
    id: 'vertex',
    displayName: 'Google Vertex',
    streamShape: 'gemini',
    initialFallbackEligible: false,
    failoverEligible: true,
    adapterRouted: true,
    apiKeyEnvVars: [
      'PUSH_VERTEX_SERVICE_ACCOUNT_JSON',
      'GOOGLE_APPLICATION_CREDENTIALS_JSON',
      'VITE_VERTEX_SERVICE_ACCOUNT_JSON',
    ],
    webProxyPath: '/api/vertex/chat',
    modelsProxyPath: '/api/vertex/models',
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    streamShape: 'anthropic',
    initialFallbackEligible: true,
    failoverEligible: true,
    adapterRouted: true,
    contentBlocksByDefault: true,
    reasoningBlocksByDefault: true,
    baseUrl: 'https://api.anthropic.com/v1/messages',
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    models: ANTHROPIC_MODELS,
    apiKeyEnvVars: ['PUSH_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'VITE_ANTHROPIC_API_KEY'],
    webProxyPath: '/api/anthropic/chat',
    modelsProxyPath: '/api/anthropic/models',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    streamShape: 'openai-responses',
    initialFallbackEligible: true,
    failoverEligible: true,
    adapterRouted: true,
    baseUrl: 'https://api.openai.com/v1/responses',
    defaultModel: OPENAI_DEFAULT_MODEL,
    models: OPENAI_MODELS,
    apiKeyEnvVars: ['PUSH_OPENAI_API_KEY', 'OPENAI_API_KEY', 'VITE_OPENAI_API_KEY'],
    webProxyPath: '/api/openai/chat',
    modelsProxyPath: '/api/openai/models',
  },
  {
    id: 'google',
    displayName: 'Google Gemini',
    streamShape: 'gemini',
    initialFallbackEligible: true,
    failoverEligible: true,
    adapterRouted: true,
    contentBlocksByDefault: true,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: GOOGLE_DEFAULT_MODEL,
    models: GOOGLE_MODELS,
    apiKeyEnvVars: [
      'PUSH_GOOGLE_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'VITE_GOOGLE_API_KEY',
    ],
    webProxyPath: '/api/google/chat',
    modelsProxyPath: '/api/google/models',
  },
];

const PROVIDER_DEFINITION_BY_ID: ReadonlyMap<RealProviderId, ProviderDefinition> = new Map(
  PROVIDER_DEFINITIONS.map((def) => [def.id, def]),
);

export const REAL_PROVIDERS: readonly RealProviderId[] = PROVIDER_DEFINITIONS.map((def) => def.id);

export function isRealProviderId(id: AIProviderType): id is RealProviderId {
  return id !== 'demo';
}

export function getProviderDefinition(id: RealProviderId): ProviderDefinition {
  const def = PROVIDER_DEFINITION_BY_ID.get(id);
  if (!def) {
    throw new Error(`No ProviderDefinition for id "${id}"`);
  }
  return def;
}

export function findProviderDefinition(id: string): ProviderDefinition | undefined {
  return PROVIDER_DEFINITION_BY_ID.get(id as RealProviderId);
}

export function getProviderDisplayName(id: AIProviderType | string): string {
  if (id === 'demo') return 'Demo';
  return findProviderDefinition(id)?.displayName ?? id;
}

export function getProviderTimeoutDisplayName(id: AIProviderType | string): string {
  if (id === 'demo') return 'Demo';
  const def = findProviderDefinition(id);
  return def?.timeoutDisplayName ?? def?.displayName ?? id;
}

export function getProviderStreamShape(id: RealProviderId): ProviderStreamShape {
  return getProviderDefinition(id).streamShape;
}

export function getInitialFallbackProviderOrder(): readonly RealProviderId[] {
  return PROVIDER_DEFINITIONS.filter((def) => def.initialFallbackEligible).map((def) => def.id);
}

export function getFailoverProviderOrder(): readonly RealProviderId[] {
  return PROVIDER_DEFINITIONS.filter((def) => def.failoverEligible).map((def) => def.id);
}

export function getAdapterRoutedProviderIds(): readonly RealProviderId[] {
  return PROVIDER_DEFINITIONS.filter((def) => def.adapterRouted).map((def) => def.id);
}

export function providerConsumesContentBlocksByDefault(provider: string): boolean {
  return findProviderDefinition(provider)?.contentBlocksByDefault === true;
}

export function providerCarriesReasoningBlocksByDefault(provider: string): boolean {
  return findProviderDefinition(provider)?.reasoningBlocksByDefault === true;
}

export function providerDefinitionsCoverCanonicalIds(): boolean {
  const realIds = ALL_PROVIDERS.filter(
    (provider): provider is RealProviderId => provider !== 'demo',
  );
  return (
    realIds.length === PROVIDER_DEFINITIONS.length &&
    realIds.every((provider) => PROVIDER_DEFINITION_BY_ID.has(provider))
  );
}
