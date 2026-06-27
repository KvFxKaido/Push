import { GOOGLE_DEFAULT_MODEL } from '@/lib/providers';
import { createRegistryModelProviderConfig } from './useApiKeyConfig';

const providerConfig = createRegistryModelProviderConfig('google', {
  envVar: import.meta.env.VITE_GOOGLE_API_KEY,
  defaultModel: GOOGLE_DEFAULT_MODEL,
});

export const getGoogleKey = providerConfig.getKey;

export function useGoogleConfig() {
  return providerConfig.useConfig();
}
