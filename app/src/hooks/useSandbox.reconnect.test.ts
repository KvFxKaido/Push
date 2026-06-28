// Regression test for the "infinite reconnecting spinner on refresh" bug.
//
// The saved-session reconnect effect in useSandbox sets status to
// 'reconnecting' itself. Before the fix, `status` was in the effect's
// dependency array, so that write re-ran the effect and the prior run's
// cleanup flipped `cancelled = true` on the in-flight liveness probe — the
// probe's `.then`/`.catch` then no-oped and status was stranded at
// 'reconnecting' forever.
//
// The sibling useSandbox.test.ts mocks React with a runtime whose useEffect
// ignores dependency arrays and never re-runs effects, so it structurally
// CANNOT reproduce this. This file provides a minimal *dependency-aware*
// hooks runtime (still node-only, no DOM) that re-runs effects on dep change
// exactly like React — enough to make the self-cancel observable.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Module mocks (mirror useSandbox.test.ts; needed so the module loads) ---
const sandboxClient = vi.hoisted(() => ({
  createSandbox: vi.fn(),
  cleanupSandbox: vi.fn(),
  execInSandbox: vi.fn(),
  setSandboxOwnerToken: vi.fn(),
  getSandboxOwnerToken: vi.fn<() => string | null>(() => null),
  setActiveSandboxEnvironment: vi.fn(),
  clearSandboxEnvironment: vi.fn(),
  probeSandboxEnvironment: vi.fn(),
  hibernateSandbox: vi.fn(),
  restoreFromSnapshot: vi.fn(),
  msSinceLastSandboxCall: vi.fn(() => 0),
  hasInFlightSandboxCalls: vi.fn(() => false),
  suppressIdleTouch: vi.fn(),
}));

const safeStorage = vi.hoisted(() => ({
  get: vi.fn<(k: string) => string | null>(() => null),
  set: vi.fn(),
  remove: vi.fn(),
}));

const fileLedger = vi.hoisted(() => ({ reset: vi.fn() }));
const symbolLedger = vi.hoisted(() => ({
  reset: vi.fn(),
  setRepo: vi.fn(),
  hydrate: vi.fn(async () => {}),
  clearRepo: vi.fn(async () => {}),
}));
const cacheLib = vi.hoisted(() => ({
  clearFileVersionCache: vi.fn(),
  clearSandboxWorkspaceRevision: vi.fn(),
}));
const ghAuth = vi.hoisted(() => ({
  getActiveGitHubTokenInfo: vi.fn(() => ({ token: '', kind: 'none' as const })),
  isDurableUserToken: vi.fn(
    (kind: string) => kind === 'oauth' || kind === 'pat' || kind === 'env' || kind === 'unknown',
  ),
  isInstallationToken: vi.fn((kind: string) => kind === 'app'),
  APP_TOKEN_STORAGE_KEY: 'github_app_token',
}));
const repoCoverage = vi.hoisted(() => ({
  checkRepoCoverage: vi.fn(async () => ({
    coverage: 'covered' as const,
    installUrl: undefined as string | undefined,
  })),
}));
const sandboxSession = vi.hoisted(() => ({
  buildSandboxSessionStorageKey: vi.fn<(repo?: string | null, branch?: string | null) => string>(
    (repo, branch) => `sbx:${repo}:${branch}`,
  ),
  clearSandboxSessionByStorageKey: vi.fn(),
  loadSandboxSession: vi.fn<() => unknown>(() => null),
  saveSandboxSession: vi.fn(),
  touchSandboxSessionActivity: vi.fn(),
  isSavedSessionRecoverable: vi.fn<() => boolean>(() => true),
  decideReconnectProbe: vi.fn((args: { savedSandboxId: string; now: number }) => ({
    probe: true,
    nextAttempt: { sandboxId: args.savedSandboxId, at: args.now, attempts: 1 },
  })),
  shouldRetryReconnect: vi.fn(() => false),
}));
const checkpointGate = vi.hoisted(() => ({ nativeCheckpointsActive: vi.fn(() => false) }));

