import { KILOCODE_DEFAULT_MODEL, normalizeKilocodeModelName } from '@/lib/providers';
import { createRegistryModelProviderConfig } from './useApiKeyConfig';

const providerConfig = createRegistryModelProviderConfig('kilocode', {
  envVar: import.meta.env.VITE_KILOCODE_API_KEY,
  defaultModel: KILOCODE_DEFAULT_MODEL,
  normalizeModel: normalizeKilocodeModelName,
});

export const getKilocodeKey = providerConfig.getKey;

export function useKilocodeConfig() {
  return providerConfig.useConfig();
}
