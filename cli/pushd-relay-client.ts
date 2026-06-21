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
 * Liveness heartbeat (GOpencode review #1): the ladder only fires on an
 * *observed* terminal. A WS-level ping with a bounded pong window
 * (`RELAY_HEARTBEAT_INTERVAL_MS`) catches the half-open case the network
 * never reports — miss a pong/traffic and we `terminate()` into the
 * ladder. Suspended while the send buffer is backlogged so a slow-but-
 * live transfer isn't mistaken for a dead link.
 *
 * Backoff nudge (GOpencode review #3): `nudge()` is a no-op while the
 * link is healthy or a dial is in flight, but collapses a pending
 * backoff wait (or an exhausted/stranded state) and re-dials from the
 * top. Drive it from an external "network restored / app foregrounded"
 * signal to skip the wait without disturbing a working connection.
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

/**
 * App-level liveness heartbeat (GOpencode review, suggested-priority #1).
 *
 * The reconnect ladder above only fires on an *observed* terminal —
 * a `close`/`error` event, or a non-101 upgrade. On a flaky mobile /
 * NAT path the TCP connection can go **half-open**: the peer is gone
 * but no FIN/RST ever arrives, so `ws` never emits `close` and the
 * ladder never arms. The daemon then sits "open" forever against a
 * dead relay. A WS-level ping with a bounded pong window is the only
 * thing that surfaces that state: miss a pong and we `terminate()`,
 * which synthesizes the `close` the network failed to deliver and
 * routes into the existing reconnect path.
 *
 * Default cadence: ping every `RELAY_HEARTBEAT_INTERVAL_MS`; if no
 * pong (or any inbound frame — traffic proves liveness too) arrived
 * since the previous tick, the link is declared dead. Effective
 * detection window is therefore ~1–2 intervals. Set the interval to
 * 0 (or any value ≤ 0) to disable — used by tests that don't want a
 * background timer.
 */
export const RELAY_HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * When the socket has more than this many bytes still buffered for
 * send, the heartbeat tick is suspended for that round: a large
 * backlog means we're mid-transfer (the link is up, just slow), so
 * pinging-and-timing-out would be a false positive that kills a
 * working transfer. Mirrors GOpencode's `bufferedAmount` guard.
 */
const RELAY_HEARTBEAT_BUFFER_SUSPEND_BYTES = 64 * 1024;

export type RelayConnectionStatus =
  | { state: 'connecting'; attempt: number }
  | { state: 'open' }
  | {
      state: 'unreachable';
      code: number;
      reason: string;
      attempt: number;
      exhausted: boolean;
      /** True when the failure won't self-heal (auth/origin config) so the
       *  client stopped retrying — fix the cause and re-enable. */
      fatal?: boolean;
    }
  | {
      state: 'closed';
      code: number;
      reason: string;
      attempt: number;
      exhausted: boolean;
      fatal?: boolean;
    };

/**
 * Turn a relay-upgrade rejection (a non-101 HTTP response on the WS upgrade)
 * into a human reason + whether it's fatal (won't self-heal, so retrying is
 * pointless). The `ws` client exposes the failed upgrade's HTTP status + body
 * via the `unexpected-response` event; the worker answers with
 * `{ error: { code, message } }` (see app/src/worker/relay-routes.ts). This is
 * what turns an opaque "1006 connection error" into the actual cause — the
 * thing that took a `wrangler tail` to discover.
 */
export function describeRelayUpgradeRejection(
  statusCode: number,
  errorCode: string | null,
  message: string | null,
): { reason: string; fatal: boolean } {
  switch (errorCode) {
    case 'RELAY_TOKEN_NOT_CONFIGURED':
      return { reason: `worker has no PUSH_RELAY_TOKEN set (HTTP ${statusCode})`, fatal: true };
    case 'BEARER_REJECTED':
      return {
        reason: `relay token rejected — the daemon's token doesn't match the worker's PUSH_RELAY_TOKEN (HTTP ${statusCode})`,
        fatal: true,
      };
    case 'ORIGIN_REJECTED':
      return { reason: `origin rejected by the worker (HTTP ${statusCode})`, fatal: true };
    case 'UPGRADE_REQUIRED':
      return {
        reason: `worker did not accept the WebSocket upgrade (HTTP ${statusCode})`,
        fatal: false,
      };
  }
  // No / unknown structured code. 401 & 403 are config-shaped — retrying won't
  // fix a bad token or a blocked origin, so go fatal. A 404 means the relay
  // route isn't there (old deploy / routes unbound) — let it retry briefly in
  // case a deploy is mid-flight. 5xx and the rest are treated as transient.
  if (statusCode === 401 || statusCode === 403) {
    return { reason: `${message || 'rejected'} (HTTP ${statusCode})`, fatal: true };
  }
  if (statusCode === 404) {
    return {
      reason: `relay route not found — worker may be an old deploy or relay routes aren't bound (HTTP 404)`,
      fatal: false,
    };
  }
  return { reason: `${message || 'upgrade rejected'} (HTTP ${statusCode})`, fatal: false };
}

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
  /**
   * App-level liveness heartbeat interval (ms). Default
   * `RELAY_HEARTBEAT_INTERVAL_MS`. Set ≤ 0 to disable the heartbeat
   * entirely (no background timer) — tests that aren't exercising
   * half-open detection pass 0 so they don't leave a timer running.
   */
  heartbeatIntervalMs?: number;
}

export interface RelayClientHandle {
  /** Last status callback fired. Synchronous read for "what's the state right now?". */
  readonly status: RelayConnectionStatus;
  /**
   * Send a text frame. If the WS isn't open yet, the frame is queued
   * (bounded FIFO, capacity SEND_QUEUE_MAX) and flushed on next open.
   * When the queue is at capacity, the OLDEST queued frame is dropped
   * (with a single-line stderr) so the most recent control envelopes
   * survive — losing a stale `relay_phone_allow` is worse than losing
   * a fresh one. Always returns `true`; callers that need
   * delivery-guaranteed semantics should layer their own retry.
   */
  send(frame: string): boolean;
  /**
   * Force a fresh dial. Resets the backoff counter and clears
   * `exhausted`. Safe to call from any state; idempotent within one
   * tick — concurrent calls collapse via the `dialPending` flag so
   * only one dial is in flight at a time.
   */
  reconnect(): void;
  /**
   * Backoff nudge (GOpencode review, suggested-priority #3). Unlike
   * `reconnect()`, this is a *no-op when the link is healthy or a dial
   * is already in flight* — it never disrupts a working connection.
   * It only acts when we're parked in a backoff wait or sitting
   * exhausted/stranded: it collapses the remaining wait, resets the
   * ladder to the top, and dials immediately. The intended trigger is
   * an external "things changed, try now" signal — network restored,
   * the controlling app returned to foreground — where waiting out the
   * full 30s backoff would be needless latency. A `fatal` (bad token /
   * origin) latch is left untouched, since no network event fixes it.
   */
  nudge(): void;
  /**
   * Tear down: close the WS, clear any pending reconnect timer.
   * Idempotent.
   */
  close(): void;
}

export function buildRelayUrl(deploymentUrl: string, sessionId: string): string {
  // Normalize via `URL` so the relay path joins relative to whatever
  // base path the operator supplied. Operators run pushd against
  // deployments like `https://example.com/api` or even a Workers
  // route like `https://example.com/v1/api`; blindly appending
  // `/api/relay/...` would double-up the prefix and 404. The
  // approach: replace the URL's path with the relay route, keeping
  // origin + scheme intact, then rewrite the scheme to ws(s).
  //
  // PR #530 Copilot review. Bare hostnames without a scheme
  // (`example.com`) are tolerated — URL needs a scheme, so we
  // fallback-prefix with `wss://` before parsing.
  let toParse = deploymentUrl.trim();
  if (
    !toParse.startsWith('http://') &&
    !toParse.startsWith('https://') &&
    !toParse.startsWith('ws://') &&
    !toParse.startsWith('wss://')
  ) {
    toParse = `wss://${toParse}`;
  }
  const url = new URL(toParse);
  url.pathname = `/api/relay/v1/session/${encodeURIComponent(sessionId)}/connect`;
  url.search = '';
  url.hash = '';
  // Rewrite scheme: http(s) → ws(s); ws(s) stays.
  const scheme =
    url.protocol === 'https:' || url.protocol === 'wss:'
      ? 'wss:'
      : url.protocol === 'http:' || url.protocol === 'ws:'
        ? 'ws:'
        : url.protocol;
  return `${scheme}//${url.host}${url.pathname}`;
}

export function startPushdRelayClient(opts: PushdRelayClientOptions): RelayClientHandle {
  const url = buildRelayUrl(opts.deploymentUrl, opts.sessionId);
  const schedule = opts.backoffScheduleMs ?? RELAY_RECONNECT_BACKOFF_MS;
  const maxAttempts = opts.maxReconnectAttempts ?? RELAY_RECONNECT_MAX_ATTEMPTS;
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? RELAY_HEARTBEAT_INTERVAL_MS;

  // The token lives only in this closure variable + the `protocols`
  // array we pass to `WebSocket`. NEVER copy it into status objects,
  // error messages, or audit lines.
  const protocols = [SUBPROTOCOL_SELECTOR, `bearer.${opts.token}`];

  let currentStatus: RelayConnectionStatus = { state: 'connecting', attempt: 0 };
  let ws: WebSocket | null = null;
  // `hasEverOpened` is client-lifetime: set true on the first
  // successful open and never reset. Used to classify the terminal
  // state — a reconnect failure AFTER a previously successful
  // connection reports `closed` (the server is reachable, just not
  // right now), while a never-opened lifetime reports `unreachable`.
  // PR #529 Copilot review: the previous per-dial `everOpened` reset
  // mis-classified post-success reconnect failures as `unreachable`.
  let hasEverOpened = false;
  // Set when an upgrade rejection is classified non-self-healing (bad token,
  // blocked origin). Suppresses further auto-retries — a fatal config error
  // would just burn the backoff ladder and end "exhausted" with no new info.
  // Cleared by `reconnect()` so the operator can retry after fixing the cause.
  let fatal = false;
  // `openedThisDial` tracks whether the CURRENT dial's WS reached
  // 'open' — used only for internal flow (the open handler swaps a
  // status without needing to query the socket). Reset at every dial
  // start, set in the WS open handler.
  let openedThisDial = false;
  let clientClosed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // True between scheduling a dial (via timer OR microtask) and the
  // dial actually running. `reconnect()` checks this so back-to-back
  // calls collapse to one dial; without the guard, two microtasks
  // would each call `dial()` and the second would orphan the first's
  // WebSocket (overlapping connections + competing event handlers).
  // PR #529 Copilot review.
  let dialPending = false;
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

  /**
   * Terminal status for a non-self-healing failure: surface the reason and
   * stop retrying (no timer scheduled). `reconnect()` clears `fatal` to allow
   * a manual retry after the operator fixes the cause.
   */
  const setFatalTerminal = (code: number, reason: string): void => {
    fatal = true;
    setStatus({
      state: hasEverOpened ? 'closed' : 'unreachable',
      code,
      reason,
      attempt,
      exhausted: true,
      fatal: true,
    });
  };

  const scheduleReconnect = (terminalCode: number, terminalReason: string): void => {
    if (clientClosed || fatal) return;
    // `attempt` is 0-indexed before this call: attempt 0 was the
    // initial dial, attempt 1 is the first retry. The N-th retry
    // (1-based) uses schedule[N-1].
    if (attempt >= maxAttempts) {
      setStatus({
        state: hasEverOpened ? 'closed' : 'unreachable',
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
      state: hasEverOpened ? 'closed' : 'unreachable',
      code: terminalCode,
      reason: terminalReason,
      attempt,
      exhausted: false,
    });
    dialPending = true;
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
    dialPending = false;
    if (clientClosed) return;
    openedThisDial = false;
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

    // App-level liveness state for THIS dial. `alive` is set by any
    // inbound signal (pong frame or data message) and cleared on each
    // heartbeat tick right before the next ping is sent; a tick that
    // finds it still cleared declares the link half-open and forces a
    // reconnect. The timer is dial-scoped and torn down in
    // `fireTerminalOnce` so it can never outlive its socket.
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let alive = true;
    const clearHeartbeat = (): void => {
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };
    const markAlive = (): void => {
      alive = true;
    };

    socket.on('open', () => {
      hasEverOpened = true;
      openedThisDial = true;
      attempt = 0;
      setStatus({ state: 'open' });
      flushSendQueue();

      // Arm the liveness heartbeat now that the socket is open. Disabled
      // when the interval is ≤ 0 (test seam). `.unref()` keeps the timer
      // from holding the daemon's event loop open on its own — the WS
      // already does that while the connection matters.
      alive = true;
      if (heartbeatIntervalMs > 0) {
        heartbeatTimer = setInterval(() => {
          // Gate on THIS dial's socket, never the module-level `ws`
          // (which may already point at a newer dial). A non-open
          // socket means the close path is mid-flight; let it clear us.
          if (socket.readyState !== socket.OPEN) return;
          // Mid-transfer backlog: link is up but slow. Treat as alive
          // and skip this round rather than risk a false-positive kill.
          if (socket.bufferedAmount > RELAY_HEARTBEAT_BUFFER_SUSPEND_BYTES) {
            alive = true;
            return;
          }
          if (!alive) {
            // No pong/traffic since the previous tick → half-open. The
            // network never delivered a close; synthesize one. The event
            // name calls out the half-open cause explicitly so ops can
            // grep heartbeat-driven kills apart from peer-initiated
            // closes (which never emit this line). Never logs the bearer.
            process.stderr.write(
              `${JSON.stringify({ level: 'warn', event: 'relay_heartbeat_half_open', attempt })}\n`,
            );
            clearHeartbeat();
            try {
              socket.terminate();
            } catch {
              // best-effort — the close handler still routes to reconnect
            }
            return;
          }
          alive = false;
          try {
            socket.ping();
          } catch {
            // best-effort; a failed ping surfaces as a missed pong next tick
          }
        }, heartbeatIntervalMs);
        if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
      }
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

    // Any pong proves the peer is alive. So does any data frame, so the
    // `message` handler also marks alive — a chatty relay keeps the link
    // certified without depending on pong support specifically.
    socket.on('pong', markAlive);

    socket.on('message', (data, isBinary) => {
      markAlive();
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
          state: hasEverOpened ? 'closed' : 'unreachable',
          code,
          reason: reason || 'client closed',
          attempt,
          exhausted: false,
        });
        return;
      }
      scheduleReconnect(
        code,
        reason || (openedThisDial ? 'connection closed' : 'connection failed'),
      );
    };

    let terminalFired = false;
    const fireTerminalOnce = (code: number, reason: string, isFatal = false): void => {
      if (terminalFired) return;
      terminalFired = true;
      // Stop this dial's heartbeat first — the socket is going away and
      // a stray tick must not fire against a dead/replaced connection.
      clearHeartbeat();
      // `ws` does NOT auto-close the socket on `unexpected-response`, and a
      // terminal close/error leaves nothing to reuse — terminate so the
      // underlying TCP socket can't leak across the (now dead) dial.
      try {
        if (socket.readyState !== socket.CLOSED) socket.terminate();
      } catch {
        // best-effort
      }
      if (isFatal) setFatalTerminal(code, reason);
      else handleTerminal(code, reason);
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
    // Non-101 upgrade response (the Worker rejected the dial). `ws` hands us
    // the raw HTTP response — read its status + JSON error body and surface the
    // actual reason instead of the generic 1006 the close/error path would
    // otherwise report. Listening here also suppresses `ws`'s default
    // "Unexpected server response" error emit, so we own the terminal. Body is
    // bounded + the handler always fires terminal (on end, error, or close) so
    // a half-open response can't hang the dial.
    socket.on('unexpected-response', (_req, res) => {
      const statusCode = typeof res.statusCode === 'number' ? res.statusCode : 0;
      const chunks: Buffer[] = [];
      let size = 0;
      const MAX_BODY = 4096;
      res.on('data', (c: Buffer) => {
        if (size < MAX_BODY) {
          chunks.push(c);
          size += c.length;
        }
      });
      const finish = (): void => {
        let errorCode: string | null = null;
        let message: string | null = null;
        try {
          // `relay-routes.ts` jsonError emits a FLAT envelope:
          //   { "error": "<CODE>", "message": "<text>" }
          // (the `error` field IS the code). Tolerate a nested
          // `{ error: { code, message } }` too in case the shape ever changes.
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            error?: unknown;
            message?: unknown;
          };
          if (typeof parsed?.error === 'string') {
            errorCode = parsed.error;
            if (typeof parsed.message === 'string') message = parsed.message;
          } else if (parsed?.error && typeof parsed.error === 'object') {
            const e = parsed.error as { code?: unknown; message?: unknown };
            if (typeof e.code === 'string') errorCode = e.code;
            if (typeof e.message === 'string') message = e.message;
            else if (typeof parsed.message === 'string') message = parsed.message;
          }
        } catch {
          // Non-JSON body (e.g. an HTML error page) — fall back to status-only.
        }
        const { reason, fatal: isFatal } = describeRelayUpgradeRejection(
          statusCode,
          errorCode,
          message,
        );
        fireTerminalOnce(statusCode, reason, isFatal);
      };
      res.on('end', finish);
      res.on('error', finish);
      // `close` covers the finished-or-aborted cases ('aborted' is deprecated
      // in newer Node). `fireTerminalOnce` dedupes, so an end→close pair is safe.
      res.on('close', finish);
    });
  };

  // Kick off the first dial on the next tick so consumers can attach
  // handlers between construction and the first status callback.
  // Without this, a synchronous throw in the WebSocket constructor
  // would call `onStatus` before the caller has wired it up.
  dialPending = true;
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
      // Manual retry clears a fatal classification — the operator presumably
      // fixed the token/origin and wants another dial.
      fatal = false;
      const existing = ws;
      ws = null;
      if (existing && existing.readyState !== existing.CLOSED) {
        try {
          existing.terminate();
        } catch {
          /* ignore */
        }
      }
      // `dialPending` guard collapses back-to-back reconnect() calls:
      // if a dial is already scheduled (microtask or timer), the
      // second reconnect() reuses it instead of stacking another one.
      // Without this, two reconnect() calls in one tick would create
      // overlapping WebSockets — second microtask's dial() would
      // orphan the first's socket.
      if (dialPending) return;
      dialPending = true;
      // queueMicrotask so the caller's status observer sees the
      // 'connecting' transition AFTER they've finished handling the
      // reconnect() call.
      queueMicrotask(() => {
        if (!clientClosed) dial();
      });
    },
    nudge(): void {
      // A backoff nudge from an external "try now" signal (network
      // restored, app foregrounded). Unlike reconnect(), it must never
      // disturb a healthy link or a dial that's already in flight.
      if (clientClosed || fatal) return;
      // Healthy or actively connecting — nothing to accelerate.
      if (currentStatus.state === 'open' || currentStatus.state === 'connecting') return;
      // A dial is already scheduled to fire immediately (microtask path,
      // no backoff timer pending) — let it land instead of stacking.
      if (dialPending && reconnectTimer === null) return;
      // Otherwise we're either parked mid-backoff (timer armed) or
      // exhausted/stranded (no timer). Collapse the wait, reset the
      // ladder to the top, and dial now.
      clearReconnectTimer();
      attempt = 0;
      dialPending = true;
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
