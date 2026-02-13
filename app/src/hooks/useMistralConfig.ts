import { MISTRAL_DEFAULT_MODEL } from '@/lib/providers';
import { createApiKeyGetter, useApiKeyWithModelConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'mistral_api_key';
const MODEL_STORAGE = 'mistral_model';

export const getMistralKey = createApiKeyGetter(
  KEY_STORAGE,
  import.meta.env.VITE_MISTRAL_API_KEY,
);

export function useMistralConfig() {
  return useApiKeyWithModelConfig(
    KEY_STORAGE,
    MODEL_STORAGE,
    import.meta.env.VITE_MISTRAL_API_KEY,
    MISTRAL_DEFAULT_MODEL,
    getMistralKey,
  );
}
