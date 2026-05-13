/**
 * relay-daemon-binding.ts — Web-side WebSocket adapter for a phone
 * dialling pushd through the Worker-mediated relay. Phase 2.f sibling
 * to `local-daemon-binding.ts`.
 *
 * Transport differences from the loopback adapter:
 *
 *   - Target URL is `wss://<deploymentUrl>/api/relay/v1/session/
 *     <sessionId>/connect` (the Worker relay route from 2.b).
 *     `deploymentUrl` is the Worker base URL the operator configured
 *     via `push daemon relay enable`; `sessionId` is the opaque
 *     routing key pushd picked and shared in the pair bundle.
 *
 *   - Bearer rides `Sec-WebSocket-Protocol: push.relay.v1,
 *     bearer.<attachToken>`. The attach token is `pushd_da_*` from
 *     the pair bundle, NOT the operator's `pushd_relay_*`.
 *
 *   - After `open`, the adapter sends a single `relay_attach` envelope
 *     carrying the caller's `lastSeq` so the DO can replay buffered
 *     pushd → phone events (2.d.2). The DO either replays in seq
 *     order or emits `relay_replay_unavailable` if the gap is
 *     bigger than the buffer.
 *
 *   - Non-loopback by definition. The hostname guard from the
 *     loopback adapter (`LOOPBACK_HOSTS`) is reversed: the relay
 *     adapter REFUSES loopback hosts to keep an operator from
 *     pointing it at a local stub and silently shipping with a
 *     misconfigured deploymentUrl. Tests bypass via the
 *     `allowAnyHost` option.
 *
 * Returns a `LocalDaemonBinding` (the same adapter type Phase 1
 * exports). The chat round-loop already plumbs that interface; the
 * binding shape is intentionally transport-agnostic.
 */
import {
  PROTOCOL_VERSION,
  isRelayEnvelope,
  validateEventEnvelope,
  validateRelayEnvelope,
} from '@push/lib/protocol-schema';
import {
  DaemonRequestError,
  type ConnectionStatus,
  type LocalDaemonBinding,
  type RequestOptions,
  type SessionEvent,
  type SessionResponse,
} from './local-daemon-binding';

const SUBPROTOCOL_SELECTOR = 'push.relay.v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export interface RelayDaemonBindingOptions {
  /**
   * Worker deployment base URL. Accepts `http(s)://` or `ws(s)://`;
   * http(s) is rewritten to ws(s) at dial time. Trailing slashes
   * trimmed.
   */
  deploymentUrl: string;
  /** Opaque routing key chosen by pushd; shared via the pair bundle. */
  sessionId: string;
  /**
   * Attach-token bearer, `pushd_da_*`. Carried in
   * `Sec-WebSocket-Protocol`. Held only in this closure + the
   * `protocols` array.
   */
  token: string;
  /**
   * Sent in the `relay_attach` envelope right after the WS opens.
   * Omit (or pass `null`) for a fresh attach with no replay.
   */
  lastSeq?: number | null;
  /** Called on every status transition (same shape as loopback). */
  onStatus?: (status: ConnectionStatus) => void;
  /** Called once per validated incoming event envelope. */
  onEvent?: (event: SessionEvent) => void;
  /**
   * Called when the relay tells us replay isn't possible (gap >
   * buffer). The consumer should fall back to `attach_session` to
   * fetch current state. The reason string is the human-readable
   * payload from the relay; UI may show a brief signal.
   */
  onReplayUnavailable?: (reason: string) => void;
  /** Called when a malformed payload arrives (same shape as loopback). */
  onMalformed?: (raw: string, reason: string) => void;
  /**
   * Test seam. The adapter normally refuses loopback hosts (the
   * relay is by definition non-loopback). Tests against a local
   * stub flip this on.
   */
  allowAnyHost?: boolean;
}

function makeRequestId(): string {
  const buf = new Uint8Array(4);
  globalThis.crypto.getRandomValues(buf);
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  return `req_${Date.now().toString(36)}_${hex}`;
}

