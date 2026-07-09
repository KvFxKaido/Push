import { getOllamaKey } from '@/hooks/useOllamaConfig';
import { getOpenRouterKey } from '@/hooks/useOpenRouterConfig';
import { getZenKey } from '@/hooks/useZenConfig';
import { getNvidiaKey } from '@/hooks/useNvidiaConfig';
import { getKilocodeKey } from '@/hooks/useKilocodeConfig';
import { getFireworksKey } from '@/hooks/useFireworksConfig';
import { getDeepSeekKey } from '@/hooks/useDeepSeekConfig';
import { getSakanaKey } from '@/hooks/useSakanaConfig';
import { getAnthropicKey } from '@/hooks/useAnthropicConfig';
import { getOpenAIKey } from '@/hooks/useOpenAIConfig';
import { getGoogleKey } from '@/hooks/useGoogleConfig';
import {
  getAnthropicModelName,
  getCloudflareWorkerConfigured,
  getGoogleModelName,
  getLastUsedProvider,
  getOpenAIModelName,
  getPreferredProvider,
  type PreferredProvider,
} from './providers';
import type { AIProviderType } from '@/types';
import { getInitialFallbackProviderOrder } from '@push/lib/provider-definition';

// The set of providers that can be active is exactly `AIProviderType` (every
// provider id, including `demo`). Aliased rather than re-listed so the id
// vocabulary stays single-sourced in `ALL_PROVIDERS` (provider-contract.ts).
export type ActiveProvider = AIProviderType;

const PROVIDER_READY_CHECKS: Record<PreferredProvider, () => boolean> = {
  ollama: () => Boolean(getOllamaKey()),
  openrouter: () => Boolean(getOpenRouterKey()),
  cloudflare: () => getCloudflareWorkerConfigured(),
  zen: () => Boolean(getZenKey()),
  nvidia: () => Boolean(getNvidiaKey()),
  kilocode: () => Boolean(getKilocodeKey()),
  fireworks: () => Boolean(getFireworksKey()),
  deepseek: () => Boolean(getDeepSeekKey()),
  sakana: () => Boolean(getSakanaKey()),
  anthropic: () => Boolean(getAnthropicKey() && getAnthropicModelName()),
  openai: () => Boolean(getOpenAIKey() && getOpenAIModelName()),
  google: () => Boolean(getGoogleKey() && getGoogleModelName()),
};

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
 * 1. If the user set a preference AND that provider has a key → use it.
 * 2. Use the last provider the user picked (if still configured).
 * 3. Otherwise, use whichever provider has a key (first available wins).
 * 4. No keys → demo.
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
