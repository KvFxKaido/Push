import { describe, expect, it } from 'vitest';
import {
  INITIAL_RESTORE_DETECTION_PLAN_STATE,
  planAutoBackRestoreDetection,
  type RestoreDetectionPlanState,
} from './useWorkspaceSandboxRestore';

const REPO = 'owner/repo';
const SEP = String.fromCharCode(0); // the planner joins the scope key on NUL
const scopeKey = (sandboxId: string, branch: string): string =>
  `${sandboxId}${SEP}${REPO}${SEP}${branch}`;
const SCOPE_X = scopeKey('sb-1', 'feature/x');

describe('planAutoBackRestoreDetection', () => {
  it('schedules the first ready lane and marks its scope as probed', () => {
    const plan = planAutoBackRestoreDetection(INITIAL_RESTORE_DETECTION_PLAN_STATE, {
      sandboxId: 'sb-1',
      branch: ' feature/x ',
      repoFullName: REPO,
      enabled: true,
    });

    expect(plan.probe).toEqual({ sandboxId: 'sb-1', branch: 'feature/x', repoFullName: REPO });
    expect(plan.state.probedScopes).toEqual([SCOPE_X]);
  });

  it('does not schedule the same lane twice', () => {
    const state: RestoreDetectionPlanState = { probedScopes: [SCOPE_X] };
    const plan = planAutoBackRestoreDetection(state, {
      sandboxId: 'sb-1',
      branch: 'feature/x',
      repoFullName: REPO,
      enabled: true,
    });

    expect(plan.probe).toBeNull();
    expect(plan.state).toBe(state);
  });

  it('re-probes a branch switch that keeps the same sandbox (Codex P2)', () => {
    // Typed branch switches preserve the sandbox; the checkpoint lane is scoped by
    // repo+branch, so the new branch must re-detect instead of being suppressed.
    const state: RestoreDetectionPlanState = { probedScopes: [SCOPE_X] };
    const plan = planAutoBackRestoreDetection(state, {
      sandboxId: 'sb-1',
      branch: 'feature/y',
      repoFullName: REPO,
      enabled: true,
    });

    expect(plan.probe).toEqual({ sandboxId: 'sb-1', branch: 'feature/y', repoFullName: REPO });
    expect(plan.state.probedScopes).toEqual([SCOPE_X, scopeKey('sb-1', 'feature/y')]);
  });

  it('schedules a new sandbox id after a prior lane was probed', () => {
    const state: RestoreDetectionPlanState = { probedScopes: [SCOPE_X] };
    const plan = planAutoBackRestoreDetection(state, {
      sandboxId: 'sb-2',
      branch: 'feature/x',
      repoFullName: REPO,
      enabled: true,
    });

    expect(plan.probe).toEqual({ sandboxId: 'sb-2', branch: 'feature/x', repoFullName: REPO });
    expect(plan.state.probedScopes).toEqual([SCOPE_X, scopeKey('sb-2', 'feature/x')]);
  });

  it('does not schedule while disabled or missing required context', () => {
    const state: RestoreDetectionPlanState = { probedScopes: [] };
    const base = { sandboxId: 'sb-1', branch: 'feature/x', repoFullName: REPO, enabled: true };
    expect(planAutoBackRestoreDetection(state, { ...base, enabled: false })).toEqual({
      state,
      probe: null,
    });
    expect(planAutoBackRestoreDetection(state, { ...base, sandboxId: null })).toEqual({
      state,
      probe: null,
    });
    expect(planAutoBackRestoreDetection(state, { ...base, branch: '  ' })).toEqual({
      state,
      probe: null,
    });
    // repoFullName is required — the native store keys its on-device dir on it.
    expect(planAutoBackRestoreDetection(state, { ...base, repoFullName: null })).toEqual({
      state,
      probe: null,
    });
  });
});
