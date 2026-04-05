import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeadlessTaskBrief } from '../task-brief.ts';

describe('buildHeadlessTaskBrief', () => {
  it('uses the shared delegation brief shape for headless tasks', () => {
    const brief = buildHeadlessTaskBrief('Fix the auth retry bug', ['npm test -- auth', 'npm run lint']);

    assert.ok(brief.includes('Task: Fix the auth retry bug'));
    assert.ok(brief.includes('Acceptance checks:'));
    assert.ok(brief.includes('accept_1: Exit 0: npm test -- auth'));
    assert.ok(brief.includes('accept_2: Exit 0: npm run lint'));
  });

  it('keeps simple tasks compact when there are no acceptance checks', () => {
    const brief = buildHeadlessTaskBrief('Trace the auth flow');
    assert.equal(brief, 'Task: Trace the auth flow');
  });
});
