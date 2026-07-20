import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  getCuratedModels,
  fetchModels,
  DEFAULT_MODELS,
  OPENROUTER_MODELS,
  OLLAMA_MODELS,
  ZEN_MODELS,
  FIREWORKS_MODELS,
} from '../model-catalog.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function extractExportedStringArray(source, exportName) {
  const match = source.match(
    new RegExp(
      `export const ${exportName}(?::\\s*string\\[\\])?\\s*=\\s*\\[([\\s\\S]*?)\\r?\\n\\];`,
    ),
  );
  assert.ok(match, `Expected to find exported array ${exportName}`);
  // Match string literals and constant references (e.g. ZEN_DEFAULT_MODEL)
  return [...match[1].matchAll(/'([^']+)'|([A-Z_][A-Z0-9_]+)/g)].map(([, literal, constRef]) => {
    if (literal) return literal;
    // Resolve the constant reference from the same source file
    const constMatch = source.match(new RegExp(`export const ${constRef}\\s*=\\s*'([^']+)';`));
    assert.ok(constMatch, `Expected to resolve constant ${constRef} referenced in ${exportName}`);
    return constMatch[1];
  });
}

function extractExportedStringConstant(source, exportName) {
  const match = source.match(new RegExp(`export const ${exportName}\\s*=\\s*'([^']+)';`));
  assert.ok(match, `Expected to find exported string constant ${exportName}`);
  return match[1];
}

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

  it('returns empty array for unknown provider', () => {
    assert.deepEqual(getCuratedModels('unknown'), []);
    assert.deepEqual(getCuratedModels(''), []);
    assert.deepEqual(getCuratedModels(undefined), []);
  });
});

describe('catalog parity', () => {
  // Read from the shared source of truth where the arrays are actually defined
  const providerModelsSource = readFileSync(
    new URL('../../lib/provider-models.ts', import.meta.url),
    'utf8',
  );

  it('keeps the shared curated model lists in sync with the web catalog', () => {
    assert.deepEqual(
      OPENROUTER_MODELS,
      extractExportedStringArray(providerModelsSource, 'OPENROUTER_MODELS'),
    );
    assert.deepEqual(ZEN_MODELS, extractExportedStringArray(providerModelsSource, 'ZEN_MODELS'));
    assert.deepEqual(
      FIREWORKS_MODELS,
      extractExportedStringArray(providerModelsSource, 'FIREWORKS_MODELS'),
    );
  });

  it('keeps the CLI provider defaults in sync with the web catalog', () => {
    assert.deepEqual(DEFAULT_MODELS, {
      ollama: extractExportedStringConstant(providerModelsSource, 'OLLAMA_DEFAULT_MODEL'),
      openrouter: extractExportedStringConstant(providerModelsSource, 'OPENROUTER_DEFAULT_MODEL'),
      zai: extractExportedStringConstant(providerModelsSource, 'ZAI_DEFAULT_MODEL'),
      kimi: extractExportedStringConstant(providerModelsSource, 'KIMI_DEFAULT_MODEL'),
      huggingface: extractExportedStringConstant(providerModelsSource, 'HUGGINGFACE_DEFAULT_MODEL'),
      zen: extractExportedStringConstant(providerModelsSource, 'ZEN_DEFAULT_MODEL'),
      fireworks: extractExportedStringConstant(providerModelsSource, 'FIREWORKS_DEFAULT_MODEL'),
      deepseek: extractExportedStringConstant(providerModelsSource, 'DEEPSEEK_DEFAULT_MODEL'),
      sakana: extractExportedStringConstant(providerModelsSource, 'SAKANA_DEFAULT_MODEL'),
      openai: extractExportedStringConstant(providerModelsSource, 'OPENAI_DEFAULT_MODEL'),
      xai: extractExportedStringConstant(providerModelsSource, 'XAI_DEFAULT_MODEL'),
      anthropic: extractExportedStringConstant(providerModelsSource, 'ANTHROPIC_DEFAULT_MODEL'),
      google: extractExportedStringConstant(providerModelsSource, 'GOOGLE_DEFAULT_MODEL'),
    });
  });
});

describe('DEFAULT_MODELS', () => {
  // Hardcoded expected values — not cross-referencing PROVIDER_CONFIGS
  // because those are env-overridable at import time.
  const EXPECTED = {
    ollama: 'minimax-m3',
    openrouter: 'anthropic/claude-sonnet-4.6:nitro',
    zai: 'glm-5.2',
    kimi: 'kimi-k2.7-code-highspeed',
    huggingface: 'deepseek-ai/DeepSeek-V4-Pro',
    zen: 'big-pickle',
    fireworks: 'accounts/fireworks/models/deepseek-v4-pro',
    deepseek: 'deepseek-v4-pro',
    sakana: 'fugu',
    openai: 'gpt-5.4',
    xai: 'grok-4.5',
    anthropic: 'claude-sonnet-4-6',
    google: 'gemini-3.5-flash',
  };

  it('has correct hardcoded defaults', () => {
    for (const [id, expected] of Object.entries(EXPECTED)) {
      assert.equal(DEFAULT_MODELS[id], expected, `DEFAULT_MODELS.${id} should be "${expected}"`);
    }
  });

  it('covers all providers', () => {
    assert.deepEqual(Object.keys(DEFAULT_MODELS).sort(), [
      'anthropic',
      'deepseek',
      'fireworks',
      'google',
      'huggingface',
      'kimi',
      'ollama',
      'openai',
      'openrouter',
      'sakana',
      'xai',
      'zai',
      'zen',
    ]);
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

describe('fetchModels', () => {
  it('derives the OpenAI models URL from the Responses endpoint', async () => {
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'gpt-test' }] }),
      };
    };

    const result = await fetchModels(
      { id: 'openai', url: 'https://api.openai.com/v1/responses' },
      'sk-test',
    );

    assert.equal(capturedUrl, 'https://api.openai.com/v1/models');
    assert.deepEqual(result, { models: ['gpt-test'], source: 'live' });
  });
});
