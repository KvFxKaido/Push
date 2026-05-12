/**
 * local-daemon-binding.ts — Web-side WebSocket adapter for a paired
 * pushd. PR 3a of the remote-sessions track.
 *
 * Talks to a loopback pushd over the same NDJSON envelope shape the
 * Unix socket uses, but on a `ws://127.0.0.1:<port>` connection
 * gated by the subprotocol auth flow added in `cli/pushd-ws.ts`.
 *
 * Auth: bearer is carried in `Sec-WebSocket-Protocol` because the
 * browser WebSocket constructor can't set an Authorization header.
 * Format: `pushd.v1, bearer.<token>`. The server picks `pushd.v1`
 * and validates the `bearer.` entry.
 *
 * Scope (PR 3a): adapter + status surface only. No UI, no pairing
 * flow, no token storage. PR 3b wires this into the Workspace Hub.
 */
import { PROTOCOL_VERSION, validateEventEnvelope } from '@push/lib/protocol-schema';

const SUBPROTOCOL_SELECTOR = 'pushd.v1';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Mirror of the wire envelope shape from `lib/protocol-schema.ts`. */
export interface SessionEvent {
  v: string;
  kind: 'event';
  sessionId: string;
  runId?: string;
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
}

export interface SessionResponse<T = unknown> {
  v: string;
  kind: 'response';
  requestId: string;
  type: string;
  sessionId: string | null;
  ok: boolean;
  payload: T;
  error: { code: string; message: string; retryable?: boolean } | null;
}

export type ConnectionStatus =
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'auth-failed'; reason: string }
  | { state: 'closed'; code: number; reason: string };

export interface LocalDaemonBindingOptions {
  port: number;
  token: string;
  /** Defaults to 127.0.0.1. Browsers refuse non-loopback https→ws anyway. */
  host?: string;
  /** Called on every status transition. */
  onStatus?: (status: ConnectionStatus) => void;
  /** Called once per validated incoming event envelope. */
  onEvent?: (event: SessionEvent) => void;
  /**
   * Called when the adapter receives a malformed payload. Default
   * behaviour is to swallow it (the connection stays open) — the hook
   * lets the consumer surface it for diagnostics.
   */
  onMalformed?: (raw: string, reason: string) => void;
}

export interface RequestOptions {
  type: string;
  payload?: Record<string, unknown>;
  sessionId?: string;
  timeoutMs?: number;
}

export interface LocalDaemonBinding {
  readonly status: ConnectionStatus;
  /**
   * Send a request envelope. Resolves with the response payload, or
   * rejects on error, timeout, or connection close.
   */
  request<T = unknown>(opts: RequestOptions): Promise<SessionResponse<T>>;
  /** Close the connection. Idempotent. */
  close(): void;
}

