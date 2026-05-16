import { OPENAI_DEFAULT_MODEL } from '@/lib/providers';
import { createModelProviderConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'openai_api_key';
const MODEL_STORAGE = 'openai_model';

const providerConfig = createModelProviderConfig({
  storageKey: KEY_STORAGE,
  modelStorageKey: MODEL_STORAGE,
  envVar: import.meta.env.VITE_OPENAI_API_KEY,
  defaultModel: OPENAI_DEFAULT_MODEL,
});

export const getOpenAIKey = providerConfig.getKey;

export function useOpenAIConfig() {
  return providerConfig.useConfig();
}
