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
  hibernateSandbox,
  restoreFromSnapshot,
  msSinceLastSandboxCall,
  suppressIdleTouch,
} from '@/lib/sandbox-client';
import type { GitCommitIdentity } from '@/lib/sandbox-client';
import { safeStorageGet } from '@/lib/safe-storage';
import { fileLedger } from '@/lib/file-awareness-ledger';
import { symbolLedger } from '@/lib/symbol-persistence-ledger';
import {
  clearFileVersionCache,
  clearSandboxWorkspaceRevision,
} from '@/lib/sandbox-file-version-cache';
import { getActiveGitHubToken, APP_TOKEN_STORAGE_KEY } from '@/lib/github-auth';
import {
  buildSandboxSessionStorageKey,
  clearSandboxSessionByStorageKey,
  loadSandboxSession,
  saveSandboxSession,
} from '@/lib/sandbox-session';
import { isDefinitivelyGoneMessage, isDefinitivelyGoneError } from '@/lib/sandbox-error-utils';

export type SandboxStatus = 'idle' | 'reconnecting' | 'creating' | 'ready' | 'error';

const APP_COMMIT_IDENTITY_KEY = 'github_app_commit_identity';
const SANDBOX_MAX_AGE_MS = 25 * 60 * 1000; // 25 min (conservative vs Modal's 30 min)
const IDLE_HIBERNATE_MS = 8 * 60 * 1000; // 8 min idle before snapshot
const IDLE_CHECK_INTERVAL_MS = 60 * 1000; // check every minute

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
  // Bumped whenever the persisted snapshot fields change so `snapshotInfo` re-reads localStorage.
  const [snapshotInfoTick, setSnapshotInfoTick] = useState(0);
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

    const attemptSnapshotRestore = async (): Promise<string | null> => {
      if (!saved.snapshotId || !saved.restoreToken) return null;
      console.log(`[useSandbox] Attempting restore from snapshot ${saved.snapshotId}`);
      setStatus('reconnecting');
      try {
        const session = await restoreFromSnapshot(saved.snapshotId, saved.restoreToken, {
          repoFullName: saved.repoFullName,
          branch: saved.branch,
        });
        if (cancelled || session.status !== 'ready') return null;
        setSandboxId(session.sandboxId);
        sandboxIdRef.current = session.sandboxId;
        sessionStorageKeyRef.current = activeSessionStorageKey;
        setActiveSandboxEnvironment(session.sandboxId);
        setStatus('ready');
        const symbolKey = saved.repoFullName
          ? `${saved.repoFullName}:${saved.branch || 'main'}`
          : 'scratch';
        symbolLedger.setRepo(symbolKey);
        void symbolLedger.hydrate();
        // Persist the new sandbox ID (snapshot consumed).
        saveSandboxSession(saved.repoFullName, saved.branch, {
          sandboxId: session.sandboxId,
          ownerToken: session.ownerToken || '',
          repoFullName: saved.repoFullName,
          branch: saved.branch,
          createdAt: Date.now(),
        });
        console.log(`[useSandbox] Restored from snapshot → ${session.sandboxId}`);
        return session.sandboxId;
      } catch (restoreErr) {
        console.debug('[useSandbox] Snapshot restore failed:', restoreErr);
        return null;
      }
    };

    suppressIdleTouch(); // Don't let reconnect probes reset idle clock
    const reconnectPromise = execInSandbox(saved.sandboxId, 'true')
      .then(async (result) => {
        if (cancelled) return null;
        if (result.exitCode === 0) {
          setSandboxId(saved.sandboxId);
          sandboxIdRef.current = saved.sandboxId;
          sessionStorageKeyRef.current = activeSessionStorageKey;
          setActiveSandboxEnvironment(saved.sandboxId);
          setStatus('ready');
          const symbolKey = saved.repoFullName
            ? `${saved.repoFullName}:${saved.branch || 'main'}`
            : 'scratch';
          symbolLedger.setRepo(symbolKey);
          void symbolLedger.hydrate();
          probeSandboxEnvironment(saved.sandboxId).catch(() => {});
          console.log('[useSandbox] Reconnected to saved sandbox:', saved.sandboxId);
          return saved.sandboxId;
        }
        const reason = result.error || 'Sandbox is no longer reachable';
        if (isDefinitivelyGoneMessage(reason)) {
          console.debug(`[useSandbox] Reconnect: container gone for ${saved.sandboxId}: ${reason}`);
          // Attempt snapshot restore before giving up.
          const restored = await attemptSnapshotRestore();
          if (restored) return restored;
          clearTrackedSession(activeSessionStorageKey, saved.sandboxId);
        } else {
          console.debug(
            `[useSandbox] Reconnect: transient failure for ${saved.sandboxId} (exit ${result.exitCode}): ${reason} — keeping session`,
          );
        }
        setStatus('idle');
        return null;
      })
      .catch(async (err: unknown) => {
        if (cancelled) return null;
        const msg = err instanceof Error ? err.message : String(err);
        if (isDefinitivelyGoneError(err)) {
          console.debug(`[useSandbox] Reconnect: container gone for ${saved.sandboxId}: ${msg}`);
          const restored = await attemptSnapshotRestore();
          if (restored) return restored;
          clearTrackedSession(activeSessionStorageKey, saved.sandboxId);
        } else {
          console.debug(
            `[useSandbox] Reconnect: transient error for ${saved.sandboxId}: ${msg} — keeping session`,
          );
        }
        setStatus('idle');
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

  // Idle hibernation timer — snapshot the sandbox after 8 min of no tool calls.
  // The snapshot preserves the full working tree so restore is fast. Without this,
  // the container silently dies at the 1-hour Modal timeout and the user loses
  // all uncommitted state.
  useEffect(() => {
    if (status !== 'ready') return;
    const id = sandboxIdRef.current;
    if (!id) return;

    const timer = setInterval(() => {
      const idle = msSinceLastSandboxCall();
      if (idle < IDLE_HIBERNATE_MS) return;

      // Don't hibernate if something else already changed the status.
      if (statusRef.current !== 'ready') return;

      console.log(`[useSandbox] Idle for ${Math.round(idle / 1000)}s — hibernating sandbox ${id}`);

      // Capture the owner token BEFORE hibernate clears it.
      const ownerToken = getSandboxOwnerToken(id) || '';

      hibernateSandbox(id, { repoFullName: activeRepoFullName, branch: activeBranch })
        .then((result) => {
          if (!result.ok || !result.snapshotId) {
            console.debug('[useSandbox] Idle hibernate failed:', result.error);
            return;
          }
          // Persist the snapshotId for restore on next app open.
          if (activeRepoFullName != null && activeBranch) {
            const now = Date.now();
            saveSandboxSession(activeRepoFullName, activeBranch, {
              sandboxId: id,
              ownerToken,
              repoFullName: activeRepoFullName,
              branch: activeBranch,
              createdAt: now,
              snapshotId: result.snapshotId,
              restoreToken: result.restoreToken,
              snapshotCreatedAt: now,
            });
          }
          // Transition to idle — the container is terminated. This stops
          // the interval from firing again (status !== 'ready' guard)
          // and signals the UI that the sandbox needs a restore/create.
          setSandboxId(null);
          sandboxIdRef.current = null;
          setStatus('idle');
          setSnapshotInfoTick((n) => n + 1);
          console.log(`[useSandbox] Hibernated → snapshot ${result.snapshotId}`);
        })
        .catch((err: unknown) => {
          console.debug('[useSandbox] Idle hibernate error:', err);
        });
    }, IDLE_CHECK_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [activeBranch, activeRepoFullName, status]);

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

        // Hydrate the symbol persistence ledger scoped to repo+branch
        const symbolRepoKey = repo ? `${repo}:${normalizedBranch}` : 'scratch';
        symbolLedger.setRepo(symbolRepoKey);
        void symbolLedger.hydrate();
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

    // Reset file awareness ledger, symbol cache, version cache, and environment — new sandbox = clean slate
    fileLedger.reset();
    void symbolLedger.clearRepo();
    symbolLedger.reset();
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

    // Reset the file-awareness ledger only when the repo/branch actually
    // changed so stale read/write state doesn't leak through, but we
    // preserve coverage when re-binding within the same session.
    if (currentSessionStorageKey !== nextSessionStorageKey) {
      fileLedger.reset();
    }
  }, []);

  // Expose session createdAt for expiry warnings
  const createdAt = useMemo(() => {
    const saved = loadSandboxSession(activeRepoFullName, activeBranch);
    return saved?.createdAt ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRepoFullName, activeBranch, sandboxId]);

  // Snapshot info for UI affordances. Reads the persisted session and re-evaluates
  // on status/sandbox transitions and explicit tick bumps from hibernate/forget.
  // Requires both snapshotId AND restoreToken — without the token the restore
  // endpoint rejects the call, so advertising hibernated/Restore UX would lie
  // and the user would silently fall back to a clean clone.
  const snapshotInfo = useMemo<{ snapshotId: string; createdAt: number } | null>(() => {
    const saved = loadSandboxSession(activeRepoFullName, activeBranch);
    if (!saved?.snapshotId || !saved.restoreToken) return null;
    return {
      snapshotId: saved.snapshotId,
      createdAt: saved.snapshotCreatedAt ?? saved.createdAt,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRepoFullName, activeBranch, sandboxId, status, snapshotInfoTick]);

  // Explicit user-triggered hibernate. Mirrors the idle-timer path but surfaces
  // success/failure to the caller so the hub can toast on error.
  const hibernate = useCallback(async (): Promise<boolean> => {
    const id = sandboxIdRef.current;
    if (!id) return false;
    if (statusRef.current !== 'ready') return false;
    if (activeRepoFullName == null || !activeBranch) return false;

    const ownerToken = getSandboxOwnerToken(id) || '';
    try {
      const result = await hibernateSandbox(id, {
        repoFullName: activeRepoFullName,
        branch: activeBranch,
      });
      if (!result.ok || !result.snapshotId) {
        console.debug('[useSandbox] Manual hibernate failed:', result.error);
        return false;
      }
      const now = Date.now();
      saveSandboxSession(activeRepoFullName, activeBranch, {
        sandboxId: id,
        ownerToken,
        repoFullName: activeRepoFullName,
        branch: activeBranch,
        createdAt: now,
        snapshotId: result.snapshotId,
        restoreToken: result.restoreToken,
        snapshotCreatedAt: now,
      });
      setSandboxId(null);
      sandboxIdRef.current = null;
      setStatus('idle');
      setSnapshotInfoTick((n) => n + 1);
      console.log(`[useSandbox] Manual hibernate → snapshot ${result.snapshotId}`);
      return true;
    } catch (err) {
      console.debug('[useSandbox] Manual hibernate error:', err);
      return false;
    }
  }, [activeRepoFullName, activeBranch]);

  // Drop the stored snapshot (and the dead container binding, if any). Used by
  // the Hub's "Forget sandbox state" affordance so the next start is a clean
  // clone instead of restoring a workspace the user has declared broken.
  const forgetSnapshot = useCallback((): void => {
    if (activeRepoFullName == null || !activeBranch) return;
    const saved = loadSandboxSession(activeRepoFullName, activeBranch);
    if (!saved?.snapshotId) return;

    const liveId = sandboxIdRef.current;
    if (liveId && saved.sandboxId === liveId && saved.ownerToken) {
      saveSandboxSession(activeRepoFullName, activeBranch, {
        sandboxId: saved.sandboxId,
        ownerToken: saved.ownerToken,
        repoFullName: saved.repoFullName,
        branch: saved.branch,
        createdAt: saved.createdAt,
      });
    } else {
      const storageKey = buildSandboxSessionStorageKey(activeRepoFullName, activeBranch);
      // Pass the expected sandboxId so a newer session written by another tab
      // between our read and delete doesn't get evicted by mistake.
      if (storageKey) clearSandboxSessionByStorageKey(storageKey, saved.sandboxId);
    }
    setSnapshotInfoTick((n) => n + 1);
    console.log('[useSandbox] Forgot sandbox snapshot');
  }, [activeRepoFullName, activeBranch]);

  /**
   * Ping the current sandbox to verify it's still alive.
   * If alive → restore 'ready' status (clears transient errors).
   * If dead  → transition to 'error' with an actionable message.
   * No-op if no sandbox is active.
   *
   * IMPORTANT: the tracked session is only cleared when we have a
   * *definitive* signal that the container is gone (exit_code === -1 from
   * the backend, or a MODAL_NOT_FOUND-class error). Transient failures
   * (timeouts, cold-starts, network blips, rate limits) leave the session
   * intact so the next tool call can retry against the live container. The
   * earlier catch-all "clear on any error" behavior silently nuked healthy
   * sessions mid-chat, which surfaced as writes reporting success but the
   * next read/exec hitting a brand-new sandbox with the original file state.
   */
  const refresh = useCallback(async (opts?: { silent?: boolean }): Promise<boolean> => {
    const id = sandboxIdRef.current;
    if (!id) return false;

    if (!opts?.silent) setStatus('creating'); // reuse 'creating' as a "checking" state (shows spinner)

    try {
      suppressIdleTouch(); // Don't let refresh probes reset idle clock
      const result = await execInSandbox(id, 'true');

      if (sandboxIdRef.current !== id) return false;

      if (result.exitCode === 0) {
        setStatus('ready');
        console.debug(`[useSandbox] Refresh success for ${id}`);
        return true;
      }

      // exit_code === -1 is overloaded on the backend — it's returned for
      // "sandbox not found / expired" (which IS gone) but also for
      // "unauthorized owner token", "command timed out", and generic
      // container errors (which are all transient). So we gate teardown on
      // the accompanying error text, not the numeric exit code alone.
      const reason = result.error || 'Sandbox is no longer reachable';
      setStatus('error');
      setError(reason);
      if (isDefinitivelyGoneMessage(reason)) {
        console.debug(`[useSandbox] Refresh: container gone for ${id}: ${reason}`);
        clearTrackedSession(sessionStorageKeyRef.current, id);
      } else {
        console.debug(
          `[useSandbox] Refresh: transient failure for ${id} (exit ${result.exitCode}): ${reason} — keeping session`,
        );
      }
      return false;
    } catch (err) {
      if (sandboxIdRef.current !== id) return false;
      const msg = err instanceof Error ? err.message : String(err);
      setStatus('error');
      setError(msg);
      if (isDefinitivelyGoneError(err)) {
        console.debug(`[useSandbox] Refresh: container gone for ${id}: ${msg}`);
        clearTrackedSession(sessionStorageKeyRef.current, id);
      } else {
        console.debug(`[useSandbox] Refresh: transient error for ${id}: ${msg} — keeping session`);
      }
      return false;
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
    hibernate,
    forgetSnapshot,
    snapshotInfo,
  };
}
