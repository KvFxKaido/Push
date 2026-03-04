import { NVIDIA_DEFAULT_MODEL } from '@/lib/providers';
import { createModelProviderConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'nvidia_api_key';
const MODEL_STORAGE = 'nvidia_model';

const providerConfig = createModelProviderConfig({
  storageKey: KEY_STORAGE,
  modelStorageKey: MODEL_STORAGE,
  envVar: import.meta.env.VITE_NVIDIA_API_KEY,
  defaultModel: NVIDIA_DEFAULT_MODEL,
});

export const getNvidiaKey = providerConfig.getKey;

export function useNvidiaConfig() {
  return providerConfig.useConfig();
}
