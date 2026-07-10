import { getOllamaKey } from '@/hooks/useOllamaConfig';
import { getOpenRouterKey } from '@/hooks/useOpenRouterConfig';
import { getZaiKey } from '@/hooks/useZaiConfig';
import { getKimiKey } from '@/hooks/useKimiConfig';
import { getZenKey } from '@/hooks/useZenConfig';
import { getNvidiaKey } from '@/hooks/useNvidiaConfig';
import { getFireworksKey } from '@/hooks/useFireworksConfig';
import { getDeepSeekKey } from '@/hooks/useDeepSeekConfig';
import { getSakanaKey } from '@/hooks/useSakanaConfig';
import { getAnthropicKey } from '@/hooks/useAnthropicConfig';
import { getOpenAIKey } from '@/hooks/useOpenAIConfig';
import { getXAIKey } from '@/hooks/useXAIConfig';
import { getGoogleKey } from '@/hooks/useGoogleConfig';
import {
  getAnthropicModelName,
  getCloudflareWorkerConfigured,
  getGoogleModelName,
  getLastUsedProvider,
  getOpenAIModelName,
  getXAIModelName,
  getPreferredProvider,
  getZaiModelName,
  getKimiModelName,
  type PreferredProvider,
} from './providers';
import type { AIProviderType } from '@/types';
import { getInitialFallbackProviderOrder } from '@push/lib/provider-definition';
import {
  getCachedProviderCapabilitySnapshot,
  type ProviderCredentialSource,
} from './provider-engine-capability';

// The set of providers that can be active is exactly `AIProviderType` (every
// provider id, including `demo`). Aliased rather than re-listed so the id
// vocabulary stays single-sourced in `ALL_PROVIDERS` (provider-contract.ts).
export type ActiveProvider = AIProviderType;

const PROVIDER_READY_CHECKS: Record<PreferredProvider, () => boolean> = {
  ollama: () => Boolean(getOllamaKey() || hasServerProviderCredential('ollama')),
  openrouter: () => Boolean(getOpenRouterKey() || hasServerProviderCredential('openrouter')),
  zai: () => Boolean((getZaiKey() || hasServerProviderCredential('zai')) && getZaiModelName()),
  kimi: () => Boolean((getKimiKey() || hasServerProviderCredential('kimi')) && getKimiModelName()),
  cloudflare: () => getCloudflareWorkerConfigured() || hasServerProviderCredential('cloudflare'),
  zen: () => Boolean(getZenKey() || hasServerProviderCredential('zen')),
  nvidia: () => Boolean(getNvidiaKey() || hasServerProviderCredential('nvidia')),
  fireworks: () => Boolean(getFireworksKey() || hasServerProviderCredential('fireworks')),
  deepseek: () => Boolean(getDeepSeekKey() || hasServerProviderCredential('deepseek')),
  sakana: () => Boolean(getSakanaKey() || hasServerProviderCredential('sakana')),
  anthropic: () =>
    Boolean(
      (getAnthropicKey() || hasServerProviderCredential('anthropic')) && getAnthropicModelName(),
    ),
  openai: () =>
    Boolean((getOpenAIKey() || hasServerProviderCredential('openai')) && getOpenAIModelName()),
  xai: () => Boolean((getXAIKey() || hasServerProviderCredential('xai')) && getXAIModelName()),
  google: () =>
    Boolean((getGoogleKey() || hasServerProviderCredential('google')) && getGoogleModelName()),
};

// Server credential sources the FOREGROUND path can actually dispatch with.
// `user-key` (the identity-keyed server-secret store) is deliberately excluded:
// only the engine/CoderJob adapter injects it — the foreground Worker preamble
// (`runPreamble`) resolves an env secret, gateway BYOK, or the request header,
// never the user-secrets store. Counting `user-key` here would foreground-route
// a provider whose key the foreground path can't reach, so the turn 401s
// instead of falling back. (Engine capability is gated separately by
// `isProviderEngineCapable`, which does honor `user-key`.)
const FOREGROUND_SERVER_SOURCES: readonly ProviderCredentialSource[] = [
  'gateway-byok',
  'binding',
  'worker-secret',
];

function hasServerProviderCredential(provider: PreferredProvider): boolean {
  const source = getCachedProviderCapabilitySnapshot().sources[provider] ?? null;
  return source !== null && FOREGROUND_SERVER_SOURCES.includes(source);
}

/**
 * Fallback order when no preference or last-used provider is available.
 * Neutral ordering — no provider is favoured.
 */
const PROVIDER_FALLBACK_ORDER: readonly PreferredProvider[] = getInitialFallbackProviderOrder();

/**
 * Check whether a provider is fully configured (has credentials / required fields).
 * Returns false for 'demo' since it's not a real provider.
 */
export function isProviderAvailable(provider: ActiveProvider): boolean {
  if (provider === 'demo') return false;
  const check = PROVIDER_READY_CHECKS[provider as PreferredProvider];
  return check ? check() : false;
}

/**
 * Determine which provider is active.
 *
 * 1. If the user set a preference AND that provider has credentials → use it.
 * 2. Use the last provider the user picked (if still configured).
 * 3. Otherwise, use whichever provider has credentials (first available wins).
 * 4. No credentials → demo.
 */
export function getActiveProvider(): ActiveProvider {
  const preferred = getPreferredProvider();

  // Honour explicit preference when the provider is fully configured.
  if (preferred && PROVIDER_READY_CHECKS[preferred]()) return preferred;

  // No preference — use the last provider the user picked, if still ready.
  const lastUsed = getLastUsedProvider();
  if (lastUsed && PROVIDER_READY_CHECKS[lastUsed]()) return lastUsed;

  // Fall back to any available provider.
  for (const p of PROVIDER_FALLBACK_ORDER) {
    if (PROVIDER_READY_CHECKS[p]()) return p;
  }
  return 'demo';
}
