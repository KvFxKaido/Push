import { ANTHROPIC_DEFAULT_MODEL } from '@/lib/providers';
import { createRegistryModelProviderConfig } from './useApiKeyConfig';

const providerConfig = createRegistryModelProviderConfig('anthropic', {
  envVar: import.meta.env.VITE_ANTHROPIC_API_KEY,
  defaultModel: ANTHROPIC_DEFAULT_MODEL,
});

export const getAnthropicKey = providerConfig.getKey;

export function useAnthropicConfig() {
  return providerConfig.useConfig();
}
