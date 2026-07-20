import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubTokenKind } from '@/lib/github-auth';
import { USER_TOKEN_GATE_MESSAGE, formatRepoNotCoveredMessage } from '@/lib/sandbox-auth-gate';

const sandboxClient = vi.hoisted(() => ({
  createSandbox: vi.fn(),
  cleanupSandbox: vi.fn(),
  execInSandbox: vi.fn(),
  pingSandbox: vi.fn(),
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
  // Real predicate (pure string check) — the recovery branch relies on it to
  // classify a token-missing probe error as unrecoverable, mirroring the real
  // (unmocked) isDefinitivelyGone* classifiers.
  isMissingOwnerTokenError: (err: unknown) =>
    err instanceof Error &&
    err.message === 'Sandbox access token missing. Start or reconnect the sandbox session.',
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
  getActiveGitHubTokenInfo: vi.fn<() => { token: string; kind: GitHubTokenKind }>(() => ({
    token: '',
    kind: 'none',
  })),
  isDurableUserToken: vi.fn(
    (kind: string) => kind === 'oauth' || kind === 'pat' || kind === 'env' || kind === 'unknown',
  ),
  isInstallationToken: vi.fn((kind: string) => kind === 'app'),
  APP_TOKEN_STORAGE_KEY: 'github_app_token',
}));
const repoCoverage = vi.hoisted(() => ({
  checkRepoCoverage: vi.fn<
    (repo: string) => Promise<{
      coverage: 'covered' | 'not_covered' | 'unknown';
      installUrl?: string;
    }>
  >(async () => ({ coverage: 'covered', installUrl: undefined })),
}));
const sandboxSession = vi.hoisted(() => ({
  buildSandboxSessionStorageKey: vi.fn<(repo?: string | null, branch?: string | null) => string>(
    (repo, branch) => `sbx:${repo}:${branch}`,
  ),
  clearSandboxSessionByStorageKey: vi.fn(),
  loadSandboxSession: vi.fn<() => unknown>(() => null),
  saveSandboxSession: vi.fn(),
  touchSandboxSessionActivity: vi.fn(),
  markSandboxSessionMutated: vi.fn(),
  isSavedSessionRecoverable: vi.fn<() => boolean>(() => true),
  decideReconnectProbe: vi.fn((args: { savedSandboxId: string; now: number }) => ({
    probe: true,
    nextAttempt: { sandboxId: args.savedSandboxId, at: args.now, attempts: 1 },
  })),
  shouldRetryReconnect: vi.fn(() => false),
}));

// The native-recovery gate. Default OFF (web behavior); flipped per-test to
// assert the native shell skips every cloud-snapshot path.
const checkpointGate = vi.hoisted(() => ({ nativeCheckpointsActive: vi.fn(() => false) }));

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
vi.mock('@/lib/sandbox-mutation-signal', () => ({ onWorkspaceMutation: vi.fn(() => () => {}) }));
vi.mock('@/lib/checkpoint/checkpoint-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/checkpoint/checkpoint-store')>();
  return { ...actual, nativeCheckpointsActive: checkpointGate.nativeCheckpointsActive };
});

type Cell = { value: unknown };
const reactState = vi.hoisted(() => ({
  cells: [] as Cell[],
  index: 0,
  refs: [] as { current: unknown }[],
  refIndex: 0,
  effects: [] as Array<() => void | (() => void)>,
}));

vi.mock('react', () => ({
  useState: <T>(initial: T | (() => T)) => {
    const i = reactState.index++;
    if (!reactState.cells[i]) {
      const seed = typeof initial === 'function' ? (initial as () => T)() : initial;
      reactState.cells[i] = { value: seed };
    }
    const cell = reactState.cells[i];
    const setter = (v: T | ((prev: T) => T)) => {
      cell.value = typeof v === 'function' ? (v as (prev: T) => T)(cell.value as T) : v;
    };
    return [cell.value as T, setter];
  },
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useEffect: (fn: () => void | (() => void)) => {
    reactState.effects.push(fn);
  },
  useRef: <T>(initial: T) => {
    const i = reactState.refIndex++;
    if (!reactState.refs[i]) reactState.refs[i] = { current: initial };
    return reactState.refs[i] as { current: T };
  },
  useMemo: <T>(fn: () => T) => fn(),
}));

const { useSandbox } = await import('./useSandbox');

function render(
  repo: string | null = null,
  branch: string | null = null,
  defaultBranch: string | null = null,
) {
  reactState.index = 0;
  reactState.refIndex = 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useSandbox(repo, branch, defaultBranch);
}

async function runEffects(limit: number = reactState.effects.length): Promise<Array<() => void>> {
  const effects = reactState.effects.splice(0, limit);
  const cleanups: Array<() => void> = [];
  for (const effect of effects) {
    const cleanup = effect();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  }
  await Promise.resolve();
  await Promise.resolve();
  return cleanups;
}

