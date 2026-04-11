import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkingMemory,
  formatCoderStateDiff,
  shouldInjectCoderStateOnToolResult,
} from '../../lib/working-memory.ts';

describe('shared working-memory helpers', () => {
  it('injects on first sync when state exists', () => {
    const state = createWorkingMemory();
    state.plan = 'Investigate auth failure';

    assert.equal(shouldInjectCoderStateOnToolResult(state, null, 1, 2_000, 120_000, null), true);
  });

  it('does not reinject unchanged state under low pressure before cadence', () => {
    const state = createWorkingMemory();
    state.plan = 'Fix regression';

    assert.equal(shouldInjectCoderStateOnToolResult(state, state, 3, 2_000, 120_000, 2), false);
  });

  it('reinjects unchanged state under elevated context pressure', () => {
    const state = createWorkingMemory();
    state.plan = 'Fix regression';

    assert.equal(shouldInjectCoderStateOnToolResult(state, state, 3, 90_000, 120_000, 2), true);
  });

  it('reinjects unchanged state on the long-task cadence', () => {
    const state = createWorkingMemory();
    state.plan = 'Fix regression';

    assert.equal(shouldInjectCoderStateOnToolResult(state, state, 10, 2_000, 120_000, 4), true);
  });

  it('formats a compact state delta when only one field changed', () => {
    const previous = createWorkingMemory();
    previous.plan = 'Refactor auth';
    previous.openTasks = ['Update tests'];

    const current = createWorkingMemory();
    current.plan = 'Refactor auth';
    current.openTasks = ['Update tests', 'Tighten types'];

    const diff = formatCoderStateDiff(current, previous, 4);
    assert.ok(diff.includes('[CODER_STATE delta]'));
    assert.ok(diff.includes('Open tasks: Update tests; Tighten types'));
    assert.ok(!diff.includes('Plan: Refactor auth'));
  });
});
