import { NVIDIA_DEFAULT_MODEL } from '@/lib/providers';
import { createRegistryModelProviderConfig } from './useApiKeyConfig';

const providerConfig = createRegistryModelProviderConfig('nvidia', {
  envVar: import.meta.env.VITE_NVIDIA_API_KEY,
  defaultModel: NVIDIA_DEFAULT_MODEL,
});

export const getNvidiaKey = providerConfig.getKey;

export function useNvidiaConfig() {
  return providerConfig.useConfig();
}
