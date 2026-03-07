import type { AIProviderType, AIProviderConfig, AIModel, AgentRole } from '@/types';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from './safe-storage';

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
  demo:       { chat: '',                                                                                models: ''                                                                        },
};

// Valid Ollama model names — these must exist on the Ollama server
export const OLLAMA_DEFAULT_MODEL = 'gemini-3-flash-preview';

// OpenRouter default model — Claude Sonnet 4.6
export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';
// OpenCode Zen (OpenAI-compatible) default model
export const ZEN_DEFAULT_MODEL = 'big-pickle';
// Nvidia NIM (OpenAI-compatible) default model
export const NVIDIA_DEFAULT_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct';

export const OPENROUTER_MODELS: string[] = [
  // Claude 4 series
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-opus-4.6',
  'anthropic/claude-haiku-4.5',
  // OpenAI GPT-5.4
  'openai/gpt-5.4-pro',
  'openai/gpt-5.4',
  // OpenAI Codex
  'openai/gpt-5.2-codex',
  'openai/gpt-5.3-codex',
  // Free model picks
  'stepfun/step-3.5-flash:free',
  // Google Gemini
  'google/gemini-3.1-pro-preview',
  'google/gemini-3-flash-preview',
  // Mistral
  'mistralai/devstral-small-latest',
  'mistralai/mistral-large-latest',
  // MiniMax
  'minimax/minimax-m2.5',
  'minimax/minimax-m2.1',
  // Z.AI (GLM)
  'zhipu/glm-4.7',
  'zhipu/glm-5.0',
  // Others
  'x-ai/grok-4.1-fast',
  'moonshotai/kimi-k2.5',
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

export const NVIDIA_MODELS: string[] = [
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'meta/llama-3.3-70b-instruct',
  'meta/llama-3.1-405b-instruct',
  'deepseek-ai/deepseek-r1',
  'qwen/qwen2.5-coder-32b-instruct',
  'mistralai/mistral-large-2-instruct',
];

/** Build the standard orchestrator/coder/auditor model triple for a provider. */
function makeRoleModels(
  id: string,
  displayName: string,
  provider: AIProviderType,
  context: number,
): AIModel[] {
  return (['orchestrator', 'coder', 'auditor'] as const).map((role) => ({
    id,
    name: `${displayName} (${role.charAt(0).toUpperCase() + role.slice(1)})`,
    provider,
    role,
    context,
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
    description: 'OpenRouter — Access 50+ models including Claude, GPT-4, Gemini (OpenAI-compatible)',
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

const nvidiaModel = createModelNameStorage('nvidia_model', NVIDIA_DEFAULT_MODEL);
export const getNvidiaModelName = nvidiaModel.get;
export const setNvidiaModelName = nvidiaModel.set;

/** Runtime model-name getters for providers where the user can override the default. */
const MODEL_NAME_GETTERS: Partial<Record<AIProviderType, () => string>> = {
  ollama: getOllamaModelName,
  openrouter: getOpenRouterModelName,
  zen: getZenModelName,
  nvidia: getNvidiaModelName,
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
  return getter ? { ...model, id: getter() } : model;
}

// ---------------------------------------------------------------------------
// Provider preference — user picks which backend to use
// ---------------------------------------------------------------------------

const PREFERRED_PROVIDER_KEY = 'preferred_provider';

export type PreferredProvider = 'ollama' | 'openrouter' | 'zen' | 'nvidia';

export function getPreferredProvider(): PreferredProvider | null {
  const stored = safeStorageGet(PREFERRED_PROVIDER_KEY);
  if (stored === 'ollama' || stored === 'openrouter' || stored === 'zen' || stored === 'nvidia') return stored;
  return null;
}

export function setPreferredProvider(provider: PreferredProvider): void {
  safeStorageSet(PREFERRED_PROVIDER_KEY, provider);
}

export function clearPreferredProvider(): void {
  safeStorageRemove(PREFERRED_PROVIDER_KEY);
}