// The hook syncs sandboxId/status into refs via useEffect. Our useEffect mock
// skips those, so tests call this after state transitions to keep the refs
// aligned with what real React would do after a re-render.
function syncRefsFromState() {
  // Mutate .current so closures that captured the ref object see the update.
  reactState.refs[0].current = reactState.cells[0].value;
  reactState.refs[2].current = reactState.cells[1].value;
}

beforeEach(() => {
  Object.values(sandboxClient).forEach((m) => {
    if (typeof m === 'function' && 'mockReset' in m) m.mockReset();
  });
  sandboxClient.getSandboxOwnerToken.mockReturnValue(null);
  sandboxClient.msSinceLastSandboxCall.mockReturnValue(0);
  sandboxClient.probeSandboxEnvironment.mockResolvedValue(null);
  Object.values(safeStorage).forEach((m) => m.mockReset());
  safeStorage.get.mockReturnValue(null);
  fileLedger.reset.mockReset();
  Object.values(symbolLedger).forEach((m) => m.mockReset());
  symbolLedger.hydrate.mockResolvedValue(undefined);
  symbolLedger.clearRepo.mockResolvedValue(undefined);
  cacheLib.clearFileVersionCache.mockReset();
  cacheLib.clearSandboxWorkspaceRevision.mockReset();
  ghAuth.getActiveGitHubTokenInfo.mockReset().mockReturnValue({ token: '', kind: 'none' });
  ghAuth.isDurableUserToken.mockClear();
  ghAuth.isInstallationToken.mockClear();
  repoCoverage.checkRepoCoverage
    .mockReset()
    .mockResolvedValue({ coverage: 'covered', installUrl: undefined });
  Object.values(sandboxSession).forEach((m) => m.mockReset());
  sandboxSession.buildSandboxSessionStorageKey.mockImplementation(
    (repo, branch) => `sbx:${repo}:${branch}`,
  );
  sandboxSession.loadSandboxSession.mockReturnValue(null);
  checkpointGate.nativeCheckpointsActive.mockReset().mockReturnValue(false);
  reactState.cells = [];
  reactState.index = 0;
  reactState.refs = [];
  reactState.refIndex = 0;
  reactState.effects = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSandbox — initial state', () => {
  it('returns idle with no sandbox id or error', () => {
    const hook = render('owner/repo', 'main');
    expect(hook.sandboxId).toBeNull();
    expect(hook.status).toBe('idle');
    expect(hook.error).toBeNull();
    expect(hook.snapshotInfo).toBeNull();
    expect(hook.createdAt).toBeNull();
  });

  it('exposes snapshotInfo when a saved snapshot with restoreToken exists', () => {
    sandboxSession.loadSandboxSession.mockReturnValue({
      sandboxId: 'sb-1',
      snapshotId: 'snap-1',
      restoreToken: 'tok',
      createdAt: 111,
      snapshotCreatedAt: 222,
    });
    const hook = render('owner/repo', 'main');
    expect(hook.snapshotInfo).toEqual({ snapshotId: 'snap-1', createdAt: 222 });
    expect(hook.createdAt).toBe(111);
  });

  it('treats a snapshot without a restoreToken as not-restorable', () => {
    sandboxSession.loadSandboxSession.mockReturnValue({
      sandboxId: 'sb-1',
      snapshotId: 'snap-1',
      createdAt: 111,
    });
    const hook = render('owner/repo', 'main');
    expect(hook.snapshotInfo).toBeNull();
  });
});

