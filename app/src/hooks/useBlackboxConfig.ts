import { BLACKBOX_DEFAULT_MODEL } from '@/lib/providers';
import { createModelProviderConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'blackbox_api_key';
const MODEL_STORAGE = 'blackbox_model';

const providerConfig = createModelProviderConfig({
  storageKey: KEY_STORAGE,
  modelStorageKey: MODEL_STORAGE,
  envVar: import.meta.env.VITE_BLACKBOX_API_KEY,
  defaultModel: BLACKBOX_DEFAULT_MODEL,
});

export const getBlackboxKey = providerConfig.getKey;

export function useBlackboxConfig() {
  return providerConfig.useConfig();
}
