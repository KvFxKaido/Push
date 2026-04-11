import { describe, expect, it, vi } from 'vitest';
import type { GitHubUser } from '@/types';
import { buildAuthSession } from './useAuthSession';

function createPatAuth(
  overrides: Partial<{
    token: string;
    logout: () => void;
    loading: boolean;
    error: string | null;
    setTokenManually: (token: string) => Promise<boolean>;
    validatedUser: GitHubUser | null;
  }> = {},
) {
  return {
    token: '',
    logout: vi.fn(),
    loading: false,
    error: null,
    setTokenManually: vi.fn(async () => true),
    validatedUser: null,
    ...overrides,
  };
}

function createAppAuth(
  overrides: Partial<{
    token: string;
    installationId: string;
    connect: () => void;
    install: () => void;
    disconnect: () => void;
    setInstallationIdManually: (id: string) => Promise<boolean>;
    loading: boolean;
    error: string | null;
    validatedUser: GitHubUser | null;
    isAppAuth: boolean;
  }> = {},
) {
  return {
    token: '',
    installationId: '',
    connect: vi.fn(),
    install: vi.fn(),
    disconnect: vi.fn(),
    setInstallationIdManually: vi.fn(async () => true),
    loading: false,
    error: null,
    validatedUser: null,
    isAppAuth: false,
    ...overrides,
  };
}

describe('buildAuthSession', () => {
  it('prefers GitHub App state when available', () => {
    const patUser: GitHubUser = { login: 'pat-user', avatar_url: '' };
    const appUser: GitHubUser = { login: 'app-user', avatar_url: '' };
    const disconnect = vi.fn();
    const patAuth = createPatAuth({ token: 'ghp_pat', validatedUser: patUser });
    const appAuth = createAppAuth({
      token: 'ghu_app',
      installationId: '123456',
      validatedUser: appUser,
      isAppAuth: true,
      loading: true,
      error: 'proxy unavailable',
    });

    const session = buildAuthSession(patAuth, appAuth, disconnect);

    expect(session.status).toBe('app');
    expect(session.token).toBe('ghu_app');
    expect(session.patToken).toBe('ghp_pat');
    expect(session.validatedUser).toEqual(appUser);
    expect(session.isAppAuth).toBe(true);
    expect(session.installationId).toBe('123456');
    expect(session.loading).toBe(true);
    expect(session.error).toBe('proxy unavailable');
    expect(session.appLoading).toBe(true);
    expect(session.appError).toBe('proxy unavailable');
    expect(session.disconnect).toBe(disconnect);
  });

  it('falls back to PAT auth when no app token is active', () => {
    const patUser: GitHubUser = { login: 'pat-user', avatar_url: '' };
    const disconnect = vi.fn();
    const setTokenManually = vi.fn(async () => true);
    const patAuth = createPatAuth({
      token: 'ghp_pat',
      validatedUser: patUser,
      setTokenManually,
    });
    const appAuth = createAppAuth({
      error: 'worker unavailable',
    });

    const session = buildAuthSession(patAuth, appAuth, disconnect);

    expect(session.status).toBe('pat');
    expect(session.token).toBe('ghp_pat');
    expect(session.patToken).toBe('ghp_pat');
    expect(session.validatedUser).toEqual(patUser);
    expect(session.isAppAuth).toBe(false);
    expect(session.installationId).toBeNull();
    expect(session.error).toBe('worker unavailable');
    expect(session.connectPat).toBe(setTokenManually);
  });

  it('returns a signed-out session when neither auth path is active', () => {
    const session = buildAuthSession(createPatAuth(), createAppAuth(), vi.fn());

    expect(session.status).toBe('signed_out');
    expect(session.token).toBeNull();
    expect(session.patToken).toBeNull();
    expect(session.installationId).toBeNull();
    expect(session.validatedUser).toBeNull();
    expect(session.isAppAuth).toBe(false);
    expect(session.loading).toBe(false);
    expect(session.error).toBeNull();
    expect(session.appLoading).toBe(false);
    expect(session.appError).toBeNull();
  });
});