describe('useSandbox.start', () => {
  it('creates the sandbox, transitions to ready, and persists the session', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-new',
      ownerToken: 'owner-tok',
    });
    ghAuth.getActiveGitHubTokenInfo.mockReturnValue({ token: 'gh-token', kind: 'app' });
    const hook = render();
    const id = await hook.start('owner/repo', 'feature');
    expect(id).toBe('sb-new');
    expect(sandboxClient.createSandbox).toHaveBeenCalledWith(
      'owner/repo',
      'feature',
      'gh-token',
      undefined,
    );
    // sandboxId cell (0) and status cell (1)
    expect(reactState.cells[0].value).toBe('sb-new');
    expect(reactState.cells[1].value).toBe('ready');
    expect(sandboxSession.saveSandboxSession).toHaveBeenCalled();
  });

  it('syncs sandboxIdRef synchronously in start(), not only via the later effect', async () => {
    // Regression (Codex P2 on #1315): a mutating tool call dispatched right
    // after start() resolves — before React has run the sandboxId->ref sync
    // effect — must still see the correct id in the ref, or the workspace
    // mutation listener drops the session's first real mutation and a later
    // unmutated-session cold-start fast path can discard real work.
    // Deliberately does NOT call syncRefsFromState() first — that helper is
    // the manual stand-in for the effect this test is proving isn't required.
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-new',
      ownerToken: 'owner-tok',
    });
    const hook = render();
    await hook.start('owner/repo', 'feature');

    expect(reactState.refs[0].current).toBe('sb-new');
  });

  it('threads the active default branch into sandbox creation', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-new',
      ownerToken: 'owner-tok',
    });
    ghAuth.getActiveGitHubTokenInfo.mockReturnValue({ token: 'gh-token', kind: 'app' });
    const hook = render('owner/repo', 'develop', 'develop');

    const id = await hook.start('owner/repo', 'develop');

    expect(id).toBe('sb-new');
    expect(sandboxClient.createSandbox).toHaveBeenCalledWith(
      'owner/repo',
      'develop',
      'gh-token',
      undefined,
      'develop',
    );
  });

  it('does not send a GitHub token when repo is empty (scratch mode)', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-scratch',
      ownerToken: 'owner',
    });
    ghAuth.getActiveGitHubTokenInfo.mockReturnValue({ token: 'gh-token', kind: 'app' });
    const hook = render();
    await hook.start('', undefined);
    expect(sandboxClient.createSandbox).toHaveBeenCalledWith('', undefined, '', undefined);
  });

  it('blocks durable user-scoped repo tokens until the sandbox acknowledgment is set', async () => {
    ghAuth.getActiveGitHubTokenInfo.mockReturnValue({ token: 'ghp-user', kind: 'pat' });
    const hook = render();
    const id = await hook.start('owner/repo', 'main');
    expect(id).toBeNull();
    expect(sandboxClient.createSandbox).not.toHaveBeenCalled();
    expect(reactState.cells[1].value).toBe('error');
    expect(reactState.cells[2].value).toBe(USER_TOKEN_GATE_MESSAGE);
  });

  it('allows durable user-scoped repo tokens after acknowledgment', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-ack',
      ownerToken: 'owner-tok',
    });
    ghAuth.getActiveGitHubTokenInfo.mockReturnValue({ token: 'ghp-user', kind: 'pat' });
    safeStorage.get.mockImplementation((key: string) =>
      key === 'github_sandbox_user_token_ack' ? '1' : null,
    );
    const hook = render();
    const id = await hook.start('owner/repo', 'main');
    expect(id).toBe('sb-ack');
    expect(sandboxClient.createSandbox).toHaveBeenCalledWith(
      'owner/repo',
      'main',
      'ghp-user',
      undefined,
    );
  });

  it('blocks an App installation when it does not cover the repo, with an actionable message', async () => {
    ghAuth.getActiveGitHubTokenInfo.mockReturnValue({ token: 'ghs-inst', kind: 'app' });
    repoCoverage.checkRepoCoverage.mockResolvedValue({
      coverage: 'not_covered',
      installUrl: 'https://github.com/apps/push-agent/installations/new',
    });
    const hook = render();
    const id = await hook.start('owner/repo', 'main');
    expect(id).toBeNull();
    expect(sandboxClient.createSandbox).not.toHaveBeenCalled();
    expect(reactState.cells[1].value).toBe('error');
    expect(reactState.cells[2].value).toBe(
      formatRepoNotCoveredMessage(
        'owner/repo',
        'https://github.com/apps/push-agent/installations/new',
      ),
    );
  });

  it('proceeds when the App covers the repo (installation token, normal path)', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-cov',
      ownerToken: 'owner-tok',
    });
    ghAuth.getActiveGitHubTokenInfo.mockReturnValue({ token: 'ghs-inst', kind: 'app' });
    repoCoverage.checkRepoCoverage.mockResolvedValue({
      coverage: 'covered',
      installUrl: undefined,
    });
    const hook = render();
    const id = await hook.start('owner/repo', 'main');
    expect(id).toBe('sb-cov');
    expect(repoCoverage.checkRepoCoverage).toHaveBeenCalledWith('owner/repo');
  });

  it('transitions to error when the sandbox reports creation failure', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'error',
      error: 'boot failed',
    });
    const hook = render();
    const id = await hook.start('owner/repo', 'main');
    expect(id).toBeNull();
    expect(reactState.cells[1].value).toBe('error');
    expect(reactState.cells[2].value).toBe('boot failed');
  });

  it('captures thrown errors and reports them', async () => {
    sandboxClient.createSandbox.mockRejectedValue(new Error('network down'));
    const hook = render();
    const id = await hook.start('owner/repo', 'main');
    expect(id).toBeNull();
    expect(reactState.cells[1].value).toBe('error');
    expect(reactState.cells[2].value).toBe('network down');
  });

  it('probes and reuses an error-state sandbox when it is still alive', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'owner-tok',
    });
    const hook = render();
    await hook.start('owner/repo', 'main');
    syncRefsFromState();

    hook.markUnreachable('SANDBOX_UNREACHABLE');
    syncRefsFromState();
    sandboxClient.createSandbox.mockClear();
    sandboxClient.pingSandbox.mockResolvedValue(true);

    const id = await hook.start('owner/repo', 'main');

    expect(id).toBe('sb-1');
    expect(sandboxClient.pingSandbox).toHaveBeenCalledWith('sb-1');
    expect(sandboxClient.createSandbox).not.toHaveBeenCalled();
    expect(reactState.cells[1].value).toBe('ready');
    expect(reactState.cells[2].value).toBeNull();
  });

  it('restores a saved snapshot before replacing a definitively-gone error sandbox', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'owner-tok',
    });
    const hook = render();
    await hook.start('owner/repo', 'main');
    syncRefsFromState();

    hook.markUnreachable('Sandbox not found');
    syncRefsFromState();
    sandboxClient.createSandbox.mockClear();
    sandboxClient.pingSandbox.mockRejectedValue(new Error('Sandbox not found'));
    sandboxSession.loadSandboxSession.mockReturnValue({
      sandboxId: 'sb-1',
      ownerToken: 'owner-tok',
      repoFullName: 'owner/repo',
      branch: 'main',
      createdAt: 123,
      snapshotId: 'snap-1',
      restoreToken: 'restore-tok',
    });
    sandboxClient.restoreFromSnapshot.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-restored',
      ownerToken: 'owner-restored',
    });

    const id = await hook.start('owner/repo', 'main');

    expect(id).toBe('sb-restored');
    expect(sandboxClient.restoreFromSnapshot).toHaveBeenCalledWith('snap-1', 'restore-tok', {
      repoFullName: 'owner/repo',
      branch: 'main',
    });
    expect(sandboxClient.createSandbox).not.toHaveBeenCalled();
    expect(reactState.cells[0].value).toBe('sb-restored');
    expect(reactState.cells[1].value).toBe('ready');
  });

  it('skips restoring a snapshot and cold-starts when the session never mutated', async () => {
    sandboxClient.createSandbox
      .mockResolvedValueOnce({
        status: 'ready',
        sandboxId: 'sb-1',
        ownerToken: 'owner-tok',
      })
      .mockResolvedValueOnce({
        status: 'ready',
        sandboxId: 'sb-2',
        ownerToken: 'owner-tok-2',
      });
    const hook = render();
    await hook.start('owner/repo', 'main');
    syncRefsFromState();

    hook.markUnreachable('Sandbox not found');
    syncRefsFromState();
    sandboxClient.pingSandbox.mockRejectedValue(new Error('Sandbox not found'));
    // A real snapshot IS on offer — this proves the skip is driven by
    // hasMutated===false, not by an absent snapshot.
    sandboxSession.loadSandboxSession.mockReturnValue({
      sandboxId: 'sb-1',
      ownerToken: 'owner-tok',
      repoFullName: 'owner/repo',
      branch: 'main',
      createdAt: 123,
      snapshotId: 'snap-1',
      restoreToken: 'restore-tok',
      hasMutated: false,
    });

    const id = await hook.start('owner/repo', 'main');

    expect(id).toBe('sb-2');
    expect(sandboxClient.restoreFromSnapshot).not.toHaveBeenCalled();
    expect(sandboxClient.createSandbox).toHaveBeenCalledTimes(2);
    expect(reactState.cells[0].value).toBe('sb-2');
    expect(reactState.cells[1].value).toBe('ready');
  });

  it('cold-starts after retiring a definitively-gone error sandbox without a snapshot', async () => {
    sandboxClient.createSandbox
      .mockResolvedValueOnce({
        status: 'ready',
        sandboxId: 'sb-1',
        ownerToken: 'owner-tok',
      })
      .mockResolvedValueOnce({
        status: 'ready',
        sandboxId: 'sb-2',
        ownerToken: 'owner-tok-2',
      });
    const hook = render();
    await hook.start('owner/repo', 'main');
    syncRefsFromState();

    hook.markUnreachable('Sandbox not found');
    syncRefsFromState();
    sandboxClient.pingSandbox.mockRejectedValue(new Error('Sandbox not found'));

    const id = await hook.start('owner/repo', 'main');

    expect(id).toBe('sb-2');
    expect(sandboxSession.clearSandboxSessionByStorageKey).toHaveBeenCalledWith(
      'sbx:owner/repo:main',
      'sb-1',
    );
    expect(cacheLib.clearFileVersionCache).toHaveBeenCalledWith('sb-1');
    expect(sandboxClient.createSandbox).toHaveBeenCalledTimes(2);
    expect(reactState.cells[0].value).toBe('sb-2');
    expect(reactState.cells[1].value).toBe('ready');
  });

  it('keeps the id and clears error status on a transient (non-gone) probe failure', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'owner-tok',
    });
    const hook = render();
    await hook.start('owner/repo', 'main');
    syncRefsFromState();

    hook.markUnreachable('SANDBOX_UNREACHABLE');
    syncRefsFromState();
    sandboxClient.createSandbox.mockClear();
    // Non-definitive failure (timeout-style) — not "gone", not token-missing.
    sandboxClient.pingSandbox.mockRejectedValue(new Error('command timed out'));

    const id = await hook.start('owner/repo', 'main');

    expect(id).toBe('sb-1');
    expect(sandboxClient.createSandbox).not.toHaveBeenCalled();
    // Status resets to 'ready' so ensureSandbox's guard won't re-probe every call.
    expect(reactState.cells[1].value).toBe('ready');
    expect(reactState.cells[2].value).toBeNull();
  });

  it('retires and cold-starts when the probe throws a missing-owner-token error', async () => {
    // The web definitive-loss path clears the owner token but leaves the id, so
    // the recovery probe throws the local missing-token error. That is NOT
    // transient — it must fall through to restore/cold-start, not hand back the
    // corpse (Codex P1).
    sandboxClient.createSandbox
      .mockResolvedValueOnce({ status: 'ready', sandboxId: 'sb-1', ownerToken: 'owner-tok' })
      .mockResolvedValueOnce({ status: 'ready', sandboxId: 'sb-2', ownerToken: 'owner-tok-2' });
    const hook = render();
    await hook.start('owner/repo', 'main');
    syncRefsFromState();

    hook.markUnreachable('SANDBOX_UNREACHABLE');
    syncRefsFromState();
    sandboxClient.pingSandbox.mockRejectedValue(
      new Error('Sandbox access token missing. Start or reconnect the sandbox session.'),
    );

    const id = await hook.start('owner/repo', 'main');

    expect(id).toBe('sb-2');
    expect(sandboxClient.createSandbox).toHaveBeenCalledTimes(2);
    expect(reactState.cells[0].value).toBe('sb-2');
    expect(reactState.cells[1].value).toBe('ready');
  });
});

