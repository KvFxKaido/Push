import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  getActiveGitHubToken: vi.fn<() => string>(() => ''),
  APP_TOKEN_STORAGE_KEY: 'github_app_token',
}));
const sandboxSession = vi.hoisted(() => ({
  buildSandboxSessionStorageKey: vi.fn<(repo?: string | null, branch?: string | null) => string>(
    (repo, branch) => `sbx:${repo}:${branch}`,
  ),
  clearSandboxSessionByStorageKey: vi.fn(),
  loadSandboxSession: vi.fn<() => unknown>(() => null),
  saveSandboxSession: vi.fn(),
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
vi.mock('@/lib/sandbox-session', () => sandboxSession);

type Cell = { value: unknown };
const reactState = vi.hoisted(() => ({
  cells: [] as Cell[],
  index: 0,
  refs: [] as { current: unknown }[],
  refIndex: 0,
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
  useEffect: () => {},
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
  Object.values(safeStorage).forEach((m) => m.mockReset());
  safeStorage.get.mockReturnValue(null);
  fileLedger.reset.mockReset();
  Object.values(symbolLedger).forEach((m) => m.mockReset());
  symbolLedger.hydrate.mockResolvedValue(undefined);
  symbolLedger.clearRepo.mockResolvedValue(undefined);
  cacheLib.clearFileVersionCache.mockReset();
  cacheLib.clearSandboxWorkspaceRevision.mockReset();
  ghAuth.getActiveGitHubToken.mockReset().mockReturnValue('');
  Object.values(sandboxSession).forEach((m) => m.mockReset());
  sandboxSession.buildSandboxSessionStorageKey.mockImplementation(
    (repo, branch) => `sbx:${repo}:${branch}`,
  );
  sandboxSession.loadSandboxSession.mockReturnValue(null);
  reactState.cells = [];
  reactState.index = 0;
  reactState.refs = [];
  reactState.refIndex = 0;
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
    ghAuth.getActiveGitHubToken.mockReturnValue('gh-token');
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
    ghAuth.getActiveGitHubToken.mockReturnValue('gh-token');
    const hook = render();
    await hook.start('', undefined);
    expect(sandboxClient.createSandbox).toHaveBeenCalledWith('', undefined, '', undefined);
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
