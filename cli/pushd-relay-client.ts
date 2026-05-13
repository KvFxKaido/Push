/**
 * pushd-relay-client.ts — Outbound WebSocket dialer for the
 * Worker-mediated relay. Phase 2.e of the remote-sessions track.
 *
 * Wire shape: opens `wss://<deployment>/api/relay/v1/session/<id>/connect`
 * carrying a deployment-scoped bearer in `Sec-WebSocket-Protocol`:
 *
 *   Sec-WebSocket-Protocol: push.relay.v1, bearer.<token>
 *
 * The Worker route (`app/src/worker/relay-routes.ts`) parses both
 * entries: it echoes `push.relay.v1` and validates the `bearer.`
 * prefix. The bearer is `pushd_relay_<random>`; the prefix is part
 * of the credential, so the operator-stored secret has to include
 * it (otherwise an unprefixed value can't accidentally match).
 *
 * Reconnect ladder: mirrors `useLocalDaemon.ts` exactly — six entries
 * `[1s, 2s, 4s, 8s, 16s, 30s]` with cap 6 so the 30s tier is actually
 * reachable. After exhaustion the client surfaces `exhausted: true`
 * on its status callback and stops; a manual `reconnect()` re-arms.
 *
 * Token discipline: the token is held in closure scope and passed
 * once to the `WebSocket` constructor via `protocols`. It never
 * appears in status objects, log lines, audit events, or close
 * reasons — even on auth-fail (the close code + spec'd reason are
 * the only public signal).
 *
 * Pre-open frame buffering: callers can `send()` before the WS opens
 * (e.g. the daemon emitting `relay_phone_allow` envelopes at startup,
 * before the dial has settled). Frames are queued in a bounded FIFO
 * and flushed in order on `open`. Cap is intentionally small —
 * pushd should not be backlogging more than a handful of control
 * envelopes pre-open. Past the cap, oldest frames are dropped with
 * a one-line stderr to make the loss visible.
 */
import { WebSocket } from 'ws';

/**
 * Backoff ladder for auto-reconnect. Each entry is the delay before
 * the Nth retry: index 0 = 1st retry (1s), index 5 = 6th retry (30s).
 * Length and cap match by construction so the 30s entry actually
 * fires as the 6th retry. Changing one without the other strands an
 * entry.
 *
 * Mirrors `app/src/hooks/useLocalDaemon.ts:RECONNECT_BACKOFF_MS` /
 * `RECONNECT_MAX_ATTEMPTS` exactly — Phase 1.f loopback parity.
 */
export const RELAY_RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
export const RELAY_RECONNECT_MAX_ATTEMPTS = 6;

const SUBPROTOCOL_SELECTOR = 'push.relay.v1';
const SEND_QUEUE_MAX = 64;

export type RelayConnectionStatus =
  | { state: 'connecting'; attempt: number }
  | { state: 'open' }
  | { state: 'unreachable'; code: number; reason: string; attempt: number; exhausted: boolean }
  | { state: 'closed'; code: number; reason: string; attempt: number; exhausted: boolean };

export interface PushdRelayClientOptions {
  /**
   * Worker deployment base URL. Accepts both `http(s)://` and
   * `ws(s)://`; an `http(s)://` value is rewritten to `ws(s)://`
   * for the actual connect. The path `/api/relay/v1/session/<id>/connect`
   * is appended.
   */
  deploymentUrl: string;
  /**
   * Opaque routing key chosen by pushd and shared with the phone at
   * pairing time. NOT load-bearing for security — the allowlist gate
   * is the actual security boundary (see decision doc 2.d.1 walk-back).
   */
  sessionId: string;
  /**
   * Deployment-scoped relay bearer. Format: `pushd_relay_<random>`.
   * Held only in closure scope; never appears in any callback payload.
   */
  token: string;
  /** Status transitions — `connecting → open → closed/unreachable`. */
  onStatus?: (status: RelayConnectionStatus) => void;
  /** One call per inbound text frame from the relay. NDJSON-shaped. */
  onMessage?: (text: string) => void;
  /**
   * Called every time the WS reaches `open`. The argument is a
   * `send` function bound to this connection — use it for "on every
   * connect" re-emit (e.g. the full `relay_phone_allow` allowlist).
   * Called AFTER pre-open buffered frames have been flushed.
   */
  onOpen?: (send: (frame: string) => void) => void;
  /**
   * Test seam: override the backoff schedule. Default is
   * `RELAY_RECONNECT_BACKOFF_MS`. Test code passes a compressed
   * schedule (e.g. `[10, 20]`) so timers don't drag the test clock.
   */
  backoffScheduleMs?: readonly number[];
  /** Test seam: override the max-attempts cap. */
  maxReconnectAttempts?: number;
}

