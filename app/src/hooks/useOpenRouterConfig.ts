import { OPENROUTER_DEFAULT_MODEL } from '@/lib/providers';
import { createModelProviderConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'openrouter_api_key';
const MODEL_STORAGE = 'openrouter_model';

const providerConfig = createModelProviderConfig({
  storageKey: KEY_STORAGE,
  modelStorageKey: MODEL_STORAGE,
  envVar: import.meta.env.VITE_OPENROUTER_API_KEY,
  defaultModel: OPENROUTER_DEFAULT_MODEL,
});

export const getOpenRouterKey = providerConfig.getKey;

export function useOpenRouterConfig() {
  return providerConfig.useConfig();
}
