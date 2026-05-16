import type { AIProviderType, AIProviderConfig, AIModel, AgentRole } from '@/types';
import { getAzureModelName, getBedrockModelName } from '@/hooks/useExperimentalProviderConfig';
import { getVertexModelName } from '@/hooks/useVertexConfig';
import { resolveApiUrl } from './api-url';
import { getModelCapabilities } from './model-capabilities';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from './safe-storage';
import { VERTEX_DEFAULT_MODEL as SHARED_VERTEX_DEFAULT_MODEL } from './vertex-provider';
import { ZEN_GO_DEFAULT_MODEL, ZEN_GO_MODELS as SHARED_ZEN_GO_MODELS } from './zen-go';
export {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_MODELS,
  BLACKBOX_DEFAULT_MODEL,
  BLACKBOX_MODELS,
  CLOUDFLARE_DEFAULT_MODEL,
  CLOUDFLARE_MODELS,
  KILOCODE_DEFAULT_MODEL,
  KILOCODE_MODELS,
  NVIDIA_DEFAULT_MODEL,
  NVIDIA_MODELS,
  OLLAMA_DEFAULT_MODEL,
  OPENADAPTER_DEFAULT_MODEL,
  OPENADAPTER_MODELS,
  OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_MODELS,
  ZEN_DEFAULT_MODEL,
  ZEN_MODELS,
} from '@push/lib/provider-models';
import {
  ANTHROPIC_DEFAULT_MODEL,
  BLACKBOX_DEFAULT_MODEL,
  CLOUDFLARE_DEFAULT_MODEL,
  KILOCODE_DEFAULT_MODEL,
  NVIDIA_DEFAULT_MODEL,
  OLLAMA_DEFAULT_MODEL,
  OPENADAPTER_DEFAULT_MODEL,
  OPENROUTER_DEFAULT_MODEL,
  ZEN_DEFAULT_MODEL,
} from '@push/lib/provider-models';

// ---------------------------------------------------------------------------
// Provider URL registry — single source of truth for dev/prod endpoints
// ---------------------------------------------------------------------------

/** Resolve a provider endpoint: dev uses Vite proxy paths, prod goes through
 *  resolveApiUrl so the Capacitor WebView gets an absolute Worker URL while
 *  the same-origin web build keeps relative paths. */
function providerUrl(devPath: string, prodPath: string): string {
  return import.meta.env.DEV ? devPath : resolveApiUrl(prodPath);
}

export const PROVIDER_URLS: Record<AIProviderType, { chat: string; models: string }> = {
  ollama: {
    chat: providerUrl('/ollama/v1/chat/completions', '/api/ollama/chat'),
    models: providerUrl('/ollama/v1/models', '/api/ollama/models'),
  },
  openrouter: {
    chat: providerUrl('/openrouter/api/v1/chat/completions', '/api/openrouter/chat'),
    models: providerUrl('/openrouter/api/v1/models', '/api/openrouter/models'),
  },
  cloudflare: {
    chat: providerUrl('/api/cloudflare/chat', '/api/cloudflare/chat'),
    models: providerUrl('/api/cloudflare/models', '/api/cloudflare/models'),
  },
  zen: {
    chat: providerUrl('/opencode/zen/v1/chat/completions', '/api/zen/chat'),
    models: providerUrl('/opencode/zen/v1/models', '/api/zen/models'),
  },
  nvidia: {
    chat: providerUrl('/nvidia/v1/chat/completions', '/api/nvidia/chat'),
    models: providerUrl('/nvidia/v1/models', '/api/nvidia/models'),
  },
  blackbox: {
    chat: providerUrl('/blackbox/chat/completions', '/api/blackbox/chat'),
    models: providerUrl('/blackbox/models', '/api/blackbox/models'),
  },
  azure: {
    chat: providerUrl('/api/azure/chat', '/api/azure/chat'),
    models: providerUrl('/api/azure/models', '/api/azure/models'),
  },
  bedrock: {
    chat: providerUrl('/api/bedrock/chat', '/api/bedrock/chat'),
    models: providerUrl('/api/bedrock/models', '/api/bedrock/models'),
  },
  vertex: {
    chat: providerUrl('/api/vertex/chat', '/api/vertex/chat'),
    models: providerUrl('/api/vertex/models', '/api/vertex/models'),
  },
  demo: { chat: '', models: '' },
  kilocode: {
    chat: providerUrl('/api/kilocode/chat', '/api/kilocode/chat'),
    models: providerUrl('/api/kilocode/models', '/api/kilocode/models'),
  },
  openadapter: {
    chat: providerUrl('/api/openadapter/chat', '/api/openadapter/chat'),
    models: providerUrl('/api/openadapter/models', '/api/openadapter/models'),
  },
  anthropic: {
    chat: providerUrl('/api/anthropic/chat', '/api/anthropic/chat'),
    // Anthropic's /v1/models exists, but for MVP the curated ANTHROPIC_MODELS
    // list seeds the dropdown; a Worker `/api/anthropic/models` proxy can land
    // alongside live fetching in a follow-up.
    models: providerUrl('/api/anthropic/models', '/api/anthropic/models'),
  },
};

