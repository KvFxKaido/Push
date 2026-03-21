import { OPENADAPTER_DEFAULT_MODEL } from '@/lib/providers';
import { createModelProviderConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'openadapter_api_key';
const MODEL_STORAGE = 'openadapter_model';

const providerConfig = createModelProviderConfig({
  storageKey: KEY_STORAGE,
  modelStorageKey: MODEL_STORAGE,
  envVar: import.meta.env.VITE_OPENADAPTER_API_KEY,
  defaultModel: OPENADAPTER_DEFAULT_MODEL,
});

export const getOpenAdapterKey = providerConfig.getKey;

export function useOpenAdapterConfig() {
  return providerConfig.useConfig();
}
