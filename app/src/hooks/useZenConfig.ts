import { ZEN_DEFAULT_MODEL } from '@/lib/providers';
import { createModelProviderConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'zen_api_key';
const MODEL_STORAGE = 'zen_model';

const providerConfig = createModelProviderConfig({
  storageKey: KEY_STORAGE,
  modelStorageKey: MODEL_STORAGE,
  envVar: import.meta.env.VITE_ZEN_API_KEY,
  defaultModel: ZEN_DEFAULT_MODEL,
});

export const getZenKey = providerConfig.getKey;

export function useZenConfig() {
  return providerConfig.useConfig();
}
