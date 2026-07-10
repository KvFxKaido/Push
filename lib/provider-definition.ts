/**
 * Shared provider definitions.
 *
 * `ALL_PROVIDERS` in provider-contract.ts owns the id vocabulary. This module
 * owns provider metadata that should not be re-keyed by hand across web, CLI,
 * and Worker surfaces: display names, native wire shape, and fallback policy.
 *
 * Some provider behavior is still intentionally imperative. Stream factories
 * live next to their concrete adapters, and model-dependent transport splits
 * (Zen Go Anthropic routes) stay behind the capability/profile gates that can
 * inspect the selected model.
 */

import { ALL_PROVIDERS, type AIProviderType } from './provider-contract.ts';
import {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_MODELS,
  CLOUDFLARE_DEFAULT_MODEL,
  CLOUDFLARE_MODELS,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_MODELS,
  FIREWORKS_DEFAULT_MODEL,
  FIREWORKS_MODELS,
  GOOGLE_DEFAULT_MODEL,
  GOOGLE_MODELS,
  NVIDIA_DEFAULT_MODEL,
  NVIDIA_MODELS,
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_MODELS,
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

export interface ProviderCliDefinition {
  /** CLI/provider picker declaration order. */
  readonly order: number;
  /** Default upstream URL for the CLI when no URL env override is present. */
  readonly defaultUrl: string;
  /** Env vars checked live, in order, for URL overrides. */
  readonly urlEnvVars: readonly string[];
  /** Env var checked live for the model override. */
  readonly modelEnvVar: string;
  /** Optional CLI-only key aliases layered over the shared provider aliases. */
  readonly apiKeyEnvVars?: readonly string[];
}

export interface ProviderIconDefinition {
  /** Small provider mark used by app settings and provider pickers. */
  readonly src: string;
  readonly alt: string;
  /** Text fallback when the remote logo cannot load. */
  readonly fallbackText: string;
}

export interface ProviderSettingsDefinition {
  /** Provider description shown in app settings and provider summaries. */
  readonly description: string;
  /** User-facing env var name for BYOK/setup copy. */
  readonly envKey: string;
  /** User-facing setup URL or deployment hint. */
  readonly envUrl: string;
  /** Context window used by the role-model summaries in Settings. */
  readonly modelContextWindow: number;
  /** Local storage key for user-entered API keys, when the provider uses one. */
  readonly keyStorageKey?: string;
  /** Local storage key for the selected model. */
  readonly modelStorageKey?: string;
  /** Built-in key settings order. Omitted for separate/private settings panels. */
  readonly builtInOrder?: number;
  readonly keyPlaceholder?: string;
  readonly keySaveLabel?: string;
  readonly keyHint?: string;
  /**
   * Present when gateway BYOK covers this provider only PARTIALLY: some model
   * families authenticate in a way the AI Gateway cannot inject for a custom
   * provider (injection sets `Authorization` only). Settings must then keep
   * offering the key input alongside the "Key in gateway" state instead of
   * declaring a local key unused — the note explains which models still need
   * it. Consumer: `ProviderKeySection` via `BUILT_IN_SETTINGS_PROVIDER_META`.
   */
  readonly byokPartialNote?: string;
}

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
  /** CLI runtime config when this provider ships in the local binary. */
  readonly cli?: ProviderCliDefinition;
  /** App/provider-picker icon metadata. */
  readonly icon: ProviderIconDefinition;
  /** App settings metadata shared with provider summaries and storage helpers. */
  readonly settings: ProviderSettingsDefinition;
}

