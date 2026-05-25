import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { EXACT_REPEAT_LIMIT, evaluateLoopState } from '../../lib/loop-detection.ts';

const engineSource = readFileSync(new URL('../engine.ts', import.meta.url), 'utf8');

// Drift detector: the CLI must NOT re-grow a bespoke repeated-call breaker.
// The loop *decision* lives in lib/loop-detection.ts and the CLI must route
// through it. These assertions fail loudly if a future edit re-inlines a
// hard-coded threshold breaker in the engine instead of delegating.
describe('CLI loop-detection drift — no ad-hoc breaker', () => {
  it('engine delegates the loop decision to the shared lib/loop-detection oracle', () => {
    assert.match(
      engineSource,
      /from '\.\.\/lib\/loop-detection\.ts'/,
      'cli/engine.ts must import the shared loop-detection oracle',
    );
    assert.ok(
      engineSource.includes('evaluateLoopState('),
      'cli/engine.ts must call evaluateLoopState() to decide loop outcomes',
    );
  });

  it('engine no longer hard-codes the abort threshold inline', () => {
    // The old breaker was `const seen = ...; if (seen >= 3) { abort }`. The
    // threshold now comes from EXACT_REPEAT_LIMIT via the oracle. Guard
    // against any re-introduced inline numeric repeat-count comparison.
    assert.doesNotMatch(
      engineSource,
      /if\s*\(\s*seen\s*>=\s*\d+\s*\)/,
      'cli/engine.ts must not inline a `seen >= N` repeated-call abort',
    );
    assert.ok(
      engineSource.includes('EXACT_REPEAT_LIMIT'),
      'cli/engine.ts must source the abort threshold from EXACT_REPEAT_LIMIT',
    );
  });

  it('the abort drives off the oracle verdict, not a local count', () => {
    assert.ok(
      engineSource.includes("loopVerdict.action === 'abort'"),
      'cli/engine.ts must abort on the oracle verdict action',
    );
  });
});

// Behavioral pin: the relocated policy preserves the prior CLI abort threshold
// so the convergence is a refactor, not a silent behavior change.
describe('CLI loop-detection drift — preserved abort semantics', () => {
  it('aborts at the exact-repeat limit and not below', () => {
    assert.equal(
      evaluateLoopState({ exactRepeat: { count: EXACT_REPEAT_LIMIT - 1 } }).action,
      'none',
    );
    assert.equal(evaluateLoopState({ exactRepeat: { count: EXACT_REPEAT_LIMIT } }).action, 'abort');
  });

  it('keeps the abort enforced even while the near-duplicate ladder is dark', () => {
    const verdict = evaluateLoopState({
      exactRepeat: { count: EXACT_REPEAT_LIMIT },
      similarity: { value: 0.99, streak: 99 },
      similarityEnforced: false,
    });
    assert.equal(verdict.action, 'abort');
  });
});
