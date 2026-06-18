import { describe, expect, it } from 'vitest';
import {
  INITIAL_RESTORE_DETECTION_PLAN_STATE,
  planAutoBackRestoreDetection,
  type RestoreDetectionPlanState,
} from './useWorkspaceSandboxRestore';

describe('planAutoBackRestoreDetection', () => {
  it('schedules the first ready sandbox and marks it as probed', () => {
    const plan = planAutoBackRestoreDetection(INITIAL_RESTORE_DETECTION_PLAN_STATE, {
      sandboxId: 'sb-1',
      branch: ' feature/x ',
      enabled: true,
    });

    expect(plan.probe).toEqual({ sandboxId: 'sb-1', branch: 'feature/x' });
    expect(plan.state.probedSandboxIds).toEqual(['sb-1']);
  });

  it('does not schedule the same sandbox twice', () => {
    const state: RestoreDetectionPlanState = { probedSandboxIds: ['sb-1'] };
    const plan = planAutoBackRestoreDetection(state, {
      sandboxId: 'sb-1',
      branch: 'feature/x',
      enabled: true,
    });

    expect(plan.probe).toBeNull();
    expect(plan.state).toBe(state);
  });

  it('schedules a new sandbox id after a prior sandbox was probed', () => {
    const state: RestoreDetectionPlanState = { probedSandboxIds: ['sb-1'] };
    const plan = planAutoBackRestoreDetection(state, {
      sandboxId: 'sb-2',
      branch: 'feature/x',
      enabled: true,
    });

    expect(plan.probe).toEqual({ sandboxId: 'sb-2', branch: 'feature/x' });
    expect(plan.state.probedSandboxIds).toEqual(['sb-1', 'sb-2']);
  });

  it('does not schedule while disabled or missing required context', () => {
    const state: RestoreDetectionPlanState = { probedSandboxIds: [] };
    expect(
      planAutoBackRestoreDetection(state, {
        sandboxId: 'sb-1',
        branch: 'feature/x',
        enabled: false,
      }),
    ).toEqual({ state, probe: null });
    expect(
      planAutoBackRestoreDetection(state, {
        sandboxId: null,
        branch: 'feature/x',
        enabled: true,
      }),
    ).toEqual({ state, probe: null });
    expect(
      planAutoBackRestoreDetection(state, {
        sandboxId: 'sb-1',
        branch: '  ',
        enabled: true,
      }),
    ).toEqual({ state, probe: null });
  });
});
