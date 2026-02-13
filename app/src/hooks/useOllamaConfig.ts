import { OLLAMA_DEFAULT_MODEL } from '@/lib/providers';
import { createApiKeyGetter, useApiKeyWithModelConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'ollama_api_key';
const MODEL_STORAGE = 'ollama_model';

export const getOllamaKey = createApiKeyGetter(
  KEY_STORAGE,
  import.meta.env.VITE_OLLAMA_API_KEY,
);

export function useOllamaConfig() {
  return useApiKeyWithModelConfig(
    KEY_STORAGE,
    MODEL_STORAGE,
    import.meta.env.VITE_OLLAMA_API_KEY,
    OLLAMA_DEFAULT_MODEL,
    getOllamaKey,
  );
}
