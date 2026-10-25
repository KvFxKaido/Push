// Zen renamed its Claude ids (dotted → dashed). A stored selection must migrate
// through ZEN_RENAMED_MODELS wherever it is read; this pins the map against the
// catalog and drives the CLI's real read point (PROVIDER_CONFIGS.zen).
import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { PROVIDER_CONFIGS } from '../provider.ts';
import { ZEN_MODELS, ZEN_RENAMED_MODELS } from '../../lib/provider-models.ts';

const originalModel = process.env.PUSH_ZEN_MODEL;
afterEach(() => {
  if (originalModel === undefined) delete process.env.PUSH_ZEN_MODEL;
  else process.env.PUSH_ZEN_MODEL = originalModel;
});

test('every rename lands on a seeded id, and no retired id is still seeded', () => {
  for (const [from, to] of Object.entries(ZEN_RENAMED_MODELS)) {
    assert.ok(ZEN_MODELS.includes(to), `${from} → ${to}: target not in ZEN_MODELS`);
    assert.ok(!ZEN_MODELS.includes(from), `${from} is renamed but still seeded`);
  }
});

test('a configured dotted Zen Claude id migrates on the CLI', () => {
  process.env.PUSH_ZEN_MODEL = 'claude-opus-4.8';
  assert.equal(PROVIDER_CONFIGS.zen.defaultModel, 'claude-opus-4-8');
  // No successor on Zen: passed through, not swapped for another model.
  process.env.PUSH_ZEN_MODEL = 'claude-opus-4.1';
  assert.equal(PROVIDER_CONFIGS.zen.defaultModel, 'claude-opus-4.1');
  // Other providers are untouched by the Zen map.
  process.env.PUSH_OPENROUTER_MODEL = 'claude-opus-4.8';
  assert.equal(PROVIDER_CONFIGS.openrouter.defaultModel, 'claude-opus-4.8');
  delete process.env.PUSH_OPENROUTER_MODEL;
});
