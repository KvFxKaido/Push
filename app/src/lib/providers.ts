import type { AIProviderType, AIProviderConfig, AIModel, AgentRole, PRData, AnalysisResult } from '@/types';
import { analyzePRWithOllamaCloud } from '@/lib/ollama';

export const PROVIDERS: AIProviderConfig[] = [
  {
    type: 'ollama-cloud',
    name: 'Ollama Cloud',
    description: 'Role-based agent models via Ollama Cloud',
    envKey: 'VITE_OLLAMA_CLOUD_API_KEY',
    envUrl: 'VITE_OLLAMA_CLOUD_API_URL',
    models: [
      {
        id: 'kimi-k2.5:cloud',
        name: 'Kimi K2.5 (Orchestrator)',
        provider: 'ollama-cloud',
        role: 'orchestrator',
        context: 256_000,
      },
    ],
  },
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

export async function analyzePR(
  prData: PRData,
  _providerType: AIProviderType,
  modelId?: string,
): Promise<AnalysisResult> {
  return analyzePRWithOllamaCloud(prData, modelId || 'k2p5');
}
