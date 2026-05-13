/**
 * useLocalDaemon — React hook that owns the lifecycle of one
 * `LocalDaemonBinding` (the WS adapter from PR 3a / #509).
 *
 * Sibling under `app/src/hooks/`, intentionally NOT folded into
 * `useChat`: the chat hook is guarded by an ESLint `max-lines` rule
 * (see CLAUDE.md "New feature checklist"), and the Local PC transport
 * is its own concern.
 *
 * Phase 1.f auto-reconnect: when the long-lived WS drops (either
 * pre-open `unreachable` or post-open `closed` with an abnormal code),
 * the hook schedules an exponential-backoff reconnect (1s/2s/4s/8s/
 * 16s/30s) for up to RECONNECT_MAX_ATTEMPTS tries before giving up
 * and waiting on a manual `reconnect()` call. Manual reconnect
 * resets the counter. Surface fields (`reconnectInfo.attempts`,
 * `nextAttemptAt`, `exhausted`, `maxAttempts`) let the UI banner
 * render the live state.
 *
 * Architecture: two effects split the responsibilities so neither
 * one performs side effects inside a `useState` updater:
 *   1. Status-driven scheduler effect: watches `wsStatus`, decides
 *      whether to schedule the next retry, and updates
 *      `reconnectInfo` state (no timer here).
 *   2. Timer effect: watches `reconnectInfo.nextAttemptAt` and
 *      schedules the actual `setTimeout`. Cleanup clears it on
 *      change/unmount.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  type ConnectionStatus,
  type LocalDaemonBinding,
  type RequestOptions,
  type SessionEvent,
  type SessionResponse,
  createLocalDaemonBinding,
} from '@/lib/local-daemon-binding';
import { LOCAL_PC_HOST } from '@/lib/local-pc-binding';
import type { LiveDaemonBinding } from '@/lib/local-daemon-sandbox-client';
import type { LocalPcBinding } from '@/types';

/**
 * Cap on the in-memory event log. The probe screen renders the
 * tail; we keep enough to debug a hand-paired session without
 * unbounded memory growth from a chatty daemon. Drop oldest first.
 */
const EVENT_LOG_CAP = 50;

/**
 * Backoff ladder for auto-reconnect. Each entry is the delay before
 * the corresponding retry (index 0 = 1st retry's delay, index 5 =
 * 6th retry's delay). After RECONNECT_MAX_ATTEMPTS retries the hook
 * gives up and waits on a manual `reconnect()` call. The ladder
 * length and the cap match by construction so the 30s tier is
 * actually reachable as the 6th and final retry; changing one
 * without the other strands an entry.
 */
export const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
export const RECONNECT_MAX_ATTEMPTS = 6;

/**
 * Close codes we treat as "intentionally closed by us" and therefore
 * NOT eligible for auto-reconnect. The adapter calls `ws.close(1000,
 * 'client closing')` when its consumer drops the binding; pushd's
 * graceful shutdown sends 1001 ("going away"), which IS reconnectable
 * — the daemon will come back. Any code other than 1000 plus an
 * `unreachable` state (= pre-open failure) routes to the backoff
 * ladder.
 */
const CLIENT_INITIATED_CLOSE_CODE = 1000;

/** A request that failed via `DaemonRequestError` or generic Error. */
export interface DaemonRequestFailure {
  message: string;
  code?: string;
  retryable?: boolean;
}

/** Reducer action shape for the auto-reconnect state machine. */
type ReconnectAction =
  | { type: 'STATUS_OPEN' }
  | { type: 'STATUS_DROPPED'; cap: number; schedule: readonly number[]; now: number }
  | { type: 'MANUAL_RESET' };

export interface ReconnectInfo {
  /**
   * Number of retry attempts already scheduled since the last
   * successful `open` (or since manual reconnect). The banner
   * renders "attempt {attempts} of {maxAttempts}" — `attempts` is
   * the retry number currently waiting to fire (1-based). Reset to
   * 0 on `open` or manual reconnect.
   */
  attempts: number;
  /**
   * `Date.now()`-shaped epoch ms when the next auto-reconnect attempt
   * fires, or `null` when no attempt is scheduled (status === 'open',
   * status === 'connecting', or attempts exhausted).
   */
  nextAttemptAt: number | null;
  /**
   * True once auto-reconnect has burned through `maxAttempts` retries
   * without an open. Cleared by a manual `reconnect()`.
   */
  exhausted: boolean;
  /**
   * Effective max-retries cap so callers (banner UI) can render
   * "attempt N of M" without duplicating the constant. Reflects the
   * hook's option override if one was passed.
   */
  maxAttempts: number;
}

