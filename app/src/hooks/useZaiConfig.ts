import { ZAI_DEFAULT_MODEL } from '@/lib/providers';
import { createRegistryModelProviderConfig } from './useApiKeyConfig';

const providerConfig = createRegistryModelProviderConfig('zai', {
  envVar: import.meta.env.VITE_ZAI_API_KEY,
  defaultModel: ZAI_DEFAULT_MODEL,
});

export const getZaiKey = providerConfig.getKey;

export function useZaiConfig() {
  return providerConfig.useConfig();
}