/**
 * Registry order is policy order, not the raw id-vocabulary order. It preserves
 * the existing failover ordering.
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
    icon: {
      src: 'https://models.dev/logos/ollama-cloud.svg',
      alt: 'Ollama logo',
      fallbackText: 'O',
    },
    settings: {
      description: 'Ollama — run open models locally or on cloud GPUs (OpenAI-compatible)',
      envKey: 'VITE_OLLAMA_API_KEY',
      envUrl: 'http://localhost:11434',
      modelContextWindow: 131_072,
      keyStorageKey: 'ollama_api_key',
      modelStorageKey: 'ollama_model',
      builtInOrder: 10,
      keyPlaceholder: 'Ollama API key',
      keySaveLabel: 'Save Ollama key',
      keyHint: 'Ollama API key (local or cloud).',
    },
    cli: {
      order: 10,
      defaultUrl: 'https://ollama.com/v1/chat/completions',
      urlEnvVars: ['PUSH_OLLAMA_URL', 'OLLAMA_API_URL'],
      modelEnvVar: 'PUSH_OLLAMA_MODEL',
    },
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    streamShape: 'openai-responses',
    initialFallbackEligible: true,
    failoverEligible: true,
    adapterRouted: true,
    baseUrl: 'https://openrouter.ai/api/v1/responses',
    defaultModel: OPENROUTER_DEFAULT_MODEL,
    models: OPENROUTER_MODELS,
    apiKeyEnvVars: ['PUSH_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY', 'VITE_OPENROUTER_API_KEY'],
    webProxyPath: '/api/openrouter/chat',
    modelsProxyPath: '/api/openrouter/models',
    icon: {
      src: 'https://models.dev/logos/openrouter.svg',
      alt: 'OpenRouter logo',
      fallbackText: 'OR',
    },
    settings: {
      description:
        'OpenRouter — Access 50+ models including Claude, GPT-4, Gemini, with optional BYOK routing via your OpenRouter account',
      envKey: 'VITE_OPENROUTER_API_KEY',
      envUrl: 'https://openrouter.ai',
      modelContextWindow: 200_000,
      keyStorageKey: 'openrouter_api_key',
      modelStorageKey: 'openrouter_model',
      builtInOrder: 20,
      keyPlaceholder: 'OpenRouter API key',
      keySaveLabel: 'Save OpenRouter key',
      keyHint:
        'OpenRouter API key from openrouter.ai. BYOK works too: keep provider-native keys in your OpenRouter account, then use your OpenRouter key here.',
    },
    cli: {
      order: 20,
      defaultUrl: 'https://openrouter.ai/api/v1/responses',
      urlEnvVars: ['PUSH_OPENROUTER_URL'],
      modelEnvVar: 'PUSH_OPENROUTER_MODEL',
    },
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
    icon: {
      src: 'https://models.dev/logos/cloudflare.svg',
      alt: 'Cloudflare logo',
      fallbackText: 'CF',
    },
    settings: {
      description:
        'Cloudflare Workers AI via native Worker binding (`env.AI`) with no browser API key',
      envKey: 'CLOUDFLARE_WORKERS_AI_BINDING',
      envUrl: 'Worker binding',
      modelContextWindow: 131_072,
      modelStorageKey: 'cloudflare_model',
    },
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
    icon: {
      src: 'https://models.dev/logos/opencode.svg',
      alt: 'OpenCode Zen logo',
      fallbackText: 'Z',
    },
    settings: {
      description: 'OpenCode Zen routing API (OpenAI-compatible)',
      envKey: 'VITE_ZEN_API_KEY',
      envUrl: 'https://opencode.ai/zen',
      modelContextWindow: 200_000,
      keyStorageKey: 'zen_api_key',
      modelStorageKey: 'zen_model',
      builtInOrder: 80,
      keyPlaceholder: 'Zen API key',
      keySaveLabel: 'Save OpenCode Zen key',
      keyHint: 'OpenCode Zen API key for https://opencode.ai/zen.',
      // Go is a SEPARATE OpenCode service (subscription pool) from
      // pay-as-you-go Zen — don't consolidate them in copy. Its MiniMax/Qwen
      // families are published under @ai-sdk/anthropic and authenticate via
      // `x-api-key` on /zen/go/v1/messages — which gateway BYOK cannot inject
      // (Authorization only). Those models keep using the caller's key; do
      // NOT treat a saved OpenCode key as redundant just because the gateway
      // holds one.
      byokPartialNote:
        'Go — OpenCode’s separate subscription service — includes MiniMax and Qwen models that authenticate with x-api-key, which the gateway cannot inject. The server covers them when deployed with the Secrets Store binding; a key saved here takes precedence.',
    },
    cli: {
      order: 30,
      defaultUrl: 'https://opencode.ai/zen/v1/chat/completions',
      urlEnvVars: ['PUSH_ZEN_URL'],
      modelEnvVar: 'PUSH_ZEN_MODEL',
      apiKeyEnvVars: [
        'PUSH_ZEN_API_KEY',
        'ZEN_API_KEY',
        'OPENCODE_API_KEY',
        'VITE_ZEN_API_KEY',
        'VITE_OPENCODE_API_KEY',
      ],
    },
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
    icon: {
      src: 'https://models.dev/logos/nvidia.svg',
      alt: 'NVIDIA NIM logo',
      fallbackText: 'N',
    },
    settings: {
      description: 'Nvidia NIM inference microservices (OpenAI-compatible)',
      envKey: 'VITE_NVIDIA_API_KEY',
      envUrl: 'https://build.nvidia.com',
      modelContextWindow: 131_072,
      keyStorageKey: 'nvidia_api_key',
      modelStorageKey: 'nvidia_model',
      builtInOrder: 70,
      keyPlaceholder: 'Nvidia API key',
      keySaveLabel: 'Save Nvidia key',
      keyHint: 'Nvidia NIM API key (OpenAI-compatible endpoint).',
    },
    cli: {
      order: 40,
      defaultUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
      urlEnvVars: ['PUSH_NVIDIA_URL'],
      modelEnvVar: 'PUSH_NVIDIA_MODEL',
    },
  },
  {
    id: 'fireworks',
    displayName: 'Fireworks AI',
    streamShape: 'openai-responses',
    initialFallbackEligible: true,
    failoverEligible: true,
    adapterRouted: true,
    baseUrl: 'https://api.fireworks.ai/inference/v1/responses',
    defaultModel: FIREWORKS_DEFAULT_MODEL,
    models: FIREWORKS_MODELS,
    apiKeyEnvVars: ['PUSH_FIREWORKS_API_KEY', 'FIREWORKS_API_KEY', 'VITE_FIREWORKS_API_KEY'],
    webProxyPath: '/api/fireworks/chat',
    modelsProxyPath: '/api/fireworks/models',
    icon: {
      src: 'https://fireworks.ai/favicon.ico',
      alt: 'Fireworks AI logo',
      fallbackText: 'FW',
    },
    settings: {
      description: 'Fireworks AI — OpenAI Responses-native serverless inference API',
      envKey: 'VITE_FIREWORKS_API_KEY',
      envUrl: 'https://api.fireworks.ai/inference/v1',
      modelContextWindow: 128_000,
      keyStorageKey: 'fireworks_api_key',
      modelStorageKey: 'fireworks_model',
      builtInOrder: 110,
      keyPlaceholder: 'Fireworks AI API key',
      keySaveLabel: 'Save Fireworks AI key',
      keyHint:
        'Fireworks AI API key from fireworks.ai. Direct /v1/responses with MCP-style tool support.',
    },
    cli: {
      order: 60,
      defaultUrl: 'https://api.fireworks.ai/inference/v1/responses',
      urlEnvVars: ['PUSH_FIREWORKS_URL'],
      modelEnvVar: 'PUSH_FIREWORKS_MODEL',
    },
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
    icon: {
      src: 'https://models.dev/logos/deepseek.svg',
      alt: 'DeepSeek logo',
      fallbackText: 'DS',
    },
    settings: {
      description:
        'DeepSeek direct — OpenAI-compatible api.deepseek.com with V4 reasoning models and thinking mode',
      envKey: 'VITE_DEEPSEEK_API_KEY',
      envUrl: 'https://api.deepseek.com',
      modelContextWindow: 1_000_000,
      keyStorageKey: 'deepseek_api_key',
      modelStorageKey: 'deepseek_model',
      builtInOrder: 60,
      keyPlaceholder: 'DeepSeek API key',
      keySaveLabel: 'Save DeepSeek key',
      keyHint:
        'DeepSeek API key from platform.deepseek.com. Direct api.deepseek.com — OpenAI-compatible with V4 reasoning models.',
    },
    cli: {
      order: 90,
      defaultUrl: 'https://api.deepseek.com/anthropic/v1/messages',
      urlEnvVars: ['PUSH_DEEPSEEK_URL'],
      modelEnvVar: 'PUSH_DEEPSEEK_MODEL',
    },
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
    icon: {
      src: 'https://sakana.ai/favicon.ico',
      alt: 'Sakana AI logo',
      fallbackText: 'Sk',
    },
    settings: {
      description:
        'Sakana AI — Fugu multi-agent orchestration over frontier models (OpenAI-compatible)',
      envKey: 'VITE_SAKANA_API_KEY',
      envUrl: 'https://api.sakana.ai/v1',
      modelContextWindow: 1_000_000,
      keyStorageKey: 'sakana_api_key',
      modelStorageKey: 'sakana_model',
      builtInOrder: 120,
      keyPlaceholder: 'Sakana AI API key',
      keySaveLabel: 'Save Sakana AI key',
      keyHint: 'Sakana AI API key from console.sakana.ai. Fugu multi-agent orchestration.',
    },
    cli: {
      order: 100,
      defaultUrl: 'https://api.sakana.ai/v1/responses',
      urlEnvVars: ['PUSH_SAKANA_URL'],
      modelEnvVar: 'PUSH_SAKANA_MODEL',
    },
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
    icon: {
      src: 'https://models.dev/logos/anthropic.svg',
      alt: 'Anthropic logo',
      fallbackText: 'A',
    },
    settings: {
      description:
        'Anthropic Claude direct — native /v1/messages API with prompt caching and extended thinking',
      envKey: 'VITE_ANTHROPIC_API_KEY',
      envUrl: 'https://api.anthropic.com',
      modelContextWindow: 200_000,
      keyStorageKey: 'anthropic_api_key',
      modelStorageKey: 'anthropic_model',
      builtInOrder: 30,
      keyPlaceholder: 'Anthropic API key (sk-ant-…)',
      keySaveLabel: 'Save Anthropic key',
      keyHint:
        'Anthropic API key from console.anthropic.com. Direct /v1/messages with prompt caching and extended thinking.',
    },
    cli: {
      order: 120,
      defaultUrl: 'https://api.anthropic.com/v1/messages',
      urlEnvVars: ['PUSH_ANTHROPIC_URL'],
      modelEnvVar: 'PUSH_ANTHROPIC_MODEL',
    },
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
    icon: {
      src: 'https://models.dev/logos/openai.svg',
      alt: 'OpenAI logo',
      fallbackText: 'GPT',
    },
    settings: {
      description: 'OpenAI direct — GPT models with automatic prefix-based prompt caching',
      envKey: 'VITE_OPENAI_API_KEY',
      envUrl: 'https://api.openai.com',
      modelContextWindow: 200_000,
      keyStorageKey: 'openai_api_key',
      modelStorageKey: 'openai_model',
      builtInOrder: 40,
      keyPlaceholder: 'OpenAI API key (sk-…)',
      keySaveLabel: 'Save OpenAI key',
      keyHint:
        'OpenAI API key from platform.openai.com. Direct /v1/responses with automatic prefix-based prompt caching.',
    },
    cli: {
      order: 110,
      defaultUrl: 'https://api.openai.com/v1/responses',
      urlEnvVars: ['PUSH_OPENAI_URL'],
      modelEnvVar: 'PUSH_OPENAI_MODEL',
    },
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
    icon: {
      src: 'https://models.dev/logos/google.svg',
      alt: 'Google Gemini logo',
      fallbackText: 'Gm',
    },
    settings: {
      description:
        'Google Gemini direct — native generativelanguage.googleapis.com API with a plain API key (distinct from Vertex)',
      envKey: 'VITE_GOOGLE_API_KEY',
      envUrl: 'https://generativelanguage.googleapis.com',
      modelContextWindow: 1_000_000,
      keyStorageKey: 'google_api_key',
      modelStorageKey: 'google_model',
      builtInOrder: 50,
      keyPlaceholder: 'Google Gemini API key',
      keySaveLabel: 'Save Google key',
      keyHint:
        'Google Gemini API key from aistudio.google.com. Direct generativelanguage.googleapis.com — distinct from Vertex.',
    },
    cli: {
      order: 130,
      defaultUrl: 'https://generativelanguage.googleapis.com/v1beta',
      urlEnvVars: ['PUSH_GOOGLE_URL'],
      modelEnvVar: 'PUSH_GOOGLE_MODEL',
    },
  },
];

const PROVIDER_DEFINITION_BY_ID: ReadonlyMap<RealProviderId, ProviderDefinition> = new Map(
  PROVIDER_DEFINITIONS.map((def) => [def.id, def]),
);

export const REAL_PROVIDERS: readonly RealProviderId[] = PROVIDER_DEFINITIONS.map((def) => def.id);

export function isRealProviderId(id: string): id is RealProviderId {
  return PROVIDER_DEFINITION_BY_ID.has(id as RealProviderId);
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

export function getProviderIconDefinition(id: RealProviderId): ProviderIconDefinition {
  return getProviderDefinition(id).icon;
}

export function getProviderSettingsDefinition(id: RealProviderId): ProviderSettingsDefinition {
  return getProviderDefinition(id).settings;
}

export function getBuiltInSettingsProviderDefinitions(): readonly ProviderDefinition[] {
  return PROVIDER_DEFINITIONS.filter((def) => def.settings.builtInOrder !== undefined).sort(
    (a, b) => (a.settings.builtInOrder ?? 0) - (b.settings.builtInOrder ?? 0),
  );
}

export function getProviderApiKeyStorageKey(id: RealProviderId): string | undefined {
  return getProviderDefinition(id).settings.keyStorageKey;
}

export function getProviderModelStorageKey(id: RealProviderId): string | undefined {
  return getProviderDefinition(id).settings.modelStorageKey;
}

export function providerForApiKeyStorageKey(storageKey: string): RealProviderId | null {
  for (const def of PROVIDER_DEFINITIONS) {
    if (def.settings.keyStorageKey === storageKey) return def.id;
  }
  return null;
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

export function getCliProviderDefinitions(): readonly ProviderDefinition[] {
  return PROVIDER_DEFINITIONS.filter((def) => def.cli).sort(
    (a, b) => (a.cli?.order ?? 0) - (b.cli?.order ?? 0),
  );
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
