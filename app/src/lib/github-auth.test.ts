import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_TOKEN_STORAGE_KEY,
  OAUTH_STORAGE_KEY,
  getActiveGitHubToken,
  getGitHubAuthHeaders,
} from './github-auth';

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
