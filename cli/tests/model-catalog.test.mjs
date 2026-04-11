import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  getCuratedModels,
  fetchModels,
  DEFAULT_MODELS,
  OPENROUTER_MODELS,
  OLLAMA_MODELS,
  NVIDIA_MODELS,
  ZEN_MODELS,
  KILOCODE_MODELS,
  BLACKBOX_MODELS,
  OPENADAPTER_MODELS,
} from '../model-catalog.ts';

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

  it('returns Nvidia models', () => {
    const models = getCuratedModels('nvidia');
    assert.ok(models.length > 0);
    assert.deepEqual(models, NVIDIA_MODELS);
  });

  it('returns OpenAdapter models', () => {
    const models = getCuratedModels('openadapter');
    assert.ok(models.length > 0);
    assert.deepEqual(models, OPENADAPTER_MODELS);
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
      NVIDIA_MODELS,
      extractExportedStringArray(providerModelsSource, 'NVIDIA_MODELS'),
    );
    assert.deepEqual(
      KILOCODE_MODELS,
      extractExportedStringArray(providerModelsSource, 'KILOCODE_MODELS'),
    );
    assert.deepEqual(
      BLACKBOX_MODELS,
      extractExportedStringArray(providerModelsSource, 'BLACKBOX_MODELS'),
    );
    assert.deepEqual(
      OPENADAPTER_MODELS,
      extractExportedStringArray(providerModelsSource, 'OPENADAPTER_MODELS'),
    );
  });

  it('keeps the CLI provider defaults in sync with the web catalog', () => {
    assert.deepEqual(DEFAULT_MODELS, {
      ollama: extractExportedStringConstant(providerModelsSource, 'OLLAMA_DEFAULT_MODEL'),
      openrouter: extractExportedStringConstant(providerModelsSource, 'OPENROUTER_DEFAULT_MODEL'),
      zen: extractExportedStringConstant(providerModelsSource, 'ZEN_DEFAULT_MODEL'),
      nvidia: extractExportedStringConstant(providerModelsSource, 'NVIDIA_DEFAULT_MODEL'),
      kilocode: extractExportedStringConstant(providerModelsSource, 'KILOCODE_DEFAULT_MODEL'),
      blackbox: extractExportedStringConstant(providerModelsSource, 'BLACKBOX_DEFAULT_MODEL'),
      openadapter: extractExportedStringConstant(providerModelsSource, 'OPENADAPTER_DEFAULT_MODEL'),
    });
  });
});

describe('DEFAULT_MODELS', () => {
  // Hardcoded expected values — not cross-referencing PROVIDER_CONFIGS
  // because those are env-overridable at import time.
  const EXPECTED = {
    ollama: 'gemini-3-flash-preview',
    openrouter: 'anthropic/claude-sonnet-4.6:nitro',
    zen: 'big-pickle',
    nvidia: 'nvidia/llama-3.1-nemotron-70b-instruct',
    kilocode: 'google/gemini-3-flash-preview',
    blackbox: 'blackbox-ai',
    openadapter: 'deepseek/deepseek-v3',
  };

  it('has correct hardcoded defaults', () => {
    for (const [id, expected] of Object.entries(EXPECTED)) {
      assert.equal(DEFAULT_MODELS[id], expected, `DEFAULT_MODELS.${id} should be "${expected}"`);
    }
  });

  it('covers all providers', () => {
    assert.deepEqual(Object.keys(DEFAULT_MODELS).sort(), [
      'blackbox',
      'kilocode',
      'nvidia',
      'ollama',
      'openadapter',
      'openrouter',
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
