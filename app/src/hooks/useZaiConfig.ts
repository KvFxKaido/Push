import { ZAI_DEFAULT_MODEL } from '@/lib/providers';
import { createModelProviderConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'zai_api_key';
const MODEL_STORAGE = 'zai_model';

const providerConfig = createModelProviderConfig({
  storageKey: KEY_STORAGE,
  modelStorageKey: MODEL_STORAGE,
  envVar: import.meta.env.VITE_ZAI_API_KEY,
  defaultModel: ZAI_DEFAULT_MODEL,
});

export const getZaiKey = providerConfig.getKey;

export function useZaiConfig() {
  return providerConfig.useConfig();
}
