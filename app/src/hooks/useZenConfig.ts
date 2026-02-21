import { ZEN_DEFAULT_MODEL } from '@/lib/providers';
import { createApiKeyGetter, useApiKeyWithModelConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'zen_api_key';
const MODEL_STORAGE = 'zen_model';

export const getZenKey = createApiKeyGetter(
  KEY_STORAGE,
  import.meta.env.VITE_ZEN_API_KEY,
);

export function useZenConfig() {
  return useApiKeyWithModelConfig(
    KEY_STORAGE,
    MODEL_STORAGE,
    import.meta.env.VITE_ZEN_API_KEY,
    ZEN_DEFAULT_MODEL,
    getZenKey,
  );
}
