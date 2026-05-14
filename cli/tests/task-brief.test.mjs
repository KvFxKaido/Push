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
});
