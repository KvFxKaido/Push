import { describe, expect, it } from 'vitest';
import { PROVIDER_DEFINITIONS, type RealProviderId } from '@push/lib/provider-definition';
import {
  compareProviderModelIds,
  formatModelDisplayName,
  getModelDisplayGroupKey,
  getModelDisplayLeafName,
  normalizeFireworksModelName,
  normalizeKilocodeModelName,
  PROVIDER_URLS,
} from './providers';

const DEV_PROXY_PATHS: Partial<Record<RealProviderId, { chat: string; models: string }>> = {
  ollama: {
    chat: '/ollama/v1/chat/completions',
    models: '/ollama/v1/models',
  },
  openrouter: {
    chat: '/openrouter/api/v1/chat/completions',
    models: '/openrouter/api/v1/models',
  },
  zen: {
    chat: '/opencode/zen/v1/chat/completions',
    models: '/opencode/zen/v1/models',
  },
  nvidia: {
    chat: '/nvidia/v1/chat/completions',
    models: '/nvidia/v1/models',
  },
  blackbox: {
    chat: '/blackbox/chat/completions',
    models: '/blackbox/models',
  },
};

describe('PROVIDER_URLS', () => {
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

describe('formatModelDisplayName', () => {
  it('normalizes routed Blackbox ids and uses provider shorthand labels', () => {
    expect(formatModelDisplayName('blackbox', 'blackboxai/anthropic/claude-sonnet-4.6')).toBe(
      'Anthropic / claude-sonnet-4.6',
    );
    expect(formatModelDisplayName('openrouter', 'openai/gpt-5.4')).toBe('OpenAI / gpt-5.4');
  });

  it('groups Blackbox native ids while keeping Ollama native ids readable', () => {
    expect(formatModelDisplayName('blackbox', 'blackbox-pro')).toBe('Blackbox / blackbox-pro');
    expect(formatModelDisplayName('ollama', 'gemini-3-flash-preview')).toBe(
      'gemini-3-flash-preview',
    );
  });

  it('formats Kilo auto routes with a readable provider label', () => {
    expect(formatModelDisplayName('kilocode', 'kilo-auto/balanced')).toBe('Kilo Auto / balanced');
  });

  it('formats Cloudflare model ids with readable provider grouping', () => {
    expect(formatModelDisplayName('cloudflare', '@cf/qwen/qwen3-30b-a3b-fp8')).toBe(
      'Qwen / qwen3-30b-a3b-fp8',
    );
  });
});

describe('normalizeKilocodeModelName', () => {
  it('migrates retired Kilo defaults and rejects label-shaped selections', () => {
    expect(normalizeKilocodeModelName('google/gemini-2.0-flash')).toBe(
      'google/gemini-3-flash-preview',
    );
    expect(normalizeKilocodeModelName('anthropic/claude-3.5-sonnet')).toBe(
      'anthropic/claude-sonnet-4.6',
    );
    expect(normalizeKilocodeModelName('openai/gpt-4o')).toBe('openai/gpt-5.2');
    expect(normalizeKilocodeModelName('Anthropic: Claude Sonnet 4.6')).toBe(
      'google/gemini-3-flash-preview',
    );
    expect(normalizeKilocodeModelName('kilo-auto/balanced')).toBe('kilo-auto/balanced');
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

describe('Blackbox display grouping', () => {
  it('groups first-party Blackbox models under the Blackbox bucket', () => {
    expect(getModelDisplayGroupKey('blackbox', 'blackbox-pro')).toBe('blackbox');
    expect(getModelDisplayLeafName('blackbox', 'blackbox-pro')).toBe('blackbox-pro');
  });

  it('groups bare vendor ids with their routed siblings instead of the Blackbox bucket', () => {
    // Blackbox serves Anthropic models as bare dated ids; infer the vendor so they
    // land under "Anthropic" alongside any `blackboxai/anthropic/...` entries.
    expect(getModelDisplayGroupKey('blackbox', 'claude-haiku-4-5-20251001')).toBe('anthropic');
    expect(getModelDisplayLeafName('blackbox', 'claude-haiku-4-5-20251001')).toBe(
      'claude-haiku-4-5-20251001',
    );
    expect(formatModelDisplayName('blackbox', 'claude-haiku-4-5-20251001')).toBe(
      'Anthropic / claude-haiku-4-5-20251001',
    );
  });

  it('sorts by provider bucket, then model name', () => {
    const models = [
      'blackboxai/qwen/qwen3-coder-32b-instruct',
      'blackbox-pro',
      'blackboxai/anthropic/claude-sonnet-4.6',
    ];

    expect(
      [...models].sort((left, right) => compareProviderModelIds('blackbox', left, right)),
    ).toEqual([
      'blackboxai/anthropic/claude-sonnet-4.6',
      'blackbox-pro',
      'blackboxai/qwen/qwen3-coder-32b-instruct',
    ]);
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
