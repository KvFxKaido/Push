import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitHubUser } from '../types';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/safe-storage';
import { isNetworkFetchError, validateGitHubToken as validateToken } from '@/lib/utils';

const INSTALLATION_ID_KEY = 'github_app_installation_id';
const TOKEN_KEY = 'github_app_token';
const TOKEN_EXPIRY_KEY = 'github_app_token_expiry';
const USER_KEY = 'github_app_user';

// Refresh token 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// GitHub App name for installation URL
const GITHUB_APP_NAME = 'push-auth';

// GitHub App OAuth Client ID (public value — safe to hardcode, like GITHUB_APP_NAME)
const GITHUB_APP_CLIENT_ID = 'Iv23liJZx2boQUWBDb3T';
const GITHUB_APP_REDIRECT_URI = import.meta.env.VITE_GITHUB_APP_REDIRECT_URI || '';

type TokenResponse = {
  token: string;
  expires_at: string;
  permissions: Record<string, string>;
  repository_selection: string;
  user?: GitHubUser | null;
};

type UseGitHubAppAuth = {
  token: string;
  installationId: string;
  connect: () => void;
  install: () => void;
  disconnect: () => void;
  setInstallationIdManually: (instId: string) => Promise<boolean>;
  loading: boolean;
  error: string | null;
  validatedUser: GitHubUser | null;
  isAppAuth: boolean;
};

function formatProxyUnavailableError(route: string): string {
  return [
    `Cannot reach ${route}.`,
    'Local API proxy is unavailable.',
    'Run Worker dev server in another terminal: `cd /home/ishaw/projects/Push && npx wrangler dev --port 8787`.',
    'If your Worker runs on a different port, set `VITE_API_PROXY_TARGET` in `app/.env`.',
  ].join(' ');
}

function formatAppTokenError(status: number, errorMessage: string): string {
  if (status === 403 && errorMessage.includes('installation_id is not allowed')) {
    return 'This installation is not authorized on this deployment. Ask the admin to add your installation ID to GITHUB_ALLOWED_INSTALLATION_IDS in Worker secrets.';
  }
  if (status === 403) {
    return 'Access denied while fetching GitHub App token. Verify the app installation and Worker configuration.';
  }
  return errorMessage || `Failed to fetch token: ${status}`;
}

function getGitHubAppRedirectUri(): string {
  const configured = GITHUB_APP_REDIRECT_URI.trim();
  if (configured) {
    // Normalize via URL constructor so trailing-slash handling matches the fallback path
    // and GitHub's registered callback URL.
    try { return new URL(configured).toString(); } catch { return configured; }
  }
  // Canonical root URL avoids origin/slash mismatches in GitHub callback checks.
  return new URL('/', window.location.origin).toString();
}

function parseStoredUser(raw: string | null): GitHubUser | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { login?: unknown; avatar_url?: unknown };
    if (typeof parsed.login !== 'string' || !parsed.login.trim()) return null;
    return {
      login: parsed.login,
      avatar_url: typeof parsed.avatar_url === 'string' ? parsed.avatar_url : '',
    };
  } catch {
    return null;
  }
}

async function fetchAppToken(installationId: string): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch('/api/github/app-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installation_id: installationId }),
    });
  } catch (err) {
    if (isNetworkFetchError(err)) {
      throw new Error(formatProxyUnavailableError('/api/github/app-token'));
    }
    throw err instanceof Error ? err : new Error(String(err));
  }

  if (!res.ok) {
    const rawBody = await res.text().catch(() => '');
    let rawError = '';
    try {
      const data = JSON.parse(rawBody) as { error?: unknown; details?: unknown };
      if (typeof data.error === 'string' && data.error.trim()) {
        rawError = data.error;
      } else if (typeof data.details === 'string' && data.details.trim()) {
        rawError = data.details;
      }
    } catch {
      // Non-JSON error body (e.g. proxy/runtime HTML)
      rawError = rawBody.slice(0, 300);
    }
    throw new Error(formatAppTokenError(res.status, rawError));
  }

  return res.json();
}

