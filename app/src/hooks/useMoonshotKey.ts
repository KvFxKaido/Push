import { createApiKeyGetter, useApiKeyConfig } from './useApiKeyConfig';

const STORAGE_KEY = 'moonshot_api_key';

export const getMoonshotKey = createApiKeyGetter(
  STORAGE_KEY,
  import.meta.env.VITE_MOONSHOT_API_KEY,
);

export function useMoonshotKey() {
  return useApiKeyConfig(STORAGE_KEY, import.meta.env.VITE_MOONSHOT_API_KEY, getMoonshotKey);
}
