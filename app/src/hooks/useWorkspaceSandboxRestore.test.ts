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
type CheckpointRestoreAvailability =
  import('@/lib/checkpoint/checkpoint-store').CheckpointRestoreAvailability;

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
  // The hand-rolled React mock reuses ref/state cells by hook order between
  // renderRestore calls. If the hook's useRef/useState order changes, update
  // this harness deliberately instead of trusting positional reuse by accident.
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

function startEffects(limit: number = reactState.effects.length): void {
  const effects = reactState.effects.splice(0, limit);
  for (const effect of effects) effect();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
      sourceRef: 'draft/auto/feature/x',
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
    // Quiet success means no session-context line either — the work is back,
    // there is nothing for the lead to be warned about.
    expect(view.contextLine).toBeNull();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('checkpoint_auto_restore_restored'),
    );
  });

  it('surfaces the banner AND the session-context line when auto restore defers', async () => {
    const detect = vi.fn(async () => ({
      available: true as const,
      checkpointId: 'checkpoint-1',
      summary: '2 files changed',
      sourceRef: 'draft/auto/feature/x',
    }));
    const apply = vi.fn(async () => ({ status: 'skipped-dirty' as const }));

    renderRestore({ detect, apply });
    await runEffects();
    const view = renderRestore({ detect, apply });

    expect(view.available).toBe(true);
    expect(view.contextLine).toBe(
      'Unpushed work from this chat exists at origin ref draft/auto/feature/x; explicit restore is available.',
    );
  });

  it('does not dispatch auto restore after the live lane scope changes', async () => {
    const availability = deferred<CheckpointRestoreAvailability>();
    const detect = vi.fn(() => availability.promise);
    const apply = vi.fn(async () => ({
      status: 'restored' as const,
      checkpointId: 'checkpoint-1',
    }));

    renderRestore({ detect, apply });
    startEffects();

    // Warm branch switches can preserve the same sandbox. The stale detect
    // result must not apply feature/x's checkpoint into feature/y.
    renderRestore({ branch: 'feature/y', detect, apply });
    startEffects(1);
    availability.resolve({
      available: true,
      checkpointId: 'checkpoint-1',
      summary: '2 files changed',
      sourceRef: 'draft/auto/feature/x',
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(apply).not.toHaveBeenCalled();
    expect(renderRestore({ branch: 'feature/y', detect, apply }).available).toBe(false);
  });

  it('shows the existing restore banner when auto restore refuses a dirty target', async () => {
    const detect = vi.fn(async () => ({
      available: true as const,
      checkpointId: 'checkpoint-1',
      summary: '2 files changed',
      sourceRef: 'draft/auto/feature/x',
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
      sourceRef: 'draft/auto/feature/x',
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

  it('does not attach a stale manual-restore completion to a newly installed lane offer', async () => {
    // fugu warning on #1572: a lane change during the manual restore's await
    // can install a NEW branch's offer; the old completion must not mutate it.
    const manualApply = deferred<{ status: 'restored'; checkpointId: string }>();
    let manualPhase = false;
    const apply = vi.fn(async () => {
      if (manualPhase) return manualApply.promise;
      return { status: 'skipped-dirty' as const };
    });
    const detect = vi.fn(async (input: { branch: string }) =>
      input.branch === 'feature/x'
        ? {
            available: true as const,
            checkpointId: 'checkpoint-x',
            summary: 'x summary',
            sourceRef: 'draft/auto/feature/x',
          }
        : {
            available: true as const,
            checkpointId: 'checkpoint-y',
            summary: 'y summary',
            sourceRef: 'draft/auto/feature/y',
          },
    );

    renderRestore({ detect, apply });
    await runEffects();
    let view = renderRestore({ detect, apply });
    expect(view.available).toBe(true);

    manualPhase = true;
    const pendingRestore = view.restore();

    // The lane switches while the manual restore is in flight; feature/y's
    // detection installs its own offer (its auto-apply also defers on dirty).
    manualPhase = false;
    renderRestore({ branch: 'feature/y', detect, apply });
    await runEffects();

    manualPhase = true;
    manualApply.reject(new Error('transport failed'));
    await pendingRestore;

    view = renderRestore({ branch: 'feature/y', detect, apply });
    expect(view.available).toBe(true);
    expect(view.summary).toBe('y summary');
    // Without the invoked-scope guard, the stale completion writes
    // 'transport failed' into feature/y's fresh offer.
    expect(view.error).not.toBe('transport failed');
  });

  it('explicit restore retry logs its own paired events after an auto-defer', async () => {
    const detect = vi.fn(async () => ({
      available: true as const,
      checkpointId: 'checkpoint-1',
      summary: '2 files changed',
      sourceRef: 'draft/auto/feature/x',
    }));
    // Auto attempt defers on dirty; the user-triggered retry succeeds.
    const apply = vi
      .fn()
      .mockResolvedValueOnce({ status: 'skipped-dirty' as const })
      .mockResolvedValueOnce({ status: 'restored' as const, checkpointId: 'checkpoint-1' });

    renderRestore({ detect, apply });
    await runEffects();
    let view = renderRestore({ detect, apply });
    expect(view.available).toBe(true);

    await view.restore();
    view = renderRestore({ detect, apply });
    expect(view.available).toBe(false);
    expect(view.contextLine).toBeNull();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('checkpoint_restore_restored'),
    );
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
