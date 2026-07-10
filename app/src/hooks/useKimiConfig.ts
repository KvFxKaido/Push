import { KIMI_DEFAULT_MODEL } from '@/lib/providers';
import { createRegistryModelProviderConfig } from './useApiKeyConfig';

const providerConfig = createRegistryModelProviderConfig('kimi', {
  envVar: import.meta.env.VITE_KIMI_API_KEY,
  defaultModel: KIMI_DEFAULT_MODEL,
});

export const getKimiKey = providerConfig.getKey;

export function useKimiConfig() {
  return providerConfig.useConfig();
}
