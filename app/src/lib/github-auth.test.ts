import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Clear VITE_GITHUB_TOKEN before loading the module under test. ENV_TOKEN is
// captured at module load time (`const ENV_TOKEN = import.meta.env.VITE_GITHUB_TOKEN || ''`),
// so the stub must be in place before the dynamic import resolves to keep
// assertions deterministic across environments that set this var.
vi.stubEnv('VITE_GITHUB_TOKEN', '');

const {
  APP_TOKEN_STORAGE_KEY,
  OAUTH_STORAGE_KEY,
  getActiveGitHubToken,
  getActiveGitHubTokenInfo,
  classifyTokenString,
  isDurableUserToken,
  isInstallationToken,
  getGitHubAuthHeaders,
  getGitHubAuthHeadersForToken,
} = await import('./github-auth');

function createStorageMock() {
  const store = new Map<string, string>();
  return {
    store,
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
  };
}

function stubWindowWithStorage(localStorage: ReturnType<typeof createStorageMock>) {
  vi.stubGlobal('window', {
    localStorage,
    sessionStorage: createStorageMock(),
  });
}

describe('getActiveGitHubToken', () => {
  let localStorage: ReturnType<typeof createStorageMock>;

  beforeEach(() => {
    localStorage = createStorageMock();
    stubWindowWithStorage(localStorage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns an empty string when no tokens are stored', () => {
    expect(getActiveGitHubToken()).toBe('');
  });

  it('returns the app token when only the app token is stored', () => {
    localStorage.store.set(APP_TOKEN_STORAGE_KEY, 'app-token-xyz');
    expect(getActiveGitHubToken()).toBe('app-token-xyz');
  });

  it('returns the OAuth token when only the OAuth token is stored', () => {
    localStorage.store.set(OAUTH_STORAGE_KEY, 'oauth-token-abc');
    expect(getActiveGitHubToken()).toBe('oauth-token-abc');
  });

  it('prefers the app token over the OAuth token when both are stored', () => {
    localStorage.store.set(APP_TOKEN_STORAGE_KEY, 'app-token-xyz');
    localStorage.store.set(OAUTH_STORAGE_KEY, 'oauth-token-abc');
    expect(getActiveGitHubToken()).toBe('app-token-xyz');
  });

  it('falls through to OAuth token when the app token is an empty string', () => {
    localStorage.store.set(APP_TOKEN_STORAGE_KEY, '');
    localStorage.store.set(OAUTH_STORAGE_KEY, 'oauth-token-abc');
    expect(getActiveGitHubToken()).toBe('oauth-token-abc');
  });

  it('returns an empty string when window is undefined (SSR)', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('window', undefined);
    expect(getActiveGitHubToken()).toBe('');
  });
});

describe('classifyTokenString', () => {
  it('maps GitHub token prefixes to authority kinds', () => {
    expect(classifyTokenString('ghs_abc')).toBe('app');
    expect(classifyTokenString('gho_abc')).toBe('oauth');
    expect(classifyTokenString('ghu_abc')).toBe('oauth');
    expect(classifyTokenString('ghp_abc')).toBe('pat');
    expect(classifyTokenString('github_pat_abc')).toBe('pat');
  });

  it('returns none for empty and unknown for unrecognized shapes', () => {
    expect(classifyTokenString('')).toBe('none');
    expect(classifyTokenString('legacy-opaque-token')).toBe('unknown');
  });
});

describe('isInstallationToken / isDurableUserToken', () => {
  it('treats only app as the scoped+expiring regime', () => {
    expect(isInstallationToken('app')).toBe(true);
    expect(isInstallationToken('oauth')).toBe(false);
    expect(isInstallationToken('none')).toBe(false);
  });

  it('flags user-scoped and unknown as durable, but not app or none', () => {
    expect(isDurableUserToken('oauth')).toBe(true);
    expect(isDurableUserToken('pat')).toBe(true);
    expect(isDurableUserToken('env')).toBe(true);
    expect(isDurableUserToken('unknown')).toBe(true); // fail safe
    expect(isDurableUserToken('app')).toBe(false);
    expect(isDurableUserToken('none')).toBe(false);
  });
});

