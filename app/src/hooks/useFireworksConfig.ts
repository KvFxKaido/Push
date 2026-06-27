import { FIREWORKS_DEFAULT_MODEL, normalizeFireworksModelName } from '@/lib/providers';
import { createRegistryModelProviderConfig } from './useApiKeyConfig';

const providerConfig = createRegistryModelProviderConfig('fireworks', {
  envVar: import.meta.env.VITE_FIREWORKS_API_KEY,
  defaultModel: FIREWORKS_DEFAULT_MODEL,
  normalizeModel: normalizeFireworksModelName,
});

export const getFireworksKey = providerConfig.getKey;

export function useFireworksConfig() {
  return providerConfig.useConfig();
}
