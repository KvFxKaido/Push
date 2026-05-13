/**
 * useRelayDaemon — React hook that owns the lifecycle of one
 * relay-WS adapter. Phase 2.f sibling to `useLocalDaemon`.
 *
 * Architecture is identical to the loopback hook (status-driven
 * reconnect reducer + timer effect). The shape differences are:
 *
 *   - Transport: `createRelayDaemonBinding` instead of
 *     `createLocalDaemonBinding`; URL + bearer come from a
 *     `RelayBinding` not a `LocalPcBinding`.
 *
 *   - `relay_replay_unavailable`: the chat-screen consumer wants a
 *     transient signal (mode chip amber flash) but no banner. The
 *     hook surfaces `replayUnavailableAt` — a `Date.now()` ms
 *     timestamp that flips on every event, so the UI can render an
 *     "amber for 3s" effect by comparing against now. Cleared on
 *     successful reconnect.
 *
 *   - lastSeq plumbing: the hook tracks the highest `seq` seen on
 *     incoming events so a reconnect's `relay_attach` envelope
 *     resumes from the right point. The reducer reads it from a
 *     ref so the connection effect doesn't re-fire on every event.
 *
 * The reconnect ladder is intentionally the SAME as `useLocalDaemon`
 * (decided in the 2.f scope chat): [1s, 2s, 4s, 8s, 16s, 30s] cap 6.
 * A future PR may make it relay-specific once real phone testing
 * shows what mobile networks actually need.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  type ConnectionStatus,
  type LocalDaemonBinding,
  type RequestOptions,
  type SessionEvent,
  type SessionResponse,
} from '@/lib/local-daemon-binding';
import { createRelayDaemonBinding } from '@/lib/relay-daemon-binding';
import type { RelayBinding } from '@/types';

const EVENT_LOG_CAP = 50;

/** Mirror of `useLocalDaemon`'s ladder so a single source of truth
 * lives in `useLocalDaemon.ts` long-term. Today this hook keeps its
 * own copy to avoid coupling the two surfaces; if the two ever
 * actually diverge, the duplication makes that explicit. */
export const RELAY_RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
export const RELAY_RECONNECT_MAX_ATTEMPTS = 6;

const CLIENT_INITIATED_CLOSE_CODE = 1000;

type ReconnectAction =
  | { type: 'STATUS_OPEN' }
  | { type: 'STATUS_DROPPED'; cap: number; schedule: readonly number[]; now: number }
  | { type: 'MANUAL_RESET' };

export interface ReconnectInfo {
  attempts: number;
  nextAttemptAt: number | null;
  exhausted: boolean;
  maxAttempts: number;
}

export interface UseRelayDaemonResult {
  status: ConnectionStatus;
  events: SessionEvent[];
  request: <T = unknown>(opts: RequestOptions) => Promise<SessionResponse<T>>;
  /** Force-close and recreate the binding. Resets backoff. */
  reconnect: () => void;
  reconnectInfo: ReconnectInfo;
  /**
   * `Date.now()` ms when the relay last emitted
   * `relay_replay_unavailable`. Initial value is `null`; flips to a
   * fresh timestamp on every event. The chat-screen mode chip
   * compares this against now to render a brief amber flash.
   * Cleared on successful reconnect — old replay-unavailable signals
   * shouldn't lingering after the user has re-attached cleanly.
   */
  replayUnavailableAt: number | null;
}

interface UseRelayDaemonOptions {
  reconnectKey?: number;
  onMalformed?: (raw: string, reason: string) => void;
  onEvent?: (event: SessionEvent) => void;
  /** Test seam: override backoff schedule. */
  backoffScheduleMs?: readonly number[];
  /** Test seam: override max-attempts cap. */
  maxReconnectAttempts?: number;
}

