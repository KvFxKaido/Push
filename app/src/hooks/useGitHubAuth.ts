import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitHubUser } from '../types';
import { classifyTokenString, type GitHubTokenKind } from '@/lib/github-auth';
import { setAcknowledgedUserTokenInjection } from '@/lib/sandbox-auth-gate';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/safe-storage';
import { isNetworkFetchError, validateGitHubToken as validateToken } from '@/lib/utils';

const STORAGE_KEY = 'github_access_token';
const STATE_KEY = 'github_oauth_state';

const CLIENT_ID = import.meta.env.VITE_GITHUB_CLIENT_ID || '';
const OAUTH_PROXY = import.meta.env.VITE_GITHUB_OAUTH_PROXY || '';
const OAUTH_REDIRECT_URI = import.meta.env.VITE_GITHUB_REDIRECT_URI || '';
const ENV_TOKEN = import.meta.env.VITE_GITHUB_TOKEN || '';

type UseGitHubAuth = {
  token: string;
  tokenKind: GitHubTokenKind;
  login: () => void;
  logout: () => void;
  loading: boolean;
  error: string | null;
  configured: boolean;
  oauthConfigured: boolean;
  setTokenManually: (token: string) => Promise<boolean>;
  validatedUser: GitHubUser | null;
};

function userFlowTokenKind(token: string): GitHubTokenKind {
  const shape = classifyTokenString(token);
  return shape === 'pat' ? 'pat' : 'oauth';
}

function initialTokenState(): { token: string; kind: GitHubTokenKind } {
  const stored = safeStorageGet(STORAGE_KEY);
  if (stored) return { token: stored, kind: userFlowTokenKind(stored) };
  if (ENV_TOKEN) return { token: ENV_TOKEN, kind: 'env' };
  return { token: '', kind: 'none' };
}

function getOAuthRedirectUri(): string {
  const configured = OAUTH_REDIRECT_URI.trim();
  if (configured) {
    // Normalize via URL constructor so trailing-slash handling matches the fallback path
    // and GitHub's registered callback URL.
    try {
      return new URL(configured).toString();
    } catch {
      return configured;
    }
  }
  return new URL('/', window.location.origin).toString();
}

export function useGitHubAuth(): UseGitHubAuth {
  const [{ token, kind: tokenKind }, setTokenState] = useState(initialTokenState);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validatedUser, setValidatedUser] = useState<GitHubUser | null>(null);
  const mountValidated = useRef(false);

  // Single source of truth for the token/kind pair so the two can never
  // desync: every "we have a user-flow token" site derives the kind from the
  // token shape, and every "we have nothing" site collapses to the same
  // `none` pair. Updating one without the other is no longer expressible.
  const applyUserToken = useCallback((nextToken: string) => {
    setTokenState({ token: nextToken, kind: userFlowTokenKind(nextToken) });
  }, []);
  const clearToken = useCallback(() => {
    setTokenState({ token: '', kind: 'none' });
  }, []);

  // On mount: silently re-validate stored token
  useEffect(() => {
    if (mountValidated.current) return;
    mountValidated.current = true;

    const stored = safeStorageGet(STORAGE_KEY);
    const candidate = stored || ENV_TOKEN;
    if (!candidate) return;

    validateToken(candidate).then((user) => {
      if (user) {
        setValidatedUser(user);
      } else if (stored) {
        // A stored OAuth/PAT token expired or was revoked — clear it so the
        // UI and the sandbox gate both see "signed out".
        safeStorageRemove(STORAGE_KEY);
        clearToken();
        setValidatedUser(null);
      } else {
        // The candidate is the build-time ENV_TOKEN, which lives outside
        // storage and outside this hook's state — `getActiveGitHubTokenInfo()`
        // (the source the sandbox gate reads) will keep resolving it
        // regardless. Collapsing our state to `none` here would desync the two
        // (Settings shows signed-out, but the gate still blocks on an env
        // token with no way to acknowledge it). Leave the env pair in place;
        // a genuinely invalid env token surfaces as an honest API failure.
        setValidatedUser(null);
      }
    });
  }, [clearToken]);

  const setTokenManually = useCallback(
    async (pat: string): Promise<boolean> => {
      const trimmed = pat.trim();
      if (!trimmed) return false;

      setLoading(true);
      setError(null);

      const user = await validateToken(trimmed);
      if (user) {
        safeStorageSet(STORAGE_KEY, trimmed);
        applyUserToken(trimmed);
        setValidatedUser(user);
        setLoading(false);
        return true;
      } else {
        setError('Invalid token — could not authenticate with GitHub.');
        setLoading(false);
        return false;
      }
    },
    [applyUserToken],
  );

  const login = useCallback(() => {
    if (!CLIENT_ID) {
      setError('Missing VITE_GITHUB_CLIENT_ID. Add it to your .env file to enable OAuth.');
      return;
    }

    const state = crypto.randomUUID();
    safeStorageSet(STATE_KEY, state, 'session');

    const redirectUri = getOAuthRedirectUri();
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: 'repo',
      state,
    });

    window.location.assign(`https://github.com/login/oauth/authorize?${params.toString()}`);
  }, []);

  const logout = useCallback(() => {
    safeStorageRemove(STORAGE_KEY);
    clearToken();
    setValidatedUser(null);
    // Consent to inject a durable user-scoped token into a cloud sandbox is
    // tied to the credential — drop it when the credential is removed so a
    // later (possibly different) token can't ride a stale acknowledgment.
    setAcknowledgedUserTokenInjection(false);
  }, [clearToken]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code) {
      return;
    }

    const expectedState = safeStorageGet(STATE_KEY, 'session');
    safeStorageRemove(STATE_KEY, 'session');

    if (!state || state !== expectedState) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError('GitHub OAuth failed: invalid state parameter.');
      return;
    }

    if (!OAUTH_PROXY) {
      setError('Missing VITE_GITHUB_OAUTH_PROXY to exchange the OAuth code for a token.');
      return;
    }

    setLoading(true);
    setError(null);

    fetch(OAUTH_PROXY, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code,
        redirect_uri: getOAuthRedirectUri(),
      }),
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Token exchange failed');
        }
        return response.json();
      })
      .then(async (data: { access_token?: string }) => {
        if (!data.access_token) {
          throw new Error('No access token returned');
        }
        safeStorageSet(STORAGE_KEY, data.access_token);
        applyUserToken(data.access_token);
        window.history.replaceState({}, document.title, window.location.pathname);

        // Validate the OAuth token too
        const user = await validateToken(data.access_token);
        if (user) setValidatedUser(user);
      })
      .catch((err: Error) => {
        if (isNetworkFetchError(err)) {
          setError(
            'GitHub OAuth error: Could not reach your OAuth proxy. Check `VITE_GITHUB_OAUTH_PROXY` and local network access.',
          );
          return;
        }
        setError(`GitHub OAuth error: ${err.message}`);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [applyUserToken]);

  return {
    token,
    tokenKind,
    login,
    logout,
    loading,
    error,
    configured: Boolean(CLIENT_ID) || Boolean(ENV_TOKEN),
    oauthConfigured: Boolean(CLIENT_ID),
    setTokenManually,
    validatedUser,
  };
}
