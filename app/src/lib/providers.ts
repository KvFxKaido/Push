import type { AIProviderType, AIProviderConfig, AIModel, AgentRole } from '@/types';
import { resetMistralAgent } from './orchestrator';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from './safe-storage';

// Valid Ollama model names — these must exist on the Ollama server
export const OLLAMA_DEFAULT_MODEL = 'gemini-3-flash-preview';

// Valid Mistral model names via Mistral API
export const MISTRAL_DEFAULT_MODEL = 'devstral-small-latest';
export const ZAI_DEFAULT_MODEL = 'glm-4.5';

export const ZAI_MODELS: string[] = [
  'glm-4.5',
  'glm-4.5-flash',
  'glm-4.6',
  'glm-4.7',
  'glm-4.7-flash',
  'glm-5',
];

export const MINIMAX_DEFAULT_MODEL = 'MiniMax-M2.5';

export const MINIMAX_MODELS: string[] = [
  'MiniMax-M2.5',
  'MiniMax-M2.5-highspeed',
  'MiniMax-M2.1',
  'MiniMax-M2.1-highspeed',
  'MiniMax-M2',
];

// OpenRouter default model — Claude Sonnet 4.5
export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';

export const OPENROUTER_MODELS: string[] = [
  // Claude 4 series
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-opus-4.6',
  'anthropic/claude-haiku-4.5',
  // OpenAI GPT-5 & o1
  'openai/gpt-5.2',
  'openai/gpt-5-mini',
  'openai/o1',
  // OpenAI Codex
  'openai/gpt-5.3-codex',
  'openai/gpt-5.2-codex',
  'openai/gpt-5.1-codex',
  // Google Gemini
  'google/gemini-3-flash-preview',
  'google/gemini-3-pro-preview',
  // Others
  'x-ai/grok-4.1-fast',
  'moonshotai/kimi-k2.5',
  'z-ai/glm-5',
  'minimax/minimax-m2.5',
];

export const PROVIDERS: AIProviderConfig[] = [
  {
    type: 'moonshot',
    name: 'Kimi For Coding',
    description: 'Kimi K2.5 via Kimi For Coding API (OpenAI-compatible)',
    envKey: 'VITE_MOONSHOT_API_KEY',
    models: [
      {
        id: 'k2p5',
        name: 'Kimi K2.5 (Orchestrator)',
        provider: 'moonshot',
        role: 'orchestrator',
        context: 262_144,
      },
      {
        id: 'k2p5',
        name: 'Kimi K2.5 (Coder)',
        provider: 'moonshot',
        role: 'coder',
        context: 262_144,
      },
      {
        id: 'k2p5',
        name: 'Kimi K2.5 (Auditor)',
        provider: 'moonshot',
        role: 'auditor',
        context: 262_144,
      },
    ],
  },
  {
    type: 'ollama',
    name: 'Ollama',
    description: 'Ollama — run open models locally or on cloud GPUs (OpenAI-compatible)',
    envKey: 'VITE_OLLAMA_API_KEY',
    envUrl: 'http://localhost:11434',
    models: [
      {
        id: OLLAMA_DEFAULT_MODEL,
        name: 'Ollama (Orchestrator)',
        provider: 'ollama',
        role: 'orchestrator',
        context: 131_072,
      },
      {
        id: OLLAMA_DEFAULT_MODEL,
        name: 'Ollama (Coder)',
        provider: 'ollama',
        role: 'coder',
        context: 131_072,
      },
      {
        id: OLLAMA_DEFAULT_MODEL,
        name: 'Ollama (Auditor)',
        provider: 'ollama',
        role: 'auditor',
        context: 131_072,
      },
    ],
  },
  {
    type: 'mistral',
    name: 'Mistral',
    description: 'Mistral AI API — Devstral and other models (OpenAI-compatible)',
    envKey: 'VITE_MISTRAL_API_KEY',
    envUrl: 'https://console.mistral.ai',
    models: [
      {
        id: MISTRAL_DEFAULT_MODEL,
        name: 'Devstral (Orchestrator)',
        provider: 'mistral',
        role: 'orchestrator',
        context: 262_144,
      },
      {
        id: MISTRAL_DEFAULT_MODEL,
        name: 'Devstral (Coder)',
        provider: 'mistral',
        role: 'coder',
        context: 262_144,
      },
      {
        id: MISTRAL_DEFAULT_MODEL,
        name: 'Devstral (Auditor)',
        provider: 'mistral',
        role: 'auditor',
        context: 262_144,
      },
    ],
  },
  {
    type: 'zai',
    name: 'Z.ai',
    description: 'Z.ai API — GLM models (OpenAI-compatible)',
    envKey: 'VITE_ZAI_API_KEY',
    envUrl: 'https://platform.z.ai',
    models: [
      {
        id: ZAI_DEFAULT_MODEL,
        name: 'GLM 4.5 (Orchestrator)',
        provider: 'zai',
        role: 'orchestrator',
        context: 131_072,
      },
      {
        id: ZAI_DEFAULT_MODEL,
        name: 'GLM 4.5 (Coder)',
        provider: 'zai',
        role: 'coder',
        context: 131_072,
      },
      {
        id: ZAI_DEFAULT_MODEL,
        name: 'GLM 4.5 (Auditor)',
        provider: 'zai',
        role: 'auditor',
        context: 131_072,
      },
    ],
  },
  {
    type: 'minimax',
    name: 'MiniMax',
    description: 'MiniMax API — M2.5 and other models (OpenAI-compatible)',
    envKey: 'VITE_MINIMAX_API_KEY',
    envUrl: 'https://platform.minimax.io',
    models: [
      {
        id: MINIMAX_DEFAULT_MODEL,
        name: 'MiniMax M2.5 (Orchestrator)',
        provider: 'minimax',
        role: 'orchestrator',
        context: 200_000,
      },
      {
        id: MINIMAX_DEFAULT_MODEL,
        name: 'MiniMax M2.5 (Coder)',
        provider: 'minimax',
        role: 'coder',
        context: 200_000,
      },
      {
        id: MINIMAX_DEFAULT_MODEL,
        name: 'MiniMax M2.5 (Auditor)',
        provider: 'minimax',
        role: 'auditor',
        context: 200_000,
      },
    ],
  },
  {
    type: 'openrouter',
    name: 'OpenRouter',
    description: 'OpenRouter — Access 50+ models including Claude, GPT-4, Gemini (OpenAI-compatible)',
    envKey: 'VITE_OPENROUTER_API_KEY',
    envUrl: 'https://openrouter.ai',
    models: [
      {
        id: OPENROUTER_DEFAULT_MODEL,
        name: 'OpenRouter (Orchestrator)',
        provider: 'openrouter',
        role: 'orchestrator',
        context: 200_000,
      },
      {
        id: OPENROUTER_DEFAULT_MODEL,
        name: 'OpenRouter (Coder)',
        provider: 'openrouter',
        role: 'coder',
        context: 200_000,
      },
      {
        id: OPENROUTER_DEFAULT_MODEL,
        name: 'OpenRouter (Auditor)',
        provider: 'openrouter',
        role: 'auditor',
        context: 200_000,
      },
    ],
  },
];

