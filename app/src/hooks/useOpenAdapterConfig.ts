import { OPENADAPTER_DEFAULT_MODEL } from '@/lib/providers';
import { createRegistryModelProviderConfig } from './useApiKeyConfig';

const providerConfig = createRegistryModelProviderConfig('openadapter', {
  envVar: import.meta.env.VITE_OPENADAPTER_API_KEY,
  defaultModel: OPENADAPTER_DEFAULT_MODEL,
});

export const getOpenAdapterKey = providerConfig.getKey;

export function useOpenAdapterConfig() {
  return providerConfig.useConfig();
}
