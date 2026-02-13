import { ZAI_DEFAULT_MODEL } from '@/lib/providers';
import { createApiKeyGetter, useApiKeyWithModelConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'zai_api_key';
const MODEL_STORAGE = 'zai_model';

export const getZaiKey = createApiKeyGetter(
  KEY_STORAGE,
  import.meta.env.VITE_ZAI_API_KEY,
);

export function useZaiConfig() {
  return useApiKeyWithModelConfig(
    KEY_STORAGE,
    MODEL_STORAGE,
    import.meta.env.VITE_ZAI_API_KEY,
    ZAI_DEFAULT_MODEL,
    getZaiKey,
  );
}
