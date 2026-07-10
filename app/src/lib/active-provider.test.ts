import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCapabilitySnapshot } from './provider-engine-capability';
import type { PreferredProvider } from './providers';

const state = vi.hoisted(() => ({
  keys: {
    ollama: '',
    openrouter: '',
    zen: '',
    nvidia: '',
    fireworks: '',
    deepseek: '',
    sakana: '',
    anthropic: '',
    openai: '',
    google: '',
  },
  cloudflareConfigured: false,
  preferredProvider: null as PreferredProvider | null,
  lastUsedProvider: null as PreferredProvider | null,
  sources: {} as ProviderCapabilitySnapshot['sources'],
}));

vi.mock('@/hooks/useOllamaConfig', () => ({ getOllamaKey: () => state.keys.ollama }));
vi.mock('@/hooks/useOpenRouterConfig', () => ({
  getOpenRouterKey: () => state.keys.openrouter,
}));
vi.mock('@/hooks/useZenConfig', () => ({ getZenKey: () => state.keys.zen }));
vi.mock('@/hooks/useNvidiaConfig', () => ({ getNvidiaKey: () => state.keys.nvidia }));
vi.mock('@/hooks/useFireworksConfig', () => ({ getFireworksKey: () => state.keys.fireworks }));
vi.mock('@/hooks/useDeepSeekConfig', () => ({ getDeepSeekKey: () => state.keys.deepseek }));
vi.mock('@/hooks/useSakanaConfig', () => ({ getSakanaKey: () => state.keys.sakana }));
vi.mock('@/hooks/useAnthropicConfig', () => ({
  getAnthropicKey: () => state.keys.anthropic,
}));
vi.mock('@/hooks/useOpenAIConfig', () => ({ getOpenAIKey: () => state.keys.openai }));
vi.mock('@/hooks/useGoogleConfig', () => ({ getGoogleKey: () => state.keys.google }));

vi.mock('./providers', async () => {
  const actual = await vi.importActual<typeof import('./providers')>('./providers');
  return {
    ...actual,
    getCloudflareWorkerConfigured: () => state.cloudflareConfigured,
    getPreferredProvider: () => state.preferredProvider,
    getLastUsedProvider: () => state.lastUsedProvider,
  };
});

vi.mock('./provider-engine-capability', () => ({
  getCachedProviderCapabilitySnapshot: () => ({
    providers: {},
    sources: state.sources,
    gatewayActive: false,
    probed: true,
  }),
}));

import { getActiveProvider, isProviderAvailable } from './active-provider';

function resetState(): void {
  for (const provider of Object.keys(state.keys) as Array<keyof typeof state.keys>) {
    state.keys[provider] = '';
  }
  state.cloudflareConfigured = false;
  state.preferredProvider = null;
  state.lastUsedProvider = null;
  state.sources = {};
}

describe('active provider selection', () => {
  beforeEach(() => {
    resetState();
  });

  it('treats a server-held Anthropic credential as available without a browser key', () => {
    state.preferredProvider = 'anthropic';
    state.keys.openrouter = 'sk-or-local';
    state.sources = { anthropic: 'gateway-byok' };

    expect(isProviderAvailable('anthropic')).toBe(true);
    expect(getActiveProvider()).toBe('anthropic');
  });

  it('does not treat an unknown credential snapshot as availability', () => {
    state.preferredProvider = 'anthropic';
    state.keys.openrouter = 'sk-or-local';

    expect(isProviderAvailable('anthropic')).toBe(false);
    expect(getActiveProvider()).toBe('openrouter');
  });
});