// Experimental direct-deployment defaults — only used as placeholders before the user
// configures a concrete deployment/model.
export const AZURE_DEFAULT_MODEL = 'gpt-4.1';
export const BEDROCK_DEFAULT_MODEL = 'anthropic.claude-3-7-sonnet-20250219-v1:0';
export const VERTEX_DEFAULT_MODEL = SHARED_VERTEX_DEFAULT_MODEL;
export const ZEN_GO_MODELS: string[] = [...SHARED_ZEN_GO_MODELS];
export { ZEN_GO_DEFAULT_MODEL };

export const ZEN_GO_URLS = {
  chat: providerUrl('/opencode/zen/go/v1/chat/completions', '/api/zen/go/chat'),
};

const MODEL_ROUTE_PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  'arcee-ai': 'Arcee AI',
  blackbox: 'Blackbox',
  cohere: 'Cohere',
  deepseek: 'DeepSeek',
  google: 'Google',
  'kilo-auto': 'Kilo Auto',
  meta: 'Meta',
  'meta-llama': 'Meta',
  minimax: 'MiniMax',
  mistralai: 'Mistral',
  moonshotai: 'Moonshot',
  openai: 'OpenAI',
  perplexity: 'Perplexity',
  qwen: 'Qwen',
  stepfun: 'StepFun',
  'x-ai': 'xAI',
  'z-ai': 'Zhipu',
};

const LEGACY_KILOCODE_MODEL_MIGRATIONS: Record<string, string> = {
  'google/gemini-2.0-flash': 'google/gemini-3-flash-preview',
  'anthropic/claude-3.5-sonnet': 'anthropic/claude-sonnet-4.6',
  'openai/gpt-4o': 'openai/gpt-5.2',
};

export function normalizeKilocodeModelName(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return KILOCODE_DEFAULT_MODEL;

  const migrated = LEGACY_KILOCODE_MODEL_MIGRATIONS[trimmed];
  if (migrated) return migrated;

  if (!trimmed.includes('/') || /\s/.test(trimmed)) {
    return KILOCODE_DEFAULT_MODEL;
  }

  return trimmed;
}

