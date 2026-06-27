import { SAKANA_DEFAULT_MODEL, normalizeSakanaModelName } from '@/lib/providers';
import { createRegistryModelProviderConfig } from './useApiKeyConfig';

const providerConfig = createRegistryModelProviderConfig('sakana', {
  envVar: import.meta.env.VITE_SAKANA_API_KEY,
  defaultModel: SAKANA_DEFAULT_MODEL,
  normalizeModel: normalizeSakanaModelName,
});

export const getSakanaKey = providerConfig.getKey;

export function useSakanaConfig() {
  return providerConfig.useConfig();
}
