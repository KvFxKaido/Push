// Drift + behavior test for the reasoning-heavy model registry.
//
// `lib/reasoning-models.ts` is the single source of truth for "does this model
// think for a long time before it speaks?" (CLAUDE.md "one source of truth per
// vocabulary"). The cases below are drawn from the real provider catalogs in
// `lib/provider-models.ts` so a catalog id shape we actually ship can't quietly
// fall on the wrong side of the predicate. The split also pins the deliberate
// scope: glm-5.x / kimi-k2.x / deepseek-r1 in, the older glm-4.x line and the
// frontier non-R1 models out.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isReasoningHeavyModel,
  reasoningHeavyFamily,
  REASONING_HEAVY_MODEL_MATCHERS,
} from '../../lib/reasoning-models.ts';

// Heavy reasoners — every id shape the catalogs use: bare, vendor-prefixed,
// `:nitro`-suffixed, and the Fireworks `p`-decimal slugs.
const HEAVY = [
  ['glm-5', 'glm-5'],
  ['glm-5.1', 'glm-5'],
  ['glm-5-turbo', 'glm-5'],
  ['z-ai/glm-5:nitro', 'glm-5'],
  ['z-ai/glm-5.1:nitro', 'glm-5'],
  ['accounts/fireworks/models/glm-5p1', 'glm-5'],
  ['accounts/fireworks/models/glm-5p2', 'glm-5'],
  ['kimi-k2', 'kimi-k2'],
  ['kimi-k2.5', 'kimi-k2'],
  ['kimi-k2.6', 'kimi-k2'],
  ['moonshotai/kimi-k2.5:nitro', 'kimi-k2'],
  ['accounts/fireworks/models/kimi-k2p7-code', 'kimi-k2'],
  ['accounts/fireworks/models/kimi-k2p6', 'kimi-k2'],
  ['deepseek-r1', 'deepseek-r1'],
  ['deepseek/deepseek-r1', 'deepseek-r1'],
  ['deepseek-ai/deepseek-r1', 'deepseek-r1'],
];

// NOT heavy — the older GLM line, non-R1 DeepSeek, and frontier models that
// don't (per observed evidence) need the patient affordance. Keeping these out
// is the point of the anchored matcher.
const NOT_HEAVY = [
  'z-ai/glm-4.7:nitro',
  'glm-4.7',
  'glm-50', // adjacent digit must not be read as glm-5
  'deepseek-v4-pro',
  'deepseek/deepseek-v3.2:nitro',
  'claude-opus-4.8',
  'gpt-5.4',
  'gpt-5.4-codex',
  'gemini-3.5-flash',
  'qwen3.6-plus',
  'minimax-m3',
  'kimi-k1.5', // a hypothetical older Kimi line is not k2
];

describe('reasoning-heavy model registry', () => {
  it('flags every known heavy-reasoner id shape', () => {
    for (const [id] of HEAVY) {
      assert.equal(isReasoningHeavyModel(id), true, `expected heavy: ${id}`);
    }
  });

  it('is case-insensitive', () => {
    assert.equal(isReasoningHeavyModel('Z-AI/GLM-5.1:Nitro'), true);
    assert.equal(isReasoningHeavyModel('Kimi-K2.6'), true);
  });

  it('does not flag non-heavy models (glm-4.x, non-R1 DeepSeek, frontier)', () => {
    for (const id of NOT_HEAVY) {
      assert.equal(isReasoningHeavyModel(id), false, `expected NOT heavy: ${id}`);
    }
  });

  it('returns false for a null/undefined/empty id rather than throwing', () => {
    assert.equal(isReasoningHeavyModel(null), false);
    assert.equal(isReasoningHeavyModel(undefined), false);
    assert.equal(isReasoningHeavyModel(''), false);
  });

  it('attributes the matched family for logs/telemetry', () => {
    for (const [id, family] of HEAVY) {
      assert.equal(reasoningHeavyFamily(id), family, `family mismatch: ${id}`);
    }
    assert.equal(reasoningHeavyFamily('gpt-5.4'), null);
    assert.equal(reasoningHeavyFamily(null), null);
  });

  it('every matcher carries a documenting note (self-documenting table)', () => {
    for (const m of REASONING_HEAVY_MODEL_MATCHERS) {
      assert.ok(m.family.length > 0, 'family handle required');
      assert.ok(m.note.length > 0, `matcher ${m.family} needs a note`);
      assert.ok(m.pattern instanceof RegExp, `matcher ${m.family} needs a RegExp`);
    }
  });
});