function normalizeProviderModelId(provider: AIProviderType | string, modelId: string): string {
  const trimmed = modelId.trim();
  if (provider === 'blackbox') return trimmed.replace(/^blackboxai\//i, '');
  return trimmed;
}

export function getModelDisplayGroupKey(
  provider: AIProviderType | string,
  modelId: string,
): string {
  const normalized = normalizeProviderModelId(provider, modelId);
  if (provider === 'cloudflare' && normalized.startsWith('@')) {
    const parts = normalized.split('/');
    if (parts.length >= 3) return parts[1] || '';
  }
  const slash = normalized.indexOf('/');
  if (slash > 0) return normalized.slice(0, slash);
  if (provider === 'blackbox' && normalized) return 'blackbox';
  return '';
}

export function getModelDisplayGroupLabel(groupKey: string): string {
  return MODEL_ROUTE_PROVIDER_LABELS[groupKey] || groupKey;
}

export function getModelDisplayLeafName(
  provider: AIProviderType | string,
  modelId: string,
): string {
  const normalized = normalizeProviderModelId(provider, modelId);
  if (provider === 'cloudflare' && normalized.startsWith('@')) {
    const parts = normalized.split('/');
    if (parts.length >= 3) return parts.slice(2).join('/');
  }
  const slash = normalized.indexOf('/');
  return slash > 0 ? normalized.slice(slash + 1) : normalized;
}

export function formatModelDisplayName(provider: AIProviderType | string, modelId: string): string {
  const normalized = normalizeProviderModelId(provider, modelId);
  const groupKey = getModelDisplayGroupKey(provider, modelId);
  if (!groupKey) return normalized;
  return `${getModelDisplayGroupLabel(groupKey)} / ${getModelDisplayLeafName(provider, modelId)}`;
}

export function compareProviderModelIds(
  provider: AIProviderType | string,
  left: string,
  right: string,
): number {
  const leftGroup = getModelDisplayGroupLabel(getModelDisplayGroupKey(provider, left));
  const rightGroup = getModelDisplayGroupLabel(getModelDisplayGroupKey(provider, right));
  const groupDiff = leftGroup.localeCompare(rightGroup, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  if (groupDiff !== 0) return groupDiff;

  const leafDiff = getModelDisplayLeafName(provider, left).localeCompare(
    getModelDisplayLeafName(provider, right),
    undefined,
    { numeric: true, sensitivity: 'base' },
  );
  if (leafDiff !== 0) return leafDiff;

  return normalizeProviderModelId(provider, left).localeCompare(
    normalizeProviderModelId(provider, right),
    undefined,
    { numeric: true, sensitivity: 'base' },
  );
}

/** Build the standard role model set for a provider. */
function makeRoleModels(
  id: string,
  displayName: string,
  provider: AIProviderType,
  context: number,
): AIModel[] {
  return (['orchestrator', 'coder', 'explorer', 'auditor', 'reviewer'] as const).map((role) => ({
    id,
    name: `${displayName} (${role.charAt(0).toUpperCase() + role.slice(1)})`,
    provider,
    role,
    context,
    capabilities: getModelCapabilities(provider, id),
  }));
}

export const PROVIDERS: AIProviderConfig[] = [
  {
    type: 'ollama',
    name: 'Ollama',
    description: 'Ollama — run open models locally or on cloud GPUs (OpenAI-compatible)',
    envKey: 'VITE_OLLAMA_API_KEY',
    envUrl: 'http://localhost:11434',
    models: makeRoleModels(OLLAMA_DEFAULT_MODEL, 'Ollama', 'ollama', 131_072),
  },
  {
    type: 'openrouter',
    name: 'OpenRouter',
    description:
      'OpenRouter — Access 50+ models including Claude, GPT-4, Gemini, with optional BYOK routing via your OpenRouter account',
    envKey: 'VITE_OPENROUTER_API_KEY',
    envUrl: 'https://openrouter.ai',
    models: makeRoleModels(OPENROUTER_DEFAULT_MODEL, 'OpenRouter', 'openrouter', 200_000),
  },
  {
    type: 'cloudflare',
    name: 'Cloudflare Workers AI',
    description:
      'Cloudflare Workers AI via native Worker binding (`env.AI`) with no browser API key',
    envKey: 'CLOUDFLARE_WORKERS_AI_BINDING',
    envUrl: 'Worker binding',
    models: makeRoleModels(
      CLOUDFLARE_DEFAULT_MODEL,
      'Cloudflare Workers AI',
      'cloudflare',
      131_072,
    ),
  },
  {
    type: 'zen',
    name: 'OpenCode Zen',
    description: 'OpenCode Zen routing API (OpenAI-compatible)',
    envKey: 'VITE_ZEN_API_KEY',
    envUrl: 'https://opencode.ai/zen',
    models: makeRoleModels(ZEN_DEFAULT_MODEL, 'OpenCode Zen', 'zen', 200_000),
  },
  {
    type: 'nvidia',
    name: 'Nvidia NIM',
    description: 'Nvidia NIM inference microservices (OpenAI-compatible)',
    envKey: 'VITE_NVIDIA_API_KEY',
    envUrl: 'https://build.nvidia.com',
    models: makeRoleModels(NVIDIA_DEFAULT_MODEL, 'Nvidia NIM', 'nvidia', 131_072),
  },
  {
    type: 'blackbox',
    name: 'Blackbox AI',
    description: 'Blackbox AI — unified inference API with 300+ models (OpenAI-compatible)',
    envKey: 'VITE_BLACKBOX_API_KEY',
    envUrl: 'https://www.blackbox.ai',
    models: makeRoleModels(BLACKBOX_DEFAULT_MODEL, 'Blackbox AI', 'blackbox', 200_000),
  },
  {
    type: 'kilocode',
    name: 'Kilo Code',
    description: 'Kilo Code — Unified AI gateway with hundreds of models (OpenAI-compatible)',
    envKey: 'VITE_KILOCODE_API_KEY',
    envUrl: 'https://api.kilo.ai/api/gateway',
    models: makeRoleModels(KILOCODE_DEFAULT_MODEL, 'Kilo Code', 'kilocode', 128_000),
  },
  {
    type: 'openadapter',
    name: 'OpenAdapter',
    description: 'OpenAdapter — 69+ open-source models through one OpenAI-compatible gateway',
    envKey: 'VITE_OPENADAPTER_API_KEY',
    envUrl: 'https://openadapter.dev',
    models: makeRoleModels(OPENADAPTER_DEFAULT_MODEL, 'OpenAdapter', 'openadapter', 131_072),
  },
  {
    type: 'azure',
    name: 'Azure OpenAI',
    description:
      'Experimental private connector for direct Azure OpenAI and Azure AI Foundry deployments',
    envKey: 'VITE_AZURE_OPENAI_API_KEY',
    envUrl: 'https://your-resource.services.ai.azure.com/api/projects/PROJECT',
    models: makeRoleModels(AZURE_DEFAULT_MODEL, 'Azure OpenAI', 'azure', 200_000),
  },
  {
    type: 'bedrock',
    name: 'AWS Bedrock',
    description: 'Experimental private connector for direct Bedrock OpenAI-compatible endpoints',
    envKey: 'VITE_BEDROCK_API_KEY',
    envUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
    models: makeRoleModels(BEDROCK_DEFAULT_MODEL, 'AWS Bedrock', 'bedrock', 200_000),
  },
  {
    type: 'vertex',
    name: 'Google Vertex',
    description:
      'Experimental private connector for Google Vertex using service-account auth with Gemini OpenAPI and Claude partner-model routing',
    envKey: 'VITE_VERTEX_SERVICE_ACCOUNT_JSON',
    envUrl: 'global',
    models: makeRoleModels(VERTEX_DEFAULT_MODEL, 'Google Vertex', 'vertex', 1_000_000),
  },
  {
    type: 'anthropic',
    name: 'Anthropic',
    description:
      'Anthropic Claude direct — native /v1/messages API with prompt caching and extended thinking',
    envKey: 'VITE_ANTHROPIC_API_KEY',
    envUrl: 'https://api.anthropic.com',
    models: makeRoleModels(ANTHROPIC_DEFAULT_MODEL, 'Anthropic', 'anthropic', 200_000),
  },
];

export function getProvider(type: AIProviderType): AIProviderConfig | undefined {
  return PROVIDERS.find((p) => p.type === type);
}

export function getDefaultModel(type: AIProviderType): AIModel | undefined {
  const provider = getProvider(type);
  return provider?.models[0];
}

// ---------------------------------------------------------------------------
// Runtime model name — factory + per-provider instances
// ---------------------------------------------------------------------------

function createModelNameStorage(
  storageKey: string,
  defaultModel: string,
  onSet?: () => void,
  normalizeModel?: (model: string) => string,
): { get: () => string; set: (model: string) => void } {
  const sanitizeModel = (model: string): string => {
    const trimmed = model.trim();
    return normalizeModel ? normalizeModel(trimmed) : trimmed;
  };

  return {
    get: () => {
      const stored = safeStorageGet(storageKey);
      if (!stored) return defaultModel;
      const normalized = sanitizeModel(stored);
      if (normalized && normalized !== stored) {
        safeStorageSet(storageKey, normalized);
      }
      return normalized || defaultModel;
    },
    set: (model: string) => {
      const normalized = sanitizeModel(model);
      if (!normalized) return;
      safeStorageSet(storageKey, normalized);
      onSet?.();
    },
  };
}

const ollamaModel = createModelNameStorage('ollama_model', OLLAMA_DEFAULT_MODEL);
export const getOllamaModelName = ollamaModel.get;
export const setOllamaModelName = ollamaModel.set;

const openRouterModel = createModelNameStorage('openrouter_model', OPENROUTER_DEFAULT_MODEL);
export const getOpenRouterModelName = openRouterModel.get;
export const setOpenRouterModelName = openRouterModel.set;

const cloudflareModel = createModelNameStorage('cloudflare_model', CLOUDFLARE_DEFAULT_MODEL);
export const getCloudflareModelName = cloudflareModel.get;
export const setCloudflareModelName = cloudflareModel.set;

const CLOUDFLARE_WORKER_CONFIGURED_KEY = 'cloudflare_worker_configured';
export function getCloudflareWorkerConfigured(): boolean {
  return safeStorageGet(CLOUDFLARE_WORKER_CONFIGURED_KEY) === 'true';
}
export function setCloudflareWorkerConfigured(configured: boolean): void {
  safeStorageSet(CLOUDFLARE_WORKER_CONFIGURED_KEY, configured ? 'true' : 'false');
}

const zenModel = createModelNameStorage('zen_model', ZEN_DEFAULT_MODEL);
export const getZenModelName = zenModel.get;
export const setZenModelName = zenModel.set;

const ZEN_GO_MODE_KEY = 'zen_go_mode';
export function getZenGoMode(): boolean {
  return safeStorageGet(ZEN_GO_MODE_KEY) === 'true';
}
export function setZenGoMode(enabled: boolean): void {
  if (enabled) safeStorageSet(ZEN_GO_MODE_KEY, 'true');
  else safeStorageRemove(ZEN_GO_MODE_KEY);
}

const nvidiaModel = createModelNameStorage('nvidia_model', NVIDIA_DEFAULT_MODEL);
export const getNvidiaModelName = nvidiaModel.get;
export const setNvidiaModelName = nvidiaModel.set;

const blackboxModel = createModelNameStorage('blackbox_model', BLACKBOX_DEFAULT_MODEL);
export const getBlackboxModelName = blackboxModel.get;
export const setBlackboxModelName = blackboxModel.set;

const azureModel = createModelNameStorage('azure_model', AZURE_DEFAULT_MODEL);
export const setAzureModelName = azureModel.set;

const bedrockModel = createModelNameStorage('bedrock_model', BEDROCK_DEFAULT_MODEL);
export const setBedrockModelName = bedrockModel.set;

const vertexModel = createModelNameStorage('vertex_model', VERTEX_DEFAULT_MODEL);
export const setVertexModelName = vertexModel.set;

const openAdapterModel = createModelNameStorage('openadapter_model', OPENADAPTER_DEFAULT_MODEL);
export const getOpenAdapterModelName = openAdapterModel.get;
export const setOpenAdapterModelName = openAdapterModel.set;

const kiloCodeModel = createModelNameStorage(
  'kilocode_model',
  KILOCODE_DEFAULT_MODEL,
  undefined,
  normalizeKilocodeModelName,
);
export const getKiloCodeModelName = kiloCodeModel.get;
export const setKiloCodeModelName = kiloCodeModel.set;

const anthropicModel = createModelNameStorage('anthropic_model', ANTHROPIC_DEFAULT_MODEL);
export const getAnthropicModelName = anthropicModel.get;
export const setAnthropicModelName = anthropicModel.set;

/** Runtime model-name getters for providers where the user can override the default. */
const MODEL_NAME_GETTERS: Partial<Record<AIProviderType, () => string>> = {
  ollama: getOllamaModelName,
  openrouter: getOpenRouterModelName,
  cloudflare: getCloudflareModelName,
  zen: getZenModelName,
  nvidia: getNvidiaModelName,
  blackbox: getBlackboxModelName,
  azure: getAzureModelName,
  bedrock: getBedrockModelName,
  vertex: getVertexModelName,
  kilocode: getKiloCodeModelName,
  openadapter: getOpenAdapterModelName,
  anthropic: getAnthropicModelName,
};

/** Return the current runtime model name for a provider, or undefined if unknown. */
export function getModelNameForProvider(provider: string): string | undefined {
  return (MODEL_NAME_GETTERS as Record<string, (() => string) | undefined>)[provider]?.();
}

export function getModelForRole(type: AIProviderType, role: AgentRole): AIModel | undefined {
  const provider = getProvider(type);
  const model = provider?.models.find((m) => m.role === role);
  if (!model) return undefined;

  const getter = MODEL_NAME_GETTERS[type];
  if (!getter) return model;

  const resolvedId = getter();
  return {
    ...model,
    id: resolvedId,
    capabilities: getModelCapabilities(type, resolvedId),
  };
}

// ---------------------------------------------------------------------------
// Provider preference — user picks which backend to use
// ---------------------------------------------------------------------------

const PREFERRED_PROVIDER_KEY = 'preferred_provider';

export type PreferredProvider =
  | 'ollama'
  | 'openrouter'
  | 'cloudflare'
  | 'zen'
  | 'nvidia'
  | 'blackbox'
  | 'azure'
  | 'bedrock'
  | 'vertex'
  | 'kilocode'
  | 'openadapter'
  | 'anthropic';

export function getPreferredProvider(): PreferredProvider | null {
  const stored = safeStorageGet(PREFERRED_PROVIDER_KEY);
  if (
    stored === 'ollama' ||
    stored === 'openrouter' ||
    stored === 'cloudflare' ||
    stored === 'zen' ||
    stored === 'nvidia' ||
    stored === 'blackbox' ||
    stored === 'azure' ||
    stored === 'bedrock' ||
    stored === 'vertex' ||
    stored === 'kilocode' ||
    stored === 'openadapter' ||
    stored === 'anthropic'
  )
    return stored;
  return null;
}

export function setPreferredProvider(provider: PreferredProvider): void {
  safeStorageSet(PREFERRED_PROVIDER_KEY, provider);
  setLastUsedProvider(provider);
}

export function clearPreferredProvider(): void {
  safeStorageRemove(PREFERRED_PROVIDER_KEY);
}

// ---------------------------------------------------------------------------
// Last-used provider — remembered by auto mode
// ---------------------------------------------------------------------------

const LAST_USED_PROVIDER_KEY = 'last_used_provider';

export function getLastUsedProvider(): PreferredProvider | null {
  const stored = safeStorageGet(LAST_USED_PROVIDER_KEY);
  if (
    stored === 'ollama' ||
    stored === 'openrouter' ||
    stored === 'cloudflare' ||
    stored === 'zen' ||
    stored === 'nvidia' ||
    stored === 'blackbox' ||
    stored === 'azure' ||
    stored === 'bedrock' ||
    stored === 'vertex' ||
    stored === 'kilocode' ||
    stored === 'openadapter' ||
    stored === 'anthropic'
  )
    return stored;
  return null;
}

export function setLastUsedProvider(provider: PreferredProvider): void {
  safeStorageSet(LAST_USED_PROVIDER_KEY, provider);
}
