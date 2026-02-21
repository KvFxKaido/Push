import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getCuratedModels, DEFAULT_MODELS, OPENROUTER_MODELS, OLLAMA_MODELS, MISTRAL_MODELS } from '../model-catalog.mjs';
import { PROVIDER_CONFIGS } from '../provider.mjs';

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

  it('returns empty array for unknown provider', () => {
    assert.deepEqual(getCuratedModels('unknown'), []);
    assert.deepEqual(getCuratedModels(''), []);
    assert.deepEqual(getCuratedModels(undefined), []);
  });
});

describe('DEFAULT_MODELS', () => {
  it('matches PROVIDER_CONFIGS defaults', () => {
    for (const [id, cfg] of Object.entries(PROVIDER_CONFIGS)) {
      assert.equal(
        DEFAULT_MODELS[id],
        cfg.defaultModel,
        `DEFAULT_MODELS.${id} should match PROVIDER_CONFIGS.${id}.defaultModel`,
      );
    }
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
