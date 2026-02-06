import type { AIProviderType, AIProviderConfig, AIModel, AgentRole } from '@/types';

export const OLLAMA_DEFAULT_MODEL = 'qwen2.5-coder';

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
