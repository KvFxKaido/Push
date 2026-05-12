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

/** A request that failed via `DaemonRequestError` or generic Error. */
export interface DaemonRequestFailure {
  message: string;
  code?: string;
  retryable?: boolean;
}

export interface UseLocalDaemonResult {
  status: ConnectionStatus;
  events: SessionEvent[];
  request: <T = unknown>(opts: RequestOptions) => Promise<SessionResponse<T>>;
  /** Force-close and recreate the binding (Retry button). */
  reconnect: () => void;
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

  const bindingRef = useRef<LocalDaemonBinding | null>(null);
  const onMalformedRef = useRef(options.onMalformed);
  // Refs may only be written outside render (react-hooks/refs). Mirror
  // the latest callback into the ref via an effect so the adapter's
  // onMalformed hook can fire the freshest handler without forcing a
  // reconnect when the consumer changes it mid-lifetime.
  useEffect(() => {
    onMalformedRef.current = options.onMalformed;
  }, [options.onMalformed]);

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
      onStatus: (next) => setWsStatus(next),
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
    setLocalReconnectKey((k) => k + 1);
  }, []);

  return { status, events, request, reconnect };
}
