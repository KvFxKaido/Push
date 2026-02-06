import type { AIProviderType, AIProviderConfig, AIModel, AgentRole } from '@/types';

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
    type: 'ollama-cloud',
    name: 'Ollama Cloud',
    description: 'Run large models on Ollama\'s cloud infrastructure',
    envKey: 'VITE_OLLAMA_API_KEY',
    baseUrl: '/api/ollama/chat',
    models: [
      {
        id: 'llama4:maverick-cloud',
        name: 'Llama 4 Maverick',
        provider: 'ollama-cloud',
        role: 'orchestrator',
        context: 128_000,
      },
      {
        id: 'llama4:maverick-cloud',
        name: 'Llama 4 Maverick',
        provider: 'ollama-cloud',
        role: 'coder',
        context: 128_000,
      },
      {
        id: 'llama4:maverick-cloud',
        name: 'Llama 4 Maverick',
        provider: 'ollama-cloud',
        role: 'auditor',
        context: 128_000,
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
  return provider?.models.find((m) => m.role === role);
}