interface PendingRequest {
  resolve: (response: SessionResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  type: string;
}

function buildRelayUrl(deploymentUrl: string, sessionId: string): string {
  let base = deploymentUrl.replace(/\/+$/, '');
  if (base.startsWith('https://')) base = `wss://${base.slice('https://'.length)}`;
  else if (base.startsWith('http://')) base = `ws://${base.slice('http://'.length)}`;
  return `${base}/api/relay/v1/session/${encodeURIComponent(sessionId)}/connect`;
}

function extractHost(deploymentUrl: string): string | null {
  try {
    const url = new URL(
      deploymentUrl.startsWith('ws://') || deploymentUrl.startsWith('wss://')
        ? deploymentUrl.replace(/^ws/, 'http')
        : deploymentUrl,
    );
    return url.hostname;
  } catch {
    return null;
  }
}

export function createRelayDaemonBinding(opts: RelayDaemonBindingOptions): LocalDaemonBinding {
  if (!opts.allowAnyHost) {
    const host = extractHost(opts.deploymentUrl);
    if (host !== null && LOOPBACK_HOSTS.has(host)) {
      throw new Error(`relay-daemon-binding refuses loopback host: ${host}`);
    }
  }
  const url = buildRelayUrl(opts.deploymentUrl, opts.sessionId);
  const protocols = [SUBPROTOCOL_SELECTOR, `bearer.${opts.token}`];

  let status: ConnectionStatus = { state: 'connecting' };
  let everOpened = false;
  let clientClosed = false;
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
    // Send the `relay_attach` envelope so the DO can replay buffered
    // pushd → phone events after our last-seen `seq`. Browser
    // `WebSocket` can't set custom upgrade headers, so connection
    // state rides in-band — same constraint as Phase 1's bearer.
    // A `lastSeq` of null/undefined is a fresh attach with no
    // replay; the DO treats it as starting from zero.
    const attachEnvelope: Record<string, unknown> = {
      v: PROTOCOL_VERSION,
      kind: 'relay_attach',
      ts: Date.now(),
    };
    if (typeof opts.lastSeq === 'number' && Number.isFinite(opts.lastSeq) && opts.lastSeq >= 0) {
      attachEnvelope.lastSeq = opts.lastSeq;
    }
    try {
      ws.send(`${JSON.stringify(attachEnvelope)}\n`);
    } catch {
      // If the send fails the close handler will fire — no
      // additional path needed here.
    }
  });

  ws.addEventListener('message', (ev: MessageEvent) => {
    const raw = typeof ev.data === 'string' ? ev.data : '';
    if (!raw) {
      opts.onMalformed?.('', 'expected string frame');
      return;
    }
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
        opts.onMalformed?.(trimmed, 'unsupported protocol version');
        continue;
      }
      // Relay-control envelopes (2.d.1 vocab): only
      // `relay_replay_unavailable` is consumed by the client. Other
      // relay-control kinds are server-side bookkeeping (allow /
      // revoke / attach are pushd → relay or phone → relay) and
      // should never reach a phone client; we drop them silently
      // rather than surface as malformed since a future protocol
      // extension might add new server → client kinds.
      if (isRelayEnvelope(parsed)) {
        const issues = validateRelayEnvelope(parsed);
        if (issues.length > 0) {
          opts.onMalformed?.(trimmed, `relay envelope validation failed: ${issues[0].message}`);
          continue;
        }
        const env = parsed as { kind: string; reason?: string };
        if (env.kind === 'relay_replay_unavailable') {
          try {
            opts.onReplayUnavailable?.(env.reason ?? 'replay unavailable');
          } catch {
            // see setStatus
          }
        }
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
        if (!entry) continue;
        pending.delete(reqId);
        clearTimeout(entry.timer);
        if (response.ok) {
          entry.resolve(response);
        } else {
          const err = response.error;
          entry.reject(
            new DaemonRequestError({
              code: err?.code ?? 'UNKNOWN',
              message: err?.message ?? `${entry.type} failed`,
              retryable: err?.retryable ?? false,
            }),
          );
        }
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
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`connection closed before response (code=${code})`));
    }
    pending.clear();
    if (!everOpened && !clientClosed) {
      setStatus({
        state: 'unreachable',
        code,
        reason: reason || 'connection closed before open',
      });
    } else {
      setStatus({ state: 'closed', code, reason });
    }
  };

  let terminalFired = false;
  const fireTerminalOnce = (code: number, reason: string): void => {
    if (terminalFired) return;
    terminalFired = true;
    onTerminal(code, reason);
  };
  ws.addEventListener('close', (ev: CloseEvent) => fireTerminalOnce(ev.code, ev.reason));
  ws.addEventListener('error', () => {
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
        type: reqOpts.type,
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
    clientClosed = true;
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
