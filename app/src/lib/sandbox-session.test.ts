import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSandboxSessionStorageKey,
  clearSandboxSessionByStorageKey,
  loadSandboxSession,
  saveSandboxSession,
  type PersistedSandboxSession,
} from './sandbox-session';

function createStorageMock() {
  const data = new Map<string, string>();

  return {
    data,
    getItem: vi.fn((key: string) => (data.has(key) ? data.get(key)! : null)),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
  };
}

function createSession(overrides: Partial<PersistedSandboxSession> = {}): PersistedSandboxSession {
  return {
    sandboxId: 'sb-123',
    ownerToken: 'owner-token',
    repoFullName: 'owner/repo',
    branch: 'main',
    createdAt: 123456,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sandbox-session', () => {
  it('keys repo sessions by repo and branch', () => {
    expect(buildSandboxSessionStorageKey('owner/repo', 'main'))
      .toBe('sandbox_session:repo%3Aowner%2Frepo:main');
    expect(buildSandboxSessionStorageKey('owner/repo', 'feature/test'))
      .toBe('sandbox_session:repo%3Aowner%2Frepo:feature%2Ftest');
  });

  it('uses a dedicated scratch key', () => {
    expect(buildSandboxSessionStorageKey('', 'main'))
      .toBe('sandbox_session:__scratch__:main');
  });

  it('returns null for repo sessions without a branch', () => {
    expect(buildSandboxSessionStorageKey('owner/repo', null)).toBeNull();
  });

  it('saves and loads a branch-scoped session', () => {
    const localStorage = createStorageMock();
    vi.stubGlobal('window', { localStorage, sessionStorage: createStorageMock() });

    const session = createSession({ branch: 'feature-x' });
    saveSandboxSession('owner/repo', 'feature-x', session);

    expect(loadSandboxSession('owner/repo', 'feature-x')).toEqual(session);
    expect(loadSandboxSession('owner/repo', 'main')).toBeNull();
  });

  it('migrates matching legacy session data once', () => {
    const localStorage = createStorageMock();
    vi.stubGlobal('window', { localStorage, sessionStorage: createStorageMock() });

    const legacy = createSession({ repoFullName: 'owner/repo', branch: 'main' });
    localStorage.setItem('sandbox_session', JSON.stringify(legacy));

    expect(loadSandboxSession('owner/repo', 'main')).toEqual(legacy);
    expect(localStorage.removeItem).toHaveBeenCalledWith('sandbox_session');
    expect(localStorage.getItem('sandbox_session:repo%3Aowner%2Frepo:main')).toBe(JSON.stringify(legacy));
  });

  it('does not migrate legacy session data across branches', () => {
    const localStorage = createStorageMock();
    vi.stubGlobal('window', { localStorage, sessionStorage: createStorageMock() });

    const legacy = createSession({ repoFullName: 'owner/repo', branch: 'main' });
    localStorage.setItem('sandbox_session', JSON.stringify(legacy));

    expect(loadSandboxSession('owner/repo', 'feature-x')).toBeNull();
    expect(localStorage.getItem('sandbox_session')).toBe(JSON.stringify(legacy));
  });

  it('clears session by storage key', () => {
    const localStorage = createStorageMock();
    vi.stubGlobal('window', { localStorage, sessionStorage: createStorageMock() });

    const key = buildSandboxSessionStorageKey('owner/repo', 'main');
    expect(key).not.toBeNull();
    localStorage.setItem(key!, JSON.stringify(createSession()));

    expect(clearSandboxSessionByStorageKey(key)).toBe(true);
    expect(localStorage.getItem(key!)).toBeNull();
  });

  it('does not clear a storage key that now belongs to a different sandbox', () => {
    const localStorage = createStorageMock();
    vi.stubGlobal('window', { localStorage, sessionStorage: createStorageMock() });

    const key = buildSandboxSessionStorageKey('owner/repo', 'main');
    expect(key).not.toBeNull();
    localStorage.setItem(key!, JSON.stringify(createSession({ sandboxId: 'sb-newer' })));

    expect(clearSandboxSessionByStorageKey(key, 'sb-older')).toBe(false);
    expect(localStorage.getItem(key!)).toBe(JSON.stringify(createSession({ sandboxId: 'sb-newer' })));
  });
});
