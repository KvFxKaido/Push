/**
 * useLocalDaemon — React hook that owns the lifecycle of one
 * `LocalDaemonBinding` (the WS adapter from PR 3a / #509).
 *
 * Sibling under `app/src/hooks/`, intentionally NOT folded into
 * `useChat`: the chat hook is guarded by an ESLint `max-lines` rule
 * (see CLAUDE.md "New feature checklist"), and the Local PC transport
 * is its own concern. PR 3c will wire dispatch through this hook,
 * but the seam stays here, not inside useChat.
 *
 * PR 3b uses this hook only on the Local PC probe screen — the chat
 * round loop still runs against the cloud sandbox.
 *
 * Phase 1.f (PR claude/remote-sessions-auto-reconnect): when the
 * long-lived WS transitions to `unreachable`, the hook schedules
 * exponential-backoff reconnects (1s/2s/4s/8s/16s capped at 30s) for
 * up to RECONNECT_MAX_ATTEMPTS tries before giving up and waiting on
 * a manual `reconnect()` call. Manual reconnect resets the counter.
 * Surface fields (`reconnect.attempts`, `nextAttemptAt`, `exhausted`)
 * let the UI banner render the live state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ConnectionStatus,
  type LocalDaemonBinding,
  type RequestOptions,
  type SessionEvent,
  type SessionResponse,
  createLocalDaemonBinding,
} from '@/lib/local-daemon-binding';
import { LOCAL_PC_HOST } from '@/lib/local-pc-binding';
import type { LocalPcBinding } from '@/types';

/**
 * Cap on the in-memory event log. The probe screen renders the
 * tail; we keep enough to debug a hand-paired session without
 * unbounded memory growth from a chatty daemon. Drop oldest first.
 */
const EVENT_LOG_CAP = 50;

/**
 * Backoff ladder for auto-reconnect after `unreachable`. Each entry
 * is the delay before the *next* attempt. After RECONNECT_MAX_ATTEMPTS
 * consecutive unreachables, auto-reconnect gives up and waits on a
 * manual `reconnect()` call. The ladder is fixed (not generated) so
 * the banner can read the exact wait time for the next attempt.
 */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const RECONNECT_MAX_ATTEMPTS = 5;

/** A request that failed via `DaemonRequestError` or generic Error. */
export interface DaemonRequestFailure {
  message: string;
  code?: string;
  retryable?: boolean;
}

export interface ReconnectInfo {
  /**
   * Number of consecutive auto-reconnect attempts since the last
   * successful `open`. Reset to 0 on `open` or on manual reconnect.
   */
  attempts: number;
  /**
   * `Date.now()`-shaped epoch ms when the next auto-reconnect attempt
   * fires, or `null` when no attempt is scheduled (status === 'open',
   * status === 'connecting', or attempts exhausted).
   */
  nextAttemptAt: number | null;
  /**
   * True once auto-reconnect has burned through RECONNECT_MAX_ATTEMPTS
   * unreachables without an open. Cleared by a manual `reconnect()`.
   */
  exhausted: boolean;
}

export interface UseLocalDaemonResult {
  status: ConnectionStatus;
  events: SessionEvent[];
  request: <T = unknown>(opts: RequestOptions) => Promise<SessionResponse<T>>;
  /** Force-close and recreate the binding (Retry button). Resets backoff. */
  reconnect: () => void;
  /** Live state of the auto-reconnect scheduler — for banner UI. */
  reconnectInfo: ReconnectInfo;
}

