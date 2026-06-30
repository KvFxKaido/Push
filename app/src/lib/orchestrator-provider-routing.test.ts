import { afterEach, describe, expect, it, vi } from 'vitest';
import { REAL_PROVIDERS } from '@push/lib/provider-definition';

type MockPreferredProvider = import('./providers').PreferredProvider;

function mockProviderState(options?: {
  cloudflareConfigured?: boolean;
  cloudflareModel?: string;
  kilocodeKey?: string;
  fireworksKey?: string;
  preferredProvider?: MockPreferredProvider | null;
  lastUsedProvider?: MockPreferredProvider | null;
}): void {
  const {
    cloudflareConfigured = false,
    cloudflareModel = '@cf/qwen/qwen3-30b-a3b-fp8',
    kilocodeKey = '',
    fireworksKey = '',
    preferredProvider = null,
    lastUsedProvider = null,
  } = options ?? {};

  vi.doMock('@/hooks/useOllamaConfig', () => ({ getOllamaKey: () => '' }));
  vi.doMock('@/hooks/useOpenRouterConfig', () => ({ getOpenRouterKey: () => '' }));
  vi.doMock('@/hooks/useZenConfig', () => ({ getZenKey: () => '' }));
  vi.doMock('@/hooks/useNvidiaConfig', () => ({ getNvidiaKey: () => '' }));
  vi.doMock('@/hooks/useKilocodeConfig', () => ({ getKilocodeKey: () => kilocodeKey }));
  vi.doMock('@/hooks/useFireworksConfig', () => ({ getFireworksKey: () => fireworksKey }));
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

  it('returns a PushStream for the kilocode provider', async () => {
    mockProviderState();

    const { getProviderPushStream } = await import('./orchestrator');

    // Per-provider memoization: same provider returns the same PushStream
    // identity (preserves lib-side coalescing dedupe).
    const a = getProviderPushStream('kilocode');
    const b = getProviderPushStream('kilocode');
    expect(typeof a).toBe('function');
    expect(a).toBe(b);
  });
});

describe('Fireworks AI provider routing', () => {
  it('falls back to fireworks when it is the only configured provider', async () => {
    mockProviderState({ fireworksKey: 'fireworks-key' });

    const { getActiveProvider } = await import('./orchestrator');

    expect(getActiveProvider()).toBe('fireworks');
  }, 15_000);

  it('returns a PushStream for the fireworks provider', async () => {
    mockProviderState();

    const { getProviderPushStream } = await import('./orchestrator');

    const a = getProviderPushStream('fireworks');
    const b = getProviderPushStream('fireworks');
    expect(typeof a).toBe('function');
    expect(a).toBe(b);
  });
});

