import { FIREWORKS_DEFAULT_MODEL, normalizeFireworksModelName } from '@/lib/providers';
import { createModelProviderConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'fireworks_api_key';
const MODEL_STORAGE = 'fireworks_model';

const providerConfig = createModelProviderConfig({
  storageKey: KEY_STORAGE,
  modelStorageKey: MODEL_STORAGE,
  envVar: import.meta.env.VITE_FIREWORKS_API_KEY,
  defaultModel: FIREWORKS_DEFAULT_MODEL,
  normalizeModel: normalizeFireworksModelName,
});

export const getFireworksKey = providerConfig.getKey;

export function useFireworksConfig() {
  return providerConfig.useConfig();
}