export function getProvider(type: AIProviderType): AIProviderConfig | undefined {
  return PROVIDERS.find((p) => p.type === type);
}

export function getDefaultModel(type: AIProviderType): AIModel | undefined {
  const provider = getProvider(type);
  return provider?.models[0];
}

export function getModelForRole(
  type: AIProviderType,
  role: AgentRole,
): AIModel | undefined {
  const provider = getProvider(type);
  const model = provider?.models.find((m) => m.role === role);
  if (!model) return undefined;

  // For Ollama, overlay the user-selected model name at runtime
  if (type === 'ollama') {
    const userModel = getOllamaModelName();
    return { ...model, id: userModel };
  }
  // For Mistral, overlay the user-selected model name at runtime
  if (type === 'mistral') {
    const userModel = getMistralModelName();
    return { ...model, id: userModel };
  }
  if (type === 'zai') {
    const userModel = getZaiModelName();
    return { ...model, id: userModel };
  }
  if (type === 'minimax') {
    const userModel = getMiniMaxModelName();
    return { ...model, id: userModel };
  }
  if (type === 'openrouter') {
    const userModel = getOpenRouterModelName();
    return { ...model, id: userModel };
  }
  return model;
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

const mistralModel = createModelNameStorage('mistral_model', MISTRAL_DEFAULT_MODEL, () => resetMistralAgent());
export const getMistralModelName = mistralModel.get;
export const setMistralModelName = mistralModel.set;

const zaiModel = createModelNameStorage('zai_model', ZAI_DEFAULT_MODEL);
export const getZaiModelName = zaiModel.get;
export const setZaiModelName = zaiModel.set;

const miniMaxModel = createModelNameStorage('minimax_model', MINIMAX_DEFAULT_MODEL);
export const getMiniMaxModelName = miniMaxModel.get;
export const setMiniMaxModelName = miniMaxModel.set;

const openRouterModel = createModelNameStorage('openrouter_model', OPENROUTER_DEFAULT_MODEL);
export const getOpenRouterModelName = openRouterModel.get;
export const setOpenRouterModelName = openRouterModel.set;

// ---------------------------------------------------------------------------
// Provider preference — user picks which backend to use
// ---------------------------------------------------------------------------

const PREFERRED_PROVIDER_KEY = 'preferred_provider';

export type PreferredProvider = 'moonshot' | 'ollama' | 'mistral' | 'zai' | 'minimax' | 'openrouter';

export function getPreferredProvider(): PreferredProvider | null {
  const stored = safeStorageGet(PREFERRED_PROVIDER_KEY);
  if (stored === 'moonshot' || stored === 'ollama' || stored === 'mistral' || stored === 'zai' || stored === 'minimax' || stored === 'openrouter') return stored;
  return null;
}

export function setPreferredProvider(provider: PreferredProvider): void {
  safeStorageSet(PREFERRED_PROVIDER_KEY, provider);
}

export function clearPreferredProvider(): void {
  safeStorageRemove(PREFERRED_PROVIDER_KEY);
}
