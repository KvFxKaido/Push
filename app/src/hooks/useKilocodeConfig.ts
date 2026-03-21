import { KILOCODE_DEFAULT_MODEL, normalizeKilocodeModelName } from '@/lib/providers';
import { createModelProviderConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'kilocode_api_key';
const MODEL_STORAGE = 'kilocode_model';

const providerConfig = createModelProviderConfig({
  storageKey: KEY_STORAGE,
  modelStorageKey: MODEL_STORAGE,
  envVar: import.meta.env.VITE_KILOCODE_API_KEY,
  defaultModel: KILOCODE_DEFAULT_MODEL,
  normalizeModel: normalizeKilocodeModelName,
});

export const getKilocodeKey = providerConfig.getKey;

export function useKilocodeConfig() {
  return providerConfig.useConfig();
}
