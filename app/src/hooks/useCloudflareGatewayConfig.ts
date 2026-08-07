import { CLOUDFLARE_GATEWAY_DEFAULT_MODEL } from '@/lib/providers';
import { createRegistryModelProviderConfig } from './useApiKeyConfig';

const providerConfig = createRegistryModelProviderConfig('cloudflare-gateway', {
  envVar: import.meta.env.VITE_CLOUDFLARE_GATEWAY_TOKEN,
  defaultModel: CLOUDFLARE_GATEWAY_DEFAULT_MODEL,
});

export const getCloudflareGatewayKey = providerConfig.getKey;

export function useCloudflareGatewayConfig() {
  return providerConfig.useConfig();
}