describe('useSandbox reconnect', () => {
  it('seeds the saved owner token before probing a saved sandbox', async () => {
    sandboxSession.loadSandboxSession.mockReturnValue({
      sandboxId: 'sb-saved',
      ownerToken: 'owner-tok',
      repoFullName: 'owner/repo',
      branch: 'main',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    sandboxClient.pingSandbox.mockResolvedValue(true);
    sandboxClient.execInSandbox.mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    render('owner/repo', 'main');
    const cleanups = await runEffects(3);

    expect(sandboxClient.setSandboxOwnerToken).toHaveBeenCalledWith('owner-tok');
    expect(sandboxClient.setSandboxOwnerToken).toHaveBeenCalledWith('owner-tok', 'sb-saved');
    expect(sandboxClient.pingSandbox).toHaveBeenCalledWith('sb-saved');
    expect(sandboxClient.setSandboxOwnerToken.mock.invocationCallOrder[0]).toBeLessThan(
      sandboxClient.pingSandbox.mock.invocationCallOrder[0],
    );

    cleanups.forEach((cleanup) => cleanup());
  });
});

describe('useSandbox.stop', () => {
  it('is a no-op when no sandbox is active', async () => {
    const hook = render();
    await hook.stop();
    expect(sandboxClient.cleanupSandbox).not.toHaveBeenCalled();
  });

  it('cleans up sandbox + ledgers + caches when a sandbox is active', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'tok',
    });
    const hook = render();
    await hook.start('owner/repo', 'main');
    syncRefsFromState();
    await hook.stop();
    expect(sandboxClient.cleanupSandbox).toHaveBeenCalledWith('sb-1');
    expect(fileLedger.reset).toHaveBeenCalled();
    expect(symbolLedger.reset).toHaveBeenCalled();
    expect(cacheLib.clearFileVersionCache).toHaveBeenCalledWith('sb-1');
    // Post-stop state: idle, no id, no error
    expect(reactState.cells[0].value).toBeNull();
    expect(reactState.cells[1].value).toBe('idle');
    expect(reactState.cells[2].value).toBeNull();
  });

  it('still clears local state when cleanup throws', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'tok',
    });
    sandboxClient.cleanupSandbox.mockRejectedValue(new Error('timeout'));
    const hook = render();
    await hook.start('owner/repo', 'main');
    syncRefsFromState();
    await hook.stop();
    expect(reactState.cells[0].value).toBeNull();
    expect(reactState.cells[1].value).toBe('idle');
  });
});

