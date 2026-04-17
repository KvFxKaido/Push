import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  get: vi.fn<(key: string, scope?: 'session' | 'local') => string | null>(),
  set: vi.fn<(key: string, value: string, scope?: 'session' | 'local') => boolean>(() => true),
  remove: vi.fn<(key: string, scope?: 'session' | 'local') => void>(),
}));
const utils = vi.hoisted(() => ({
  validateGitHubToken: vi.fn(),
  isNetworkFetchError: vi.fn<() => boolean>(() => false),
}));

vi.mock('@/lib/safe-storage', () => ({
  safeStorageGet: (k: string, s?: 'session' | 'local') => storage.get(k, s),
  safeStorageSet: (k: string, v: string, s?: 'session' | 'local') => storage.set(k, v, s),
  safeStorageRemove: (k: string, s?: 'session' | 'local') => storage.remove(k, s),
}));
vi.mock('@/lib/utils', () => ({
  validateGitHubToken: (...args: unknown[]) => utils.validateGitHubToken(...args),
  isNetworkFetchError: (...args: unknown[]) => utils.isNetworkFetchError(...args),
}));

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

const { useGitHubAuth } = await import('./useGitHubAuth');

function render() {
  reactState.index = 0;
  reactState.refIndex = 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useGitHubAuth();
}

beforeEach(() => {
  storage.get.mockReset().mockReturnValue(null);
  storage.set.mockReset().mockReturnValue(true);
  storage.remove.mockReset();
  utils.validateGitHubToken.mockReset();
  utils.isNetworkFetchError.mockReset().mockReturnValue(false);
  reactState.cells = [];
  reactState.index = 0;
  reactState.refs = [];
  reactState.refIndex = 0;
});

describe('useGitHubAuth — initial token state', () => {
  it('seeds token from storage when present', () => {
    storage.get.mockReturnValue('ghp_stored');
    const auth = render();
    expect(auth.token).toBe('ghp_stored');
  });

  it('returns an empty token when neither storage nor env has a token', () => {
    storage.get.mockReturnValue(null);
    const auth = render();
    expect(auth.token).toBe('');
    expect(auth.validatedUser).toBeNull();
    expect(auth.loading).toBe(false);
    expect(auth.error).toBeNull();
  });
});

describe('useGitHubAuth.setTokenManually', () => {
  it('rejects empty/whitespace input', async () => {
    const auth = render();
    const ok = await auth.setTokenManually('   ');
    expect(ok).toBe(false);
    expect(utils.validateGitHubToken).not.toHaveBeenCalled();
  });

  it('persists the token and stores the validated user on success', async () => {
    utils.validateGitHubToken.mockResolvedValue({
      login: 'octocat',
    });
    const auth = render();
    const ok = await auth.setTokenManually('  ghp_abc  ');
    expect(ok).toBe(true);
    expect(utils.validateGitHubToken).toHaveBeenCalledWith('ghp_abc');
    expect(storage.set).toHaveBeenCalledWith('github_access_token', 'ghp_abc', undefined);
    // token cell (index 0) is now 'ghp_abc', validatedUser cell (index 3)
    expect(reactState.cells[0].value).toBe('ghp_abc');
    expect(reactState.cells[3].value).toEqual({ login: 'octocat' });
    // loading cell (index 1) returns to false
    expect(reactState.cells[1].value).toBe(false);
  });

  it('records an error message when validation fails', async () => {
    utils.validateGitHubToken.mockResolvedValue(null);
    const auth = render();
    const ok = await auth.setTokenManually('ghp_bad');
    expect(ok).toBe(false);
    expect(storage.set).not.toHaveBeenCalled();
    // error cell (index 2) is set to a descriptive message
    expect(reactState.cells[2].value).toContain('Invalid token');
  });
});

describe('useGitHubAuth.logout', () => {
  it('clears the stored token and validated user', () => {
    storage.get.mockReturnValue('ghp_stored');
    utils.validateGitHubToken.mockResolvedValue({ login: 'octocat' });
    const auth = render();
    auth.logout();
    expect(storage.remove).toHaveBeenCalledWith('github_access_token', undefined);
    expect(reactState.cells[0].value).toBe('');
    expect(reactState.cells[3].value).toBeNull();
  });
});

describe('useGitHubAuth.login', () => {
  it('sets an error when VITE_GITHUB_CLIENT_ID is missing (default)', () => {
    const auth = render();
    auth.login();
    // When the client id env is unset, the hook records a helpful error.
    expect(reactState.cells[2].value).toContain('VITE_GITHUB_CLIENT_ID');
  });
});

describe('useGitHubAuth — configured flags', () => {
  it('exposes configured=false when no client id and no env token are present', () => {
    const auth = render();
    expect(auth.configured).toBe(false);
    expect(auth.oauthConfigured).toBe(false);
  });
});
