import { HUGGINGFACE_DEFAULT_MODEL } from '@/lib/providers';
import { createRegistryModelProviderConfig } from './useApiKeyConfig';

const providerConfig = createRegistryModelProviderConfig('huggingface', {
  envVar: import.meta.env.VITE_HUGGINGFACE_API_KEY,
  defaultModel: HUGGINGFACE_DEFAULT_MODEL,
});

export const getHuggingFaceKey = providerConfig.getKey;

export function useHuggingFaceConfig() {
  return providerConfig.useConfig();
}
