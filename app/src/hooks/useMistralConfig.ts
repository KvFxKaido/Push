import { MISTRAL_DEFAULT_MODEL } from '@/lib/providers';
import { createModelProviderConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'mistral_api_key';
const MODEL_STORAGE = 'mistral_model';

const providerConfig = createModelProviderConfig({
  storageKey: KEY_STORAGE,
  modelStorageKey: MODEL_STORAGE,
  envVar: import.meta.env.VITE_MISTRAL_API_KEY,
  defaultModel: MISTRAL_DEFAULT_MODEL,
});

export const getMistralKey = providerConfig.getKey;

export function useMistralConfig() {
  return providerConfig.useConfig();
}
