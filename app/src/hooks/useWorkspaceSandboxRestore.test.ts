import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Effect = () => void | (() => void);
type RefCell = { current: unknown };
type StateCell = { value: unknown };

const reactState = vi.hoisted(() => ({
  refs: [] as RefCell[],
  refIndex: 0,
  states: [] as StateCell[],
  stateIndex: 0,
  effects: [] as Effect[],
}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useEffect: (fn: Effect) => {
    reactState.effects.push(fn);
  },
  useRef: <T>(initial: T) => {
    const i = reactState.refIndex++;
    if (!reactState.refs[i]) reactState.refs[i] = { current: initial };
    return reactState.refs[i] as { current: T };
  },
  useState: <T>(initial: T | (() => T)) => {
    const i = reactState.stateIndex++;
    if (!reactState.states[i]) {
      const seed = typeof initial === 'function' ? (initial as () => T)() : initial;
      reactState.states[i] = { value: seed };
    }
    const cell = reactState.states[i];
    const setter = (value: T | ((prev: T) => T)) => {
      cell.value = typeof value === 'function' ? (value as (prev: T) => T)(cell.value as T) : value;
    };
    return [cell.value as T, setter];
  },
}));

const {
  INITIAL_RESTORE_DETECTION_PLAN_STATE,
  planAutoBackRestoreDetection,
  useWorkspaceSandboxRestore,
} = await import('./useWorkspaceSandboxRestore');
type RestoreDetectionPlanState = import('./useWorkspaceSandboxRestore').RestoreDetectionPlanState;
type UseWorkspaceSandboxRestoreArgs =
  import('./useWorkspaceSandboxRestore').UseWorkspaceSandboxRestoreArgs;
type WorkspaceSandboxRestoreState =
  import('./useWorkspaceSandboxRestore').WorkspaceSandboxRestoreState;

const REPO = 'owner/repo';
const SEP = String.fromCharCode(0); // the planner joins the scope key on NUL
const scopeKey = (sandboxId: string, branch: string): string =>
  `${sandboxId}${SEP}${REPO}${SEP}${branch}`;
const SCOPE_X = scopeKey('sb-1', 'feature/x');

function renderRestore(
  overrides: Partial<UseWorkspaceSandboxRestoreArgs> = {},
): WorkspaceSandboxRestoreState {
  reactState.refIndex = 0;
  reactState.stateIndex = 0;
  reactState.effects = [];
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useWorkspaceSandboxRestore({
    sandboxId: 'sb-1',
    branch: 'feature/x',
    repoFullName: REPO,
    enabled: true,
    detect: vi.fn(async () => ({ available: false as const })),
    apply: vi.fn(async () => ({ status: 'unsupported' as const })),
    ...overrides,
  });
}

async function runEffects(): Promise<void> {
  const effects = reactState.effects.splice(0);
  for (const effect of effects) effect();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  reactState.refs = [];
  reactState.refIndex = 0;
  reactState.states = [];
  reactState.stateIndex = 0;
  reactState.effects = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe('useWorkspaceSandboxRestore auto restore', () => {
  it('quietly applies an available checkpoint and suppresses the banner on success', async () => {
    const detect = vi.fn(async () => ({
      available: true as const,
      checkpointId: 'checkpoint-1',
      summary: '2 files changed',
    }));
    const apply = vi.fn(async () => ({
      status: 'restored' as const,
      checkpointId: 'checkpoint-1',
    }));

    renderRestore({ detect, apply });
    await runEffects();
    const view = renderRestore({ detect, apply });

    expect(detect).toHaveBeenCalledWith({
      sandboxId: 'sb-1',
      branch: 'feature/x',
      repoFullName: REPO,
    });
    expect(apply).toHaveBeenCalledWith({
      sandboxId: 'sb-1',
      branch: 'feature/x',
      repoFullName: REPO,
      checkpointId: 'checkpoint-1',
    });
    expect(view.available).toBe(false);
    expect(view.summary).toBe('');
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('checkpoint_auto_restore_restored'),
    );
  });

  it('shows the existing restore banner when auto restore refuses a dirty target', async () => {
    const detect = vi.fn(async () => ({
      available: true as const,
      checkpointId: 'checkpoint-1',
      summary: '2 files changed',
    }));
    const apply = vi.fn(async () => ({ status: 'skipped-dirty' as const }));

    renderRestore({ detect, apply });
    await runEffects();
    const view = renderRestore({ detect, apply });

    expect(view.available).toBe(true);
    expect(view.summary).toBe('2 files changed');
    expect(view.error).toBe('Restore skipped because the workspace changed.');
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('checkpoint_auto_restore_deferred'),
    );
  });

  it('shows the restore banner when auto restore throws after detection succeeds', async () => {
    const detect = vi.fn(async () => ({
      available: true as const,
      checkpointId: 'checkpoint-1',
      summary: '2 files changed',
    }));
    const apply = vi.fn(async () => {
      throw new Error('transport failed');
    });

    renderRestore({ detect, apply });
    await runEffects();
    const view = renderRestore({ detect, apply });

    expect(view.available).toBe(true);
    expect(view.error).toBe('transport failed');
  });

  it('does not call restore when no checkpoint is available', async () => {
    const detect = vi.fn(async () => ({ available: false as const, reason: 'no_checkpoint' }));
    const apply = vi.fn(async () => ({
      status: 'restored' as const,
      checkpointId: 'checkpoint-1',
    }));

    renderRestore({ detect, apply });
    await runEffects();
    const view = renderRestore({ detect, apply });

    expect(apply).not.toHaveBeenCalled();
    expect(view.available).toBe(false);
  });
});
