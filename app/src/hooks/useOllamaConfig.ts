import { OLLAMA_DEFAULT_MODEL } from '@/lib/providers';
import { createRegistryModelProviderConfig } from './useApiKeyConfig';

const providerConfig = createRegistryModelProviderConfig('ollama', {
  envVar: import.meta.env.VITE_OLLAMA_API_KEY,
  defaultModel: OLLAMA_DEFAULT_MODEL,
});

export const getOllamaKey = providerConfig.getKey;

export function useOllamaConfig() {
  return providerConfig.useConfig();
}