describe('useSandbox.rebindSessionRepo', () => {
  it('carries hasMutated forward onto the new branch key', async () => {
    // Regression (Codex P2 on #1315): branch-on-first-prompt's fork moves the
    // live session onto a new branch via this path, not saveSandboxSession.
    // Without carrying hasMutated forward here, the working branch's first
    // keep-warm snapshot has no `existing` record to read it from, lands
    // `undefined`, and the definitively-gone recovery skip never fires for
    // the unmutated session it exists for.
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'owner-tok',
    });
    const hook = render();
    await hook.start('owner/repo', 'main');

    // Simulate the record persisted under the cold-start key — saveSandboxSession
    // itself is mocked, so it never actually reaches safeStorage in this harness.
    safeStorage.get.mockImplementation((key: string) =>
      key === 'sbx:owner/repo:main'
        ? JSON.stringify({
            sandboxId: 'sb-1',
            ownerToken: 'owner-tok',
            repoFullName: 'owner/repo',
            branch: 'main',
            createdAt: 123,
            hasMutated: false,
          })
        : null,
    );
    sandboxClient.getSandboxOwnerToken.mockReturnValue('owner-tok');

    hook.rebindSessionRepo('owner/repo', 'feature/new-branch');

    expect(sandboxSession.saveSandboxSession).toHaveBeenLastCalledWith(
      'owner/repo',
      'feature/new-branch',
      expect.objectContaining({ sandboxId: 'sb-1', hasMutated: false }),
    );
  });

  it('is a no-op when no sandbox is active', () => {
    const hook = render();
    hook.rebindSessionRepo('owner/repo', 'feature/new-branch');
    expect(sandboxSession.saveSandboxSession).not.toHaveBeenCalled();
  });
});

