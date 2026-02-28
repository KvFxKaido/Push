import { createKeyOnlyProviderConfig } from './useApiKeyConfig';

const STORAGE_KEY = 'tavily_api_key';

const tavilyConfig = createKeyOnlyProviderConfig({
  storageKey: STORAGE_KEY,
  envVar: import.meta.env.VITE_TAVILY_API_KEY,
});

export const getTavilyKey = tavilyConfig.getKey;

export function useTavilyConfig() {
  return tavilyConfig.useConfig();
}
