import { useCallback, useMemo } from 'react';
import { useGitHubAppAuth } from '@/hooks/useGitHubAppAuth';
import { useGitHubAuth } from '@/hooks/useGitHubAuth';
import type { GitHubAuthSession, GitHubUser } from '@/types';
import type { GitHubTokenKind } from '@/lib/github-auth';

type PatAuthState = {
  token: string;
  tokenKind: GitHubTokenKind;
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

export function buildAuthSession(
  patAuth: PatAuthState,
  appAuth: AppAuthState,
  disconnect: () => void,
): GitHubAuthSession {
  const appToken = toNullableString(appAuth.token);
  const patToken = toNullableString(patAuth.token);
  const token = appToken ?? patToken;
  // Classify the credential we actually resolved, not the auth *mode*. When an
  // installation id is stored but its app token is missing (revocation, a
  // failed refresh, allowlist rejection), `isAppAuth` stays true while `token`
  // silently falls back to the PAT/OAuth token. Keying `tokenKind` off
  // `isAppAuth` there would label that durable user token as `app`, hiding the
  // sandbox acknowledgment toggle in Settings — yet `useSandbox` reads the raw
  // token from storage, sees the durable token, and blocks with no way to
  // unblock. Deriving the kind from which token won keeps Settings and the
  // gate in agreement (and mirrors `getActiveGitHubTokenInfo`'s precedence).
  const tokenKind: GitHubTokenKind = appToken ? 'app' : patToken ? patAuth.tokenKind : 'none';

  return {
    status: appAuth.isAppAuth ? 'app' : patToken ? 'pat' : 'signed_out',
    token,
    tokenKind,
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
