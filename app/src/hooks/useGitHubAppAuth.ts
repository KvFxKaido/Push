import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitHubUser } from '../types';

const INSTALLATION_ID_KEY = 'github_app_installation_id';
const TOKEN_KEY = 'github_app_token';
const TOKEN_EXPIRY_KEY = 'github_app_token_expiry';

// Refresh token 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// GitHub App name for installation URL
const GITHUB_APP_NAME = 'push-auth';

type TokenResponse = {
  token: string;
  expires_at: string;
  permissions: Record<string, string>;
  repository_selection: string;
};

type UseGitHubAppAuth = {
  token: string;
  installationId: string;
  install: () => void;
  disconnect: () => void;
  setInstallationIdManually: (instId: string) => Promise<boolean>;
  loading: boolean;
  error: string | null;
  validatedUser: GitHubUser | null;
  isAppAuth: boolean;
};

async function fetchAppToken(installationId: string): Promise<TokenResponse> {
  const res = await fetch('/api/github/app-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installation_id: installationId }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to fetch token: ${res.status}`);
  }

  return res.json();
}

async function validateToken(token: string): Promise<GitHubUser | null> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { login: data.login, avatar_url: data.avatar_url };
  } catch {
    return null;
  }
}

export function useGitHubAppAuth(): UseGitHubAppAuth {
  const [installationId, setInstallationId] = useState(
    () => localStorage.getItem(INSTALLATION_ID_KEY) || ''
  );
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || '');
  const [, setTokenExpiry] = useState(
    () => localStorage.getItem(TOKEN_EXPIRY_KEY) || ''
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validatedUser, setValidatedUser] = useState<GitHubUser | null>(null);

  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountInitialized = useRef(false);

  // Schedule token refresh before expiry
  const scheduleRefresh = useCallback((expiresAt: string, instId: string) => {
    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current);
    }

    const expiryTime = new Date(expiresAt).getTime();
    const now = Date.now();
    const refreshIn = Math.max(0, expiryTime - now - REFRESH_BUFFER_MS);

    refreshTimeoutRef.current = setTimeout(async () => {
      try {
        const data = await fetchAppToken(instId);
        localStorage.setItem(TOKEN_KEY, data.token);
        localStorage.setItem(TOKEN_EXPIRY_KEY, data.expires_at);
        setToken(data.token);
        setTokenExpiry(data.expires_at);
        scheduleRefresh(data.expires_at, instId);
      } catch (err) {
        console.error('[Push] Token refresh failed:', err);
        // Don't clear auth on refresh failure — user can still use current token
      }
    }, refreshIn);
  }, []);

  // Fetch token for installation
  const fetchAndSetToken = useCallback(async (instId: string) => {
    setLoading(true);
    setError(null);

    try {
      const data = await fetchAppToken(instId);

      localStorage.setItem(INSTALLATION_ID_KEY, instId);
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(TOKEN_EXPIRY_KEY, data.expires_at);

      setInstallationId(instId);
      setToken(data.token);
      setTokenExpiry(data.expires_at);

      // Validate and get user info
      const user = await validateToken(data.token);
      if (user) {
        setValidatedUser(user);
      }

      // Schedule refresh
      scheduleRefresh(data.expires_at, instId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to authenticate';
      setError(message);
      // Clear invalid installation
      localStorage.removeItem(INSTALLATION_ID_KEY);
      setInstallationId('');
    } finally {
      setLoading(false);
    }
  }, [scheduleRefresh]);

  // Handle installation callback from GitHub
  useEffect(() => {
    const url = new URL(window.location.href);
    const instId = url.searchParams.get('installation_id');
    const setupAction = url.searchParams.get('setup_action');

    if (instId && setupAction === 'install') {
      // Clear URL params
      window.history.replaceState({}, document.title, window.location.pathname);
      // Fetch token for new installation
      fetchAndSetToken(instId);
    }
  }, [fetchAndSetToken]);

  // On mount: validate existing installation
  useEffect(() => {
    if (mountInitialized.current) return;
    mountInitialized.current = true;

    const storedInstId = localStorage.getItem(INSTALLATION_ID_KEY);
    const storedToken = localStorage.getItem(TOKEN_KEY);
    const storedExpiry = localStorage.getItem(TOKEN_EXPIRY_KEY);

    if (!storedInstId) return;

    // Check if token is still valid
    if (storedToken && storedExpiry) {
      const expiryTime = new Date(storedExpiry).getTime();
      const now = Date.now();

      if (expiryTime > now + REFRESH_BUFFER_MS) {
        // Token still valid — validate user and schedule refresh
        validateToken(storedToken).then((user) => {
          if (user) {
            setValidatedUser(user);
            scheduleRefresh(storedExpiry, storedInstId);
          } else {
            // Token invalid — try to refresh
            fetchAndSetToken(storedInstId);
          }
        });
        return;
      }
    }

    // Token expired or missing — fetch new one
    fetchAndSetToken(storedInstId);
  }, [fetchAndSetToken, scheduleRefresh]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }
    };
  }, []);

  const install = useCallback(() => {
    // Redirect to GitHub App installation page
    const redirectUri = encodeURIComponent(window.location.origin);
    window.location.assign(
      `https://github.com/apps/${GITHUB_APP_NAME}/installations/new?redirect_uri=${redirectUri}`
    );
  }, []);

  // Manual installation ID entry (for users who already have the app installed)
  const setInstallationIdManually = useCallback(
    async (instId: string): Promise<boolean> => {
      const trimmed = instId.trim();
      if (!trimmed || !/^\d+$/.test(trimmed)) {
        setError('Invalid installation ID — must be a number');
        return false;
      }
      try {
        await fetchAndSetToken(trimmed);
        return true;
      } catch {
        return false;
      }
    },
    [fetchAndSetToken]
  );

  const disconnect = useCallback(() => {
    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current);
    }
    localStorage.removeItem(INSTALLATION_ID_KEY);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXPIRY_KEY);
    setInstallationId('');
    setToken('');
    setTokenExpiry('');
    setValidatedUser(null);
  }, []);

  return {
    token,
    installationId,
    install,
    setInstallationIdManually,
    disconnect,
    loading,
    error,
    validatedUser,
    isAppAuth: Boolean(installationId),
  };
}
