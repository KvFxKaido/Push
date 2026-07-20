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
  reasoningHeavyStreamOpts,
  REASONING_HEAVY_FIRST_TOKEN_GRACE_MS,
  REASONING_HEAVY_MODEL_MATCHERS,
  isSparseStreamingModel,
  effectiveActivityTimeoutMs,
  effectiveFirstTokenGraceMs,
  SPARSE_STREAMING_MODEL_MATCHERS,
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
  ['kimi-k3', 'kimi-k3'],
  ['kimi-k3.1', 'kimi-k3'],
  ['moonshotai/kimi-k3', 'kimi-k3'],
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

describe('reasoningHeavyStreamOpts', () => {
  it('always opts reasoning into the activity timer, model-independent', () => {
    // The reset is unconditional: a non-reasoner never emits reasoning_delta,
    // so it is a no-op for them, and gating it would re-expose an unlisted
    // reasoning model to the unresponsive kill.
    assert.equal(reasoningHeavyStreamOpts('gpt-5.4').reasoningResetsActivityTimer, true);
    assert.equal(reasoningHeavyStreamOpts('glm-5.1').reasoningResetsActivityTimer, true);
    assert.equal(reasoningHeavyStreamOpts(null).reasoningResetsActivityTimer, true);
  });

  it('grants the first-token grace ONLY to a known heavy reasoner', () => {
    assert.equal(
      reasoningHeavyStreamOpts('z-ai/glm-5.1:nitro').firstTokenGraceMs,
      REASONING_HEAVY_FIRST_TOKEN_GRACE_MS,
    );
    assert.equal(
      reasoningHeavyStreamOpts('kimi-k2.6').firstTokenGraceMs,
      REASONING_HEAVY_FIRST_TOKEN_GRACE_MS,
    );
    // Non-heavy and missing ids get no grace key — the caller's single window
    // (timeoutMs) stands, so this can only widen a window, never tighten one.
    assert.equal('firstTokenGraceMs' in reasoningHeavyStreamOpts('gpt-5.4'), false);
    assert.equal('firstTokenGraceMs' in reasoningHeavyStreamOpts('glm-4.7'), false);
    assert.equal('firstTokenGraceMs' in reasoningHeavyStreamOpts(undefined), false);
  });
});

describe('sparse-streaming model registry', () => {
  // Sakana Fugu id shapes the catalog ships: bare, ultra tier, vendor-prefixed.
  const SPARSE = ['fugu', 'fugu-ultra', 'sakana/fugu', 'Fugu-Ultra'];
  // A heavy reasoner streams its thinking (reasoning_delta), so it is NOT
  // sparse — the two axes are distinct. Plus unrelated tokens must not match.
  const NOT_SPARSE = ['glm-5.1', 'kimi-k2.6', 'deepseek-r1', 'gpt-5.4', 'fuguito', 'configure'];

  it('flags every Fugu id shape', () => {
    for (const id of SPARSE) {
      assert.equal(isSparseStreamingModel(id), true, `expected sparse: ${id}`);
    }
  });

  it('does not flag non-sparse models or unrelated tokens', () => {
    for (const id of NOT_SPARSE) {
      assert.equal(isSparseStreamingModel(id), false, `expected NOT sparse: ${id}`);
    }
  });

  it('returns false for null/undefined/empty rather than throwing', () => {
    assert.equal(isSparseStreamingModel(null), false);
    assert.equal(isSparseStreamingModel(undefined), false);
    assert.equal(isSparseStreamingModel(''), false);
  });

  it('every matcher carries a documenting note', () => {
    for (const m of SPARSE_STREAMING_MODEL_MATCHERS) {
      assert.ok(m.family.length > 0, 'family handle required');
      assert.ok(m.note.length > 0, `matcher ${m.family} needs a note`);
      assert.ok(m.pattern instanceof RegExp, `matcher ${m.family} needs a RegExp`);
    }
  });
});

describe('effectiveActivityTimeoutMs (widen-only)', () => {
  const ACTIVITY = 60_000;
  const WALL_CLOCK = 180_000;

  it('relaxes a sparse streamer to the wall-clock', () => {
    assert.equal(effectiveActivityTimeoutMs('fugu', ACTIVITY, WALL_CLOCK), WALL_CLOCK);
    assert.equal(effectiveActivityTimeoutMs('sakana/fugu', ACTIVITY, WALL_CLOCK), WALL_CLOCK);
  });

  it('keeps the default tight window for every other model', () => {
    // Liveness correctness must not depend on table completeness: an unlisted
    // model (heavy reasoner, frontier, or null) keeps the tight activity window.
    assert.equal(effectiveActivityTimeoutMs('glm-5.1', ACTIVITY, WALL_CLOCK), ACTIVITY);
    assert.equal(effectiveActivityTimeoutMs('gpt-5.4', ACTIVITY, WALL_CLOCK), ACTIVITY);
    assert.equal(effectiveActivityTimeoutMs(null, ACTIVITY, WALL_CLOCK), ACTIVITY);
  });

  it('is widen-only — never returns less than the default', () => {
    // Even if a caller (hypothetically) passed a wall-clock below the activity
    // window, the relaxation must not tighten the window.
    assert.equal(effectiveActivityTimeoutMs('fugu', 60_000, 30_000), 60_000);
  });
});

describe('effectiveFirstTokenGraceMs (widen-only)', () => {
  const GRACE = 90_000;
  const WALL_CLOCK = 180_000;

  it('relaxes a sparse streamer to the wall-clock so a silent start is tolerated', () => {
    // The Codex P2: a sparse round can stay silent BEFORE the first token (the
    // grace window fires, not the activity timeout). Both must collapse onto the
    // wall-clock for the wall-clock to be the genuine sole bound.
    assert.equal(effectiveFirstTokenGraceMs('fugu', GRACE, WALL_CLOCK), WALL_CLOCK);
    assert.equal(effectiveFirstTokenGraceMs('sakana/fugu', GRACE, WALL_CLOCK), WALL_CLOCK);
  });

  it('keeps the default grace for every other model', () => {
    assert.equal(effectiveFirstTokenGraceMs('glm-5.1', GRACE, WALL_CLOCK), GRACE);
    assert.equal(effectiveFirstTokenGraceMs('gpt-5.4', GRACE, WALL_CLOCK), GRACE);
    assert.equal(effectiveFirstTokenGraceMs(null, GRACE, WALL_CLOCK), GRACE);
  });

  it('is widen-only — never returns less than the default grace', () => {
    assert.equal(effectiveFirstTokenGraceMs('fugu', 90_000, 30_000), 90_000);
  });
});