interface PendingRequest {
  resolve: (response: SessionResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function makeRequestId(): string {
  // crypto.getRandomValues is available in modern browsers and Node.
  const buf = new Uint8Array(4);
  globalThis.crypto.getRandomValues(buf);
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  return `req_${Date.now().toString(36)}_${hex}`;
}

export function createLocalDaemonBinding(opts: LocalDaemonBindingOptions): LocalDaemonBinding {
  const host = opts.host ?? DEFAULT_HOST;
  const url = `ws://${host}:${opts.port}`;
  const protocols = [SUBPROTOCOL_SELECTOR, `bearer.${opts.token}`];

  let status: ConnectionStatus = { state: 'connecting' };
  // Tracks whether the connection ever opened. Lets us tell an
  // upgrade-time auth rejection (browser closes with 1006 before any
  // frame is received) apart from a mid-session drop. Browsers
  // intentionally hide the HTTP status of a failed WS upgrade from
  // JS, so this is the only signal we have.
  let everOpened = false;
  const pending = new Map<string, PendingRequest>();

  const setStatus = (next: ConnectionStatus): void => {
    status = next;
    try {
      opts.onStatus?.(next);
    } catch {
      // Consumer hooks must not crash the adapter.
    }
  };

  const ws = new WebSocket(url, protocols);

  ws.addEventListener('open', () => {
    everOpened = true;
    setStatus({ state: 'open' });
  });

  ws.addEventListener('message', (ev: MessageEvent) => {
    const raw = typeof ev.data === 'string' ? ev.data : '';
    if (!raw) {
      opts.onMalformed?.('', 'expected string frame');
      return;
    }
    // Server appends a trailing newline; split on \n so a frame
    // carrying multiple envelopes (defensive, server doesn't batch
    // today) is handled the same way as the Unix-socket NDJSON path.
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        opts.onMalformed?.(trimmed, 'JSON parse failed');
        continue;
      }
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        (parsed as { v?: unknown }).v !== PROTOCOL_VERSION
      ) {
        opts.onMalformed?.(trimmed, `unsupported protocol version`);
        continue;
      }
      const envelope = parsed as { kind?: unknown };
      if (envelope.kind === 'response') {
        const response = envelope as unknown as SessionResponse;
        const reqId = typeof response.requestId === 'string' ? response.requestId : null;
        if (!reqId) {
          opts.onMalformed?.(trimmed, 'response missing requestId');
          continue;
        }
        const entry = pending.get(reqId);
        if (!entry) continue; // late response after timeout — drop
        pending.delete(reqId);
        clearTimeout(entry.timer);
        entry.resolve(response);
      } else if (envelope.kind === 'event') {
        const issues = validateEventEnvelope(parsed);
        if (issues.length > 0) {
          opts.onMalformed?.(trimmed, `envelope validation failed: ${issues[0].message}`);
          continue;
        }
        try {
          opts.onEvent?.(parsed as SessionEvent);
        } catch {
          // see setStatus
        }
      } else {
        opts.onMalformed?.(trimmed, 'unknown envelope kind');
      }
    }
  });

  const onTerminal = (code: number, reason: string): void => {
    // Reject every pending request — the connection is gone.
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`connection closed before response (code=${code})`));
    }
    pending.clear();
    if (!everOpened) {
      // Closed before any frame was received → almost certainly an
      // upgrade-time rejection (bad token, wrong origin, daemon
      // refused). Surface as auth-failed so the UI can prompt
      // re-pair rather than retrying blindly.
      setStatus({
        state: 'auth-failed',
        reason: reason || 'upgrade rejected before any frame',
      });
    } else {
      setStatus({ state: 'closed', code, reason });
    }
  };

  let terminalFired = false;
  const fireTerminalOnce = (code: number, reason: string) => {
    if (terminalFired) return;
    terminalFired = true;
    onTerminal(code, reason);
  };
  ws.addEventListener('close', (ev: CloseEvent) => fireTerminalOnce(ev.code, ev.reason));
  ws.addEventListener('error', () => {
    // The 'error' event on WebSocket carries no detail in browsers
    // (security feature). Most implementations also fire 'close'
    // afterwards, which is where we'd normally extract code/reason
    // — but some runtimes (Node's undici WebSocket on a rejected
    // upgrade) only fire 'error'. Treat error-without-open as
    // terminal so the status doesn't hang in 'connecting' forever.
    fireTerminalOnce(1006, 'connection error');
  });

  const request = <T = unknown>(reqOpts: RequestOptions): Promise<SessionResponse<T>> => {
    return new Promise<SessionResponse<T>>((resolve, reject) => {
      if (status.state !== 'open') {
        reject(new Error(`not open (state=${status.state})`));
        return;
      }
      const requestId = makeRequestId();
      const envelope = {
        v: PROTOCOL_VERSION,
        kind: 'request' as const,
        requestId,
        type: reqOpts.type,
        sessionId: reqOpts.sessionId ?? null,
        payload: reqOpts.payload ?? {},
      };
      const timeoutMs = reqOpts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`request ${reqOpts.type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(requestId, {
        resolve: resolve as (response: SessionResponse) => void,
        reject,
        timer,
      });
      try {
        ws.send(`${JSON.stringify(envelope)}\n`);
      } catch (err) {
        pending.delete(requestId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  const close = (): void => {
    if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) return;
    try {
      ws.close(1000, 'client closing');
    } catch {
      // ignore — terminal handler will still fire
    }
  };

  return {
    get status() {
      return status;
    },
    request,
    close,
  };
}
