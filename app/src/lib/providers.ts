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

// ---------------------------------------------------------------------------
// Provider preference — user picks which backend to use
// ---------------------------------------------------------------------------

const PREFERRED_PROVIDER_KEY = 'preferred_provider';

export type PreferredProvider = 'moonshot' | 'ollama' | 'mistral' | 'zai';

export function getPreferredProvider(): PreferredProvider | null {
  const stored = safeStorageGet(PREFERRED_PROVIDER_KEY);
  if (stored === 'moonshot' || stored === 'ollama' || stored === 'mistral' || stored === 'zai') return stored;
  return null;
}

export function setPreferredProvider(provider: PreferredProvider): void {
  safeStorageSet(PREFERRED_PROVIDER_KEY, provider);
}

export function clearPreferredProvider(): void {
  safeStorageRemove(PREFERRED_PROVIDER_KEY);
}
