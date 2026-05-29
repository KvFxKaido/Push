import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BLOCKS_BEFORE_COMPACT,
  EXACT_REPEAT_LIMIT,
  evaluateLoopState,
  SIMILARITY_BLOCK_HITS,
  SIMILARITY_WARN_HITS,
} from '../../lib/loop-detection.ts';

const engineSource = readFileSync(new URL('../engine.ts', import.meta.url), 'utf8');
// The web round loop spans two modules: chat-send.ts (calls handleLoopVerdict)
// and chat-send-helpers.ts (which owns checkLoopBreaker + handleLoopVerdict and
// consumes buildLoopSteeringText). Treat both as the "web surface" so the
// drift check tracks the implementation wherever the max-lines extraction puts
// it.
const webSendSource =
  readFileSync(new URL('../../app/src/hooks/chat-send.ts', import.meta.url), 'utf8') +
  '\n' +
  readFileSync(new URL('../../app/src/hooks/chat-send-helpers.ts', import.meta.url), 'utf8');
const coderSource = readFileSync(new URL('../../lib/coder-agent.ts', import.meta.url), 'utf8');
const oracleSource = readFileSync(new URL('../../lib/loop-detection.ts', import.meta.url), 'utf8');

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

// Graded enforcement drift: all three surfaces must route the warn/block/compact
// steering through the shared `buildLoopSteeringText` builder and must NOT
// re-inline the [LOOP_*] copy. The tags live in exactly one place (the oracle).
describe('graded loop enforcement — shared steering vocabulary', () => {
  for (const [name, source] of [
    ['cli/engine.ts', engineSource],
    ['app/src/hooks/chat-send{,-helpers}.ts', webSendSource],
    ['lib/coder-agent.ts', coderSource],
  ]) {
    it(`${name} consumes the shared buildLoopSteeringText builder`, () => {
      assert.ok(
        source.includes('buildLoopSteeringText'),
        `${name} must build steering copy via buildLoopSteeringText`,
      );
    });

    it(`${name} does not re-inline the [LOOP_*] steering tags`, () => {
      assert.doesNotMatch(
        source,
        /\[LOOP_(DETECTED|BLOCKED|COMPACT)\]/,
        `${name} must not hard-code loop steering copy — it belongs in lib/loop-detection.ts`,
      );
    });
  }

  it('the [LOOP_*] steering tags are defined exactly once, in the oracle', () => {
    for (const tag of ['[LOOP_DETECTED]', '[LOOP_BLOCKED]', '[LOOP_COMPACT]']) {
      assert.ok(oracleSource.includes(tag), `oracle must define ${tag}`);
    }
  });
});

// Behavioral pin: the full graded ladder advances warn → block → compact → abort
// as run-level state accrues. Locks the cross-surface escalation contract so a
// future edit can't silently collapse a rung.
describe('graded loop enforcement — full ladder', () => {
  const sim = { value: 0.9, streak: SIMILARITY_BLOCK_HITS };
  it('warns at the warn boundary when enforced', () => {
    assert.equal(
      evaluateLoopState({
        similarity: { value: 0.9, streak: SIMILARITY_WARN_HITS },
        similarityEnforced: true,
      }).action,
      'warn',
    );
  });
  it('blocks, then compacts after enough blocks, then aborts post-compact', () => {
    assert.equal(
      evaluateLoopState({ similarity: sim, blocksIssued: 0, similarityEnforced: true }).action,
      'block',
    );
    assert.equal(
      evaluateLoopState({
        similarity: sim,
        blocksIssued: BLOCKS_BEFORE_COMPACT - 1,
        similarityEnforced: true,
      }).action,
      'compact',
    );
    assert.equal(
      evaluateLoopState({ similarity: sim, compactsIssued: 1, similarityEnforced: true }).action,
      'abort',
    );
  });
  it('keeps the entire near-duplicate ladder dark when not enforced', () => {
    assert.equal(
      evaluateLoopState({ similarity: sim, blocksIssued: BLOCKS_BEFORE_COMPACT - 1 }).action,
      'none',
    );
  });
});
