import { afterEach, describe, expect, it, vi } from 'vitest';
import { REAL_PROVIDERS } from '@push/lib/provider-definition';

type MockPreferredProvider = import('./providers').PreferredProvider;

function mockProviderState(options?: {
  cloudflareConfigured?: boolean;
  cloudflareModel?: string;
  fireworksKey?: string;
  preferredProvider?: MockPreferredProvider | null;
  lastUsedProvider?: MockPreferredProvider | null;
}): void {
  const {
    cloudflareConfigured = false,
    cloudflareModel = '@cf/qwen/qwen3-30b-a3b-fp8',
    fireworksKey = '',
    preferredProvider = null,
    lastUsedProvider = null,
  } = options ?? {};

  vi.doMock('@/hooks/useOllamaConfig', () => ({ getOllamaKey: () => '' }));
  vi.doMock('@/hooks/useOpenRouterConfig', () => ({ getOpenRouterKey: () => '' }));
  vi.doMock('@/hooks/useZaiConfig', () => ({ getZaiKey: () => '' }));
  vi.doMock('@/hooks/useKimiConfig', () => ({ getKimiKey: () => '' }));
  vi.doMock('@/hooks/useHuggingFaceConfig', () => ({ getHuggingFaceKey: () => '' }));
  vi.doMock('@/hooks/useZenConfig', () => ({ getZenKey: () => '' }));
  vi.doMock('@/hooks/useNvidiaConfig', () => ({ getNvidiaKey: () => '' }));
  vi.doMock('@/hooks/useFireworksConfig', () => ({ getFireworksKey: () => fireworksKey }));
  vi.doMock('./providers', async () => {
    const actual = await vi.importActual<typeof import('./providers')>('./providers');
    return {
      ...actual,
      getCloudflareModelName: () => cloudflareModel,
      getZaiModelName: () => 'glm-5.2',
      getKimiModelName: () => 'glm-5.2',
      getHuggingFaceModelName: () => 'deepseek-ai/DeepSeek-V4-Pro',
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

describe('OpenCode Zen provider routing', () => {
  // The dynamic `import('./orchestrator')` inside the test transforms a large
  // module graph on first touch; bump past the default 5s so it doesn't flake
  // under full-suite contention.
  it('returns a PushStream for the zen provider', async () => {
    mockProviderState();

    const { getProviderPushStream } = await import('./orchestrator');

    // Per-provider memoization: same provider returns the same PushStream
    // identity (preserves lib-side coalescing dedupe).
    const a = getProviderPushStream('zen');
    const b = getProviderPushStream('zen');
    expect(typeof a).toBe('function');
    expect(a).toBe(b);
  }, 15_000);
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
 * with an override). Makes openai + openrouter + nvidia available — most
 * providers need only a key, model names resolve to non-empty defaults via the
 * real `./providers` — and drives the model-aware transport getters so the
 * Anthropic-bridge isolation guard is deterministic. `nvidia` is the
 * openai-compat peer used to prove same-shape failover. Everything else is
 * keyless → unavailable.
 */
function mockFailoverState(opts?: {
  openai?: boolean;
  openrouter?: boolean;
  google?: boolean;
  zai?: boolean;
  kimi?: boolean;
  huggingface?: boolean;
  zen?: boolean;
  nvidia?: boolean;
  zenTransport?: 'anthropic' | 'openai';
}): void {
  const {
    openai = true,
    openrouter = true,
    google = false,
    zai = false,
    kimi = false,
    huggingface = false,
    zen = false,
    nvidia = true,
    zenTransport = 'openai',
  } = opts ?? {};
  vi.doMock('@/hooks/useOllamaConfig', () => ({ getOllamaKey: () => '' }));
  vi.doMock('@/hooks/useOpenRouterConfig', () => ({
    getOpenRouterKey: () => (openrouter ? 'k-openrouter' : ''),
  }));
  vi.doMock('@/hooks/useZaiConfig', () => ({ getZaiKey: () => (zai ? 'k-zai' : '') }));
  vi.doMock('@/hooks/useKimiConfig', () => ({ getKimiKey: () => (kimi ? 'k-kimi' : '') }));
  vi.doMock('@/hooks/useHuggingFaceConfig', () => ({
    getHuggingFaceKey: () => (huggingface ? 'k-huggingface' : ''),
  }));
  vi.doMock('@/hooks/useZenConfig', () => ({ getZenKey: () => (zen ? 'k-zen' : '') }));
  vi.doMock('@/hooks/useNvidiaConfig', () => ({ getNvidiaKey: () => (nvidia ? 'k-nvidia' : '') }));
  vi.doMock('@/hooks/useFireworksConfig', () => ({ getFireworksKey: () => '' }));
  vi.doMock('@/hooks/useAnthropicConfig', () => ({
    getAnthropicKey: () => '',
    getAnthropicModelName: () => '',
  }));
  vi.doMock('@/hooks/useOpenAIConfig', () => ({ getOpenAIKey: () => (openai ? 'k-openai' : '') }));
  vi.doMock('@/hooks/useGoogleConfig', () => ({
    getGoogleKey: () => (google ? 'k-google' : ''),
  }));
  vi.doMock('./providers', async () => {
    const actual = await vi.importActual<typeof import('./providers')>('./providers');
    return {
      ...actual,
      getCloudflareWorkerConfigured: () => false,
      getZaiModelName: () => 'glm-5.2',
      getPreferredProvider: () => null,
      getLastUsedProvider: () => null,
    };
  });
  // The transport predicate lives in root lib (`lib/zen-go.ts`) since the
  // Phase 3 capability-resolver move; the app `./zen-go` module is only a
  // re-export shim, so the mock must target the lib module the resolver
  // actually imports.
  vi.doMock('@push/lib/zen-go', async () => ({
    ...(await vi.importActual<typeof import('@push/lib/zen-go')>('@push/lib/zen-go')),
    getZenGoTransport: () => zenTransport,
  }));
}

describe('routesThroughAnthropicBridge', () => {
  it('is true for the direct anthropic provider with a non-empty model', async () => {
    mockFailoverState();
    const { routesThroughAnthropicBridge } = await import('./orchestrator-provider-routing');
    expect(routesThroughAnthropicBridge('anthropic', 'claude-x')).toBe(true);
    expect(routesThroughAnthropicBridge('anthropic', undefined)).toBe(false);
  });

  it('is model-dependent for zen', async () => {
    mockFailoverState({ zenTransport: 'anthropic' });
    const { routesThroughAnthropicBridge } = await import('./orchestrator-provider-routing');
    expect(routesThroughAnthropicBridge('zen', 'minimax')).toBe(true);
    expect(routesThroughAnthropicBridge('openai', 'gpt-4o')).toBe(false);
  });
});

describe('routeReplaysReasoningContent', () => {
  it('replays DeepSeek gateway reasoning and all direct Kimi reasoning', async () => {
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
    expect(routeReplaysReasoningContent('kimi', 'kimi-k2.7-code-highspeed')).toBe(true);
    expect(routeReplaysReasoningContent('kimi', 'kimi-k2.6')).toBe(true);
    expect(routeReplaysReasoningContent('huggingface', 'deepseek-ai/DeepSeek-V4-Pro')).toBe(true);
    expect(routeReplaysReasoningContent('huggingface', 'zai-org/GLM-5.2')).toBe(false);
    expect(routeReplaysReasoningContent('zen', undefined)).toBe(false);
    // Gateway-routed Kimi: preserve-thinking is forced on model-side, so
    // K2.x needs the reasoning echo through gateways too — the miss is a
    // silent chain-of-thought loss, not a 400 (unlike DeepSeek).
    expect(routeReplaysReasoningContent('openrouter', 'moonshotai/kimi-k2.7-code')).toBe(true);
    expect(routeReplaysReasoningContent('openrouter', 'moonshotai/kimi-k2-thinking')).toBe(true);
    expect(routeReplaysReasoningContent('huggingface', 'moonshotai/Kimi-K2.7-Code')).toBe(true);
    expect(routeReplaysReasoningContent('zen', 'kimi-k2.7')).toBe(true);
    expect(routeReplaysReasoningContent('openrouter', 'openai/gpt-5.2')).toBe(false);
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

  it('DOES fail over from a Zen chat on a non-Anthropic model', async () => {
    mockFailoverState({ zenTransport: 'openai' });
    const { resolveFailoverCandidates } = await import('./orchestrator-provider-routing');
    expect(resolveFailoverCandidates('zen', 'gpt', new Set(['zen']))).toEqual(['nvidia']);
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
