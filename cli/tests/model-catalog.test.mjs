import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCuratedModels,
  fetchModels,
  DEFAULT_MODELS,
  OPENROUTER_MODELS,
  OLLAMA_MODELS,
  MISTRAL_MODELS,
  ZAI_MODELS,
  GOOGLE_MODELS,
  ZEN_MODELS,
} from '../model-catalog.mjs';

describe('getCuratedModels', () => {
  it('returns OpenRouter models', () => {
    const models = getCuratedModels('openrouter');
    assert.ok(models.length > 0);
    assert.deepEqual(models, OPENROUTER_MODELS);
  });

  it('returns Ollama models', () => {
    const models = getCuratedModels('ollama');
    assert.ok(models.length > 0);
    assert.deepEqual(models, OLLAMA_MODELS);
  });

  it('returns Mistral models', () => {
    const models = getCuratedModels('mistral');
    assert.ok(models.length > 0);
    assert.deepEqual(models, MISTRAL_MODELS);
  });

  it('returns Z.AI models', () => {
    const models = getCuratedModels('zai');
    assert.ok(models.length > 0);
    assert.deepEqual(models, ZAI_MODELS);
  });

  it('returns Google models', () => {
    const models = getCuratedModels('google');
    assert.ok(models.length > 0);
    assert.deepEqual(models, GOOGLE_MODELS);
  });

  it('returns Zen models', () => {
    const models = getCuratedModels('zen');
    assert.ok(models.length > 0);
    assert.deepEqual(models, ZEN_MODELS);
  });

  it('returns empty array for unknown provider', () => {
    assert.deepEqual(getCuratedModels('unknown'), []);
    assert.deepEqual(getCuratedModels(''), []);
    assert.deepEqual(getCuratedModels(undefined), []);
  });
});

describe('fetchModels (google live list)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('uses Google native models endpoint and normalizes model names', async () => {
    let requestedUrl = '';
    let authHeader = null;
    globalThis.fetch = async (url, init = {}) => {
      requestedUrl = String(url);
      authHeader = init.headers?.Authorization ?? null;
      return new Response(JSON.stringify({
        models: [
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }, // duplicate
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const providerConfig = {
      id: 'google',
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    };
    const result = await fetchModels(providerConfig, 'gkey_test');

    assert.equal(result.source, 'live');
    assert.equal(result.error, undefined);
    assert.match(requestedUrl, /\/v1beta\/models\?/);
    assert.match(requestedUrl, /key=gkey_test/);
    assert.equal(authHeader, null, 'Google list endpoint should use ?key=, not Authorization header');
    assert.ok(result.models.includes('gemini-2.5-flash'));
    assert.ok(result.models.includes('gemini-2.0-flash'));
    assert.ok(!result.models.includes('text-embedding-004'));
    assert.equal(result.models.filter((m) => m === 'gemini-2.5-flash').length, 1);
  });
});

describe('DEFAULT_MODELS', () => {
  // Hardcoded expected values — not cross-referencing PROVIDER_CONFIGS
  // because those are env-overridable at import time.
  const EXPECTED = {
    ollama: 'gemini-3-flash-preview',
    mistral: 'devstral-small-latest',
    openrouter: 'anthropic/claude-sonnet-4.6',
    zai: 'glm-4.5',
    google: 'gemini-3.1-pro-preview',
    minimax: 'MiniMax-M2.5',
    zen: 'big-pickle',
  };

  it('has correct hardcoded defaults', () => {
    for (const [id, expected] of Object.entries(EXPECTED)) {
      assert.equal(
        DEFAULT_MODELS[id],
        expected,
        `DEFAULT_MODELS.${id} should be "${expected}"`,
      );
    }
  });

  it('covers all providers', () => {
    assert.deepEqual(Object.keys(DEFAULT_MODELS).sort(), ['google', 'minimax', 'mistral', 'ollama', 'openrouter', 'zai', 'zen']);
  });

  it('each default appears in its curated list', () => {
    for (const [id, model] of Object.entries(DEFAULT_MODELS)) {
      const models = getCuratedModels(id);
      assert.ok(
        models.includes(model),
        `Default model "${model}" should appear in curated list for ${id}`,
      );
    }
  });
});
