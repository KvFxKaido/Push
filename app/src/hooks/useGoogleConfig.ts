import { GOOGLE_DEFAULT_MODEL } from '@/lib/providers';
import { createApiKeyGetter, useApiKeyWithModelConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'google_api_key';
const MODEL_STORAGE = 'google_model';

export const getGoogleKey = createApiKeyGetter(
  KEY_STORAGE,
  import.meta.env.VITE_GOOGLE_API_KEY,
);

export function useGoogleConfig() {
  return useApiKeyWithModelConfig(
    KEY_STORAGE,
    MODEL_STORAGE,
    import.meta.env.VITE_GOOGLE_API_KEY,
    GOOGLE_DEFAULT_MODEL,
    getGoogleKey,
  );
}
