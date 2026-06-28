/**
 * useSandbox — manages sandbox session lifecycle.
 *
 * Status: idle → creating → ready → error
 *
 * The sandbox persists across messages in a single chat session.
 * Container auto-terminates on Modal's side after ~2h (see
 * SANDBOX_TIMEOUT_SECONDS in sandbox/app.py).
 *
 * Session persistence: sandbox IDs are saved to localStorage so that
 * PWA refreshes can reconnect to an existing container instead of
 * creating a new one. Saved sessions are reused for up to 50 min
 * (safety margin under the container lifetime; see SANDBOX_MAX_AGE_MS).
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
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
  hasInFlightSandboxCalls,
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
import {
  getActiveGitHubTokenInfo,
  isInstallationToken,
  APP_TOKEN_STORAGE_KEY,
} from '@/lib/github-auth';
import {
  evaluateRepoAuth,
  formatRepoNotCoveredMessage,
  hasAcknowledgedUserTokenInjection,
  USER_TOKEN_GATE_MESSAGE,
  type RepoCoverage,
} from '@/lib/sandbox-auth-gate';
import { checkRepoCoverage } from '@/lib/github-repo-coverage';
import {
  buildSandboxSessionStorageKey,
  clearSandboxSessionByStorageKey,
  decideReconnectProbe,
  isSavedSessionRecoverable,
  loadSandboxSession,
  type ReconnectAttempt,
  saveSandboxSession,
  shouldRetryReconnect,
  touchSandboxSessionActivity,
} from '@/lib/sandbox-session';
import { isDefinitivelyGoneMessage, isDefinitivelyGoneError } from '@/lib/sandbox-error-utils';
import { nativeCheckpointsActive } from '@/lib/checkpoint/checkpoint-store';

export type SandboxStatus = 'idle' | 'reconnecting' | 'creating' | 'ready' | 'error';

const APP_COMMIT_IDENTITY_KEY = 'github_app_commit_identity';
// Max age of a saved session we'll still try to reconnect to. Kept under the
// container's idle-sleep window (CF's sleepAfter is raised to ~1h in
// worker-cf-sandbox.ts; Modal lives ~2h) so we don't waste a round-trip probing
// a container that's almost certainly gone — but generous enough that a long
// session that idled survives a reconnect. A stale guess is cheap: the
// reconnect does a liveness check and falls back to a fresh sandbox.
const SANDBOX_MAX_AGE_MS = 50 * 60 * 1000; // 50 min
// Idle threshold before the reaper takes a keep-warm safety snapshot. It used
// to be 8 min AND terminated the container, so a foregrounded idle session lost
// its sandbox while the user was just sitting there (reading/thinking/composing
// don't count as activity — only tool calls touch the idle clock). Now 45 min,
// and the reaper snapshots WITHOUT terminating (see the keep-warm reaper below).
// The container's own idle-sleep is the real lifetime ceiling — raised from CF's
// 10-min default via sleepAfter (worker-cf-sandbox.ts) — and this snapshot is
// the safety net for that eventual reclaim. Kept under SANDBOX_MAX_AGE_MS (50)
// so the snapshot-then-reconnect window still aligns.
const IDLE_HIBERNATE_MS = 45 * 60 * 1000; // 45 min idle before keep-warm snapshot
// Shown when a saved snapshot existed but couldn't be restored on reconnect, so
// the user knows their prior workspace is gone and they're on a fresh sandbox
// (otherwise the restore failure is silent and looks like a normal cold start).
const RESTORE_FAILED_MESSAGE = 'Could not restore your saved workspace — starting a fresh sandbox.';
const IDLE_CHECK_INTERVAL_MS = 60 * 1000; // check every minute
// `lastActivityAt` is refreshed by the keep-warm interval, so it can be up to one
// tick stale. Bias toward one extra cheap probe rather than discarding a live
// sandbox that had real activity just before a reload.
const SANDBOX_ACTIVITY_STALENESS_GRACE_MS = IDLE_CHECK_INTERVAL_MS;
// Backoff before re-probing a saved session that returned a *transient*
// reconnect failure. Without this the reconnect effect spins: a transient probe
// failure parks status back at 'idle' (the very value this effect's guard waits
// on), so it immediately re-probes. Keep-warm snapshots make
// `isSavedSessionRecoverable` always-true for idle sessions, so the spin never
// self-terminates. A cooldown + one backoff retry breaks it while still
// auto-healing a container that's genuinely on its way back.
const RECONNECT_RETRY_BACKOFF_MS = 30 * 1000; // 30s between transient-failure re-probes
const MAX_RECONNECT_ATTEMPTS = 2; // initial probe + 1 backoff retry, then wait for a real trigger
// Consecutive transient failures a SILENT health-check probe (`refresh({ silent: true })`,
// fired every 60s) tolerates before surfacing 'error'. exit -1 is overloaded — it covers
// genuine "gone" AND transient blips (command timeout, owner-token KV/PoP propagation lag,
// container hiccup); `isDefinitivelyGoneMessage` catches the gone case immediately, so this
// only buffers the false negatives. A single blip used to flip a live sandbox to a hard
// 'error', which then stopped the health-check loop (gated on status === 'ready') — the
// "sandbox dies after ~2 min idle" report. 3 strikes ≈ 3 min before a wedged-but-not-gone
// container still surfaces. User-initiated (non-silent) refresh escalates immediately.
const SILENT_REFRESH_TRANSIENT_STRIKES = 3;

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
  const [freshSandboxId, setFreshSandboxId] = useState<string | null>(null);
  const [restoredFromSnapshotSandboxId, setRestoredFromSnapshotSandboxId] = useState<string | null>(
    null,
  );
  // Bumped by the backoff retry timer to re-enter the reconnect effect once a
  // transient failure's cooldown has elapsed (auto-heal without the spin).
  // Declared after the state cells the test harness reads by index (0=sandboxId,
  // 1=status, 2=error) so it can't shift them.
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const sandboxIdRef = useRef<string | null>(null);
  const sessionStorageKeyRef = useRef<string | null>(null);
  const statusRef = useRef<SandboxStatus>('idle');
  const reconnectingRef = useRef(false);
  const reconnectPromiseRef = useRef<Promise<string | null> | null>(null);
  const startPromiseRef = useRef<Promise<string | null> | null>(null);
  // Declared after the refs the test harness syncs by index (see
  // useSandbox.test.ts syncRefsFromState) so it doesn't shift them.
  const idleHibernatePendingRef = useRef(false);
  // Timestamp of the last idle keep-warm snapshot. The keep-warm reaper leaves
  // the container 'ready', so its interval keeps running — this gates it to one
  // snapshot per idle period (re-armed only by real activity), avoiding a
  // re-snapshot of an unchanged tree every tick.
  const lastKeepWarmSnapshotAtRef = useRef(0);
  const freshSandboxIdRef = useRef<string | null>(null);
  const snapshotRestoredSandboxIdRef = useRef<string | null>(null);
  // Reconnect backoff bookkeeping (see RECONNECT_RETRY_BACKOFF_MS): the last
  // saved sandbox we probed + attempt count, so a transient failure backs off
  // instead of re-probing on the next 'idle' tick. Declared last so they can't
  // shift the index-synced refs above (0=sandboxIdRef, 2=statusRef).
  const lastReconnectAttemptRef = useRef<ReconnectAttempt | null>(null);
  const reconnectRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Consecutive transient failures from `refresh`. A SILENT health-check probe
  // tolerates up to SILENT_REFRESH_TRANSIENT_STRIKES of these before flipping
  // the chip to 'error' (see refresh below). Reset on any success. Declared in
  // the "last" zone so it can't shift the index-synced refs above.
  const transientStrikesRef = useRef(0);
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
  //
  // `status` is deliberately NOT in this effect's dep array. The probe below
  // sets status to 'reconnecting' itself; if `status` were a dependency, that
  // write would re-run the effect, and the prior run's cleanup would flip
  // `cancelled = true` on the in-flight probe — so the probe's `.then`/`.catch`
  // would no-op and status would stay 'reconnecting' forever (the "infinite
  // reconnecting spinner on refresh" bug). Re-entry is driven by mount and by
  // `reconnectNonce` (the retry path), exactly as the cooldown note below
  // describes. We read the live status via `statusRef` instead.
  useEffect(() => {
    if (statusRef.current !== 'idle') return;
    // null/undefined = no sandbox context yet; '' = sandbox mode (ephemeral)
    if (activeRepoFullName == null || !activeSessionStorageKey) return;
    if (sandboxIdRef.current) return;

    const saved = loadSandboxSession(activeRepoFullName, activeBranch);
    if (!saved) return;

    // Only give up outright when the session is too old to expect a live
    // container, hasn't been active recently, AND has no snapshot to restore.
    // `createdAt` is the container's BIRTH, not its last use — an actively-used
    // container keeps resetting CF's sleepAfter clock, so a long *active* session
    // outlives SANDBOX_MAX_AGE_MS while staying perfectly alive. So we gate on
    // recency too: msSinceLastSandboxCall() is module-level (survives a
    // navigate-away → back remount; only a full reload resets it to Infinity),
    // and lastActivityAt is the persisted fallback the keep-warm interval keeps
    // fresh so a reload/eviction can still tell a recently-active container from
    // a stale one. When recoverable we fall through to the liveness probe (warm-
    // reattaches if the container survived) and then snapshot restore. Probing a
    // likely-dead container costs one cheap round-trip; discarding a recoverable
    // session costs the user their work.
    const ageMs = Date.now() - saved.createdAt;
    const hasSnapshot = Boolean(saved.snapshotId && saved.restoreToken);
    const persistedIdleMs =
      typeof saved.lastActivityAt === 'number' ? Date.now() - saved.lastActivityAt : Infinity;
    const idleMs = Math.min(msSinceLastSandboxCall(), persistedIdleMs);
    if (
      !isSavedSessionRecoverable({
        ageMs,
        idleMs,
        hasSnapshot,
        maxAgeMs: SANDBOX_MAX_AGE_MS,
        maxIdleMs: SANDBOX_MAX_AGE_MS + SANDBOX_ACTIVITY_STALENESS_GRACE_MS,
      })
    ) {
      clearTrackedSession(activeSessionStorageKey, saved.sandboxId);
      return;
    }

    // Transient-failure cooldown: if we just probed this same saved sandbox and
    // it failed transiently, don't immediately re-probe — status parked back at
    // 'idle' (our own write) would otherwise respin this effect. Wait out the
    // backoff; the retry timer bumps `reconnectNonce` to re-enter once it passes.
    const probeDecision = decideReconnectProbe({
      savedSandboxId: saved.sandboxId,
      prior: lastReconnectAttemptRef.current,
      now: Date.now(),
      backoffMs: RECONNECT_RETRY_BACKOFF_MS,
    });
    if (!probeDecision.probe) return;
    const reconnectAttempts = probeDecision.nextAttempt.attempts;
    lastReconnectAttemptRef.current = probeDecision.nextAttempt;

    let cancelled = false;
    reconnectingRef.current = true;
    setSandboxOwnerToken(saved.ownerToken);
    setSandboxOwnerToken(saved.ownerToken, saved.sandboxId);
    const reconnectStartTimer = setTimeout(() => {
      if (cancelled) return;
      // A warm probe can resolve before this 0ms timer fires; don't clobber a
      // settled 'ready'/'idle' back to 'reconnecting' (which would re-strand
      // the spinner). Only show 'reconnecting' if we're still waiting.
      if (statusRef.current !== 'idle') return;
      setStatus('reconnecting');
      setActiveSandboxEnvironment(null);
    }, 0);

    const attemptSnapshotRestore = async (): Promise<string | null> => {
      // On the native shell the on-device checkpoint is the sole recovery path —
      // no cloud restore. Returning null here drops the reconnect through to
      // clearTrackedSession + idle, so the controller cold-starts a fresh
      // sandbox and the native restore offer fires against it (Increment 2).
      if (nativeCheckpointsActive()) {
        console.log(
          JSON.stringify({
            level: 'info',
            event: 'sandbox_cloud_restore_skipped_native',
            sandboxId: saved.sandboxId,
            reason: 'native_checkpoints_active',
          }),
        );
        return null;
      }
      if (!saved.snapshotId || !saved.restoreToken) return null;
      console.log(`[useSandbox] Attempting restore from snapshot ${saved.snapshotId}`);
      setStatus('reconnecting');
      try {
        const session = await restoreFromSnapshot(saved.snapshotId, saved.restoreToken, {
          repoFullName: saved.repoFullName,
          branch: saved.branch,
        });
        if (cancelled) return null;
        if (session.status !== 'ready') {
          toast.error(RESTORE_FAILED_MESSAGE);
          return null;
        }
        freshSandboxIdRef.current = null;
        setFreshSandboxId(null);
        snapshotRestoredSandboxIdRef.current = session.sandboxId;
        setRestoredFromSnapshotSandboxId(session.sandboxId);
        setSandboxId(session.sandboxId);
        sandboxIdRef.current = session.sandboxId;
        sessionStorageKeyRef.current = activeSessionStorageKey;
        setActiveSandboxEnvironment(session.sandboxId);
        setStatus('ready');
        lastReconnectAttemptRef.current = null; // restored — reset retry budget
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
        if (!cancelled) toast.error(RESTORE_FAILED_MESSAGE);
        return null;
      }
    };

    // After a transient probe failure, schedule exactly one backoff retry so a
    // container that's genuinely coming back reconnects on its own — then stop,
    // leaving further attempts to a real trigger (user action, repo/branch
    // change). The cooldown guard above prevents the status='idle' write from
    // re-probing before this fires.
    const scheduleReconnectRetry = () => {
      if (cancelled) return;
      if (!shouldRetryReconnect(reconnectAttempts, MAX_RECONNECT_ATTEMPTS)) {
        console.debug(
          `[useSandbox] Reconnect: gave up auto-retry for ${saved.sandboxId} after ${reconnectAttempts} transient failures — will retry on next real trigger`,
        );
        return;
      }
      if (reconnectRetryTimerRef.current) clearTimeout(reconnectRetryTimerRef.current);
      reconnectRetryTimerRef.current = setTimeout(() => {
        reconnectRetryTimerRef.current = null;
        // Clear the cooldown's timestamp so re-entry actually probes; the attempt
        // count is preserved so the retry budget (MAX_RECONNECT_ATTEMPTS) holds.
        if (lastReconnectAttemptRef.current?.sandboxId === saved.sandboxId) {
          lastReconnectAttemptRef.current = { ...lastReconnectAttemptRef.current, at: 0 };
        }
        setReconnectNonce((n) => n + 1);
      }, RECONNECT_RETRY_BACKOFF_MS);
    };

    suppressIdleTouch(); // Don't let reconnect probes reset idle clock
    const reconnectPromise = execInSandbox(saved.sandboxId, 'true')
      .then(async (result) => {
        if (cancelled) return null;
        if (result.exitCode === 0) {
          freshSandboxIdRef.current = null;
          setFreshSandboxId(null);
          snapshotRestoredSandboxIdRef.current = null;
          setRestoredFromSnapshotSandboxId(null);
          setSandboxId(saved.sandboxId);
          sandboxIdRef.current = saved.sandboxId;
          sessionStorageKeyRef.current = activeSessionStorageKey;
          setActiveSandboxEnvironment(saved.sandboxId);
          setStatus('ready');
          lastReconnectAttemptRef.current = null; // reconnected — reset retry budget
          // A successful probe is the strongest possible liveness proof, but it's
          // suppressIdleTouch'd so it won't reset the in-memory clock (which would
          // defeat hibernation). Persist the recency directly so a subsequent
          // reload before any real call doesn't see Infinity + a stale
          // lastActivityAt and discard this still-live container.
          touchSandboxSessionActivity(
            activeRepoFullName,
            activeBranch,
            saved.sandboxId,
            Date.now(),
          );
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
          scheduleReconnectRetry();
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
          scheduleReconnectRetry();
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
      clearTimeout(reconnectStartTimer);
      if (reconnectRetryTimerRef.current) {
        clearTimeout(reconnectRetryTimerRef.current);
        reconnectRetryTimerRef.current = null;
      }
      reconnectingRef.current = false;
      reconnectPromiseRef.current = null;
    };
  }, [activeBranch, activeRepoFullName, activeSessionStorageKey, reconnectNonce]);

  // Idle hibernation timer — snapshot the sandbox after 8 min of no tool calls.
  // The snapshot preserves the full working tree so restore is fast. Without this,
  // the container silently dies at the 1-hour Modal timeout and the user loses
  // all uncommitted state. "Idle" means no completed call AND nothing in flight —
  // a long-running exec must not get the container hibernated out from under it.
  useEffect(() => {
    if (status !== 'ready') return;
    const id = sandboxIdRef.current;
    if (!id) return;

    const timer = setInterval(() => {
      const idle = msSinceLastSandboxCall();

      // Keep the persisted activity timestamp ≤1 tick stale so a reconnect after
      // a full reload/eviction (which clears the in-memory clock) can still tell
      // this recently-active, still-live container from a stale one. Skip when
      // `idle` is Infinity (no call since page load) — the persisted value is the
      // better record then, so don't clobber it with a fabricated "just now".
      if (Number.isFinite(idle)) {
        touchSandboxSessionActivity(activeRepoFullName, activeBranch, id, Date.now() - idle);
      }

      // On the native shell, WIP never leaves the device — no keep-warm snapshot
      // to Modal. Gate ONLY the snapshot, after the activity bookkeeping above,
      // so warm-reattach recency still works (Increment 2). A lost container is
      // recovered from the on-device checkpoint, not a cloud snapshot.
      if (nativeCheckpointsActive()) return;

      if (idle < IDLE_HIBERNATE_MS) return;

      // Status may have changed between ticks.
      if (statusRef.current !== 'ready') return;

      if (hasInFlightSandboxCalls()) {
        console.log(
          `[useSandbox] Idle ${Math.round(idle / 1000)}s but a sandbox call is in flight — deferring keep-warm snapshot`,
        );
        return;
      }

      // A snapshot from a prior tick may still be pending — it's suppressed
      // (invisible to the in-flight counter), so guard explicitly against
      // launching a second one.
      if (idleHibernatePendingRef.current) return;

      // Keep-warm cadence: take ONE safety snapshot per idle period. Unlike the
      // old reaper (which terminated → status 'idle' → the interval stopped),
      // keep-warm leaves the container 'ready', so this interval keeps ticking.
      // Re-arm only after real activity advances the last-call time past our
      // last snapshot — otherwise we'd re-snapshot an unchanged tree every tick.
      // `idle` is Infinity until the first sandbox call; the `> 0` guard still
      // lets that first idle snapshot through (lastCallAt would be -Infinity).
      const lastCallAt = Number.isFinite(idle) ? Date.now() - idle : 0;
      if (
        lastKeepWarmSnapshotAtRef.current > 0 &&
        lastKeepWarmSnapshotAtRef.current >= lastCallAt
      ) {
        return;
      }

      idleHibernatePendingRef.current = true;
      // Capture the owner token BEFORE the await: a concurrent
      // session-change/unmount teardown clears it (and swaps sandboxId), so the
      // late `.then` must not persist a session with a stale/empty token.
      const ownerToken = getSandboxOwnerToken(id) || '';
      console.log(
        `[useSandbox] Idle for ${Math.round(idle / 1000)}s — keep-warm snapshot of ${id} (container stays live)`,
      );

      // The reaper's own snapshot is maintenance, not activity: don't stamp the
      // idle clock (a FAILED attempt would otherwise slip the 60s-tick retry out
      // by a full idle window).
      suppressIdleTouch();
      const snapshotAt = Date.now();
      hibernateSandbox(
        id,
        { repoFullName: activeRepoFullName, branch: activeBranch },
        { keepWarm: true },
      )
        .then((result) => {
          if (!result.ok || !result.snapshotId) {
            console.debug('[useSandbox] Idle keep-warm snapshot failed:', result.error);
            return;
          }
          // A concurrent teardown may have swapped/cleared the session while we
          // awaited — don't clobber it; the teardown owns persistence then.
          if (sandboxIdRef.current !== id) {
            console.debug(
              '[useSandbox] Keep-warm snapshot stale (session changed) — skipping save',
            );
            return;
          }
          // Persist the snapshot as the safety net for a LATER real CF reclaim
          // (and for snapshot restore on reconnect). Preserve the original
          // createdAt — it's the container's real age, which the reconnect probe
          // window keys off; only the snapshot timestamp is fresh. Also preserve
          // lastActivityAt (the interval stamped it just above): without it a
          // later forgetSnapshot would have nothing to carry forward, so a reload
          // of the still-live snapshot-less container would discard it on age.
          if (activeRepoFullName != null && activeBranch) {
            const existing = loadSandboxSession(activeRepoFullName, activeBranch);
            saveSandboxSession(activeRepoFullName, activeBranch, {
              sandboxId: id,
              ownerToken,
              repoFullName: activeRepoFullName,
              branch: activeBranch,
              createdAt: existing?.createdAt ?? snapshotAt,
              lastActivityAt: existing?.lastActivityAt,
              snapshotId: result.snapshotId,
              restoreToken: result.restoreToken,
              snapshotCreatedAt: Date.now(),
            });
          }
          setSnapshotInfoTick((n) => n + 1);

          if (result.keptWarm) {
            // Container stays live + 'ready' — the user never sees it vanish.
            lastKeepWarmSnapshotAtRef.current = snapshotAt;
            console.log(
              `[useSandbox] Keep-warm snapshot ${result.snapshotId} (sandbox ${id} still live)`,
            );
          } else {
            // Deploy skew: an out-of-sync backend terminated despite keep_warm.
            // The container is gone (the client already cleared the token), so
            // go idle and let reconnect/restore take over — don't arm the
            // keep-warm clock against a dead container.
            setSandboxId(null);
            sandboxIdRef.current = null;
            freshSandboxIdRef.current = null;
            setFreshSandboxId(null);
            snapshotRestoredSandboxIdRef.current = null;
            setRestoredFromSnapshotSandboxId(null);
            setStatus('idle');
            // The reconnect/restore effect no longer keys on `status` (that
            // self-cancelled its own probe — see its dep-array note), so the
            // status→idle write above won't re-enter it on its own. Bump the
            // nonce explicitly to drive the documented hand-off: probe the dead
            // container → definitively-gone → attemptSnapshotRestore.
            setReconnectNonce((n) => n + 1);
            console.log(
              `[useSandbox] Backend terminated despite keep_warm → hibernated to ${result.snapshotId}`,
            );
          }
        })
        .catch((err: unknown) => {
          console.debug('[useSandbox] Idle keep-warm error:', err);
        })
        .finally(() => {
          idleHibernatePendingRef.current = false;
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
      freshSandboxIdRef.current = null;
      setFreshSandboxId(null);
      snapshotRestoredSandboxIdRef.current = null;
      setRestoredFromSnapshotSandboxId(null);

      try {
        // Empty repo = sandbox mode (ephemeral workspace, no clone, no token needed)
        const { token, kind: tokenKind } = repo
          ? getActiveGitHubTokenInfo()
          : { token: '', kind: 'none' as const };

        // Repo-auth gate (auth rework step 2). For the App-installation path
        // (the default), confirm the installation actually covers this repo
        // before we spin up a sandbox — so a not-covered repo gets an actionable
        // install/update prompt instead of a cryptic clone failure. Coverage is
        // only probed for the installation-token path; a durable legacy token
        // still rides the one-time acknowledgment. Fail-open on a flaky probe.
        let coverage: RepoCoverage = 'unknown';
        let coverageInstallUrl: string | undefined;
        if (repo && isInstallationToken(tokenKind)) {
          const probe = await checkRepoCoverage(repo);
          coverage = probe.coverage;
          coverageInstallUrl = probe.installUrl;
        }

        const gate = evaluateRepoAuth({
          kind: tokenKind,
          hasRepo: Boolean(repo),
          coverage,
          acknowledged: hasAcknowledgedUserTokenInjection(),
        });
        if (!gate.allow) {
          console.log(
            JSON.stringify({
              level: 'warn',
              event: 'sandbox_create_blocked',
              reason: gate.reason,
              tokenKind,
            }),
          );
          setStatus('error');
          setError(
            gate.reason === 'app_repo_not_covered'
              ? formatRepoNotCoveredMessage(repo, coverageInstallUrl)
              : USER_TOKEN_GATE_MESSAGE,
          );
          return null;
        }

        const session = await createSandbox(repo, branch, token, getGitHubAppCommitIdentity());

        if (session.status === 'error') {
          freshSandboxIdRef.current = null;
          setFreshSandboxId(null);
          setStatus('error');
          setError(session.error || 'Sandbox creation failed');
          return null;
        }

        freshSandboxIdRef.current = session.sandboxId;
        setFreshSandboxId(session.sandboxId);
        snapshotRestoredSandboxIdRef.current = null;
        setRestoredFromSnapshotSandboxId(null);
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
    freshSandboxIdRef.current = null;
    setFreshSandboxId(null);
    snapshotRestoredSandboxIdRef.current = null;
    setRestoredFromSnapshotSandboxId(null);
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
    let lastActivityAt: number | undefined;
    if (existing) {
      try {
        const parsed = JSON.parse(existing) as { createdAt?: unknown; lastActivityAt?: unknown };
        if (typeof parsed.createdAt === 'number') createdAt = parsed.createdAt;
        // Carry recency forward: the container is the same live one, just
        // re-keyed, so the reconnect gate shouldn't fall back to createdAt-age.
        if (typeof parsed.lastActivityAt === 'number') lastActivityAt = parsed.lastActivityAt;
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
      lastActivityAt,
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
    // Native shell: no manual hibernate to Modal either — the affordance is
    // hidden on native (WorkspaceChatRoute drops the handler), but guard the
    // call too so nothing ships WIP to the cloud (Increment 2).
    if (nativeCheckpointsActive()) {
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'sandbox_manual_hibernate_skipped_native',
          sandboxId: id,
          reason: 'native_checkpoints_active',
        }),
      );
      return false;
    }
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
      freshSandboxIdRef.current = null;
      setFreshSandboxId(null);
      snapshotRestoredSandboxIdRef.current = null;
      setRestoredFromSnapshotSandboxId(null);
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
        // Keep the recency signal: this drops the snapshot but the container is
        // still live, so a reconnect must not fall back to createdAt-age alone.
        lastActivityAt: saved.lastActivityAt,
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

    // On the native shell, a definitively-gone container must not strand the
    // session on its dead id: `ensureSandbox` returns the current id without a
    // status check, so without retiring it the next tool send reuses the corpse.
    // Clearing it drops us to a clean 'idle' so the next ensureSandbox cold-starts
    // a fresh sandbox and the on-device checkpoint offer fires against it
    // (Increment 2). On web this path keeps the 'error' surface — reconnect +
    // cloud snapshot handle recovery there.
    const retireDeadIdOnNative = (): boolean => {
      if (!nativeCheckpointsActive()) return false;
      setSandboxId(null);
      sandboxIdRef.current = null;
      freshSandboxIdRef.current = null;
      setFreshSandboxId(null);
      snapshotRestoredSandboxIdRef.current = null;
      setRestoredFromSnapshotSandboxId(null);
      // Drop the module-level active-environment pointer too, so a later call
      // can't route at the dead id before the cold-start rebinds it.
      setActiveSandboxEnvironment(null);
      setStatus('idle');
      setError(null);
      console.log(
        JSON.stringify({ level: 'info', event: 'sandbox_retired_dead_id_native', sandboxId: id }),
      );
      return true;
    };

    // A transient (NOT definitively-gone) probe failure. Surface 'error' only
    // when the user asked (`!silent`) or a SILENT probe has now failed
    // SILENT_REFRESH_TRANSIENT_STRIKES times in a row — a single silent blip on
    // a live container must not flip the chip to a hard 'error' that then stops
    // the 60s health-check loop (gated on status === 'ready'). The tracked
    // session is always kept; only the UI surface is gated.
    const handleTransient = (reason: string, where: string): void => {
      transientStrikesRef.current += 1;
      const escalate =
        !opts?.silent || transientStrikesRef.current >= SILENT_REFRESH_TRANSIENT_STRIKES;
      if (escalate) {
        setStatus('error');
        setError(reason);
        console.debug(
          `[useSandbox] Refresh: ${where} for ${id}: ${reason} — surfaced as error (strike ${transientStrikesRef.current})`,
        );
      } else {
        // Keep the prior status (a live health check leaves it 'ready') and the
        // prior error. The next 60s tick re-probes and resets on success.
        console.debug(
          `[useSandbox] Refresh: ${where} for ${id}: ${reason} — transient, keeping session (strike ${transientStrikesRef.current}/${SILENT_REFRESH_TRANSIENT_STRIKES})`,
        );
      }
    };

    if (!opts?.silent) setStatus('creating'); // reuse 'creating' as a "checking" state (shows spinner)

    try {
      suppressIdleTouch(); // Don't let refresh probes reset idle clock
      const result = await execInSandbox(id, 'true');

      if (sandboxIdRef.current !== id) return false;

      if (result.exitCode === 0) {
        transientStrikesRef.current = 0;
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
      if (isDefinitivelyGoneMessage(reason)) {
        transientStrikesRef.current = 0;
        setStatus('error');
        setError(reason);
        console.debug(`[useSandbox] Refresh: container gone for ${id}: ${reason}`);
        clearTrackedSession(sessionStorageKeyRef.current, id);
        retireDeadIdOnNative();
      } else {
        handleTransient(reason, `transient failure (exit ${result.exitCode})`);
      }
      return false;
    } catch (err) {
      if (sandboxIdRef.current !== id) return false;
      const msg = err instanceof Error ? err.message : String(err);
      if (isDefinitivelyGoneError(err)) {
        transientStrikesRef.current = 0;
        setStatus('error');
        setError(msg);
        console.debug(`[useSandbox] Refresh: container gone for ${id}: ${msg}`);
        clearTrackedSession(sessionStorageKeyRef.current, id);
        retireDeadIdOnNative();
      } else {
        handleTransient(msg, 'transient error');
      }
      return false;
    }
  }, []);

  /**
   * Transition sandbox to error state from outside (e.g. tool dispatch
   * detected SANDBOX_UNREACHABLE). Does not ping — just updates UI state
   * so the user can see the error and act on it.
   *
   * On the native shell this is also a strand risk: a reported-unreachable
   * container keeps its dead id (like refresh's gone-path), and `ensureSandbox`
   * returns that id without a status check — so the next tool send would reuse
   * the corpse and the on-device checkpoint offer never fires. SANDBOX_UNREACHABLE
   * can be transient, though, so we don't blindly retire here; we fire a silent
   * `refresh` probe, which owns the transient-vs-definitive decision (transient →
   * keep + heal back to ready; definitive → retire the id → cold-start). On web
   * the error surface stands and reconnect/cloud snapshot recover (Increment 2).
   */
  const markUnreachable = useCallback(
    (reason: string) => {
      if (statusRef.current === 'error') return; // already in error
      setStatus('error');
      setError(reason);
      if (nativeCheckpointsActive()) {
        void refresh({ silent: true });
      }
    },
    [refresh],
  );

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
    freshSandboxId,
    restoredFromSnapshotSandboxId,
  };
}
