import type { AIProviderType, AIProviderConfig, AIModel, AgentRole } from '@/types';
import {
  getAzureModelName,
  getBedrockModelName,
} from '@/hooks/useExperimentalProviderConfig';
import { getVertexModelName } from '@/hooks/useVertexConfig';
import { getModelCapabilities } from './model-capabilities';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from './safe-storage';
import { VERTEX_DEFAULT_MODEL as SHARED_VERTEX_DEFAULT_MODEL } from './vertex-provider';

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
  azure:      { chat: providerUrl('/api/azure/chat',                              '/api/azure/chat'),      models: providerUrl('/api/azure/models',                '/api/azure/models')      },
  bedrock:    { chat: providerUrl('/api/bedrock/chat',                            '/api/bedrock/chat'),    models: providerUrl('/api/bedrock/models',              '/api/bedrock/models')    },
  vertex:     { chat: providerUrl('/api/vertex/chat',                             '/api/vertex/chat'),     models: providerUrl('/api/vertex/models',               '/api/vertex/models')     },
  demo:       { chat: '',                                                                                models: ''                                                                        },
};

// Valid Ollama model names — these must exist on the Ollama server
export const OLLAMA_DEFAULT_MODEL = 'gemini-3-flash-preview';

// OpenRouter default model
export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6:nitro';
// OpenCode Zen (OpenAI-compatible) default model
export const ZEN_DEFAULT_MODEL = 'big-pickle';
// Nvidia NIM (OpenAI-compatible) default model
export const NVIDIA_DEFAULT_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct';
// Experimental direct-deployment defaults — only used as placeholders before the user
// configures a concrete deployment/model.
export const AZURE_DEFAULT_MODEL = 'gpt-4.1';
export const BEDROCK_DEFAULT_MODEL = 'anthropic.claude-3-7-sonnet-20250219-v1:0';
export const VERTEX_DEFAULT_MODEL = SHARED_VERTEX_DEFAULT_MODEL;

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

export const ZEN_GO_MODELS: string[] = [
  'glm-5',
  'kimi-k2.5',
  'minimax-m2.5',
];

export const ZEN_GO_URLS = {
  chat: providerUrl('/opencode/zen/go/v1/chat/completions', '/api/zen/go/chat'),
  models: providerUrl('/opencode/zen/go/v1/models', '/api/zen/go/models'),
};

export const NVIDIA_MODELS: string[] = [
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'meta/llama-3.3-70b-instruct',
  'meta/llama-3.1-405b-instruct',
  'deepseek-ai/deepseek-r1',
  'qwen/qwen2.5-coder-32b-instruct',
  'mistralai/mistral-large-2-instruct',
];

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
): { get: () => string; set: (model: string) => void } {
  return {
    get: () => safeStorageGet(storageKey) || defaultModel,
    set: (model: string) => {
      safeStorageSet(storageKey, model.trim());
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

const azureModel = createModelNameStorage('azure_model', AZURE_DEFAULT_MODEL);
export const setAzureModelName = azureModel.set;

const bedrockModel = createModelNameStorage('bedrock_model', BEDROCK_DEFAULT_MODEL);
export const setBedrockModelName = bedrockModel.set;

const vertexModel = createModelNameStorage('vertex_model', VERTEX_DEFAULT_MODEL);
export const setVertexModelName = vertexModel.set;

/** Runtime model-name getters for providers where the user can override the default. */
const MODEL_NAME_GETTERS: Partial<Record<AIProviderType, () => string>> = {
  ollama: getOllamaModelName,
  openrouter: getOpenRouterModelName,
  zen: getZenModelName,
  nvidia: getNvidiaModelName,
  azure: getAzureModelName,
  bedrock: getBedrockModelName,
  vertex: getVertexModelName,
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
  | 'azure'
  | 'bedrock'
  | 'vertex';

export function getPreferredProvider(): PreferredProvider | null {
  const stored = safeStorageGet(PREFERRED_PROVIDER_KEY);
  if (
    stored === 'ollama'
    || stored === 'openrouter'
    || stored === 'zen'
    || stored === 'nvidia'
    || stored === 'azure'
    || stored === 'bedrock'
    || stored === 'vertex'
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
    || stored === 'azure'
    || stored === 'bedrock'
    || stored === 'vertex'
  ) return stored;
  return null;
}

export function setLastUsedProvider(provider: PreferredProvider): void {
  safeStorageSet(LAST_USED_PROVIDER_KEY, provider);
}
