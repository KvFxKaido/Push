import { useCallback, useMemo } from 'react';
import { useGitHubAppAuth } from '@/hooks/useGitHubAppAuth';
import { useGitHubAuth } from '@/hooks/useGitHubAuth';
import type { GitHubAuthSession, GitHubUser } from '@/types';

type PatAuthState = {
  token: string;
  logout: () => void;
  loading: boolean;
  error: string | null;
  setTokenManually: (token: string) => Promise<boolean>;
  validatedUser: GitHubUser | null;
};

type AppAuthState = {
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
};

function toNullableString(value: string): string | null {
  return value.trim() ? value : null;
}

export function buildAuthSession(patAuth: PatAuthState, appAuth: AppAuthState, disconnect: () => void): GitHubAuthSession {
  const patToken = toNullableString(patAuth.token);
  const token = toNullableString(appAuth.token) ?? patToken;

  return {
    status: appAuth.isAppAuth ? 'app' : (patToken ? 'pat' : 'signed_out'),
    token,
    patToken,
    validatedUser: appAuth.validatedUser ?? patAuth.validatedUser,
    isAppAuth: appAuth.isAppAuth,
    installationId: toNullableString(appAuth.installationId),
    loading: appAuth.loading || patAuth.loading,
    error: appAuth.error || patAuth.error,
    appLoading: appAuth.loading,
    appError: appAuth.error,
    connectPat: patAuth.setTokenManually,
    connectApp: appAuth.connect,
    installApp: appAuth.install,
    setInstallationIdManually: appAuth.setInstallationIdManually,
    disconnect,
  };
}

export function useAuthSession(): GitHubAuthSession {
  const patAuth = useGitHubAuth();
  const appAuth = useGitHubAppAuth();
  const { logout } = patAuth;
  const { disconnect: disconnectApp } = appAuth;

  const disconnect = useCallback(() => {
    disconnectApp();
    logout();
  }, [disconnectApp, logout]);

  return useMemo(
    () => buildAuthSession(patAuth, appAuth, disconnect),
    [appAuth, disconnect, patAuth],
  );
}