export interface RelayClientHandle {
  /** Last status callback fired. Synchronous read for "what's the state right now?". */
  readonly status: RelayConnectionStatus;
  /**
   * Send a text frame. If the WS isn't open yet, the frame is queued
   * (bounded FIFO, capacity SEND_QUEUE_MAX) and flushed on next
   * open. Returns true if the frame was sent or queued, false if the
   * queue was full and the frame was dropped.
   */
  send(frame: string): boolean;
  /**
   * Force a fresh dial. Resets the backoff counter and clears
   * `exhausted`. Safe to call from any state; no-op if a connect is
   * already in flight on this tick.
   */
  reconnect(): void;
  /**
   * Tear down: close the WS, clear any pending reconnect timer.
   * Idempotent.
   */
  close(): void;
}

function buildRelayUrl(deploymentUrl: string, sessionId: string): string {
  // Normalize http(s) → ws(s); leave ws(s) intact. Trim a trailing
  // slash so the path append doesn't double up. We deliberately don't
  // validate the scheme strictly — operators may run on plain `ws://`
  // for a local Worker dev loop, and the security gate is the bearer
  // + the Worker's origin check, not the protocol.
  let base = deploymentUrl.replace(/\/+$/, '');
  if (base.startsWith('https://')) base = `wss://${base.slice('https://'.length)}`;
  else if (base.startsWith('http://')) base = `ws://${base.slice('http://'.length)}`;
  return `${base}/api/relay/v1/session/${encodeURIComponent(sessionId)}/connect`;
}

