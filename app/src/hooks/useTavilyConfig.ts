import { createApiKeyGetter, useApiKeyConfig } from './useApiKeyConfig';

const STORAGE_KEY = 'tavily_api_key';

export const getTavilyKey = createApiKeyGetter(
  STORAGE_KEY,
  import.meta.env.VITE_TAVILY_API_KEY,
);

export function useTavilyConfig() {
  return useApiKeyConfig(STORAGE_KEY, import.meta.env.VITE_TAVILY_API_KEY, getTavilyKey);
}
