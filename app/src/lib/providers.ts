import type { AIProviderType, AIProviderConfig, AIModel, AgentRole } from '@/types';

export const OLLAMA_DEFAULT_MODEL = 'kimi-k2.5:cloud';
export const MISTRAL_DEFAULT_MODEL = 'devstral-small-latest';

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
    name: 'Ollama Cloud',
    description: 'Ollama Cloud — run open models on cloud GPUs (OpenAI-compatible)',
    envKey: 'VITE_OLLAMA_API_KEY',
    envUrl: 'https://ollama.com',
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
    name: 'Mistral Vibe',
    description: 'Devstral via Mistral API (OpenAI-compatible)',
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
  return model;
}

// ---------------------------------------------------------------------------
// Ollama Cloud — runtime model name (stored in localStorage)
// ---------------------------------------------------------------------------

const OLLAMA_MODEL_KEY = 'ollama_model';

export function getOllamaModelName(): string {
  try {
    return localStorage.getItem(OLLAMA_MODEL_KEY) || OLLAMA_DEFAULT_MODEL;
  } catch {
    return OLLAMA_DEFAULT_MODEL;
  }
}

export function setOllamaModelName(model: string): void {
  localStorage.setItem(OLLAMA_MODEL_KEY, model.trim());
}

// ---------------------------------------------------------------------------
// Mistral Vibe — runtime model name (stored in localStorage)
// ---------------------------------------------------------------------------

const MISTRAL_MODEL_KEY = 'mistral_model';

export function getMistralModelName(): string {
  try {
    return localStorage.getItem(MISTRAL_MODEL_KEY) || MISTRAL_DEFAULT_MODEL;
  } catch {
    return MISTRAL_DEFAULT_MODEL;
  }
}

export function setMistralModelName(model: string): void {
  localStorage.setItem(MISTRAL_MODEL_KEY, model.trim());
}

// ---------------------------------------------------------------------------
// Provider preference — user picks which backend to use
// ---------------------------------------------------------------------------

const PREFERRED_PROVIDER_KEY = 'preferred_provider';

export type PreferredProvider = 'moonshot' | 'ollama' | 'mistral';

export function getPreferredProvider(): PreferredProvider | null {
  try {
    const stored = localStorage.getItem(PREFERRED_PROVIDER_KEY);
    if (stored === 'moonshot' || stored === 'ollama' || stored === 'mistral') return stored;
  } catch {
    // SSR / restricted context
  }
  return null;
}

export function setPreferredProvider(provider: PreferredProvider): void {
  localStorage.setItem(PREFERRED_PROVIDER_KEY, provider);
}

export function clearPreferredProvider(): void {
  localStorage.removeItem(PREFERRED_PROVIDER_KEY);
}
