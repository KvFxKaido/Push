import { afterEach, describe, expect, it, vi } from 'vitest';

type MockPreferredProvider = import('./providers').PreferredProvider;

function mockProviderState(options?: {
  kilocodeKey?: string;
  preferredProvider?: MockPreferredProvider | null;
  lastUsedProvider?: MockPreferredProvider | null;
}): void {
  const { kilocodeKey = '', preferredProvider = null, lastUsedProvider = null } = options ?? {};

  vi.doMock('@/hooks/useOllamaConfig', () => ({ getOllamaKey: () => '' }));
  vi.doMock('@/hooks/useOpenRouterConfig', () => ({ getOpenRouterKey: () => '' }));
  vi.doMock('@/hooks/useZenConfig', () => ({ getZenKey: () => '' }));
  vi.doMock('@/hooks/useNvidiaConfig', () => ({ getNvidiaKey: () => '' }));
  vi.doMock('@/hooks/useBlackboxConfig', () => ({ getBlackboxKey: () => '' }));
  vi.doMock('@/hooks/useKilocodeConfig', () => ({ getKilocodeKey: () => kilocodeKey }));
  vi.doMock('@/hooks/useExperimentalProviderConfig', () => ({
    getAzureBaseUrl: () => '',
    getAzureKey: () => '',
    getAzureModelName: () => '',
    getBedrockBaseUrl: () => '',
    getBedrockKey: () => '',
    getBedrockModelName: () => '',
  }));
  vi.doMock('@/hooks/useVertexConfig', () => ({
    getVertexBaseUrl: () => '',
    getVertexKey: () => '',
    getVertexMode: () => 'native' as const,
    getVertexModelName: () => '',
    getVertexRegion: () => '',
  }));
  vi.doMock('./providers', async () => {
    const actual = await vi.importActual<typeof import('./providers')>('./providers');
    return {
      ...actual,
      getPreferredProvider: () => preferredProvider,
      getLastUsedProvider: () => lastUsedProvider,
    };
  });
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('Kilo Code provider routing', () => {
  it('falls back to kilocode when it is the only configured provider', async () => {
    mockProviderState({ kilocodeKey: 'kilo-key' });

    const { getActiveProvider } = await import('./orchestrator');

    expect(getActiveProvider()).toBe('kilocode');
  });

  it('maps kilocode to the kilocode stream provider', async () => {
    mockProviderState();

    const { getProviderStreamFn } = await import('./orchestrator');

    expect(getProviderStreamFn('kilocode').providerType).toBe('kilocode');
  });
});
