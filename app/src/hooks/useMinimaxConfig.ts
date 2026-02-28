import { MINIMAX_DEFAULT_MODEL } from '@/lib/providers';
import { createModelProviderConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'minimax_api_key';
const MODEL_STORAGE = 'minimax_model';

const providerConfig = createModelProviderConfig({
  storageKey: KEY_STORAGE,
  modelStorageKey: MODEL_STORAGE,
  envVar: import.meta.env.VITE_MINIMAX_API_KEY,
  defaultModel: MINIMAX_DEFAULT_MODEL,
});

export const getMinimaxKey = providerConfig.getKey;

export function useMinimaxConfig() {
  return providerConfig.useConfig();
}