// --- Minimal dependency-aware hooks runtime (the key difference from the
// sibling test: useEffect honours deps and re-runs on change). ---
type EffectHook = {
  kind: 'effect';
  hasRun: boolean;
  deps: unknown[] | undefined;
  nextDeps: unknown[] | undefined;
  pending: (() => void | (() => void)) | undefined;
  cleanup: (() => void) | undefined;
};
type StateHook = { kind: 'state'; value: unknown };
type RefHook = { kind: 'ref'; current: unknown };
type MemoHook = { kind: 'memo'; deps: unknown[] | undefined; value: unknown };
type AnyHook = EffectHook | StateHook | RefHook | MemoHook;

const RT = vi.hoisted(() => {
  const store: { hooks: unknown[]; idx: number; scheduled: boolean } = {
    hooks: [],
    idx: 0,
    scheduled: false,
  };
  const depsEqual = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((x, i) => Object.is(x, b[i]));

  const react = {
    useState: <T>(initial: T | (() => T)) => {
      const i = store.idx++;
      if (!store.hooks[i]) {
        const seed = typeof initial === 'function' ? (initial as () => T)() : initial;
        store.hooks[i] = { kind: 'state', value: seed } satisfies StateHook;
      }
      const hook = store.hooks[i] as StateHook;
      const set = (v: T | ((prev: T) => T)) => {
        const next = typeof v === 'function' ? (v as (prev: T) => T)(hook.value as T) : v;
        if (!Object.is(next, hook.value)) {
          hook.value = next;
          store.scheduled = true;
        }
      };
      return [hook.value as T, set] as const;
    },
    useRef: <T>(initial: T) => {
      const i = store.idx++;
      if (!store.hooks[i]) store.hooks[i] = { kind: 'ref', current: initial } satisfies RefHook;
      return store.hooks[i] as { current: T };
    },
    useMemo: <T>(fn: () => T, deps: unknown[]) => {
      const i = store.idx++;
      const prev = store.hooks[i] as MemoHook | undefined;
      if (!prev || !depsEqual(prev.deps, deps)) {
        store.hooks[i] = { kind: 'memo', deps, value: fn() } satisfies MemoHook;
      }
      return (store.hooks[i] as MemoHook).value as T;
    },
    useCallback: <T extends (...args: never[]) => unknown>(fn: T, deps: unknown[]) =>
      react.useMemo(() => fn, deps),
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const i = store.idx++;
      if (!store.hooks[i]) {
        store.hooks[i] = {
          kind: 'effect',
          hasRun: false,
          deps: undefined,
          nextDeps: undefined,
          pending: undefined,
          cleanup: undefined,
        } satisfies EffectHook;
      }
      const hook = store.hooks[i] as EffectHook;
      hook.pending = fn;
      hook.nextDeps = deps;
    },
  };

  // Render the hook body to stability, committing effects (with dep compare)
  // after each pass and looping while a state setter scheduled a re-render.
  const flush = <T>(body: () => T): T => {
    let result: T;
    let guard = 0;
    do {
      store.scheduled = false;
      store.idx = 0;
      result = body();
      for (const raw of store.hooks) {
        const hook = raw as AnyHook | undefined;
        if (!hook || hook.kind !== 'effect' || !hook.pending) continue;
        const changed = !hook.hasRun || !depsEqual(hook.deps, hook.nextDeps);
        if (changed) {
          if (typeof hook.cleanup === 'function') hook.cleanup();
          hook.cleanup = (hook.pending() as (() => void) | undefined) ?? undefined;
          hook.deps = hook.nextDeps;
          hook.hasRun = true;
        }
        hook.pending = undefined;
      }
      if (++guard > 200) throw new Error('flush did not stabilize (render loop)');
    } while (store.scheduled);
    return result!;
  };

  const reset = () => {
    store.hooks = [];
    store.idx = 0;
    store.scheduled = false;
  };

  return { react, flush, reset };
});

vi.mock('react', () => RT.react);
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock('@/lib/sandbox-client', () => sandboxClient);
vi.mock('@/lib/safe-storage', () => ({
  safeStorageGet: (k: string) => safeStorage.get(k),
  safeStorageSet: (k: string, v: string) => safeStorage.set(k, v),
  safeStorageRemove: (k: string) => safeStorage.remove(k),
}));
vi.mock('@/lib/file-awareness-ledger', () => ({ fileLedger }));
vi.mock('@/lib/symbol-persistence-ledger', () => ({ symbolLedger }));
vi.mock('@/lib/sandbox-file-version-cache', () => cacheLib);
vi.mock('@/lib/github-auth', () => ghAuth);
vi.mock('@/lib/github-repo-coverage', () => repoCoverage);
vi.mock('@/lib/sandbox-session', () => sandboxSession);
vi.mock('@/lib/checkpoint/checkpoint-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/checkpoint/checkpoint-store')>();
  return { ...actual, nativeCheckpointsActive: checkpointGate.nativeCheckpointsActive };
});

