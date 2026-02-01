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
      {
        id: 'z-ai/glm-4.5-air:free',
        name: 'GLM 4.5 Air (Coder)',
        provider: 'openrouter',
        role: 'coder',
        context: 128_000,
      },
      {
        id: 'tngtech/deepseek-r1t-chimera:free',
        name: 'DeepSeek R1T Chimera (Auditor)',
        provider: 'openrouter',
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

export async function analyzePR(
  prData: PRData,
  _providerType: AIProviderType,
  modelId?: string,
): Promise<AnalysisResult> {
  return analyzePRWithOllamaCloud(prData, modelId || 'tngtech/deepseek-r1t-chimera:free');
}
