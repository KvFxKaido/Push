import { DEEPSEEK_DEFAULT_MODEL } from '@/lib/providers';
import { createRegistryModelProviderConfig } from './useApiKeyConfig';

const providerConfig = createRegistryModelProviderConfig('deepseek', {
  envVar: import.meta.env.VITE_DEEPSEEK_API_KEY,
  defaultModel: DEEPSEEK_DEFAULT_MODEL,
});

export const getDeepSeekKey = providerConfig.getKey;

export function useDeepSeekConfig() {
  return providerConfig.useConfig();
}
