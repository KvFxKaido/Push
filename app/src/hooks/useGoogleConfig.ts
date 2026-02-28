import { GOOGLE_DEFAULT_MODEL } from '@/lib/providers';
import { createModelProviderConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'google_api_key';
const MODEL_STORAGE = 'google_model';

const providerConfig = createModelProviderConfig({
  storageKey: KEY_STORAGE,
  modelStorageKey: MODEL_STORAGE,
  envVar: import.meta.env.VITE_GOOGLE_API_KEY,
  defaultModel: GOOGLE_DEFAULT_MODEL,
});

export const getGoogleKey = providerConfig.getKey;

export function useGoogleConfig() {
  return providerConfig.useConfig();
}
