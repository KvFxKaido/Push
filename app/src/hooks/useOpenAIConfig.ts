import { OPENAI_DEFAULT_MODEL } from '@/lib/providers';
import { createRegistryModelProviderConfig } from './useApiKeyConfig';

const providerConfig = createRegistryModelProviderConfig('openai', {
  envVar: import.meta.env.VITE_OPENAI_API_KEY,
  defaultModel: OPENAI_DEFAULT_MODEL,
});

export const getOpenAIKey = providerConfig.getKey;

export function useOpenAIConfig() {
  return providerConfig.useConfig();
}
