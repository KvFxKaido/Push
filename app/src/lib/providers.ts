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
        id: 'gemini-3-pro-preview:latest',
        name: 'Gemini 3 Pro (Auditor)',
        provider: 'ollama-cloud',
        role: 'auditor',
        context: 1_000_000,
      },
      {
        id: 'kimi-k2.5:cloud',
        name: 'Kimi K2.5 (Orchestrator)',
        provider: 'ollama-cloud',
        role: 'orchestrator',
        context: 256_000,
      },
      {
        id: 'glm-4.7:cloud',
        name: 'GLM 4.7 (Coder)',
        provider: 'ollama-cloud',
        role: 'coder',
        context: 198_000,
      },
    ],
  },
  {
    type: 'openrouter',
    name: 'OpenRouter',
    description: 'OpenAI-compatible API with access to multiple models',
    envKey: 'VITE_OPENROUTER_API_KEY',
    models: [
      {
        id: 'nvidia/nemotron-3-nano-30b-a3b:free',
        name: 'Nemotron Nano 30B (Free)',
        provider: 'openrouter',
        role: 'orchestrator',
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
  return provider?.models.find((m) => m.role === role);
}

export async function analyzePR(
  prData: PRData,
  _providerType: AIProviderType,
  modelId?: string,
): Promise<AnalysisResult> {
  return analyzePRWithOllamaCloud(prData, modelId || 'gemini-3-pro-preview:latest');
}