describe('getActiveGitHubTokenInfo', () => {
  let localStorage: ReturnType<typeof createStorageMock>;

  beforeEach(() => {
    localStorage = createStorageMock();
    stubWindowWithStorage(localStorage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns none when nothing is stored', () => {
    expect(getActiveGitHubTokenInfo()).toEqual({ token: '', kind: 'none' });
  });

  it('classifies the app-token key as app regardless of prefix', () => {
    localStorage.store.set(APP_TOKEN_STORAGE_KEY, 'opaque-installation-token');
    expect(getActiveGitHubTokenInfo()).toEqual({ token: 'opaque-installation-token', kind: 'app' });
  });

  it('classifies a pasted PAT in the OAuth key as pat', () => {
    localStorage.store.set(OAUTH_STORAGE_KEY, 'ghp_pasted');
    expect(getActiveGitHubTokenInfo()).toEqual({ token: 'ghp_pasted', kind: 'pat' });
  });

  it('classifies a real OAuth token in the OAuth key as oauth', () => {
    localStorage.store.set(OAUTH_STORAGE_KEY, 'gho_oauth');
    expect(getActiveGitHubTokenInfo()).toEqual({ token: 'gho_oauth', kind: 'oauth' });
  });

  it('treats an unrecognized OAuth-key token as oauth (origin wins over shape)', () => {
    localStorage.store.set(OAUTH_STORAGE_KEY, 'legacy-opaque');
    expect(getActiveGitHubTokenInfo().kind).toBe('oauth');
  });

  it('prefers the app token over an OAuth-key PAT', () => {
    localStorage.store.set(APP_TOKEN_STORAGE_KEY, 'ghs_app');
    localStorage.store.set(OAUTH_STORAGE_KEY, 'ghp_user');
    expect(getActiveGitHubTokenInfo()).toEqual({ token: 'ghs_app', kind: 'app' });
  });
});

describe('getGitHubAuthHeaders', () => {
  let localStorage: ReturnType<typeof createStorageMock>;

  beforeEach(() => {
    localStorage = createStorageMock();
    stubWindowWithStorage(localStorage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('always includes the GitHub v3 Accept header', () => {
    const headers = getGitHubAuthHeaders();
    expect(headers.Accept).toBe('application/vnd.github.v3+json');
  });

  it('omits the Authorization header when no token is available', () => {
    const headers = getGitHubAuthHeaders();
    expect(headers.Authorization).toBeUndefined();
  });

  it('prefixes the Authorization value with "token " when a token is present', () => {
    localStorage.store.set(APP_TOKEN_STORAGE_KEY, 'app-token-xyz');
    const headers = getGitHubAuthHeaders();
    expect(headers.Authorization).toBe('token app-token-xyz');
  });

  it('uses the OAuth token when no app token is set', () => {
    localStorage.store.set(OAUTH_STORAGE_KEY, 'oauth-token-abc');
    const headers = getGitHubAuthHeaders();
    expect(headers.Authorization).toBe('token oauth-token-abc');
  });

  it('returns a plain object (not a Headers instance)', () => {
    const headers = getGitHubAuthHeaders();
    expect(headers).toBeInstanceOf(Object);
    expect(headers).not.toBeInstanceOf(Headers);
  });
});

describe('getGitHubAuthHeadersForToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds Authorization from the explicit token without touching storage', () => {
    // No window/localStorage stubbed: this must work server-side (the DO path).
    vi.stubGlobal('window', undefined);
    const headers = getGitHubAuthHeadersForToken('install-token-123');
    expect(headers.Authorization).toBe('token install-token-123');
  });

  it('includes the User-Agent and API-version headers GitHub requires server-side', () => {
    const headers = getGitHubAuthHeadersForToken('t');
    expect(headers['User-Agent']).toBeTruthy();
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(headers.Accept).toBe('application/vnd.github.v3+json');
  });

  it('omits Authorization for an empty token', () => {
    expect(getGitHubAuthHeadersForToken('').Authorization).toBeUndefined();
  });
});
