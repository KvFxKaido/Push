import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitHubUser } from '../types';
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
  login: () => void;
  logout: () => void;
  loading: boolean;
  error: string | null;
  configured: boolean;
  oauthConfigured: boolean;
  setTokenManually: (token: string) => Promise<boolean>;
  validatedUser: GitHubUser | null;
};

function getOAuthRedirectUri(): string {
  const configured = OAUTH_REDIRECT_URI.trim();
  if (configured) {
    // Normalize via URL constructor so trailing-slash handling matches the fallback path
    // and GitHub's registered callback URL.
    try { return new URL(configured).toString(); } catch { return configured; }
  }
  return new URL('/', window.location.origin).toString();
}

export function useGitHubAuth(): UseGitHubAuth {
  const [token, setToken] = useState(() => safeStorageGet(STORAGE_KEY) || ENV_TOKEN);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validatedUser, setValidatedUser] = useState<GitHubUser | null>(null);
  const mountValidated = useRef(false);

  // On mount: silently re-validate stored token
  useEffect(() => {
    if (mountValidated.current) return;
    mountValidated.current = true;

    const stored = safeStorageGet(STORAGE_KEY) || ENV_TOKEN;
    if (!stored) return;

    validateToken(stored).then((user) => {
      if (user) {
        setValidatedUser(user);
      } else {
        // Token expired or revoked — clear it
        safeStorageRemove(STORAGE_KEY);
        setToken('');
        setValidatedUser(null);
      }
    });
  }, []);

  const setTokenManually = useCallback(async (pat: string): Promise<boolean> => {
    const trimmed = pat.trim();
    if (!trimmed) return false;

    setLoading(true);
    setError(null);

    const user = await validateToken(trimmed);
    if (user) {
      safeStorageSet(STORAGE_KEY, trimmed);
      setToken(trimmed);
      setValidatedUser(user);
      setLoading(false);
      return true;
    } else {
      setError('Invalid token — could not authenticate with GitHub.');
      setLoading(false);
      return false;
    }
  }, []);

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
    setToken('');
    setValidatedUser(null);
  }, []);

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
        setToken(data.access_token);
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
  }, []);

  return {
    token,
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