export interface UseLocalDaemonResult {
  status: ConnectionStatus;
  events: SessionEvent[];
  request: <T = unknown>(opts: RequestOptions) => Promise<SessionResponse<T>>;
  /**
   * Live tool-dispatch binding bound to the long-lived WS this hook
   * owns. Chat-layer code passes this through `setLocalDaemonBinding`
   * so each `sandbox_*` tool call reuses the same WebSocket instead
   * of opening a transient one per call.
   *
   * Null until the binding's params are set AND the WS reaches `open`
   * for the first time — early calls would race the hook's connect
   * and fail noisily; surfacing null until then matches the chat
   * dispatch's existing "not connected → fall through to cloud
   * sandbox" guard.
   */
  liveBinding: LiveDaemonBinding | null;
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
   * Phase 3 slice 4 (submit_approval UI): fire-once callback per
   * valid incoming event. The hook still accumulates events in its
   * internal log for the probe screen; this callback lets a chat-
   * surface consumer react synchronously to specific event types
   * (e.g. `approval_required`) without re-rendering on every event
   * to scan the log. Treat as a side-channel: the consumer must NOT
   * synchronously dispatch state updates that depend on
   * `useLocalDaemon`'s own state during the callback — the binding
   * adapter calls it inline from the WS message handler.
   */
  onEvent?: (event: SessionEvent) => void;
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
  const effectiveMaxAttempts = options.maxReconnectAttempts ?? RECONNECT_MAX_ATTEMPTS;
  const effectiveBackoffSchedule = options.backoffScheduleMs ?? RECONNECT_BACKOFF_MS;

  const [wsStatus, setWsStatus] = useState<ConnectionStatus>({ state: 'connecting' });
  const [wsEvents, setWsEvents] = useState<SessionEvent[]>([]);
  const [localReconnectKey, setLocalReconnectKey] = useState(0);

  // Reducer-driven reconnect bookkeeping. The reducer is the only
  // place reconnectInfo is mutated, which lets the status-driven
  // effect below dispatch atomic actions instead of calling setState
  // inside an effect body (react-hooks/set-state-in-effect). Actions:
  //   - { type: 'STATUS_OPEN' }    successful connection: zero out.
  //   - { type: 'STATUS_DROPPED' } unreachable or abnormal close:
  //                                schedule next retry or exhaust.
  //   - { type: 'MANUAL_RESET' }   user hit Retry: clear and re-arm.
  const reconnectReducer = useCallback(
    (prev: ReconnectInfo, action: ReconnectAction): ReconnectInfo => {
      switch (action.type) {
        case 'STATUS_OPEN':
          if (prev.attempts === 0 && !prev.exhausted && prev.nextAttemptAt === null) return prev;
          return {
            attempts: 0,
            nextAttemptAt: null,
            exhausted: false,
            maxAttempts: prev.maxAttempts,
          };
        case 'STATUS_DROPPED': {
          const cap = action.cap;
          if (prev.attempts >= cap) {
            if (prev.exhausted && prev.nextAttemptAt === null && prev.maxAttempts === cap) {
              return prev;
            }
            return { ...prev, nextAttemptAt: null, exhausted: true, maxAttempts: cap };
          }
          const schedule = action.schedule;
          // The Nth scheduled retry uses schedule[N-1]: 1st retry waits
          // 1s, 6th waits 30s. Clamp at the last entry as a defensive
          // guard if a future cap exceeds the schedule length.
          const delayMs =
            schedule[Math.min(prev.attempts, schedule.length - 1)] ?? schedule[schedule.length - 1];
          return {
            attempts: prev.attempts + 1,
            nextAttemptAt: action.now + delayMs,
            exhausted: false,
            maxAttempts: cap,
          };
        }
        case 'MANUAL_RESET':
          return {
            attempts: 0,
            nextAttemptAt: null,
            exhausted: false,
            maxAttempts: prev.maxAttempts,
          };
      }
    },
    [],
  );
  const [reconnectInfo, dispatchReconnect] = useReducer(reconnectReducer, undefined, () => ({
    attempts: 0,
    nextAttemptAt: null,
    exhausted: false,
    maxAttempts: effectiveMaxAttempts,
  }));

  const bindingRef = useRef<LocalDaemonBinding | null>(null);
  const onMalformedRef = useRef(options.onMalformed);
  const onEventRef = useRef(options.onEvent);
  // Refs may only be written outside render (react-hooks/refs). Mirror
  // the latest callback into the ref via an effect so the adapter's
  // onMalformed / onEvent hooks can fire the freshest handler without
  // forcing a reconnect when the consumer changes it mid-lifetime.
  useEffect(() => {
    onMalformedRef.current = options.onMalformed;
  }, [options.onMalformed]);
  useEffect(() => {
    onEventRef.current = options.onEvent;
  }, [options.onEvent]);

