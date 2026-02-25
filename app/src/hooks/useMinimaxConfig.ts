import { MINIMAX_DEFAULT_MODEL } from '@/lib/providers';
import { createApiKeyGetter, useApiKeyWithModelConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'minimax_api_key';
const MODEL_STORAGE = 'minimax_model';

export const getMinimaxKey = createApiKeyGetter(
  KEY_STORAGE,
  import.meta.env.VITE_MINIMAX_API_KEY,
);

export function useMinimaxConfig() {
  return useApiKeyWithModelConfig(
    KEY_STORAGE,
    MODEL_STORAGE,
    import.meta.env.VITE_MINIMAX_API_KEY,
    MINIMAX_DEFAULT_MODEL,
    getMinimaxKey,
  );
}