describe('useSandbox.refresh', () => {
  it('returns false when no sandbox is active', async () => {
    const hook = render();
    const ok = await hook.refresh();
    expect(ok).toBe(false);
    expect(sandboxClient.pingSandbox).not.toHaveBeenCalled();
  });

  it('transitions to ready when the sandbox ping succeeds', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'tok',
    });
    sandboxClient.pingSandbox.mockResolvedValue(true);
    const hook = render();
    await hook.start('owner/repo', 'main');
    syncRefsFromState();
    const ok = await hook.refresh({ silent: true });
    expect(ok).toBe(true);
    expect(reactState.cells[1].value).toBe('ready');
  });

  it('clears the session when the ping returns a definitively-gone signal', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'tok',
    });
    sandboxClient.pingSandbox.mockRejectedValue(new Error('Sandbox not found'));
    const hook = render();
    await hook.start('owner/repo', 'main');
    syncRefsFromState();
    const ok = await hook.refresh({ silent: true });
    expect(ok).toBe(false);
    expect(reactState.cells[1].value).toBe('error');
    expect(sandboxSession.clearSandboxSessionByStorageKey).toHaveBeenCalled();
  });

  it('keeps a SILENT transient probe at ready (single strike does not flip the chip)', async () => {
    // The 60s health check is a silent probe. A single transient blip (timeout /
    // owner-token KV-lag / hiccup) on a live container must NOT
    // flip to 'error' — that hard-errored a healthy sandbox and stopped the
    // health-check loop (the "dies after ~2 min idle" report). Session is kept too.
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'tok',
    });
    sandboxClient.pingSandbox.mockRejectedValue(new Error('command timed out'));
    const hook = render();
    await hook.start('owner/repo', 'main');
    syncRefsFromState();
    sandboxSession.clearSandboxSessionByStorageKey.mockReset();
    const ok = await hook.refresh({ silent: true });
    expect(ok).toBe(false);
    expect(sandboxSession.clearSandboxSessionByStorageKey).not.toHaveBeenCalled();
    expect(reactState.cells[1].value).toBe('ready');
  });

  it('escalates a SILENT probe to error only after 3 consecutive transient strikes', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'tok',
    });
    sandboxClient.pingSandbox.mockRejectedValue(new Error('command timed out'));
    const hook = render();
    await hook.start('owner/repo', 'main');
    syncRefsFromState();

    await hook.refresh({ silent: true }); // strike 1
    expect(reactState.cells[1].value).toBe('ready');
    await hook.refresh({ silent: true }); // strike 2
    expect(reactState.cells[1].value).toBe('ready');
    await hook.refresh({ silent: true }); // strike 3 → surface
    expect(reactState.cells[1].value).toBe('error');
    // Session is still kept — only the UI surface escalated, not a teardown.
    expect(sandboxSession.clearSandboxSessionByStorageKey).not.toHaveBeenCalled();
  });

  it('a successful probe resets the transient strike counter', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'tok',
    });
    const hook = render();
    await hook.start('owner/repo', 'main');
    syncRefsFromState();

    sandboxClient.pingSandbox.mockRejectedValue(new Error('command timed out'));
    await hook.refresh({ silent: true }); // strike 1
    await hook.refresh({ silent: true }); // strike 2
    sandboxClient.pingSandbox.mockResolvedValue(true);
    await hook.refresh({ silent: true }); // success → resets counter
    expect(reactState.cells[1].value).toBe('ready');
    // Counter reset: two fresh transient strikes still hold at ready (would be
    // 'error' at strike >= 3 if the success hadn't reset it).
    sandboxClient.pingSandbox.mockRejectedValue(new Error('command timed out'));
    await hook.refresh({ silent: true }); // strike 1 (post-reset)
    await hook.refresh({ silent: true }); // strike 2 (post-reset)
    expect(reactState.cells[1].value).toBe('ready');
  });

  it('a user-initiated (non-silent) transient refresh surfaces error immediately', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'tok',
    });
    sandboxClient.pingSandbox.mockRejectedValue(new Error('command timed out'));
    const hook = render();
    await hook.start('owner/repo', 'main');
    syncRefsFromState();
    sandboxSession.clearSandboxSessionByStorageKey.mockReset();
    const ok = await hook.refresh(); // non-silent: the user asked, so don't swallow
    expect(ok).toBe(false);
    expect(reactState.cells[1].value).toBe('error');
    // Still transient → session kept, not torn down.
    expect(sandboxSession.clearSandboxSessionByStorageKey).not.toHaveBeenCalled();
  });
});