// This runtime actually runs effects (the sibling harness doesn't), so the
// hook's visibilitychange/online listeners need a minimal DOM event target.
const noopEventTarget = { addEventListener: () => {}, removeEventListener: () => {} };
(globalThis as unknown as { document: unknown }).document ??= noopEventTarget;
(globalThis as unknown as { window: unknown }).window ??= noopEventTarget;

const { useSandbox } = await import('./useSandbox');

const flushMicrotasks = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllTimers();
  vi.useFakeTimers();
  Object.values(sandboxClient).forEach((m) => {
    if (typeof m === 'function' && 'mockReset' in m) (m as { mockReset: () => void }).mockReset();
  });
  sandboxClient.getSandboxOwnerToken.mockReturnValue(null);
  sandboxClient.msSinceLastSandboxCall.mockReturnValue(0);
  sandboxClient.hasInFlightSandboxCalls.mockReturnValue(false);
  sandboxClient.probeSandboxEnvironment.mockResolvedValue(undefined);
  safeStorage.get.mockReturnValue(null);
  Object.values(symbolLedger).forEach((m) => (m as { mockReset?: () => void }).mockReset?.());
  symbolLedger.hydrate.mockResolvedValue(undefined);
  Object.values(sandboxSession).forEach((m) => (m as { mockReset?: () => void }).mockReset?.());
  sandboxSession.buildSandboxSessionStorageKey.mockImplementation(
    (repo, branch) => `sbx:${repo}:${branch}`,
  );
  sandboxSession.isSavedSessionRecoverable.mockReturnValue(true);
  sandboxSession.decideReconnectProbe.mockImplementation(
    (args: { savedSandboxId: string; now: number }) => ({
      probe: true,
      nextAttempt: { sandboxId: args.savedSandboxId, at: args.now, attempts: 1 },
    }),
  );
  checkpointGate.nativeCheckpointsActive.mockReturnValue(false);
  RT.reset();
});

describe('useSandbox reconnect — survives self-induced re-render', () => {
  it('reaches ready after setting its own status to reconnecting (no infinite spinner)', async () => {
    const now = Date.now();
    sandboxSession.loadSandboxSession.mockReturnValue({
      sandboxId: 'sb-saved',
      ownerToken: 'owner-tok',
      repoFullName: 'owner/repo',
      branch: 'main',
      createdAt: now,
      lastActivityAt: now,
    });

    // A deferred probe so the status→'reconnecting' write (and the re-render
    // it triggers) lands BEFORE the probe resolves — the exact interleaving
    // that the old code self-cancelled on.
    let resolveProbe!: (r: {
      stdout: string;
      stderr: string;
      exitCode: number;
      truncated: boolean;
    }) => void;
    sandboxClient.execInSandbox.mockReturnValue(
      new Promise((res) => {
        resolveProbe = res;
      }),
    );

    const render = () => RT.flush(() => useSandbox('owner/repo', 'main'));

    // Mount: reconnect effect starts the probe and schedules the deferred
    // 'reconnecting' write.
    render();
    expect(sandboxClient.execInSandbox).toHaveBeenCalledWith('sb-saved', 'true');

    // Fire the setTimeout(0): status → 'reconnecting', re-rendering the hook.
    // In the old code this re-ran the reconnect effect and cancelled the probe.
    vi.advanceTimersByTime(0);
    let hook = render();
    expect(hook.status).toBe('reconnecting');

    // The container is alive — the probe succeeds.
    resolveProbe({ stdout: '', stderr: '', exitCode: 0, truncated: false });
    await flushMicrotasks();
    hook = render();

    // The probe must have been allowed to complete: status reaches 'ready'
    // and the saved sandbox is adopted (rather than stranded at 'reconnecting').
    expect(hook.status).toBe('ready');
    expect(hook.sandboxId).toBe('sb-saved');
  });
});
