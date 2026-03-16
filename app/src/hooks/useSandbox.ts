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
import {
  createSandbox,
  cleanupSandbox,
  execInSandbox,
  setSandboxOwnerToken,
  getSandboxOwnerToken,
  setActiveSandboxEnvironment,
  clearSandboxEnvironment,
  probeSandboxEnvironment,
} from '@/lib/sandbox-client';
import type { GitCommitIdentity } from '@/lib/sandbox-client';
import { safeStorageGet } from '@/lib/safe-storage';
import { fileLedger } from '@/lib/file-awareness-ledger';
import { clearFileVersionCache, clearSandboxWorkspaceRevision } from '@/lib/sandbox-file-version-cache';
import { getActiveGitHubToken, APP_TOKEN_STORAGE_KEY } from '@/lib/github-auth';
import {
  buildSandboxSessionStorageKey,
  clearSandboxSessionByStorageKey,
  loadSandboxSession,
  saveSandboxSession,
} from '@/lib/sandbox-session';

export type SandboxStatus = 'idle' | 'reconnecting' | 'creating' | 'ready' | 'error';

const APP_COMMIT_IDENTITY_KEY = 'github_app_commit_identity';
const SANDBOX_MAX_AGE_MS = 25 * 60 * 1000; // 25 min (conservative vs Modal's 30 min)

function getGitHubToken(): string {
  return getActiveGitHubToken();
}

function getGitHubAppCommitIdentity(): GitCommitIdentity | undefined {
  const appToken = safeStorageGet(APP_TOKEN_STORAGE_KEY);
  if (!appToken) return undefined;
  try {
    const raw = safeStorageGet(APP_COMMIT_IDENTITY_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { name?: unknown; email?: unknown };
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) return undefined;
    if (typeof parsed.email !== 'string' || !parsed.email.trim()) return undefined;
    return { name: parsed.name, email: parsed.email };
  } catch {
    return undefined;
  }
}

function clearTrackedSession(sessionStorageKey?: string | null, sandboxId?: string): void {
  clearSandboxSessionByStorageKey(sessionStorageKey, sandboxId);
  if (sandboxId) {
    setSandboxOwnerToken(null, sandboxId);
  }
  setSandboxOwnerToken(null);
}

