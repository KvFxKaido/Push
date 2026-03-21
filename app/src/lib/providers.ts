import type { AIProviderType, AIProviderConfig, AIModel, AgentRole } from '@/types';
import {
  getAzureModelName,
  getBedrockModelName,
} from '@/hooks/useExperimentalProviderConfig';
import { getVertexModelName } from '@/hooks/useVertexConfig';
import { getModelCapabilities } from './model-capabilities';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from './safe-storage';
import { VERTEX_DEFAULT_MODEL as SHARED_VERTEX_DEFAULT_MODEL } from './vertex-provider';
import { ZEN_GO_MODELS as SHARED_ZEN_GO_MODELS } from './zen-go';

// ---------------------------------------------------------------------------
// Provider URL registry — single source of truth for dev/prod endpoints
// ---------------------------------------------------------------------------

/** Resolve a provider endpoint: dev uses Vite proxy paths, prod uses Worker paths. */
function providerUrl(devPath: string, prodPath: string): string {
  return import.meta.env.DEV ? devPath : prodPath;
}

export const PROVIDER_URLS: Record<AIProviderType, { chat: string; models: string }> = {
  ollama:     { chat: providerUrl('/ollama/v1/chat/completions',                '/api/ollama/chat'),     models: providerUrl('/ollama/v1/models',                '/api/ollama/models')     },
  openrouter: { chat: providerUrl('/openrouter/api/v1/chat/completions',    '/api/openrouter/chat'), models: providerUrl('/openrouter/api/v1/models',        '/api/openrouter/models') },
  zen:        { chat: providerUrl('/opencode/zen/v1/chat/completions',          '/api/zen/chat'),        models: providerUrl('/opencode/zen/v1/models',          '/api/zen/models')        },
  nvidia:     { chat: providerUrl('/nvidia/v1/chat/completions',                '/api/nvidia/chat'),     models: providerUrl('/nvidia/v1/models',                '/api/nvidia/models')     },
  blackbox:   { chat: providerUrl('/blackbox/chat/completions',                '/api/blackbox/chat'),   models: providerUrl('/blackbox/models',                 '/api/blackbox/models')   },
  azure:      { chat: providerUrl('/api/azure/chat',                              '/api/azure/chat'),      models: providerUrl('/api/azure/models',                '/api/azure/models')      },
  bedrock:    { chat: providerUrl('/api/bedrock/chat',                            '/api/bedrock/chat'),    models: providerUrl('/api/bedrock/models',              '/api/bedrock/models')    },
  vertex:     { chat: providerUrl('/api/vertex/chat',                             '/api/vertex/chat'),     models: providerUrl('/api/vertex/models',               '/api/vertex/models')     },
  demo:       { chat: '',                                                                                models: ''                                                                        },
  kilocode:   { chat: providerUrl('/api/kilocode/chat',                          '/api/kilocode/chat'),   models: providerUrl('/api/kilocode/models',                '/api/kilocode/models')   },
};

// Valid Ollama model names — these must exist on the Ollama server
export const OLLAMA_DEFAULT_MODEL = 'gemini-3-flash-preview';

// OpenRouter default model
export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6:nitro';
// OpenCode Zen (OpenAI-compatible) default model
export const ZEN_DEFAULT_MODEL = 'big-pickle';
// Nvidia NIM (OpenAI-compatible) default model
export const NVIDIA_DEFAULT_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct';
// Blackbox AI (OpenAI-compatible) default model
export const BLACKBOX_DEFAULT_MODEL = 'blackbox-ai';
// Experimental direct-deployment defaults — only used as placeholders before the user
// configures a concrete deployment/model.
export const AZURE_DEFAULT_MODEL = 'gpt-4.1';
export const BEDROCK_DEFAULT_MODEL = 'anthropic.claude-3-7-sonnet-20250219-v1:0';
export const VERTEX_DEFAULT_MODEL = SHARED_VERTEX_DEFAULT_MODEL;
export const KILOCODE_DEFAULT_MODEL = 'google/gemini-3-flash-preview';

