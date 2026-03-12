import type { AIProviderType } from '@/types';

export const PROVIDER_LABELS: Record<AIProviderType, string> = {
  ollama: 'Ollama',
  openrouter: 'OpenRouter',
  zen: 'OpenCode Zen',
  nvidia: 'Nvidia NIM',
  azure: 'Azure OpenAI',
  bedrock: 'AWS Bedrock',
  vertex: 'Google Vertex',
  demo: 'Demo',
};
