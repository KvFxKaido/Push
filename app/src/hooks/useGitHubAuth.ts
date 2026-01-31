import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'github_access_token';
const STATE_KEY = 'github_oauth_state';

const CLIENT_ID = import.meta.env.VITE_GITHUB_CLIENT_ID || '';
const OAUTH_PROXY = import.meta.env.VITE_GITHUB_OAUTH_PROXY || '';
const ENV_TOKEN = import.meta.env.VITE_GITHUB_TOKEN || '';

type UseGitHubAuth = {
  token: string;
  login: () => void;
  logout: () => void;
  loading: boolean;
  error: string | null;
  configured: boolean;
  oauthConfigured: boolean;
  setTokenManually: (token: string) => void;
};

export function useGitHubAuth(): UseGitHubAuth {
  const [token, setToken] = useState(() => localStorage.getItem(STORAGE_KEY) || ENV_TOKEN);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setTokenManually = useCallback((pat: string) => {
    const trimmed = pat.trim();
    if (trimmed) {
      localStorage.setItem(STORAGE_KEY, trimmed);
      setToken(trimmed);
      setError(null);
    }
  }, []);

  const login = useCallback(() => {
    if (!CLIENT_ID) {
      setError('Missing VITE_GITHUB_CLIENT_ID. Add it to your .env file to enable OAuth.');
      return;
    }

    const state = crypto.randomUUID();
    sessionStorage.setItem(STATE_KEY, state);

    const redirectUri = window.location.origin;
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: 'repo',
      state,
    });

    window.location.assign(`https://github.com/login/oauth/authorize?${params.toString()}`);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setToken('');
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code) {
      return;
    }

    const expectedState = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(STATE_KEY);

    if (!state || state !== expectedState) {
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
        redirect_uri: window.location.origin,
      }),
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Token exchange failed');
        }
        return response.json();
      })
      .then((data: { access_token?: string }) => {
        if (!data.access_token) {
          throw new Error('No access token returned');
        }
        localStorage.setItem(STORAGE_KEY, data.access_token);
        setToken(data.access_token);
        window.history.replaceState({}, document.title, window.location.pathname);
      })
      .catch((err: Error) => {
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
  };
}