export function useRelayDaemon(
  binding: RelayBinding | null,
  options: UseRelayDaemonOptions = {},
): UseRelayDaemonResult {
  const effectiveMaxAttempts = options.maxReconnectAttempts ?? RELAY_RECONNECT_MAX_ATTEMPTS;
  const effectiveBackoffSchedule = options.backoffScheduleMs ?? RELAY_RECONNECT_BACKOFF_MS;

  const [wsStatus, setWsStatus] = useState<ConnectionStatus>({ state: 'connecting' });
  const [wsEvents, setWsEvents] = useState<SessionEvent[]>([]);
  const [localReconnectKey, setLocalReconnectKey] = useState(0);
  const [replayUnavailableAt, setReplayUnavailableAt] = useState<number | null>(null);

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
  // lastSeq tracks the highest event seq we've seen on this hook
  // instance. The connection effect reads it on each new dial to
  // build the `relay_attach { lastSeq }` envelope — that's what
  // lets the DO replay buffered events instead of starting fresh
  // each reconnect.
  const lastSeqRef = useRef<number | null>(null);
  useEffect(() => {
    onMalformedRef.current = options.onMalformed;
  }, [options.onMalformed]);
  useEffect(() => {
    onEventRef.current = options.onEvent;
  }, [options.onEvent]);

  const effectiveKey = (options.reconnectKey ?? 0) + localReconnectKey;
  const deploymentUrl = binding?.deploymentUrl ?? null;
  const sessionId = binding?.sessionId ?? null;
  const token = binding?.token ?? null;

  useEffect(() => {
    if (deploymentUrl === null || sessionId === null || token === null) {
      bindingRef.current = null;
      return;
    }
    // #530 Copilot review: createRelayDaemonBinding can throw
    // synchronously (invalid URL, loopback host without
    // allowAnyHost, etc.). A corrupted IndexedDB record OR a bad
    // bundle that somehow survived the pair flow would otherwise
    // crash the whole chat screen on mount. Wrap and route the
    // throw into a terminal `unreachable` so the ReconnectBanner
    // surfaces a recoverable Retry button.
    let handle: ReturnType<typeof createRelayDaemonBinding>;
    try {
      handle = createRelayDaemonBinding({
        deploymentUrl,
        sessionId,
        token,
        lastSeq: lastSeqRef.current,
        onStatus: (next) => {
          setWsStatus(next);
          if (next.state === 'open') {
            // Successful reconnect — drop the lingering replay-
            // unavailable signal so the chip stops flashing amber.
            setReplayUnavailableAt(null);
          }
        },
        onEvent: (event) => {
          if (typeof event.seq === 'number' && Number.isFinite(event.seq)) {
            const current = lastSeqRef.current;
            if (current === null || event.seq > current) {
              lastSeqRef.current = event.seq;
            }
          }
          setWsEvents((prev) => {
            const next =
              prev.length >= EVENT_LOG_CAP ? prev.slice(prev.length - EVENT_LOG_CAP + 1) : prev;
            return [...next, event];
          });
          try {
            onEventRef.current?.(event);
          } catch {
            // see useLocalDaemon for why consumer crashes are
            // swallowed here.
          }
        },
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        onReplayUnavailable: (_reason: string) => {
          // The chat-screen mode chip reads this timestamp to flash
          // amber for ~3s. The relay's reason string is intentionally
          // not surfaced — 2.f scope picked a lightweight signal
          // (chip flash) over a banner, so we drop the reason here.
          // Param signature kept to match the interface contract
          // (PR #530 Kilo review); `_`-prefix satisfies tsc's
          // noUnusedParameters, the eslint-disable handles the
          // `@typescript-eslint/no-unused-vars` rule which doesn't
          // honor the prefix in this repo's config.
          setReplayUnavailableAt(Date.now());
        },
        onMalformed: (raw, reason) => {
          onMalformedRef.current?.(raw, reason);
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Defer the setState so it doesn't run synchronously inside
      // the effect body — `react-hooks/set-state-in-effect` flags
      // direct setState here. queueMicrotask lands the status
      // update on the next microtask, indistinguishable from
      // synchronous from the user's POV but satisfies the rule.
      queueMicrotask(() => {
        setWsStatus({ state: 'unreachable', code: 0, reason: message });
      });
      bindingRef.current = null;
      return;
    }
    bindingRef.current = handle;
    return () => {
      bindingRef.current = null;
      handle.close();
    };
  }, [deploymentUrl, sessionId, token, effectiveKey]);

  useEffect(() => {
    if (deploymentUrl === null || sessionId === null || token === null) return;
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
  }, [wsStatus, deploymentUrl, sessionId, token, effectiveMaxAttempts, effectiveBackoffSchedule]);

  const nextAttemptAt = reconnectInfo.nextAttemptAt;
  useEffect(() => {
    if (nextAttemptAt === null) return;
    const remainingMs = Math.max(0, nextAttemptAt - Date.now());
    const timer = setTimeout(() => {
      setLocalReconnectKey((k) => k + 1);
    }, remainingMs);
    return () => clearTimeout(timer);
  }, [nextAttemptAt]);

  const status: ConnectionStatus =
    deploymentUrl === null || sessionId === null || token === null
      ? { state: 'closed', code: 0, reason: 'no binding' }
      : wsStatus;
  const events: SessionEvent[] =
    deploymentUrl === null || sessionId === null || token === null ? [] : wsEvents;

  const request = useCallback<UseRelayDaemonResult['request']>(<T>(opts: RequestOptions) => {
    const handle = bindingRef.current;
    if (!handle) {
      return Promise.reject(new Error('relay daemon not connected'));
    }
    return handle.request<T>(opts);
  }, []);

  const reconnect = useCallback(() => {
    dispatchReconnect({ type: 'MANUAL_RESET' });
    setLocalReconnectKey((k) => k + 1);
  }, []);

  return { status, events, request, reconnect, reconnectInfo, replayUnavailableAt };
}
