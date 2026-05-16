import { ANTHROPIC_DEFAULT_MODEL } from '@/lib/providers';
import { createModelProviderConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'anthropic_api_key';
const MODEL_STORAGE = 'anthropic_model';

const providerConfig = createModelProviderConfig({
  storageKey: KEY_STORAGE,
  modelStorageKey: MODEL_STORAGE,
  envVar: import.meta.env.VITE_ANTHROPIC_API_KEY,
  defaultModel: ANTHROPIC_DEFAULT_MODEL,
});

export const getAnthropicKey = providerConfig.getKey;

export function useAnthropicConfig() {
  return providerConfig.useConfig();
}
