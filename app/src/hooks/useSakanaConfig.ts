import { SAKANA_DEFAULT_MODEL, normalizeSakanaModelName } from '@/lib/providers';
import { createModelProviderConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'sakana_api_key';
const MODEL_STORAGE = 'sakana_model';

const providerConfig = createModelProviderConfig({
  storageKey: KEY_STORAGE,
  modelStorageKey: MODEL_STORAGE,
  envVar: import.meta.env.VITE_SAKANA_API_KEY,
  defaultModel: SAKANA_DEFAULT_MODEL,
  normalizeModel: normalizeSakanaModelName,
});

export const getSakanaKey = providerConfig.getKey;

export function useSakanaConfig() {
  return providerConfig.useConfig();
}