describe('Cloudflare provider routing', () => {
  it('returns a PushStream for the cloudflare provider', async () => {
    mockProviderState({ cloudflareConfigured: true });

    const { getProviderPushStream } = await import('./orchestrator');

    expect(typeof getProviderPushStream('cloudflare')).toBe('function');
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

describe('provider PushStream registry', () => {
  it('returns a memoized PushStream for every real provider', async () => {
    mockProviderState();

    const { getProviderPushStream } = await import('./orchestrator');

    for (const provider of REAL_PROVIDERS) {
      const first = getProviderPushStream(provider);
      const second = getProviderPushStream(provider);
      expect(typeof first, provider).toBe('function');
      expect(second, provider).toBe(first);
    }
  });

  it('keeps demo as an explicit erroring stream', async () => {
    mockProviderState();

    const { getProviderPushStream } = await import('./orchestrator');
    const iterator = getProviderPushStream('demo')({
      provider: 'demo',
      model: '',
      messages: [],
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow(/Demo provider has no PushStream/);
  });
});

// ---------------------------------------------------------------------------
// Provider failover candidate resolution
// ---------------------------------------------------------------------------

/**
 * Mock every provider readiness input exactly once (no layering over
 * `mockProviderState`, whose duplicate `vi.doMock` of the same module races
 * with an override). Makes openai + openrouter + azure available — most
 * providers need only a key, model names resolve to non-empty defaults via the
 * real `./providers` — and drives the model-aware transport getters so the
 * Anthropic-bridge isolation guard is deterministic. Everything else is
 * keyless → unavailable.
 */
function mockFailoverState(opts?: {
  openai?: boolean;
  openrouter?: boolean;
  google?: boolean;
  zen?: boolean;
  azure?: boolean;
  vertex?: boolean;
  vertexModel?: string;
  zenTransport?: 'anthropic' | 'openai';
  vertexTransport?: 'anthropic' | 'gemini';
}): void {
  const {
    openai = true,
    openrouter = true,
    google = false,
    zen = false,
    azure = true,
    vertex = false,
    zenTransport = 'openai',
    vertexTransport = 'gemini',
    vertexModel = vertexTransport === 'anthropic'
      ? 'claude-sonnet-4-5@20250929'
      : 'google/gemini-2.5-pro',
  } = opts ?? {};
  vi.doMock('@/hooks/useOllamaConfig', () => ({ getOllamaKey: () => '' }));
  vi.doMock('@/hooks/useOpenRouterConfig', () => ({
    getOpenRouterKey: () => (openrouter ? 'k-openrouter' : ''),
  }));
  vi.doMock('@/hooks/useZenConfig', () => ({ getZenKey: () => (zen ? 'k-zen' : '') }));
  vi.doMock('@/hooks/useNvidiaConfig', () => ({ getNvidiaKey: () => '' }));
  vi.doMock('@/hooks/useKilocodeConfig', () => ({ getKilocodeKey: () => '' }));
  vi.doMock('@/hooks/useFireworksConfig', () => ({ getFireworksKey: () => '' }));
  vi.doMock('@/hooks/useAnthropicConfig', () => ({
    getAnthropicKey: () => '',
    getAnthropicModelName: () => '',
  }));
  vi.doMock('@/hooks/useOpenAIConfig', () => ({ getOpenAIKey: () => (openai ? 'k-openai' : '') }));
  vi.doMock('@/hooks/useGoogleConfig', () => ({
    getGoogleKey: () => (google ? 'k-google' : ''),
  }));
  vi.doMock('@/hooks/useExperimentalProviderConfig', () => ({
    getAzureBaseUrl: () => (azure ? 'https://res.openai.azure.com/openai/v1' : ''),
    getAzureKey: () => (azure ? 'k-azure' : ''),
    getAzureModelName: () => (azure ? 'gpt-4o' : ''),
    getBedrockBaseUrl: () => '',
    getBedrockKey: () => '',
    getBedrockModelName: () => '',
  }));
  vi.doMock('@/hooks/useVertexConfig', () => ({
    getVertexBaseUrl: () => '',
    getVertexKey: () => (vertex ? 'k-vertex' : ''),
    getVertexMode: () => 'native' as const,
    getVertexModelName: () => (vertex ? vertexModel : ''),
    getVertexRegion: () => (vertex ? 'global' : ''),
  }));
  vi.doMock('./providers', async () => {
    const actual = await vi.importActual<typeof import('./providers')>('./providers');
    return {
      ...actual,
      getCloudflareWorkerConfigured: () => false,
      getPreferredProvider: () => null,
      getLastUsedProvider: () => null,
    };
  });
  vi.doMock('./zen-go', async () => ({
    ...(await vi.importActual<typeof import('./zen-go')>('./zen-go')),
    getZenGoTransport: () => zenTransport,
  }));
  vi.doMock('./vertex-provider', async () => ({
    ...(await vi.importActual<typeof import('./vertex-provider')>('./vertex-provider')),
    getVertexModelTransport: () => vertexTransport,
  }));
}

describe('routesThroughAnthropicBridge', () => {
  it('is true for the direct anthropic provider with a non-empty model', async () => {
    mockFailoverState();
    const { routesThroughAnthropicBridge } = await import('./orchestrator-provider-routing');
    expect(routesThroughAnthropicBridge('anthropic', 'claude-x')).toBe(true);
    expect(routesThroughAnthropicBridge('anthropic', undefined)).toBe(false);
  });

  it('is model-dependent for zen and vertex', async () => {
    mockFailoverState({ zenTransport: 'anthropic', vertexTransport: 'anthropic' });
    const { routesThroughAnthropicBridge } = await import('./orchestrator-provider-routing');
    expect(routesThroughAnthropicBridge('zen', 'minimax')).toBe(true);
    expect(routesThroughAnthropicBridge('vertex', 'claude-3')).toBe(true);
    expect(routesThroughAnthropicBridge('openai', 'gpt-4o')).toBe(false);
  });
});

describe('routeReplaysReasoningContent', () => {
  it('is true only for DeepSeek models on routes that require replay', async () => {
    mockFailoverState();
    const { routeReplaysReasoningContent } = await import('./orchestrator-provider-routing');
    expect(routeReplaysReasoningContent('zen', 'deepseek-v4-pro')).toBe(true);
    expect(routeReplaysReasoningContent('zen', 'deepseek-v4-flash')).toBe(true);
    expect(routeReplaysReasoningContent('zen', 'glm-5.1')).toBe(false);
    expect(routeReplaysReasoningContent('openrouter', 'deepseek/deepseek-r1')).toBe(true);
    expect(routeReplaysReasoningContent('openrouter', 'deepseek/deepseek-v3.2:nitro')).toBe(true);
    expect(routeReplaysReasoningContent('openrouter', 'anthropic/claude-sonnet-4.6:nitro')).toBe(
      false,
    );
    expect(routeReplaysReasoningContent('zen', undefined)).toBe(false);
  });
});

describe('resolveFailoverCandidates — Anthropic-transport isolation (Codex #1)', () => {
  it('never fails over from the direct anthropic provider', async () => {
    mockFailoverState();
    const { resolveFailoverCandidates } = await import('./orchestrator-provider-routing');
    expect(resolveFailoverCandidates('anthropic', 'claude-x', new Set(['anthropic']))).toEqual([]);
  });

  it('never fails over from a Zen Go Anthropic-transport chat, even with peers up', async () => {
    mockFailoverState({ zenTransport: 'anthropic' });
    const { resolveFailoverCandidates } = await import('./orchestrator-provider-routing');
    expect(resolveFailoverCandidates('zen', 'minimax', new Set(['zen']))).toEqual([]);
  });

  it('never fails over from a Vertex Claude chat', async () => {
    mockFailoverState({ vertexTransport: 'anthropic' });
    const { resolveFailoverCandidates } = await import('./orchestrator-provider-routing');
    expect(resolveFailoverCandidates('vertex', 'claude-3', new Set(['vertex']))).toEqual([]);
  });

  it('DOES fail over from a Zen chat on a non-Anthropic model', async () => {
    mockFailoverState({ zenTransport: 'openai' });
    const { resolveFailoverCandidates } = await import('./orchestrator-provider-routing');
    expect(resolveFailoverCandidates('zen', 'gpt', new Set(['zen']))).toEqual(['azure']);
  });
});

describe('resolveFailoverCandidates — same-shape selection + ordering (Codex #2)', () => {
  it('returns same-shape Responses providers, excluding the locked one', async () => {
    mockFailoverState();
    const { resolveFailoverCandidates } = await import('./orchestrator-provider-routing');
    expect(resolveFailoverCandidates('openrouter', 'gpt-4o', new Set(['openrouter']))).toEqual([
      'openai',
    ]);
  });

  it('includes OpenRouter in direct OpenAI Responses failover', async () => {
    mockFailoverState();
    const { resolveFailoverCandidates } = await import('./orchestrator-provider-routing');
    expect(resolveFailoverCandidates('openai', 'gpt-4o', new Set(['openai']))).toEqual([
      'openrouter',
    ]);
  });

  it('excludes model-dependent Anthropic-transport targets from Responses failover', async () => {
    mockFailoverState({ zen: true, zenTransport: 'anthropic' });
    const { resolveFailoverCandidates } = await import('./orchestrator-provider-routing');
    expect(resolveFailoverCandidates('openrouter', 'gpt-4o', new Set(['openrouter']))).toEqual([
      'openai',
    ]);
  });

  it('excludes Vertex Claude targets from Gemini failover', async () => {
    mockFailoverState({
      openai: false,
      openrouter: false,
      azure: false,
      google: true,
      vertex: true,
      vertexTransport: 'anthropic',
    });
    const { resolveFailoverCandidates } = await import('./orchestrator-provider-routing');
    expect(resolveFailoverCandidates('google', 'gemini-3.5-flash', new Set(['google']))).toEqual(
      [],
    );
  });

  it('allows Vertex Gemini targets for Gemini failover', async () => {
    mockFailoverState({
      openai: false,
      openrouter: false,
      azure: false,
      google: true,
      vertex: true,
      vertexTransport: 'gemini',
    });
    const { resolveFailoverCandidates } = await import('./orchestrator-provider-routing');
    expect(resolveFailoverCandidates('google', 'gemini-3.5-flash', new Set(['google']))).toEqual([
      'vertex',
    ]);
  });

  it('excludes providers already tried this round', async () => {
    mockFailoverState();
    const { resolveFailoverCandidates } = await import('./orchestrator-provider-routing');
    expect(
      resolveFailoverCandidates('openrouter', 'gpt-4o', new Set(['openrouter', 'openai'])),
    ).toEqual([]);
  });

  it('returns [] for the demo provider', async () => {
    mockFailoverState();
    const { resolveFailoverCandidates } = await import('./orchestrator-provider-routing');
    expect(resolveFailoverCandidates('demo', undefined, new Set(['demo']))).toEqual([]);
  });
});
