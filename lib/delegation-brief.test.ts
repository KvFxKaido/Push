import { describe, expect, it } from 'vitest';
import { buildDelegationBrief } from './delegation-brief.ts';
import type { UserGoalAnchor } from './user-goal-anchor.ts';

const anchor: UserGoalAnchor = {
  initialAsk: 'ship the goal anchor feature',
  currentWorkingGoal: 'narrow to the file store',
};

describe('buildDelegationBrief — goal layering (PR follow-up)', () => {
  it('omits the goal block when no userGoal is supplied (legacy delegations)', () => {
    const brief = buildDelegationBrief({ task: 'fix the bug' });
    expect(brief).not.toContain('[USER_GOAL]');
    expect(brief.startsWith('Task: fix the bug')).toBe(true);
  });

  it('renders the [USER_GOAL] block before the task when userGoal is set', () => {
    const brief = buildDelegationBrief({
      task: 'fix the bug',
      userGoal: anchor,
    });
    const goalIdx = brief.indexOf('[USER_GOAL]');
    const taskIdx = brief.indexOf('Task: fix the bug');
    expect(goalIdx).toBeGreaterThanOrEqual(0);
    expect(taskIdx).toBeGreaterThan(goalIdx);
    expect(brief).toContain('Initial ask: ship the goal anchor feature');
    expect(brief).toContain('Current working goal: narrow to the file store');
  });

  it('renders Addresses immediately after Task when set', () => {
    const brief = buildDelegationBrief({
      task: 'investigate the controller',
      addresses: 'Initial ask',
      userGoal: anchor,
    });
    const taskIdx = brief.indexOf('Task: investigate the controller');
    const addressesIdx = brief.indexOf('Addresses: Initial ask');
    expect(addressesIdx).toBeGreaterThan(taskIdx);
  });

  it('omits Addresses when only userGoal is set without per-node rationale', () => {
    const brief = buildDelegationBrief({
      task: 'investigate the controller',
      userGoal: anchor,
    });
    expect(brief).not.toContain('Addresses:');
  });

  it('keeps prior brief fields (Intent, Deliverable, etc.) after Addresses', () => {
    const brief = buildDelegationBrief({
      task: 'investigate the controller',
      addresses: 'Initial ask',
      intent: 'find the desync source',
      deliverable: 'A short report identifying the line that triggers restart',
      userGoal: anchor,
    });
    const addressesIdx = brief.indexOf('Addresses:');
    const intentIdx = brief.indexOf('Intent:');
    const deliverableIdx = brief.indexOf('Deliverable:');
    expect(addressesIdx).toBeGreaterThan(0);
    expect(intentIdx).toBeGreaterThan(addressesIdx);
    expect(deliverableIdx).toBeGreaterThan(intentIdx);
  });

  it('treats whitespace-only Addresses as absent (no line rendered)', () => {
    const brief = buildDelegationBrief({
      task: 't',
      addresses: '   \n\t  ',
      userGoal: anchor,
    });
    expect(brief).not.toContain('Addresses:');
  });
});
