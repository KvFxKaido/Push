import { afterEach, describe, expect, it, vi } from 'vitest';

type MockPreferredProvider = import('./providers').PreferredProvider;

function mockProviderState(options?: {
  cloudflareConfigured?: boolean;
  cloudflareModel?: string;
  kilocodeKey?: string;
  preferredProvider?: MockPreferredProvider | null;
  lastUsedProvider?: MockPreferredProvider | null;
}): void {
  const {
    cloudflareConfigured = false,
    cloudflareModel = '@cf/qwen/qwen3-30b-a3b-fp8',
    kilocodeKey = '',
    preferredProvider = null,
    lastUsedProvider = null,
  } = options ?? {};

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
      getCloudflareModelName: () => cloudflareModel,
      getCloudflareWorkerConfigured: () => cloudflareConfigured,
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
  // The dynamic `import('./orchestrator')` inside each test transforms a large
  // module graph on first touch. When the full suite has already loaded dozens
  // of modules, that transform can brush past the default 5s timeout. Bump so
  // the test doesn't flake under full-suite contention.
  it('falls back to kilocode when it is the only configured provider', async () => {
    mockProviderState({ kilocodeKey: 'kilo-key' });

    const { getActiveProvider } = await import('./orchestrator');

    expect(getActiveProvider()).toBe('kilocode');
  }, 15_000);

  it('maps kilocode to the kilocode stream provider', async () => {
    mockProviderState();

    const { getProviderStreamFn } = await import('./orchestrator');

    expect(getProviderStreamFn('kilocode').providerType).toBe('kilocode');
  });
});

describe('Cloudflare provider routing', () => {
  it('maps cloudflare to the cloudflare stream provider', async () => {
    mockProviderState({ cloudflareConfigured: true });

    const { getProviderStreamFn } = await import('./orchestrator');

    expect(getProviderStreamFn('cloudflare').providerType).toBe('cloudflare');
  });

  it('uses cloudflare when it is the preferred configured provider', async () => {
    mockProviderState({
      cloudflareConfigured: true,
      preferredProvider: 'cloudflare',
    });

    const { getActiveProvider } = await import('./orchestrator');

    expect(getActiveProvider()).toBe('cloudflare');
  });
});
