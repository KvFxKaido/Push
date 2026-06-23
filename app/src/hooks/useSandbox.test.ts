import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubTokenKind } from '@/lib/github-auth';
import { USER_TOKEN_GATE_MESSAGE, formatRepoNotCoveredMessage } from '@/lib/sandbox-auth-gate';

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
  isSavedSessionRecoverable: vi.fn<() => boolean>(() => true),
  decideReconnectProbe: vi.fn((args: { savedSandboxId: string; now: number }) => ({
    probe: true,
    nextAttempt: { sandboxId: args.savedSandboxId, at: args.now, attempts: 1 },
  })),
  shouldRetryReconnect: vi.fn(() => false),
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

function render(repo: string | null = null, branch: string | null = null) {
  reactState.index = 0;
  reactState.refIndex = 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useSandbox(repo, branch);
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
  reactState.cells = [];
  reactState.index = 0;
  reactState.refs = [];
  reactState.refIndex = 0;
  reactState.effects = [];
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
    expect(sandboxClient.execInSandbox).toHaveBeenCalledWith('sb-saved', 'true');
    expect(sandboxClient.setSandboxOwnerToken.mock.invocationCallOrder[0]).toBeLessThan(
      sandboxClient.execInSandbox.mock.invocationCallOrder[0],
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

describe('useSandbox.refresh', () => {
  it('returns false when no sandbox is active', async () => {
    const hook = render();
    const ok = await hook.refresh();
    expect(ok).toBe(false);
    expect(sandboxClient.execInSandbox).not.toHaveBeenCalled();
  });

  it('transitions to ready when the sandbox ping succeeds', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'tok',
    });
    sandboxClient.execInSandbox.mockResolvedValue({ exitCode: 0 });
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
    sandboxClient.execInSandbox.mockResolvedValue({
      exitCode: -1,
      error: 'Sandbox not found',
    });
    const hook = render();
    await hook.start('owner/repo', 'main');
    syncRefsFromState();
    const ok = await hook.refresh({ silent: true });
    expect(ok).toBe(false);
    expect(reactState.cells[1].value).toBe('error');
    expect(sandboxSession.clearSandboxSessionByStorageKey).toHaveBeenCalled();
  });

  it('keeps the session on transient errors (does not clear)', async () => {
    sandboxClient.createSandbox.mockResolvedValue({
      status: 'ready',
      sandboxId: 'sb-1',
      ownerToken: 'tok',
    });
    sandboxClient.execInSandbox.mockResolvedValue({
      exitCode: -1,
      error: 'command timed out',
    });
    const hook = render();
    await hook.start('owner/repo', 'main');
    syncRefsFromState();
    sandboxSession.clearSandboxSessionByStorageKey.mockReset();
    const ok = await hook.refresh({ silent: true });
    expect(ok).toBe(false);
    expect(sandboxSession.clearSandboxSessionByStorageKey).not.toHaveBeenCalled();
    expect(reactState.cells[1].value).toBe('error');
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