export function startPushdRelayClient(opts: PushdRelayClientOptions): RelayClientHandle {
  const url = buildRelayUrl(opts.deploymentUrl, opts.sessionId);
  const schedule = opts.backoffScheduleMs ?? RELAY_RECONNECT_BACKOFF_MS;
  const maxAttempts = opts.maxReconnectAttempts ?? RELAY_RECONNECT_MAX_ATTEMPTS;

  // The token lives only in this closure variable + the `protocols`
  // array we pass to `WebSocket`. NEVER copy it into status objects,
  // error messages, or audit lines.
  const protocols = [SUBPROTOCOL_SELECTOR, `bearer.${opts.token}`];

  let currentStatus: RelayConnectionStatus = { state: 'connecting', attempt: 0 };
  let ws: WebSocket | null = null;
  let everOpened = false;
  let clientClosed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const sendQueue: string[] = [];

  const setStatus = (next: RelayConnectionStatus): void => {
    currentStatus = next;
    try {
      opts.onStatus?.(next);
    } catch {
      // Consumer crashes must not propagate into the connect loop.
    }
  };

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = (terminalCode: number, terminalReason: string): void => {
    if (clientClosed) return;
    // `attempt` is 0-indexed before this call: attempt 0 was the
    // initial dial, attempt 1 is the first retry. The N-th retry
    // (1-based) uses schedule[N-1].
    if (attempt >= maxAttempts) {
      setStatus({
        state: everOpened ? 'closed' : 'unreachable',
        code: terminalCode,
        reason: terminalReason,
        attempt,
        exhausted: true,
      });
      return;
    }
    const idx = Math.min(attempt, schedule.length - 1);
    const delayMs = schedule[idx] ?? schedule[schedule.length - 1];
    attempt += 1;
    setStatus({
      state: everOpened ? 'closed' : 'unreachable',
      code: terminalCode,
      reason: terminalReason,
      attempt,
      exhausted: false,
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      dial();
    }, delayMs);
  };

  const flushSendQueue = (): void => {
    if (!ws || ws.readyState !== ws.OPEN) return;
    while (sendQueue.length > 0) {
      const frame = sendQueue.shift()!;
      try {
        ws.send(frame);
      } catch {
        // Connection died between OPEN-check and send. Re-queue the
        // frame at the head so the next open flushes it (or drops if
        // we've already hit the cap).
        if (sendQueue.length < SEND_QUEUE_MAX) sendQueue.unshift(frame);
        return;
      }
    }
  };

  const dial = (): void => {
    if (clientClosed) return;
    everOpened = false;
    setStatus({ state: 'connecting', attempt });

    let socket: WebSocket;
    try {
      socket = new WebSocket(url, protocols);
    } catch (err) {
      // `new WebSocket` can throw synchronously for malformed URLs.
      // Route through the same scheduling path as a runtime failure
      // so the caller sees a uniform retry shape.
      const message = err instanceof Error ? err.message : String(err);
      scheduleReconnect(1006, `dial threw: ${message}`);
      return;
    }
    ws = socket;

    socket.on('open', () => {
      everOpened = true;
      attempt = 0;
      setStatus({ state: 'open' });
      flushSendQueue();
      try {
        opts.onOpen?.((frame: string) => {
          if (ws && ws.readyState === ws.OPEN) {
            try {
              ws.send(frame);
            } catch {
              // best-effort
            }
          }
        });
      } catch {
        // see setStatus
      }
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) return; // wire is NDJSON text only
      const text = data.toString('utf8');
      try {
        opts.onMessage?.(text);
      } catch {
        // see setStatus
      }
    });

    const handleTerminal = (code: number, reason: string): void => {
      if (clientClosed) {
        // Caller-initiated close. Final status reflects intentional
        // closure; no reconnect.
        setStatus({
          state: everOpened ? 'closed' : 'unreachable',
          code,
          reason: reason || 'client closed',
          attempt,
          exhausted: false,
        });
        return;
      }
      scheduleReconnect(code, reason || (everOpened ? 'connection closed' : 'connection failed'));
    };

    let terminalFired = false;
    const fireTerminalOnce = (code: number, reason: string): void => {
      if (terminalFired) return;
      terminalFired = true;
      handleTerminal(code, reason);
    };
    socket.on('close', (code: number, reason: Buffer) => {
      fireTerminalOnce(code, reason?.toString('utf8') ?? '');
    });
    socket.on('error', () => {
      // `ws` always fires 'close' after 'error', but the close handler
      // beats the error handler to the punch on most paths. Route both
      // through `fireTerminalOnce` so we don't double-schedule.
      fireTerminalOnce(1006, 'connection error');
    });
  };

  // Kick off the first dial on the next tick so consumers can attach
  // handlers between construction and the first status callback.
  // Without this, a synchronous throw in the WebSocket constructor
  // would call `onStatus` before the caller has wired it up.
  queueMicrotask(() => {
    if (!clientClosed) dial();
  });

  return {
    get status() {
      return currentStatus;
    },
    send(frame: string): boolean {
      if (ws && ws.readyState === ws.OPEN) {
        try {
          ws.send(frame);
          return true;
        } catch {
          // fall through to queue
        }
      }
      if (sendQueue.length >= SEND_QUEUE_MAX) {
        // Drop oldest. The dropped frame's content is not logged —
        // it may contain attach-token bearer text (relay_phone_allow).
        sendQueue.shift();
        process.stderr.write(
          `pushd-relay-client: send queue full (${SEND_QUEUE_MAX}); dropped oldest frame.\n`,
        );
      }
      sendQueue.push(frame);
      return true;
    },
    reconnect(): void {
      // Manual reconnect supersedes any auto-retry: reset the counter,
      // clear any pending timer, and force a fresh dial. If a socket
      // is currently open or in-flight, close it first so the retry
      // doesn't race the old connection.
      clearReconnectTimer();
      attempt = 0;
      const existing = ws;
      ws = null;
      if (existing && existing.readyState !== existing.CLOSED) {
        try {
          existing.terminate();
        } catch {
          /* ignore */
        }
      }
      // queueMicrotask so the caller's status observer sees the
      // 'connecting' transition AFTER they've finished handling the
      // reconnect() call.
      queueMicrotask(() => {
        if (!clientClosed) dial();
      });
    },
    close(): void {
      if (clientClosed) return;
      clientClosed = true;
      clearReconnectTimer();
      const existing = ws;
      ws = null;
      if (existing && existing.readyState !== existing.CLOSED) {
        try {
          existing.close(1000, 'client closing');
        } catch {
          try {
            existing.terminate();
          } catch {
            /* ignore */
          }
        }
      }
    },
  };
}
