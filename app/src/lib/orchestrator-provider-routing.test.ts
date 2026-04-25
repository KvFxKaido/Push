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

describe('withChunkedEmitter', () => {
  // Each test reimports the module so previous mockProviderState calls don't
  // leak. We don't actually need provider state for these tests, but
  // resetModules in afterEach demands a clean import here.

  it('batches sub-word text fragments into per-word emissions', async () => {
    mockProviderState();
    const { withChunkedEmitter } = await import('./orchestrator-provider-routing');

    const onTokenSpy = vi.fn<(text: string) => void>();
    const onDoneSpy = vi.fn<() => void>();
    const onErrorSpy = vi.fn<(err: Error) => void>();
    const noop = () => {};

    const args: Parameters<typeof withChunkedEmitter>[0] = [
      [],
      onTokenSpy,
      onDoneSpy,
      onErrorSpy,
      noop,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ];
    const [, wrappedOnToken, wrappedOnDone] = withChunkedEmitter(args);

    // Stream "hello world" character by character.
    for (const ch of 'hello world') {
      wrappedOnToken(ch);
    }
    // Trailing buffer ('world') needs onDone's flush to surface.
    wrappedOnDone();

    // Without batching this would have fired 11 times, one per character.
    // With batching, the chunker emits on word boundaries (spaces) once the
    // buffer is large enough plus a terminal flush — so two calls.
    expect(onTokenSpy).toHaveBeenCalledTimes(2);
    expect(onTokenSpy.mock.calls.map(([t]) => t).join('')).toBe('hello world');
    expect(onDoneSpy).toHaveBeenCalledTimes(1);
  });

  it('flushes the trailing buffer on terminal callbacks', async () => {
    mockProviderState();
    const { withChunkedEmitter } = await import('./orchestrator-provider-routing');

    const onTokenSpy = vi.fn<(text: string) => void>();
    const onErrorSpy = vi.fn<(err: Error) => void>();
    const noop = () => {};

    const args: Parameters<typeof withChunkedEmitter>[0] = [
      [],
      onTokenSpy,
      noop as () => void,
      onErrorSpy,
      noop,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ];
    const [, wrappedOnToken, , wrappedOnError] = withChunkedEmitter(args);

    // 'no' is below MIN_CHUNK_SIZE (4) and has no word boundary, so the
    // chunker holds it. onError must flush the tail before propagating.
    wrappedOnToken('no');
    expect(onTokenSpy).not.toHaveBeenCalled();

    const err = new Error('boom');
    wrappedOnError(err);

    expect(onTokenSpy).toHaveBeenCalledTimes(1);
    expect(onTokenSpy).toHaveBeenCalledWith('no', expect.objectContaining({ chunkIndex: 1 }));
    expect(onErrorSpy).toHaveBeenCalledWith(err);
  });

  it('passes onThinkingToken through unbatched (legacy parity)', async () => {
    mockProviderState();
    const { withChunkedEmitter } = await import('./orchestrator-provider-routing');

    const onThinkingSpy = vi.fn<(t: string | null) => void>();
    const noop = () => {};

    const args: Parameters<typeof withChunkedEmitter>[0] = [
      [],
      noop,
      noop as () => void,
      noop as (e: Error) => void,
      onThinkingSpy,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ];
    const [, , , , wrappedOnThinking] = withChunkedEmitter(args);

    // Reasoning tokens should pass through verbatim — the legacy path also
    // didn't batch reasoning, only visible content.
    expect(wrappedOnThinking).toBe(onThinkingSpy);
  });
});