describe('useSandbox.markUnreachable', () => {
  it('transitions from ready to error with the provided reason', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'tok',
    });
    const hook = render();
    await hook.start('owner/repo', 'main');
    syncRefsFromState();
    hook.markUnreachable('sandbox is unreachable');
    expect(reactState.cells[1].value).toBe('error');
    expect(reactState.cells[2].value).toBe('sandbox is unreachable');
  });

  it('is a no-op when already in error', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'error',
      error: 'first',
    });
    const hook = render();
    await hook.start('owner/repo', 'main');
    syncRefsFromState();
    hook.markUnreachable('second');
    // error message is preserved from the initial failure
    expect(reactState.cells[2].value).toBe('first');
  });
});

describe('useSandbox — native local-only recovery (Increment 2)', () => {
  it('manual hibernate is a no-op on native and never ships WIP to the cloud', async () => {
    checkpointGate.nativeCheckpointsActive.mockReturnValue(true);
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'tok',
    });
    const hook = render('owner/repo', 'main');
    await hook.start('owner/repo', 'main');
    syncRefsFromState();

    const ok = await hook.hibernate();
    expect(ok).toBe(false);
    // The whole point: no snapshot call to Modal on the native shell.
    expect(sandboxClient.hibernateSandbox).not.toHaveBeenCalled();
  });

  it('retires the dead id to idle on a definitively-gone refresh (so ensureSandbox cold-starts)', async () => {
    checkpointGate.nativeCheckpointsActive.mockReturnValue(true);
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'tok',
    });
    sandboxClient.pingSandbox.mockRejectedValue(new Error('Sandbox not found'));
    const hook = render('owner/repo', 'main');
    await hook.start('owner/repo', 'main');
    syncRefsFromState();

    const ok = await hook.refresh({ silent: true });
    expect(ok).toBe(false);
    // Unlike web (which parks at 'error' and keeps the id for snapshot restore),
    // native clears the corpse: sandboxId → null, status → idle.
    expect(reactState.cells[0].value).toBeNull();
    expect(reactState.cells[1].value).toBe('idle');
    expect(reactState.cells[2].value).toBeNull();
    expect(sandboxSession.clearSandboxSessionByStorageKey).toHaveBeenCalled();
  });

  it('keeps the web error surface on a definitively-gone refresh (control)', async () => {
    // Gate OFF (default): web keeps the dead id + error so reconnect/snapshot recover.
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'tok',
    });
    sandboxClient.pingSandbox.mockRejectedValue(new Error('Sandbox not found'));
    const hook = render('owner/repo', 'main');
    await hook.start('owner/repo', 'main');
    syncRefsFromState();

    await hook.refresh({ silent: true });
    expect(reactState.cells[1].value).toBe('error');
    expect(reactState.cells[0].value).toBe('sb-1');
  });

  it('markUnreachable probes and retires a definitively-gone container on native', async () => {
    // The tool-execution loss path: ensureSandbox would otherwise reuse the dead
    // id. On native, markUnreachable fires a silent probe; a definitive-gone
    // result retires the id → idle so the next ensureSandbox cold-starts.
    checkpointGate.nativeCheckpointsActive.mockReturnValue(true);
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'tok',
    });
    sandboxClient.pingSandbox.mockRejectedValue(new Error('Sandbox not found'));
    const hook = render('owner/repo', 'main');
    await hook.start('owner/repo', 'main');
    syncRefsFromState();

    hook.markUnreachable('SANDBOX_UNREACHABLE');
    // The probe runs async; flush microtasks (mirrors runEffects' double-await).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sandboxClient.pingSandbox).toHaveBeenCalledWith('sb-1');
    expect(reactState.cells[0].value).toBeNull();
    expect(reactState.cells[1].value).toBe('idle');
  });

  it('markUnreachable heals back to ready when the native probe finds the container alive', async () => {
    // A transient SANDBOX_UNREACHABLE must NOT retire — the probe confirms the
    // container is live and the session recovers in place.
    checkpointGate.nativeCheckpointsActive.mockReturnValue(true);
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'tok',
    });
    sandboxClient.pingSandbox.mockResolvedValue(true);
    const hook = render('owner/repo', 'main');
    await hook.start('owner/repo', 'main');
    syncRefsFromState();

    hook.markUnreachable('SANDBOX_UNREACHABLE');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(reactState.cells[0].value).toBe('sb-1');
    expect(reactState.cells[1].value).toBe('ready');
  });
});