interface UseLocalDaemonOptions {
  /**
   * Bump this when the consumer wants a fresh connection attempt
   * without changing the binding shape. The reconnect() returned in
   * the result wraps this internally.
   */
  reconnectKey?: number;
  /** Surface malformed frames to the caller for diagnostics. */
  onMalformed?: (raw: string, reason: string) => void;
  /**
   * Test seam: override the backoff schedule. The default is the
   * exported `RECONNECT_BACKOFF_MS` ladder; tests pass a compressed
   * schedule (e.g. `[5, 10, 20]`) so fake timers don't have to advance
   * full seconds. Treated as readonly — never mutated.
   */
  backoffScheduleMs?: readonly number[];
  /** Test seam: override the max-attempts cap (default RECONNECT_MAX_ATTEMPTS). */
  maxReconnectAttempts?: number;
}

/**
 * Open and own a WS to a paired pushd. The hook returns a closed
 * status when `binding` is null so callers can render unpaired
 * states without conditional hooks.
 */
export function useLocalDaemon(
  binding: LocalPcBinding | null,
  options: UseLocalDaemonOptions = {},
): UseLocalDaemonResult {
  const [wsStatus, setWsStatus] = useState<ConnectionStatus>({ state: 'connecting' });
  const [wsEvents, setWsEvents] = useState<SessionEvent[]>([]);
  const [localReconnectKey, setLocalReconnectKey] = useState(0);
  const [reconnectInfo, setReconnectInfo] = useState<ReconnectInfo>({
    attempts: 0,
    nextAttemptAt: null,
    exhausted: false,
  });

  const bindingRef = useRef<LocalDaemonBinding | null>(null);
  const onMalformedRef = useRef(options.onMalformed);
  // Refs may only be written outside render (react-hooks/refs). Mirror
  // the latest callback into the ref via an effect so the adapter's
  // onMalformed hook can fire the freshest handler without forcing a
  // reconnect when the consumer changes it mid-lifetime.
  useEffect(() => {
    onMalformedRef.current = options.onMalformed;
  }, [options.onMalformed]);

  // Test seams. Capture into refs so a change after mount doesn't
  // force the connection effect to retear itself; the schedule is read
  // synchronously inside the unreachable handler.
  const backoffScheduleRef = useRef<readonly number[]>(
    options.backoffScheduleMs ?? RECONNECT_BACKOFF_MS,
  );
  const maxAttemptsRef = useRef<number>(options.maxReconnectAttempts ?? RECONNECT_MAX_ATTEMPTS);
  useEffect(() => {
    backoffScheduleRef.current = options.backoffScheduleMs ?? RECONNECT_BACKOFF_MS;
    maxAttemptsRef.current = options.maxReconnectAttempts ?? RECONNECT_MAX_ATTEMPTS;
  }, [options.backoffScheduleMs, options.maxReconnectAttempts]);

  const effectiveKey = (options.reconnectKey ?? 0) + localReconnectKey;
  const port = binding?.port ?? null;
  const token = binding?.token ?? null;

  // Active backoff timer; cleared on unmount or manual reconnect so a
  // stale timer can't re-arm a fresh binding after the user re-paired.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  // Connection lifecycle. Status transitions flow through onStatus —
  // the adapter starts in 'connecting' internally and only emits the
  // delta via the callback, so the effect body itself never calls
  // setState (react-hooks/set-state-in-effect). The unbound case is
  // handled by the derived `status` below, not by a setState reset.
  useEffect(() => {
    if (port === null || token === null) {
      bindingRef.current = null;
      clearReconnectTimer();
      return;
    }
    const handle = createLocalDaemonBinding({
      port,
      token,
      host: LOCAL_PC_HOST,
      onStatus: (next) => {
        setWsStatus(next);
        if (next.state === 'open') {
          // Successful open: clear any pending retry and zero the
          // counter so the next failure starts the ladder over.
          clearReconnectTimer();
          setReconnectInfo({ attempts: 0, nextAttemptAt: null, exhausted: false });
          return;
        }
        if (next.state === 'unreachable') {
          // Browsers collapse all pre-open failure modes (TCP refused,
          // bad bearer, origin mismatch, network error) into one
          // `unreachable` state — the adapter intentionally can't
          // distinguish them. Retry blindly: a daemon-restarted-too-
          // fast case recovers, a permanent token-rejection case
          // burns through the attempts cap and surfaces via the
          // `exhausted` flag for the manual-retry banner.
          //
          // The scheduling itself goes through setReconnectInfo's
          // updater form so we read the LATEST attempt count rather
          // than racing the React closure: two `unreachable`s in
          // quick succession (re-entrant terminal handlers) would
          // otherwise both see `attempts: 0` and schedule the same
          // 1s timer.
          setReconnectInfo((prev) => {
            const schedule = backoffScheduleRef.current;
            const cap = maxAttemptsRef.current;
            const nextAttempts = prev.attempts + 1;
            if (nextAttempts > cap) {
              // Cap reached — leave the timer cleared and flip
              // `exhausted`. The user re-arms via manual reconnect.
              clearReconnectTimer();
              return { attempts: prev.attempts, nextAttemptAt: null, exhausted: true };
            }
            // Pick the delay at the CURRENT-attempt index so the
            // first failure uses schedule[0], the second uses
            // schedule[1], etc. The last entry repeats once the
            // ladder is exhausted but the cap still allows retries.
            const delayMs =
              schedule[Math.min(prev.attempts, schedule.length - 1)] ??
              schedule[schedule.length - 1];
            clearReconnectTimer();
            reconnectTimerRef.current = setTimeout(() => {
              reconnectTimerRef.current = null;
              setLocalReconnectKey((k) => k + 1);
            }, delayMs);
            return {
              attempts: nextAttempts,
              nextAttemptAt: Date.now() + delayMs,
              exhausted: false,
            };
          });
        }
        // 'connecting' and 'closed' states leave the existing reconnect
        // schedule untouched. A client-initiated 'closed' won't fire
        // unreachable so we won't auto-retry it (correct — the user
        // asked for the close).
      },
      onEvent: (event) => {
        setWsEvents((prev) => {
          const next =
            prev.length >= EVENT_LOG_CAP ? prev.slice(prev.length - EVENT_LOG_CAP + 1) : prev;
          return [...next, event];
        });
      },
      onMalformed: (raw, reason) => {
        onMalformedRef.current?.(raw, reason);
      },
    });
    bindingRef.current = handle;
    return () => {
      bindingRef.current = null;
      handle.close();
    };
  }, [port, token, effectiveKey]);

  // Unmount-time cleanup: drop any pending retry timer regardless of
  // whether the binding effect's own cleanup ran first.
  useEffect(() => {
    return () => {
      clearReconnectTimer();
    };
  }, []);

  // Derive surface state from the binding presence + WS state. When
  // unbound, status is unconditionally "closed" with the no-binding
  // reason; events are unconditionally empty. That keeps the effect
  // body free of resets while still giving callers an honest read.
  const status: ConnectionStatus =
    port === null || token === null ? { state: 'closed', code: 0, reason: 'no binding' } : wsStatus;
  const events: SessionEvent[] = port === null || token === null ? [] : wsEvents;

  const request = useCallback<UseLocalDaemonResult['request']>(<T>(opts: RequestOptions) => {
    const handle = bindingRef.current;
    if (!handle) {
      return Promise.reject(new Error('local daemon not connected'));
    }
    return handle.request<T>(opts);
  }, []);

  const reconnect = useCallback(() => {
    // Manual reconnect supersedes any auto-retry: clear the timer,
    // reset the counter, and bump the key so the connection effect
    // recreates the binding immediately. The new attempt starts a
    // fresh `connecting` → `open`/`unreachable` cycle and the auto-
    // retry ladder is back to step 0 if it goes wrong again.
    clearReconnectTimer();
    setReconnectInfo({ attempts: 0, nextAttemptAt: null, exhausted: false });
    setLocalReconnectKey((k) => k + 1);
  }, []);

  return { status, events, request, reconnect, reconnectInfo };
}
