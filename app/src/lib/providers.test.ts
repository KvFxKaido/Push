import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getProviderModelStorageKey,
  PROVIDER_DEFINITIONS,
  type RealProviderId,
} from '@push/lib/provider-definition';
import {
  formatModelDisplayName,
  getModelDisplayGroupKey,
  getModelDisplayLeafName,
  normalizeFireworksModelName,
  getZenModelName,
  normalizeOllamaModelName,
  PROVIDER_URLS,
  PROVIDERS,
  ZEN_GO_URLS,
} from './providers';

const DEV_PROXY_PATHS: Partial<Record<RealProviderId, { chat: string; models: string }>> = {
  ollama: {
    chat: '/ollama/v1/chat/completions',
    models: '/ollama/v1/models',
  },
  openrouter: {
    chat: '/openrouter/api/v1/responses',
    models: '/openrouter/api/v1/models',
  },
  zai: {
    chat: '/zai/api/paas/v4/chat/completions',
    models: '/api/zai/models',
  },
  kimi: {
    chat: '/kimi/v1/chat/completions',
    models: '/api/kimi/models',
  },
  huggingface: {
    chat: '/huggingface/v1/chat/completions',
    models: '/huggingface/v1/models',
  },
  zen: {
    chat: '/api/zen/chat',
    models: '/opencode/zen/v1/models',
  },
};

describe('PROVIDER_URLS', () => {
  it('routes Zen chat (both tiers) through the Worker in dev, never the raw proxy', () => {
    // The Worker picks /messages, /responses or /chat/completions per model; the
    // `/opencode` Vite proxy would forward every body to the URL as written.
    expect(PROVIDER_URLS.zen.chat).toBe('/api/zen/chat');
    expect(ZEN_GO_URLS.chat).toBe('/api/zen/go/chat');
  });

  it('uses ProviderDefinition proxy paths for providers without dev proxy overrides', () => {
    for (const def of PROVIDER_DEFINITIONS) {
      if (DEV_PROXY_PATHS[def.id]) continue;
      expect(PROVIDER_URLS[def.id]).toEqual({
        chat: def.webProxyPath,
        models: def.modelsProxyPath,
      });
    }
  });

  it('preserves Vite dev proxy overrides for providers that need rewritten local paths', () => {
    for (const [provider, paths] of Object.entries(DEV_PROXY_PATHS) as Array<
      [RealProviderId, { chat: string; models: string }]
    >) {
      expect(PROVIDER_URLS[provider]).toEqual(paths);
    }
  });

  it('keeps demo unrouted', () => {
    expect(PROVIDER_URLS.demo).toEqual({ chat: '', models: '' });
  });
});

describe('provider registry URL coherence', () => {
  it("each provider's registry baseUrl host matches its CLI defaultUrl host", () => {
    // Drift guard for the #1396 copy-paste class: the zai and kimi entries
    // shipped with each other's baseUrl. Nothing consumes the registry
    // baseUrl today, so the swap was latent — this pins the invariant so the
    // first future consumer doesn't route two providers into each other's
    // upstream (Codex P2, PR #1396).
    for (const def of PROVIDER_DEFINITIONS) {
      const baseUrl = (def as { baseUrl?: string }).baseUrl;
      const defaultUrl = def.cli?.defaultUrl;
      if (!baseUrl || !defaultUrl) continue;
      expect(
        new URL(baseUrl).host,
        `${def.id}: baseUrl (${baseUrl}) and cli.defaultUrl (${defaultUrl}) must agree on host`,
      ).toBe(new URL(defaultUrl).host);
    }
  });
});

describe('PROVIDERS', () => {
  it('derives provider summaries from ProviderDefinition settings metadata', () => {
    for (const def of PROVIDER_DEFINITIONS) {
      const provider = PROVIDERS.find((entry) => entry.type === def.id);
      expect(provider).toBeTruthy();
      expect(provider).toMatchObject({
        type: def.id,
        name: def.displayName,
        description: def.settings.description,
        envKey: def.settings.envKey,
        envUrl: def.settings.envUrl,
      });
      expect(provider?.models[0]).toMatchObject({
        id: def.defaultModel,
        provider: def.id,
        context: def.settings.modelContextWindow,
      });
    }
  });
});

describe('formatModelDisplayName', () => {
  it('normalizes routed ids and uses provider shorthand labels', () => {
    expect(formatModelDisplayName('openrouter', 'openai/gpt-5.4')).toBe('OpenAI / gpt-5.4');
  });

  it('keeps Ollama native ids readable', () => {
    expect(formatModelDisplayName('ollama', 'gemini-3-flash-preview')).toBe(
      'gemini-3-flash-preview',
    );
  });

  it('formats Cloudflare model ids with readable provider grouping', () => {
    expect(formatModelDisplayName('cloudflare', '@cf/qwen/qwen3-30b-a3b-fp8')).toBe(
      'Qwen / qwen3-30b-a3b-fp8',
    );
  });
});

describe('normalizeOllamaModelName', () => {
  it('migrates retired Ollama Cloud ids and passes free-text ids through', () => {
    expect(normalizeOllamaModelName('gemini-3-flash-preview')).toBe('minimax-m3');
    expect(normalizeOllamaModelName('')).toBe('minimax-m3');
    // Free-text ids (local models, account-specific tags) are untouched.
    expect(normalizeOllamaModelName('minimax-m3:cloud')).toBe('minimax-m3:cloud');
    expect(normalizeOllamaModelName('qwen3-vl:235b-instruct')).toBe('qwen3-vl:235b-instruct');
  });
});

describe('Zen renamed model ids', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('migrates a stored dotted Claude selection on read and rewrites storage', () => {
    const data = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    };
    vi.stubGlobal('window', { localStorage, sessionStorage: localStorage });
    const key = getProviderModelStorageKey('zen')!;

    data.set(key, 'claude-sonnet-4.6');
    expect(getZenModelName()).toBe('claude-sonnet-4-6');
    expect(data.get(key)).toBe('claude-sonnet-4-6');

    // No successor on Zen: left alone rather than swapped for another model.
    data.set(key, 'claude-opus-4.1');
    expect(getZenModelName()).toBe('claude-opus-4.1');
    data.set(key, 'gpt-5.5');
    expect(getZenModelName()).toBe('gpt-5.5');
  });
});

describe('normalizeFireworksModelName', () => {
  it('rejects label-shaped selections while keeping namespaced model ids', () => {
    expect(normalizeFireworksModelName('')).toBe('accounts/fireworks/models/deepseek-v4-pro');
    expect(normalizeFireworksModelName('Fireworks Qwen Coder')).toBe(
      'accounts/fireworks/models/deepseek-v4-pro',
    );
    expect(normalizeFireworksModelName('accounts/fireworks/models/deepseek-v4-pro')).toBe(
      'accounts/fireworks/models/deepseek-v4-pro',
    );
  });
});

describe('Cloudflare display grouping', () => {
  it('drops the @cf prefix for grouping while keeping the model leaf readable', () => {
    expect(getModelDisplayGroupKey('cloudflare', '@cf/qwen/qwen3-30b-a3b-fp8')).toBe('qwen');
    expect(getModelDisplayLeafName('cloudflare', '@cf/qwen/qwen3-30b-a3b-fp8')).toBe(
      'qwen3-30b-a3b-fp8',
    );
  });
});
