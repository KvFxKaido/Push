import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCuratedModels,
  fetchModels,
  DEFAULT_MODELS,
  OPENROUTER_MODELS,
  OLLAMA_MODELS,
  NVIDIA_MODELS,
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

  it('returns Zen models', () => {
    const models = getCuratedModels('zen');
    assert.ok(models.length > 0);
    assert.deepEqual(models, ZEN_MODELS);
  });

  it('returns Nvidia models', () => {
    const models = getCuratedModels('nvidia');
    assert.ok(models.length > 0);
    assert.deepEqual(models, NVIDIA_MODELS);
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
    openrouter: 'anthropic/claude-sonnet-4.6',
    zen: 'big-pickle',
    nvidia: 'nvidia/llama-3.1-nemotron-70b-instruct',
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
    assert.deepEqual(Object.keys(DEFAULT_MODELS).sort(), ['nvidia', 'ollama', 'openrouter', 'zen']);
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