async function fetchAppOAuth(code: string): Promise<TokenResponse & { installation_id: string }> {
  let res: Response;
  try {
    res = await fetch('/api/github/app-oauth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch (err) {
    if (isNetworkFetchError(err)) {
      throw new Error(formatProxyUnavailableError('/api/github/app-oauth'));
    }
    throw err instanceof Error ? err : new Error(String(err));
  }

  if (!res.ok) {
    const rawBody = await res.text().catch(() => '');
    let rawError = '';
    let installUrl = '';
    try {
      const data = JSON.parse(rawBody) as { error?: unknown; details?: unknown; install_url?: unknown };
      if (typeof data.error === 'string' && data.error.trim()) {
        rawError = data.error;
      } else if (typeof data.details === 'string' && data.details.trim()) {
        rawError = data.details;
      }
      if (typeof data.install_url === 'string') {
        installUrl = data.install_url;
      }
    } catch {
      rawError = rawBody.slice(0, 300);
    }

    if (res.status === 404 && installUrl) {
      throw new Error(rawError || 'No installation found. Please install the GitHub App first.');
    }
    throw new Error(formatAppTokenError(res.status, rawError));
  }

  return res.json();
}

export function useGitHubAppAuth(): UseGitHubAppAuth {
  const [installationId, setInstallationId] = useState(
    () => safeStorageGet(INSTALLATION_ID_KEY) || ''
  );
  const [token, setToken] = useState(() => safeStorageGet(TOKEN_KEY) || '');
  const [, setTokenExpiry] = useState(
    () => safeStorageGet(TOKEN_EXPIRY_KEY) || ''
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validatedUser, setValidatedUser] = useState<GitHubUser | null>(
    () => parseStoredUser(safeStorageGet(USER_KEY))
  );

  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountInitialized = useRef(false);

  const saveValidatedUser = useCallback((user: GitHubUser | null) => {
    setValidatedUser(user);
    if (user) {
      safeStorageSet(USER_KEY, JSON.stringify(user));
    } else {
      safeStorageRemove(USER_KEY);
    }
  }, []);

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
        safeStorageSet(TOKEN_KEY, data.token);
        safeStorageSet(TOKEN_EXPIRY_KEY, data.expires_at);
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
  const fetchAndSetToken = useCallback(async (instId: string): Promise<boolean> => {
    setLoading(true);
    setError(null);
    const normalizedInstId = instId.trim();

    // Persist installation ID independently from token state so users don't lose it
    // when token exchange fails temporarily (network/proxy/allowlist issues).
    if (normalizedInstId) {
      safeStorageSet(INSTALLATION_ID_KEY, normalizedInstId);
      setInstallationId(normalizedInstId);
    }

    try {
      const data = await fetchAppToken(normalizedInstId);

      safeStorageSet(TOKEN_KEY, data.token);
      safeStorageSet(TOKEN_EXPIRY_KEY, data.expires_at);

      setToken(data.token);
      setTokenExpiry(data.expires_at);

      const userFromResponse = data.user && data.user.login ? data.user : null;
      if (userFromResponse) {
        saveValidatedUser(userFromResponse);
      } else {
        // Fallback for environments that don't provide user metadata.
        const user = await validateToken(data.token);
        if (user) {
          saveValidatedUser(user);
        }
      }

      // Schedule refresh
      scheduleRefresh(data.expires_at, normalizedInstId);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to authenticate';
      setError(message);
      return false;
    } finally {
      setLoading(false);
    }
  }, [saveValidatedUser, scheduleRefresh]);

  // Handle OAuth code callback (auto-connect flow)
  const handleOAuthCallback = useCallback(async (code: string) => {
    setLoading(true);
    setError(null);

    try {
      const data = await fetchAppOAuth(code);

      safeStorageSet(INSTALLATION_ID_KEY, data.installation_id);
      safeStorageSet(TOKEN_KEY, data.token);
      safeStorageSet(TOKEN_EXPIRY_KEY, data.expires_at);

      setInstallationId(data.installation_id);
      setToken(data.token);
      setTokenExpiry(data.expires_at);

      const userFromResponse = data.user && data.user.login ? data.user : null;
      if (userFromResponse) {
        saveValidatedUser(userFromResponse);
      } else {
        const user = await validateToken(data.token);
        if (user) {
          saveValidatedUser(user);
        }
      }

      scheduleRefresh(data.expires_at, data.installation_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OAuth connection failed';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [saveValidatedUser, scheduleRefresh]);

  // Handle installation callback from GitHub (install flow) or OAuth code callback (connect flow)
  useEffect(() => {
    const url = new URL(window.location.href);

    // Install callback: ?installation_id=...&setup_action=install
    const instId = url.searchParams.get('installation_id');
    const setupAction = url.searchParams.get('setup_action');
    if (instId && setupAction === 'install') {
      window.history.replaceState({}, document.title, window.location.pathname);
      fetchAndSetToken(instId);
      return;
    }

    // OAuth callback: ?code=...
    const code = url.searchParams.get('code');
    if (code) {
      window.history.replaceState({}, document.title, window.location.pathname);
      handleOAuthCallback(code);
    }
  }, [fetchAndSetToken, handleOAuthCallback]);

  // On mount: validate existing installation
  useEffect(() => {
    if (mountInitialized.current) return;
    mountInitialized.current = true;

    const storedInstId = safeStorageGet(INSTALLATION_ID_KEY);
    const storedToken = safeStorageGet(TOKEN_KEY);
    const storedExpiry = safeStorageGet(TOKEN_EXPIRY_KEY);

    if (!storedInstId) return;

    // Check if token is still valid
    if (storedToken && storedExpiry) {
      const expiryTime = new Date(storedExpiry).getTime();
      const now = Date.now();

      if (expiryTime > now + REFRESH_BUFFER_MS) {
        // Token still valid — validate user and schedule refresh
        validateToken(storedToken).then((user) => {
          if (user) {
            saveValidatedUser(user);
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
  }, [fetchAndSetToken, saveValidatedUser, scheduleRefresh]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }
    };
  }, [saveValidatedUser]);

  const connect = useCallback(() => {
    // Redirect to GitHub OAuth for auto-connect (finds existing installation automatically)
    const params = new URLSearchParams({
      client_id: GITHUB_APP_CLIENT_ID,
      redirect_uri: getGitHubAppRedirectUri(),
    });
    window.location.assign(
      `https://github.com/login/oauth/authorize?${params.toString()}`
    );
  }, []);

  const install = useCallback(() => {
    // Redirect to GitHub App installation page
    const params = new URLSearchParams({
      redirect_uri: getGitHubAppRedirectUri(),
    });
    window.location.assign(
      `https://github.com/apps/${GITHUB_APP_NAME}/installations/new?${params.toString()}`
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
      return fetchAndSetToken(trimmed);
    },
    [fetchAndSetToken]
  );

  const disconnect = useCallback(() => {
    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current);
    }
    safeStorageRemove(INSTALLATION_ID_KEY);
    safeStorageRemove(TOKEN_KEY);
    safeStorageRemove(TOKEN_EXPIRY_KEY);
    safeStorageRemove(USER_KEY);
    setInstallationId('');
    setToken('');
    setTokenExpiry('');
    saveValidatedUser(null);
  }, [saveValidatedUser]);

  return {
    token,
    installationId,
    connect,
    install,
    setInstallationIdManually,
    disconnect,
    loading,
    error,
    validatedUser,
    isAppAuth: Boolean(installationId),
  };
}