export function useSandbox(activeRepoFullName?: string | null, activeBranch?: string | null) {
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [status, setStatus] = useState<SandboxStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const sandboxIdRef = useRef<string | null>(null);
  const sessionStorageKeyRef = useRef<string | null>(null);
  const statusRef = useRef<SandboxStatus>('idle');
  const reconnectingRef = useRef(false);
  const reconnectPromiseRef = useRef<Promise<string | null> | null>(null);
  const startPromiseRef = useRef<Promise<string | null> | null>(null);
  const activeSessionStorageKey = useMemo(
    () => buildSandboxSessionStorageKey(activeRepoFullName, activeBranch),
    [activeRepoFullName, activeBranch],
  );

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
    if (activeRepoFullName == null || !activeSessionStorageKey) return;
    if (sandboxIdRef.current) return;

    const saved = loadSandboxSession(activeRepoFullName, activeBranch);
    if (!saved) return;

    const ageMs = Date.now() - saved.createdAt;
    if (ageMs > SANDBOX_MAX_AGE_MS) {
      clearTrackedSession(activeSessionStorageKey, saved.sandboxId);
      return;
    }

    let cancelled = false;
    reconnectingRef.current = true;
    setStatus('reconnecting');
    setActiveSandboxEnvironment(null);
    setSandboxOwnerToken(saved.ownerToken);
    setSandboxOwnerToken(saved.ownerToken, saved.sandboxId);

    const reconnectPromise = execInSandbox(saved.sandboxId, 'true')
      .then((result) => {
        if (cancelled) return null;
        if (result.exitCode === 0) {
          setSandboxId(saved.sandboxId);
          sandboxIdRef.current = saved.sandboxId;
          sessionStorageKeyRef.current = activeSessionStorageKey;
          setActiveSandboxEnvironment(saved.sandboxId);
          setStatus('ready');
          // Fire-and-forget environment probe on reconnect
          probeSandboxEnvironment(saved.sandboxId).catch(() => {});
          console.log('[useSandbox] Reconnected to saved sandbox:', saved.sandboxId);
          return saved.sandboxId;
        }
        clearTrackedSession(activeSessionStorageKey, saved.sandboxId);
        setStatus('idle');
        return null;
      })
      .catch(() => {
        if (!cancelled) {
          clearTrackedSession(activeSessionStorageKey, saved.sandboxId);
          setStatus('idle');
        }
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
  }, [activeBranch, activeRepoFullName, activeSessionStorageKey, status]);

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
      setActiveSandboxEnvironment(null);
      setSandboxOwnerToken(null);

      try {
        // Empty repo = sandbox mode (ephemeral workspace, no clone, no token needed)
        const token = repo ? getGitHubToken() : '';
        const session = await createSandbox(repo, branch, token, getGitHubAppCommitIdentity());

        if (session.status === 'error') {
          setStatus('error');
          setError(session.error || 'Sandbox creation failed');
          return null;
        }

        setSandboxId(session.sandboxId);
        setStatus('ready');
        setActiveSandboxEnvironment(session.sandboxId);
        setSandboxOwnerToken(session.ownerToken || null);

        const normalizedBranch = branch || 'main';
        saveSandboxSession(repo, normalizedBranch, {
          sandboxId: session.sandboxId,
          ownerToken: session.ownerToken || '',
          repoFullName: repo,
          branch: normalizedBranch,
          createdAt: Date.now(),
        });
        sessionStorageKeyRef.current = buildSandboxSessionStorageKey(repo, normalizedBranch);

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
    const sessionStorageKey = sessionStorageKeyRef.current;
    if (!id) return;

    try {
      await cleanupSandbox(id);
    } catch {
      // Best effort — container will auto-terminate anyway
    } finally {
      clearTrackedSession(sessionStorageKey, id);
    }

    // Reset file awareness ledger, version cache, and environment — new sandbox = clean slate
    fileLedger.reset();
    clearFileVersionCache(id);
    clearSandboxWorkspaceRevision(id);
    clearSandboxEnvironment(id);

    sandboxIdRef.current = null;
    sessionStorageKeyRef.current = null;
    setSandboxId(null);
    setStatus('idle');
    setError(null);
  }, []);

  const rebindSessionRepo = useCallback((repoFullName: string, branch: string = 'main') => {
    const id = sandboxIdRef.current;
    const currentSessionStorageKey = sessionStorageKeyRef.current;
    if (!id) return;
    const ownerToken = getSandboxOwnerToken();
    if (!ownerToken) return;

    const existing = currentSessionStorageKey ? safeStorageGet(currentSessionStorageKey) : null;
    let createdAt = Date.now();
    if (existing) {
      try {
        const parsed = JSON.parse(existing) as { createdAt?: unknown };
        if (typeof parsed.createdAt === 'number') createdAt = parsed.createdAt;
      } catch {
        // Ignore malformed storage and keep the fresh timestamp.
      }
    }

    saveSandboxSession(repoFullName, branch, {
      sandboxId: id,
      ownerToken,
      repoFullName,
      branch,
      createdAt,
    });
    const nextSessionStorageKey = buildSandboxSessionStorageKey(repoFullName, branch);
    if (currentSessionStorageKey && currentSessionStorageKey !== nextSessionStorageKey) {
      clearSandboxSessionByStorageKey(currentSessionStorageKey, id);
    }
    sessionStorageKeyRef.current = nextSessionStorageKey;
  }, []);

  // Expose session createdAt for expiry warnings
  const createdAt = useMemo(() => {
    const saved = loadSandboxSession(activeRepoFullName, activeBranch);
    return saved?.createdAt ?? null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRepoFullName, activeBranch, sandboxId]);

  /**
   * Ping the current sandbox to verify it's still alive.
   * If alive → restore 'ready' status (clears transient errors).
   * If dead  → transition to 'error' with an actionable message.
   * No-op if no sandbox is active.
   */
  const refresh = useCallback(async (opts?: { silent?: boolean }): Promise<boolean> => {
    const id = sandboxIdRef.current;
    if (!id) return false;

    if (!opts?.silent) setStatus('creating'); // reuse 'creating' as a "checking" state (shows spinner)

    try {
      const result = await execInSandbox(id, 'true');
      
      if (sandboxIdRef.current !== id) return false;

      if (result.exitCode === 0) {
        setStatus('ready');
        console.debug(`[useSandbox] Refresh success for ${id}`);
        return true;
      }
      // exitCode -1 or other failure: container is gone
      const reason = result.error || 'Sandbox is no longer reachable';
      setStatus('error');
      setError(reason);
      clearTrackedSession(sessionStorageKeyRef.current, id);
      return false;
      console.debug(`[useSandbox] Refresh failed for ${id}: ${reason}`);
    } catch (err) {
      if (sandboxIdRef.current !== id) return false;
      const msg = err instanceof Error ? err.message : String(err);
      setStatus('error');
      setError(msg);
      clearTrackedSession(sessionStorageKeyRef.current, id);
      return false;
      console.debug(`[useSandbox] Refresh error for ${id}: ${msg}`);
    }
  }, []);

  /**
   * Transition sandbox to error state from outside (e.g. tool dispatch
   * detected SANDBOX_UNREACHABLE). Does not ping — just updates UI state
   * so the user can see the error and act on it.
   */
  const markUnreachable = useCallback((reason: string) => {
    if (statusRef.current === 'error') return; // already in error
    setStatus('error');
    setError(reason);
  }, []);

  // Track when the page was hidden to detect "returned from background"
  const hiddenAtRef = useRef<number | null>(null);
  const healthCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Re-validate sandbox when user returns from background
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Page hidden — record timestamp
        hiddenAtRef.current = Date.now();
        return;
      }

      // Page visible again — check if we need to validate
      const id = sandboxIdRef.current;
      if (!id || statusRef.current !== 'ready') return;

      // If we were hidden for more than 10s, the sandbox might have died
      const wasHiddenFor = hiddenAtRef.current ? Date.now() - hiddenAtRef.current : 0;
      if (wasHiddenFor > 10_000) {
        refresh({ silent: true });
      }
      hiddenAtRef.current = null;
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [refresh]);

  // Periodic health check while sandbox is ready (catches expiration while tab is visible but idle)
  useEffect(() => {
    // Only poll when sandbox is ready
    if (status !== 'ready' || !sandboxId) {
      if (healthCheckIntervalRef.current) {
        clearInterval(healthCheckIntervalRef.current);
        healthCheckIntervalRef.current = null;
      }
      return;
    }

    // Check every 60s while visible
    healthCheckIntervalRef.current = setInterval(() => {
      // Skip if page is hidden — visibility handler will catch it on return
      if (document.hidden) return;

      refresh({ silent: true });
    }, 60_000);

    return () => {
      if (healthCheckIntervalRef.current) {
        clearInterval(healthCheckIntervalRef.current);
        healthCheckIntervalRef.current = null;
      }
    };
  }, [status, sandboxId, refresh]);


  return {
    sandboxId,
    status,
    error,
    start,
    stop,
    refresh,
    markUnreachable,
    rebindSessionRepo,
    createdAt,
  };
}