  const effectiveKey = (options.reconnectKey ?? 0) + localReconnectKey;
  const port = binding?.port ?? null;
  const token = binding?.token ?? null;

  // Connection lifecycle. Status transitions flow through onStatus —
  // the adapter starts in 'connecting' internally and only emits the
  // delta via the callback, so the effect body itself never calls
  // setState (react-hooks/set-state-in-effect). The unbound case is
  // handled by the derived `status` below, not by a setState reset.
  useEffect(() => {
    if (port === null || token === null) {
      bindingRef.current = null;
      return;
    }
    const handle = createLocalDaemonBinding({
      port,
      token,
      host: LOCAL_PC_HOST,
      onStatus: (next) => {
        setWsStatus(next);
      },
      onEvent: (event) => {
        setWsEvents((prev) => {
          const next =
            prev.length >= EVENT_LOG_CAP ? prev.slice(prev.length - EVENT_LOG_CAP + 1) : prev;
          return [...next, event];
        });
        // Slice 4: forward to consumer callback for synchronous
        // per-event reactions (e.g. an approval-prompt queue that
        // needs to render BEFORE the next event arrives). Wrapped
        // in try/catch so a consumer crash can't kill the binding.
        try {
          onEventRef.current?.(event);
        } catch {
          // see setStatus
        }
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

  // Scheduler effect: dispatch into the reducer whenever wsStatus
  // changes. Effects-dispatching-actions is the canonical pattern
  // for keeping React state in sync with an external system without
  // running afoul of `react-hooks/set-state-in-effect` — the reducer
  // is the single mutation point, and dispatch() doesn't trigger
  // cascading renders the way a chain of `setState` calls would.
  // (#517 chatgpt-codex review.)
  useEffect(() => {
    if (port === null || token === null) return;
    if (wsStatus.state === 'connecting') return;
    if (wsStatus.state === 'open') {
      dispatchReconnect({ type: 'STATUS_OPEN' });
      return;
    }
    const isReconnectable =
      wsStatus.state === 'unreachable' ||
      (wsStatus.state === 'closed' && wsStatus.code !== CLIENT_INITIATED_CLOSE_CODE);
    if (!isReconnectable) return;
    dispatchReconnect({
      type: 'STATUS_DROPPED',
      cap: effectiveMaxAttempts,
      schedule: effectiveBackoffSchedule,
      now: Date.now(),
    });
  }, [wsStatus, port, token, effectiveMaxAttempts, effectiveBackoffSchedule]);

  // Timer effect: when `nextAttemptAt` is set, schedule a single
  // setTimeout that bumps the reconnect key once the deadline lands.
  // Cleared whenever `nextAttemptAt` changes (new deadline, reset,
  // exhaustion) or the hook unmounts, so a stale retry from a
  // prior status cycle can't fire against a current binding.
  const nextAttemptAt = reconnectInfo.nextAttemptAt;
  useEffect(() => {
    if (nextAttemptAt === null) return;
    const remainingMs = Math.max(0, nextAttemptAt - Date.now());
    const timer = setTimeout(() => {
      setLocalReconnectKey((k) => k + 1);
    }, remainingMs);
    return () => clearTimeout(timer);
  }, [nextAttemptAt]);

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

  // Live binding the chat-layer tool dispatch hands to per-tool
  // helpers (see `local-daemon-sandbox-client.ts#runWithBinding`).
  // Memoized on `binding + open-state` so a stable identity propagates
  // through `setLocalDaemonBinding` and React's referential checks
  // don't force a re-route on every render. Null until the WS opens
  // at least once — see UseLocalDaemonResult.liveBinding doc.
  const liveBinding = useMemo<LiveDaemonBinding | null>(() => {
    if (!binding) return null;
    if (wsStatus.state !== 'open') return null;
    return { params: binding, request };
  }, [binding, wsStatus.state, request]);

  const reconnect = useCallback(() => {
    // Manual reconnect supersedes any auto-retry: reset the counter
    // and bump the key so the connection effect recreates the binding
    // immediately. Clearing `nextAttemptAt` causes the timer effect's
    // cleanup to clear any in-flight timer on the next render — no
    // stale retry will fire against the new binding.
    dispatchReconnect({ type: 'MANUAL_RESET' });
    setLocalReconnectKey((k) => k + 1);
  }, []);

  return { status, events, request, liveBinding, reconnect, reconnectInfo };
}
