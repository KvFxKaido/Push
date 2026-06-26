import { DEEPSEEK_DEFAULT_MODEL } from '@/lib/providers';
import { createModelProviderConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'deepseek_api_key';
const MODEL_STORAGE = 'deepseek_model';

const providerConfig = createModelProviderConfig({
  storageKey: KEY_STORAGE,
  modelStorageKey: MODEL_STORAGE,
  envVar: import.meta.env.VITE_DEEPSEEK_API_KEY,
  defaultModel: DEEPSEEK_DEFAULT_MODEL,
});

export const getDeepSeekKey = providerConfig.getKey;

export function useDeepSeekConfig() {
  return providerConfig.useConfig();
}
