import { OPENROUTER_DEFAULT_MODEL } from '@/lib/providers';
import { createApiKeyGetter, useApiKeyWithModelConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'openrouter_api_key';
const MODEL_STORAGE = 'openrouter_model';

export const getOpenRouterKey = createApiKeyGetter(
  KEY_STORAGE,
  import.meta.env.VITE_OPENROUTER_API_KEY,
);

export function useOpenRouterConfig() {
  return useApiKeyWithModelConfig(
    KEY_STORAGE,
    MODEL_STORAGE,
    import.meta.env.VITE_OPENROUTER_API_KEY,
    OPENROUTER_DEFAULT_MODEL,
    getOpenRouterKey,
  );
}
