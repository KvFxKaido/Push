import { OPENROUTER_DEFAULT_MODEL } from '@/lib/providers';
import { createRegistryModelProviderConfig } from './useApiKeyConfig';

const providerConfig = createRegistryModelProviderConfig('openrouter', {
  envVar: import.meta.env.VITE_OPENROUTER_API_KEY,
  defaultModel: OPENROUTER_DEFAULT_MODEL,
});

export const getOpenRouterKey = providerConfig.getKey;

export function useOpenRouterConfig() {
  return providerConfig.useConfig();
}
