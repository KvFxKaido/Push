import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKPRESSURE_MUTATION_THRESHOLD,
  createCoderPolicy,
  isVerificationPhase,
} from '../../lib/coder-policy.ts';
import { classifyTurnIntent } from '../../lib/turn-intent.ts';

function makeCtx(round = 0, phase = undefined, taskInFlight = true) {
  return { round, maxRounds: 8, phase, taskInFlight };
}

describe('shared Coder policy — CLI vocabulary', () => {
  it('recognizes verification phases', () => {
    for (const phase of ['verifying', 'running tests', 'validation', 'typecheck', 'linting']) {
      assert.equal(isVerificationPhase(phase), true);
    }
    assert.equal(isVerificationPhase('implementing'), false);
  });

  it('blocks CLI file mutations during verification with a block intervention', async () => {
    const policy = createCoderPolicy();
    for (const tool of ['write_file', 'edit_file', 'undo_edit']) {
      const result = await policy.evaluateBeforeTool(tool, {}, makeCtx(2, 'verifying'));
      assert.equal(result?.action, 'deny');
      assert.equal(result?.runtimeIntervention.mode, 'block');
      assert.equal(result?.runtimeIntervention.point, 'before_tool');
    }
    assert.equal(await policy.evaluateBeforeTool('exec', {}, makeCtx(2, 'verifying')), null);
  });

  it('steers on first drift and blocks after consecutive drift', async () => {
    const policy = createCoderPolicy();
    const drifted = '\u592A\u5E73'.repeat(25) + '\n'.repeat(25) + 'Unrelated rambling.'.repeat(20);

    const first = await policy.evaluateAfterModel(drifted, [], makeCtx(0));
    assert.equal(first?.action, 'inject');
    assert.equal(first?.runtimeIntervention.mode, 'steer');

    const second = await policy.evaluateAfterModel(drifted, [], makeCtx(1));
    assert.equal(second?.action, 'halt');
    assert.equal(second?.runtimeIntervention.mode, 'block');
  });

  it('keeps task-only guards quiet for conversational turns', async () => {
    const policy = createCoderPolicy();
    const result = await policy.evaluateAfterModel(
      "I wasn't looping — want me to continue the explanation?",
      [],
      makeCtx(0, undefined, false),
    );
    assert.equal(result, null);
  });

  it('applies verification backpressure to CLI mutations and resets on exec', async () => {
    const policy = createCoderPolicy();
    const ctx = makeCtx();
    for (let i = 0; i < BACKPRESSURE_MUTATION_THRESHOLD - 1; i += 1) {
      assert.equal(
        await policy.evaluateAfterTool('edit_file', { path: `f${i}.ts` }, 'ok', false, ctx),
        null,
      );
    }
    const nudge = await policy.evaluateAfterTool(
      'edit_file',
      { path: 'last.ts' },
      'ok',
      false,
      ctx,
    );
    assert.equal(nudge?.action, 'inject');
    assert.equal(nudge?.code, 'verification_backpressure');

    await policy.evaluateAfterTool('exec', { command: 'npm test' }, 'ok', false, ctx);
    assert.equal(
      await policy.evaluateAfterTool('edit_file', { path: 'fresh.ts' }, 'ok', false, ctx),
      null,
    );
  });
});

describe('shared lead-turn intent', () => {
  it('separates conversational questions from coding tasks', () => {
    assert.equal(classifyTurnIntent('do you think we need more unification?'), 'conversational');
    assert.equal(classifyTurnIntent("let's document this and start #1"), 'task');
  });
});
