import { BLACKBOX_DEFAULT_MODEL } from '@/lib/providers';
import { createRegistryModelProviderConfig } from './useApiKeyConfig';

const providerConfig = createRegistryModelProviderConfig('blackbox', {
  envVar: import.meta.env.VITE_BLACKBOX_API_KEY,
  defaultModel: BLACKBOX_DEFAULT_MODEL,
});

export const getBlackboxKey = providerConfig.getKey;

export function useBlackboxConfig() {
  return providerConfig.useConfig();
}