describe('useSandbox — debounced post-round keep-warm snapshot', () => {
  async function startReadySandbox() {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'tok',
    });
    sandboxClient.hibernateSandbox.mockResolvedValue({
      ok: true,
      snapshotId: 'snap-round',
      restoreToken: 'rt-round',
      keptWarm: true,
    });
    sandboxClient.getSandboxOwnerToken.mockReturnValue('tok');
    ghAuth.getActiveGitHubTokenInfo.mockReturnValue({ token: 'gh-token', kind: 'app' });
    const hook = render('owner/repo', 'main');
    await hook.start('owner/repo', 'main');
    syncRefsFromState();
    return hook;
  }

  it('coalesces a burst into one capture after the trailing window', async () => {
    vi.useFakeTimers();
    const hook = await startReadySandbox();

    hook.requestRoundCheckpoint();
    await vi.advanceTimersByTimeAsync(5_000);
    hook.requestRoundCheckpoint();
    await vi.advanceTimersByTimeAsync(5_000);
    hook.requestRoundCheckpoint();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(sandboxClient.hibernateSandbox).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sandboxClient.hibernateSandbox).toHaveBeenCalledTimes(1);
  });

  it('captures at the max-wait ceiling during sustained mutation activity', async () => {
    vi.useFakeTimers();
    const hook = await startReadySandbox();

    hook.requestRoundCheckpoint();
    for (let elapsed = 10_000; elapsed < 120_000; elapsed += 10_000) {
      await vi.advanceTimersByTimeAsync(10_000);
      hook.requestRoundCheckpoint();
    }
    expect(sandboxClient.hibernateSandbox).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sandboxClient.hibernateSandbox).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending capture on hook teardown', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const hook = await startReadySandbox();
    const cleanups = await runEffects();
    syncRefsFromState();

    hook.requestRoundCheckpoint();
    cleanups.forEach((cleanup) => cleanup());
    await vi.advanceTimersByTimeAsync(120_000);

    expect(sandboxClient.hibernateSandbox).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('keeps round-triggered cloud capture gated off on the native shell', async () => {
    vi.useFakeTimers();
    checkpointGate.nativeCheckpointsActive.mockReturnValue(true);
    const hook = await startReadySandbox();

    hook.requestRoundCheckpoint();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(sandboxClient.hibernateSandbox).not.toHaveBeenCalled();
  });
});

describe('useSandbox — keep-warm snapshot on background (page-hide)', () => {
  // Env is `node` (no DOM). The hook's visibility effect calls
  // document.addEventListener; stub a minimal document with a dispatch registry
  // so we can drive a real `visibilitychange` through the hook's handler.
  type FakeDoc = {
    hidden: boolean;
    addEventListener: (type: string, fn: () => void) => void;
    removeEventListener: (type: string, fn: () => void) => void;
    dispatch: (type: string) => void;
  };
  function installFakeDocument(): FakeDoc {
    const listeners: Record<string, Array<() => void>> = {};
    const doc: FakeDoc = {
      hidden: false,
      addEventListener: (type, fn) => {
        (listeners[type] ??= []).push(fn);
      },
      removeEventListener: (type, fn) => {
        listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
      },
      dispatch: (type) => (listeners[type] ?? []).forEach((f) => f()),
    };
    vi.stubGlobal('document', doc);
    return doc;
  }

  async function startReadySandbox(repo = 'owner/repo', branch = 'main') {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'tok',
    });
    sandboxClient.getSandboxOwnerToken.mockReturnValue('tok');
    ghAuth.getActiveGitHubTokenInfo.mockReturnValue({ token: 'gh-token', kind: 'app' });
    const hook = render(repo, branch);
    await hook.start(repo, branch);
    return hook;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('snapshots the live container when the app is backgrounded', async () => {
    sandboxClient.hibernateSandbox.mockResolvedValue({
      ok: true,
      snapshotId: 'snap-hidden',
      restoreToken: 'rt-1',
      keptWarm: true,
    });
    const doc = installFakeDocument();
    await startReadySandbox();
    const cleanups = await runEffects();
    // runEffects replays the hook's ref-sync effect with the render-time status
    // ('idle'); re-align refs to the post-start 'ready' state the handler reads.
    syncRefsFromState();

    doc.hidden = true;
    doc.dispatch('visibilitychange');
    await Promise.resolve();
    await Promise.resolve();

    // A fresh restore point is captured at the moment of backgrounding — the
    // window where a platform recycle would otherwise lose uncommitted work
    // with no snapshot yet taken (the idle reaper wouldn't fire for 45 min).
    expect(sandboxClient.hibernateSandbox).toHaveBeenCalledWith(
      'sb-1',
      { repoFullName: 'owner/repo', branch: 'main' },
      { keepWarm: true },
    );

    cleanups.forEach((c) => c());
  });

  it('does not snapshot on hide on the native shell (WIP never leaves the device)', async () => {
    checkpointGate.nativeCheckpointsActive.mockReturnValue(true);
    const doc = installFakeDocument();
    await startReadySandbox();
    const cleanups = await runEffects();
    // runEffects replays the hook's ref-sync effect with the render-time status
    // ('idle'); re-align refs to the post-start 'ready' state the handler reads.
    syncRefsFromState();

    doc.hidden = true;
    doc.dispatch('visibilitychange');
    await Promise.resolve();
    await Promise.resolve();

    expect(sandboxClient.hibernateSandbox).not.toHaveBeenCalled();

    cleanups.forEach((c) => c());
  });
});
