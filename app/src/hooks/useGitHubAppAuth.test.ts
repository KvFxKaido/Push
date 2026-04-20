import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  get: vi.fn<(key: string, scope?: 'session' | 'local') => string | null>(),
  set: vi.fn<(key: string, value: string, scope?: 'session' | 'local') => boolean>(() => true),
  remove: vi.fn<(key: string, scope?: 'session' | 'local') => void>(),
}));
const utils = vi.hoisted(() => ({
  validateGitHubToken: vi.fn(),
  isNetworkFetchError: vi.fn<() => boolean>(() => false),
}));
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/safe-storage', () => ({
  safeStorageGet: (k: string, s?: 'session' | 'local') => storage.get(k, s),
  safeStorageSet: (k: string, v: string, s?: 'session' | 'local') => storage.set(k, v, s),
  safeStorageRemove: (k: string, s?: 'session' | 'local') => storage.remove(k, s),
}));
vi.mock('@/lib/utils', () => ({
  validateGitHubToken: (...args: Parameters<typeof utils.validateGitHubToken>) =>
    utils.validateGitHubToken(...args),
  isNetworkFetchError: (...args: Parameters<typeof utils.isNetworkFetchError>) =>
    utils.isNetworkFetchError(...args),
}));

vi.stubGlobal('fetch', fetchMock);

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
}));

const { useGitHubAppAuth } = await import('./useGitHubAppAuth');

function render() {
  reactState.index = 0;
  reactState.refIndex = 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useGitHubAppAuth();
}

function makeResponse(init: { ok: boolean; status?: number; body?: unknown; text?: string }) {
  return {
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 500),
    async json() {
      return init.body;
    },
    async text() {
      return init.text ?? JSON.stringify(init.body);
    },
  };
}

beforeEach(() => {
  // Re-stub after any prior test's afterEach unstubbed globals.
  vi.stubGlobal('fetch', fetchMock);
  storage.get.mockReset().mockReturnValue(null);
  storage.set.mockReset().mockReturnValue(true);
  storage.remove.mockReset();
  utils.validateGitHubToken.mockReset();
  utils.isNetworkFetchError.mockReset().mockReturnValue(false);
  fetchMock.mockReset();
  reactState.cells = [];
  reactState.index = 0;
  reactState.refs = [];
  reactState.refIndex = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useGitHubAppAuth — initial state', () => {
  it('seeds token/installationId from storage', () => {
    storage.get.mockImplementation((key) => {
      if (key === 'github_app_installation_id') return '12345';
      if (key === 'github_app_token') return 'gha_stored';
      return null;
    });
    const auth = render();
    expect(auth.installationId).toBe('12345');
    expect(auth.token).toBe('gha_stored');
    expect(auth.isAppAuth).toBe(true);
  });

  it('returns empty strings and isAppAuth=false when storage is empty', () => {
    const auth = render();
    expect(auth.installationId).toBe('');
    expect(auth.token).toBe('');
    expect(auth.isAppAuth).toBe(false);
  });

  it('restores validatedUser from stored JSON blob', () => {
    storage.get.mockImplementation((key) =>
      key === 'github_app_user' ? JSON.stringify({ login: 'octocat', avatar_url: 'a.png' }) : null,
    );
    const auth = render();
    expect(auth.validatedUser).toEqual({
      login: 'octocat',
      avatar_url: 'a.png',
    });
  });

  it('ignores a malformed stored user blob', () => {
    storage.get.mockImplementation((key) => (key === 'github_app_user' ? 'not-json' : null));
    const auth = render();
    expect(auth.validatedUser).toBeNull();
  });
});

describe('useGitHubAppAuth.setInstallationIdManually', () => {
  it('rejects a non-numeric installation id', async () => {
    const auth = render();
    const ok = await auth.setInstallationIdManually('abc');
    expect(ok).toBe(false);
    // error cell is one of the string cells — check one contains the message
    const errors = reactState.cells
      .map((c) => c.value)
      .filter((v) => typeof v === 'string' && v.includes('Invalid installation ID'));
    expect(errors.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches a token, persists it, and marks the user validated on success', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        ok: true,
        body: {
          token: 'fresh-token',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          permissions: {},
          repository_selection: 'all',
          user: { login: 'octocat', avatar_url: 'a.png' },
        },
      }),
    );
    const auth = render();
    const ok = await auth.setInstallationIdManually('12345');
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/github/app-token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(storage.set).toHaveBeenCalledWith('github_app_installation_id', '12345', undefined);
    expect(storage.set).toHaveBeenCalledWith('github_app_token', 'fresh-token', undefined);
  });

  it('surfaces a friendly error when the app-token endpoint returns 403 (not-allowed)', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        ok: false,
        status: 403,
        body: { error: 'installation_id is not allowed' },
      }),
    );
    const auth = render();
    const ok = await auth.setInstallationIdManually('12345');
    expect(ok).toBe(false);
    const errorCell = reactState.cells.find(
      (c) => typeof c.value === 'string' && (c.value as string).includes('not authorized'),
    );
    expect(errorCell).toBeTruthy();
  });

  it('surfaces the proxy-unavailable hint when fetch is a network error', async () => {
    utils.isNetworkFetchError.mockReturnValue(true);
    fetchMock.mockRejectedValue(new Error('fetch failed'));
    const auth = render();
    const ok = await auth.setInstallationIdManually('12345');
    expect(ok).toBe(false);
    const errorCell = reactState.cells.find(
      (c) =>
        typeof c.value === 'string' &&
        (c.value as string).includes('Local API proxy is unavailable'),
    );
    expect(errorCell).toBeTruthy();
  });
});

describe('useGitHubAppAuth.disconnect', () => {
  it('removes every stored key and clears state', () => {
    storage.get.mockImplementation((key) => {
      if (key === 'github_app_installation_id') return '12345';
      if (key === 'github_app_token') return 'gha_stored';
      return null;
    });
    const auth = render();
    auth.disconnect();
    // All five keys are cleared
    const removedKeys = storage.remove.mock.calls.map((c) => c[0]);
    expect(removedKeys).toEqual(
      expect.arrayContaining([
        'github_app_installation_id',
        'github_app_token',
        'github_app_token_expiry',
        'github_app_user',
        'github_app_commit_identity',
      ]),
    );
    // Token + installationId cells are reset
    expect(reactState.cells[0].value).toBe('');
    expect(reactState.cells[1].value).toBe('');
  });
});
