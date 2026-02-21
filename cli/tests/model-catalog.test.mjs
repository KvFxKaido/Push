import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCuratedModels,
  DEFAULT_MODELS,
  OPENROUTER_MODELS,
  OLLAMA_MODELS,
  MISTRAL_MODELS,
  ZAI_MODELS,
  GOOGLE_MODELS,
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

  it('returns empty array for unknown provider', () => {
    assert.deepEqual(getCuratedModels('unknown'), []);
    assert.deepEqual(getCuratedModels(''), []);
    assert.deepEqual(getCuratedModels(undefined), []);
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
    google: 'gemini-2.5-flash',
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
    assert.deepEqual(Object.keys(DEFAULT_MODELS).sort(), ['google', 'mistral', 'ollama', 'openrouter', 'zai']);
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