export const OPENROUTER_MODELS: string[] = [
  'anthropic/claude-haiku-4.5:nitro',
  'anthropic/claude-opus-4.6:nitro',
  'anthropic/claude-sonnet-4.6:nitro',
  'arcee-ai/virtuoso-large',
  'cohere/command-a',
  'deepseek/deepseek-r1',
  'deepseek/deepseek-v3.2:nitro',
  'google/gemini-2.5-flash:nitro',
  'google/gemini-2.5-pro:nitro',
  'google/gemini-3-flash-preview:nitro',
  'google/gemini-3.1-flash-lite-preview:nitro',
  'google/gemini-3.1-pro-preview:nitro',
  'google/gemini-3.1-pro-preview-customtools:nitro',
  'meta-llama/llama-4-maverick',
  'minimax/minimax-m2.5',
  'mistralai/codestral-2508',
  'mistralai/devstral-2512',
  'mistralai/mistral-large-2512',
  'moonshotai/kimi-k2.5:nitro',
  'openai/gpt-5-mini',
  'openai/gpt-5.2-codex',
  'openai/gpt-5.3-codex',
  'openai/gpt-5.4',
  'openai/gpt-5.4-pro',
  'xiaomi/mimo-v2-omni',
  'xiaomi/mimo-v2-pro',
  'perplexity/sonar-pro',
  'qwen/qwen3-coder-flash',
  'qwen/qwen3-coder-plus',
  'qwen/qwen3.5-397b-a17b:nitro',
  'stepfun/step-3.5-flash',
  'x-ai/grok-4.1-fast',
  'x-ai/grok-4.20-beta',
  'z-ai/glm-4.7:nitro',
  'z-ai/glm-5:nitro',
  'z-ai/glm-5-turbo:nitro',
];

export const ZEN_MODELS: string[] = [
  'openai/gpt-5.3-codex',
  'openai/gpt-5.2-codex',
  'qwen3-coder',
  'gemini-3-flash',
  'gemini-3-pro',
  'kimi-k2.5',
  'kimi-k2.5-free',
  'minimax-m2.5-free',
  'big-pickle',
];

export const ZEN_GO_MODELS: string[] = [...SHARED_ZEN_GO_MODELS];

export const ZEN_GO_URLS = {
  chat: providerUrl('/opencode/zen/go/v1/chat/completions', '/api/zen/go/chat'),
};

export const NVIDIA_MODELS: string[] = [
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'meta/llama-3.3-70b-instruct',
  'meta/llama-3.1-405b-instruct',
  'deepseek-ai/deepseek-r1',
  'qwen/qwen2.5-coder-32b-instruct',
  'mistralai/mistral-large-2-instruct',
];

export const BLACKBOX_MODELS: string[] = [
  'blackbox-ai',
  'blackbox-pro',
  'blackbox-search',
];

export const KILOCODE_MODELS: string[] = [
  'google/gemini-3-flash-preview',
  'anthropic/claude-sonnet-4.6',
  'openai/gpt-5.2',
  'moonshotai/kimi-k2.5',
  'kilo-auto/balanced',
];

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

export function getModelDisplayGroupKey(provider: AIProviderType | string, modelId: string): string {
  const normalized = normalizeProviderModelId(provider, modelId);
  const slash = normalized.indexOf('/');
  if (slash > 0) return normalized.slice(0, slash);
  if (provider === 'blackbox' && normalized) return 'blackbox';
  return '';
}

export function getModelDisplayGroupLabel(groupKey: string): string {
  return MODEL_ROUTE_PROVIDER_LABELS[groupKey] || groupKey;
}

export function getModelDisplayLeafName(provider: AIProviderType | string, modelId: string): string {
  const normalized = normalizeProviderModelId(provider, modelId);
  const slash = normalized.indexOf('/');
  return slash > 0 ? normalized.slice(slash + 1) : normalized;
}

export function formatModelDisplayName(provider: AIProviderType | string, modelId: string): string {
  const normalized = normalizeProviderModelId(provider, modelId);
  const groupKey = getModelDisplayGroupKey(provider, modelId);
  const slash = normalized.indexOf('/');
  if (slash <= 0) return normalized;
  return `${getModelDisplayGroupLabel(groupKey)} / ${normalized.slice(slash + 1)}`;
}

