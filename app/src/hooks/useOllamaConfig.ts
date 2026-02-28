import { OLLAMA_DEFAULT_MODEL } from '@/lib/providers';
import { createModelProviderConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'ollama_api_key';
const MODEL_STORAGE = 'ollama_model';

const providerConfig = createModelProviderConfig({
  storageKey: KEY_STORAGE,
  modelStorageKey: MODEL_STORAGE,
  envVar: import.meta.env.VITE_OLLAMA_API_KEY,
  defaultModel: OLLAMA_DEFAULT_MODEL,
});

export const getOllamaKey = providerConfig.getKey;

export function useOllamaConfig() {
  return providerConfig.useConfig();
}
