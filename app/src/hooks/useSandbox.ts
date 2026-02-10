/**
 * useSandbox — manages sandbox session lifecycle.
 *
 * Status: idle → creating → ready → error
 *
 * The sandbox persists across messages in a single chat session.
 * Container auto-terminates on Modal's side after 30 min.
 *
 * Session persistence: sandbox IDs are saved to localStorage so that
 * PWA refreshes can reconnect to an existing container instead of
 * creating a new one. Sessions expire after 25 min (safety margin).
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { createSandbox, cleanupSandbox, execInSandbox, setSandboxOwnerToken, getSandboxOwnerToken } from '@/lib/sandbox-client';

export type SandboxStatus = 'idle' | 'creating' | 'ready' | 'error';

const OAUTH_STORAGE_KEY = 'github_access_token';
const APP_TOKEN_STORAGE_KEY = 'github_app_token';
const GITHUB_TOKEN = import.meta.env.VITE_GITHUB_TOKEN || '';

const SANDBOX_SESSION_KEY = 'sandbox_session';
const SANDBOX_MAX_AGE_MS = 25 * 60 * 1000; // 25 min (conservative vs Modal's 30 min)

interface PersistedSandboxSession {
  sandboxId: string;
  ownerToken: string;
  repoFullName: string;
  branch: string;
  createdAt: number;
}

function getGitHubToken(): string {
  return localStorage.getItem(OAUTH_STORAGE_KEY) || localStorage.getItem(APP_TOKEN_STORAGE_KEY) || GITHUB_TOKEN;
}

function saveSession(session: PersistedSandboxSession): void {
  try {
    localStorage.setItem(SANDBOX_SESSION_KEY, JSON.stringify(session));
  } catch {
    // Quota errors — not critical
  }
}

function loadSession(): PersistedSandboxSession | null {
  try {
    const raw = localStorage.getItem(SANDBOX_SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as PersistedSandboxSession;
    // repoFullName can be '' for sandbox mode (ephemeral, no repo)
    if (!session.sandboxId || !session.ownerToken || !session.createdAt) return null;
    return session;
  } catch {
    return null;
  }
}

function clearSession(): void {
  localStorage.removeItem(SANDBOX_SESSION_KEY);
  setSandboxOwnerToken(null);
}

export function useSandbox(activeRepoFullName?: string | null) {
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [status, setStatus] = useState<SandboxStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const sandboxIdRef = useRef<string | null>(null);
  const statusRef = useRef<SandboxStatus>('idle');
  const reconnectingRef = useRef(false);
  const reconnectPromiseRef = useRef<Promise<string | null> | null>(null);
  const startPromiseRef = useRef<Promise<string | null> | null>(null);

  // Keep ref in sync for cleanup
  useEffect(() => {
    sandboxIdRef.current = sandboxId;
  }, [sandboxId]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Attempt to reconnect to a saved sandbox session on mount
  useEffect(() => {
    if (status !== 'idle') return;
    // null/undefined = no sandbox context yet; '' = sandbox mode (ephemeral)
    if (activeRepoFullName == null) return;
    if (sandboxIdRef.current) return;

    const saved = loadSession();
    if (!saved) return;

    if (saved.repoFullName !== activeRepoFullName) {
      clearSession();
      return;
    }

    const ageMs = Date.now() - saved.createdAt;
    if (ageMs > SANDBOX_MAX_AGE_MS) {
      clearSession();
      return;
    }

    let cancelled = false;
    reconnectingRef.current = true;
    setSandboxOwnerToken(saved.ownerToken);

    const reconnectPromise = execInSandbox(saved.sandboxId, 'true')
      .then((result) => {
        if (cancelled) return null;
        if (result.exitCode === 0) {
          setSandboxId(saved.sandboxId);
          sandboxIdRef.current = saved.sandboxId;
          setStatus('ready');
          console.log('[useSandbox] Reconnected to saved sandbox:', saved.sandboxId);
          return saved.sandboxId;
        }
        clearSession();
        return null;
      })
      .catch(() => {
        if (!cancelled) clearSession();
        return null;
      })
      .finally(() => {
        if (!cancelled) {
          reconnectingRef.current = false;
          reconnectPromiseRef.current = null;
        }
      });

    reconnectPromiseRef.current = reconnectPromise;

    return () => {
      cancelled = true;
      reconnectingRef.current = false;
      reconnectPromiseRef.current = null;
    };
  }, [activeRepoFullName, status]);

  // Invalidate saved session when active repo changes
  useEffect(() => {
    if (activeRepoFullName == null) return;
    const saved = loadSession();
    if (saved && saved.repoFullName !== activeRepoFullName) {
      clearSession();
      if (sandboxIdRef.current && status === 'ready') {
        sandboxIdRef.current = null;
        setSandboxId(null);
        setStatus('idle');
      }
    }
  }, [activeRepoFullName, status]);

  const start = useCallback(async (repo: string, branch?: string): Promise<string | null> => {
    if (startPromiseRef.current) return startPromiseRef.current;
    if (statusRef.current === 'creating') return null;

    const startPromise = (async () => {
      // If reconnection is in progress, wait for it
      if (reconnectingRef.current && reconnectPromiseRef.current) {
        const reconnectedId = await reconnectPromiseRef.current;
        if (reconnectedId) return reconnectedId;
      }

      if (sandboxIdRef.current) return sandboxIdRef.current;

      setStatus('creating');
      setError(null);
      setSandboxOwnerToken(null);

      try {
        // Empty repo = sandbox mode (ephemeral workspace, no clone, no token needed)
        const token = repo ? getGitHubToken() : '';
        const session = await createSandbox(repo, branch, token);

        if (session.status === 'error') {
          setStatus('error');
          setError(session.error || 'Sandbox creation failed');
          return null;
        }

        setSandboxId(session.sandboxId);
        setStatus('ready');
        setSandboxOwnerToken(session.ownerToken || null);

        saveSession({
          sandboxId: session.sandboxId,
          ownerToken: session.ownerToken || '',
          repoFullName: repo,
          branch: branch || 'main',
          createdAt: Date.now(),
        });

        return session.sandboxId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus('error');
        setError(msg);
        return null;
      }
    })();

    startPromiseRef.current = startPromise;

    return startPromise.finally(() => {
      if (startPromiseRef.current === startPromise) {
        startPromiseRef.current = null;
      }
    });
  }, []);

  const stop = useCallback(async () => {
    const id = sandboxIdRef.current;
    if (!id) return;

    try {
      await cleanupSandbox(id);
    } catch {
      // Best effort — container will auto-terminate anyway
    } finally {
      clearSession();
    }

    setSandboxId(null);
    setStatus('idle');
    setError(null);
  }, []);

  const rebindSessionRepo = useCallback((repoFullName: string, branch: string = 'main') => {
    const id = sandboxIdRef.current;
    if (!id) return;
    const ownerToken = getSandboxOwnerToken();
    if (!ownerToken) return;

    const existing = loadSession();
    const createdAt = existing?.createdAt ?? Date.now();
    saveSession({
      sandboxId: id,
      ownerToken,
      repoFullName,
      branch,
      createdAt,
    });
  }, []);

  // Expose session createdAt for expiry warnings
  const createdAt = useMemo(() => {
    const saved = loadSession();
    return saved?.createdAt ?? null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sandboxId]);

  return {
    sandboxId,
    status,
    error,
    start,
    stop,
    rebindSessionRepo,
    createdAt,
  };
}
