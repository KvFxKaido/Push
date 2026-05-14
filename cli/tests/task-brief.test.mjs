import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeadlessTaskBrief } from '../task-brief.ts';

describe('buildHeadlessTaskBrief', () => {
  it('uses the shared delegation brief shape for headless tasks', () => {
    const brief = buildHeadlessTaskBrief('Fix the auth retry bug', [
      'npm test -- auth',
      'npm run lint',
    ]);

    assert.ok(brief.includes('Task: Fix the auth retry bug'));
    assert.ok(brief.includes('Acceptance checks:'));
    assert.ok(brief.includes('accept_1: Exit 0: npm test -- auth'));
    assert.ok(brief.includes('accept_2: Exit 0: npm run lint'));
  });

  it('lists the coder capability grant so the agent sees its scope', () => {
    // Headless tasks always target the Coder role — the brief must
    // surface that grant so the delegated agent knows what it can and
    // cannot do, rather than learning by hitting ROLE_CAPABILITY_DENIED.
    const brief = buildHeadlessTaskBrief('Trace the auth flow');
    assert.ok(
      brief.startsWith('Task: Trace the auth flow'),
      `brief should start with the task line, got: ${brief}`,
    );
    assert.ok(
      brief.includes('Capabilities:'),
      `brief should include a Capabilities line, got: ${brief}`,
    );
    assert.ok(
      brief.includes('edit files'),
      `brief should mention the coder write grant, got: ${brief}`,
    );
  });

  it('renders the [USER_GOAL] block above the task when userGoal option is set', () => {
    // CLI parity (PR follow-up for #550): per-node delegation briefs
    // must surface the user goal so the Coder sees the same constraint
    // the planner was bound by.
    const brief = buildHeadlessTaskBrief('Trace the auth flow', [], {
      userGoal: { initialAsk: 'restore the auth regression' },
      addresses: 'Initial ask',
    });
    const goalIdx = brief.indexOf('[USER_GOAL]');
    const taskIdx = brief.indexOf('Task: Trace the auth flow');
    assert.ok(goalIdx >= 0, `brief should include a [USER_GOAL] block, got: ${brief}`);
    assert.ok(taskIdx > goalIdx, 'Task: line should appear after the goal block');
    assert.ok(brief.includes('Initial ask: restore the auth regression'));
    assert.ok(brief.includes('Addresses: Initial ask'));
  });

  it('omits goal + addresses when the options object is empty (legacy CLI calls)', () => {
    // Calls that pre-date this parity work pass only (task, checks).
    // Their behavior must remain byte-identical.
    const beforeOpts = buildHeadlessTaskBrief('Trace the auth flow', []);
    const withEmptyOpts = buildHeadlessTaskBrief('Trace the auth flow', [], {});
    assert.equal(beforeOpts, withEmptyOpts);
    assert.ok(!withEmptyOpts.includes('[USER_GOAL]'));
    assert.ok(!withEmptyOpts.includes('Addresses:'));
  });
});