export function compareProviderModelIds(
  provider: AIProviderType | string,
  left: string,
  right: string,
): number {
  const leftGroup = getModelDisplayGroupLabel(getModelDisplayGroupKey(provider, left));
  const rightGroup = getModelDisplayGroupLabel(getModelDisplayGroupKey(provider, right));
  const groupDiff = leftGroup.localeCompare(rightGroup, undefined, { numeric: true, sensitivity: 'base' });
  if (groupDiff !== 0) return groupDiff;

  const leafDiff = getModelDisplayLeafName(provider, left)
    .localeCompare(getModelDisplayLeafName(provider, right), undefined, { numeric: true, sensitivity: 'base' });
  if (leafDiff !== 0) return leafDiff;

  return normalizeProviderModelId(provider, left)
    .localeCompare(normalizeProviderModelId(provider, right), undefined, { numeric: true, sensitivity: 'base' });
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
    description: 'OpenRouter — Access 50+ models including Claude, GPT-4, Gemini, with optional BYOK routing via your OpenRouter account',
    envKey: 'VITE_OPENROUTER_API_KEY',
    envUrl: 'https://openrouter.ai',
    models: makeRoleModels(OPENROUTER_DEFAULT_MODEL, 'OpenRouter', 'openrouter', 200_000),
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
    type: 'azure',
    name: 'Azure OpenAI',
    description: 'Experimental private connector for direct Azure OpenAI and Azure AI Foundry deployments',
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
    description: 'Experimental private connector for Google Vertex using service-account auth with Gemini OpenAPI and Claude partner-model routing',
    envKey: 'VITE_VERTEX_SERVICE_ACCOUNT_JSON',
    envUrl: 'global',
    models: makeRoleModels(VERTEX_DEFAULT_MODEL, 'Google Vertex', 'vertex', 1_000_000),
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

const kiloCodeModel = createModelNameStorage(
  'kilocode_model',
  KILOCODE_DEFAULT_MODEL,
  undefined,
  normalizeKilocodeModelName,
);
export const getKiloCodeModelName = kiloCodeModel.get;
export const setKiloCodeModelName = kiloCodeModel.set;

/** Runtime model-name getters for providers where the user can override the default. */
const MODEL_NAME_GETTERS: Partial<Record<AIProviderType, () => string>> = {
  ollama: getOllamaModelName,
  openrouter: getOpenRouterModelName,
  zen: getZenModelName,
  nvidia: getNvidiaModelName,
  blackbox: getBlackboxModelName,
  azure: getAzureModelName,
  bedrock: getBedrockModelName,
  vertex: getVertexModelName,
  kilocode: getKiloCodeModelName,
};

/** Return the current runtime model name for a provider, or undefined if unknown. */
export function getModelNameForProvider(provider: string): string | undefined {
  return (MODEL_NAME_GETTERS as Record<string, (() => string) | undefined>)[provider]?.();
}

export function getModelForRole(
  type: AIProviderType,
  role: AgentRole,
): AIModel | undefined {
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
  | 'zen'
  | 'nvidia'
  | 'blackbox'
  | 'azure'
  | 'bedrock'
  | 'vertex'
  | 'kilocode';

export function getPreferredProvider(): PreferredProvider | null {
  const stored = safeStorageGet(PREFERRED_PROVIDER_KEY);
  if (
    stored === 'ollama'
    || stored === 'openrouter'
    || stored === 'zen'
    || stored === 'nvidia'
    || stored === 'blackbox'
    || stored === 'azure'
    || stored === 'bedrock'
    || stored === 'vertex'
    || stored === 'kilocode'
  ) return stored;
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
    stored === 'ollama'
    || stored === 'openrouter'
    || stored === 'zen'
    || stored === 'nvidia'
    || stored === 'blackbox'
    || stored === 'azure'
    || stored === 'bedrock'
    || stored === 'vertex'
    || stored === 'kilocode'
  ) return stored;
  return null;
}

export function setLastUsedProvider(provider: PreferredProvider): void {
  safeStorageSet(LAST_USED_PROVIDER_KEY, provider);
}
