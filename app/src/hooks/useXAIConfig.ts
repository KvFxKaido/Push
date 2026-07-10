import { XAI_DEFAULT_MODEL } from '@/lib/providers';
import { createRegistryModelProviderConfig } from './useApiKeyConfig';

const providerConfig = createRegistryModelProviderConfig('xai', {
  envVar: import.meta.env.VITE_XAI_API_KEY,
  defaultModel: XAI_DEFAULT_MODEL,
});

export const getXAIKey = providerConfig.getKey;

export function useXAIConfig() {
  return providerConfig.useConfig();
}
