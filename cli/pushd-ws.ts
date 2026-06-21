/**
 * pushd-ws.ts — WebSocket listener for pushd, gated by device-token
 * pairing and Origin matching.
 *
 * Scope (PR 1):
 *  - Loopback-only TCP listener (127.0.0.1, ephemeral or env-pinned port).
 *  - Authenticates every upgrade by `Authorization: Bearer <token>` +
 *    Origin against the token's bound origin.
 *  - Authenticated WS connections feed the same `handleRequest` dispatcher
 *    the Unix socket uses. Wire format on the WS side is NDJSON text
 *    frames, identical envelope shape to the Unix socket.
 *  - Behind PUSHD_WS=1 (gated by the caller in `cli/pushd.ts`).
 *
 * Non-goals (PR 1): non-loopback bind, native/CLI pairing, public relay,
 * token rotation UX. Those are explicit later phases.
 */
import http from 'node:http';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { checkOrigin } from './pushd-origin.js';
import { verifyDeviceToken, touchLastUsed, type DeviceTokenRecord } from './pushd-device-tokens.js';
import { verifyDeviceAttachToken, type AttachTokenRecord } from './pushd-attach-tokens.js';
import { appendAuditEvent } from './pushd-audit-log.js';

/**
 * Per-WS-connection mutable state. Today it tracks in-flight
 * `sandbox_exec` runs so `cancel_run` arriving on the SAME WS can kill
 * the child mid-run (Phase 1.f daemon-side cancel).
 *
 * Scoping by connection — not globally — is deliberate: it guarantees
 * a stolen-runId attempt from a different paired client can't reach
 * across to abort someone else's run, even though the bearer would
 * have authorized either upgrade. The map lives only for the
 * connection's lifetime and is dropped on close.
 *
 * The relay transport breaks the one-connection-per-client assumption:
 * every paired phone shares ONE module-level wsState (`activeRelayWsState`
 * in pushd.ts), so connection-scoping alone can't isolate them. Each run
 * therefore carries the `ownerId` of the phone that started it — the
 * per-connection sender id the relay DO stamps onto every forwarded frame
 * (`RELAY_SENDER_FIELD`), which is the only trustworthy phone identity pushd
 * has. The sessionless `cancel_run` path requires a matching `ownerId` before
 * it will abort an owned run. Runs registered with no owner id (loopback
 * callers, which don't ride the relay) keep the legacy connection-scoped
 * behavior.
 */
export interface ActiveRun {
  controller: AbortController;
  /**
   * Per-phone relay sender id the run was registered under, or null when the
   * run didn't originate from the relay (loopback). A non-null value gates the
   * sessionless cancel path so the relay-shared wsState can't be used to abort
   * across phones.
   */
  ownerId: string | null;
}

export interface PushdWsConnectionState {
  activeRuns: Map<string, ActiveRun>;
}

/**
 * Auth principal carried alongside every WS connection. Phase 3
 * slice 2 introduced two kinds: durable device tokens (the original
 * pairing bearer) and device-attach tokens (short-lived, minted from
 * a parent device token). Both authorize the same operations on the
 * WS surface — the distinction matters only for cascade revoke,
 * provenance, and the `mint_device_attach_token` admin gate (only
 * device-token principals can mint).
 */
export interface PushdWsAuthRecord {
  kind: 'device' | 'attach';
  /** tokenId of the bearer (attach tokenId for kind='attach', else device tokenId). */
  tokenId: string;
  /** Parent device tokenId — same as `tokenId` when kind='device'. Used for cascade. */
  parentDeviceTokenId: string;
  boundOrigin: string;
  /** Best-effort lastUsedAt from the record at upgrade time. */
  lastUsedAt: number | null;
  /**
   * For kind='device', the underlying DeviceTokenRecord — handlers
   * that need the full record (e.g. `daemon_identify`) read it from
   * here. For kind='attach', this is null because the daemon-identify
   * surface intentionally reports the parent device, not the attach
   * tokenId (the attach token rotates; the device identity doesn't).
   */
  deviceRecord: DeviceTokenRecord | null;
}

export interface PushdWsAdapterDeps {
  /**
   * Existing pushd request dispatcher. Same fn the Unix socket uses,
   * extended with an optional `context` arg so WS-only handlers (e.g.
   * `daemon_identify`) can read the authenticated device-token record
   * without leaking transport-specific state into every other handler.
   * Unix-socket callers pass nothing; the dispatcher tolerates absence.
   *
   * Phase 3 slice 2: `auth` is the resolved principal (either a
   * device token or an attach token). `record` stays for back-compat
   * — it's populated only when the connection authenticated with a
   * device token directly. Handlers that need to distinguish (today
   * just `mint_device_attach_token`, which requires device-token
   * provenance) should read `auth.kind`.
   */
  handleRequest: (
    req: unknown,
    emitEvent: (event: unknown) => void,
    context?: {
      record?: DeviceTokenRecord;
      auth?: PushdWsAuthRecord;
      wsState?: PushdWsConnectionState;
      /**
       * Per-phone sender id the relay DO stamped onto the forwarded frame
       * (`RELAY_SENDER_FIELD`). Present only on relay-originated requests;
       * scopes `sandbox_exec` run ownership so a guessed runId from another
       * paired phone can't cancel this phone's run (Audit #3). Absent on
       * loopback, where per-connection `wsState` already isolates runs.
       */
      relaySenderId?: string;
    },
  ) => Promise<unknown>;
  /** Existing add/remove session client hooks. */
  addSessionClient: (
    sessionId: string,
    emit: (event: unknown) => void,
    capabilities: unknown,
  ) => void;
  removeSessionClient: (sessionId: string, emit: (event: unknown) => void) => void;
  /** Helper to build error response envelopes. */
  makeErrorResponse: (requestId: string, type: string, code: string, message: string) => unknown;
  /** Helper to mint request ids for synthesized errors. */
  makeRequestId: () => string;
  /**
   * Optional process-lifecycle hooks. pushd uses these to count local browser
   * clients alongside Unix-socket TUI clients for idle self-exit decisions.
   */
  onClientConnected?: () => void;
  onClientDisconnected?: () => void;
}

export interface PushdWsOptions {
  /** Override port (testing). Default: ephemeral. */
  port?: number;
  /** Override host (testing). Default: 127.0.0.1 — never loosen in prod. */
  host?: string;
  /** Path to write the bound port for `push daemon` clients to discover. */
  portFilePath?: string;
  /** Max bearer-token length accepted in the Authorization header. */
  maxTokenLength?: number;
  /**
   * Liveness heartbeat interval (ms). Default
   * `DEFAULT_HEARTBEAT_INTERVAL_MS`. Set ≤ 0 to disable the heartbeat
   * (no background timer) — tests not exercising half-open detection
   * pass 0; tests that do pass a small value.
   */
  heartbeatIntervalMs?: number;
}

/**
 * Live snapshot of one paired device's connection state, returned by
 * `listConnectedDevices`. Aggregates all open WS connections that
 * authenticated under the same parent device token — a single device
 * may have more than one (e.g. two browser tabs each with their own
 * attach token, plus possibly a direct device-token connection).
 */
export interface ConnectedDeviceRow {
  /** The parent device tokenId (stable identity across attach rotation). */
  tokenId: string;
  boundOrigin: string;
  /** Total live connections for this device (device + attach tokens combined). */
  connections: number;
  /**
   * How many of those connections authenticated via an attach token
   * versus the durable device token directly. Useful for surfaces
   * that want to flag "device token still in use" (= pairing hasn't
   * upgraded to attach yet).
   */
  attachConnections: number;
  deviceConnections: number;
  /** Most recent `lastUsedAt` observed across the connections. */
  lastUsedAt: number | null;
}

export interface PushdWsHandle {
  /** Bound TCP port. */
  port: number;
  /** Stop the listener and close active connections. */
  close: () => Promise<void>;
  /**
   * Snapshot of currently-connected devices, one row per parent
   * device tokenId. Phase 3 `list_devices` handler. Each row
   * aggregates all open WS handles for that device — combining
   * device-token connections and attach-token connections — since
   * one paired device can hold multiple WS handles (different
   * browser tabs, each with its own attach token).
   */
  listConnectedDevices: () => ConnectedDeviceRow[];
  /**
   * Close every open WS connection currently bound to the given
   * device tokenId (whether the connection authenticated with the
   * device token directly OR with an attach token derived from it).
   * Phase 3 slice 2 made this device-scoped so a cascade revoke
   * fans out across attach connections automatically. Returns the
   * count of closed connections; 0 means none were live.
   */
  disconnectByTokenId: (tokenId: string, reason: string) => number;
  /**
   * Close every open WS connection currently authenticated with the
   * given attach tokenId — and ONLY those. Used by
   * `revoke_device_attach_token` so revoking one tab's token
   * doesn't drop the user's other tabs.
   */
  disconnectByAttachTokenId: (attachTokenId: string, reason: string) => number;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MAX_TOKEN_LENGTH = 512;

/**
 * Server-side liveness heartbeat (GOpencode review #2) — the accept-side
 * mirror of the relay client's ping (`RELAY_HEARTBEAT_INTERVAL_MS`).
 * Ping each connection on this interval; terminate any that missed the
 * previous round's pong/traffic. Set ≤ 0 to disable (tests that don't
 * exercise it pass a small value or 0).
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Suspend the heartbeat for a connection whose send buffer exceeds this
 * — a backlog means we're mid-transfer (link up, just slow), so pinging
 * and timing it out would be a false positive. Mirrors the relay
 * client's `RELAY_HEARTBEAT_BUFFER_SUSPEND_BYTES`.
 */
const HEARTBEAT_BUFFER_SUSPEND_BYTES = 64 * 1024;

function getPortFilePath(override?: string): string {
  if (override) return override;
  if (process.env.PUSHD_PORT_PATH) return process.env.PUSHD_PORT_PATH;
  return path.join(os.homedir(), '.push', 'run', 'pushd.port');
}

function parseBearer(authHeader: string | undefined, maxLength: number): string | null {
  if (typeof authHeader !== 'string') return null;
  // RFC 7235: case-insensitive scheme; we still require the canonical
  // "Bearer " spelling in spirit but accept the canonical mixed case too.
  const match = /^Bearer\s+(\S.*)$/i.exec(authHeader.trim());
  if (!match) return null;
  const token = match[1].trim();
  if (token.length === 0 || token.length > maxLength) return null;
  return token;
}

/**
 * Browser WebSocket clients can't set arbitrary headers, so they
 * can't use the Authorization header path. Carry the bearer in
 * `Sec-WebSocket-Protocol` instead, alongside the canonical
 * `pushd.v1` protocol selector. Format the client sends:
 *
 *   Sec-WebSocket-Protocol: pushd.v1, bearer.<token>
 *
 * The server picks `pushd.v1` to echo back (which the browser uses
 * to confirm the upgrade) and validates the `bearer.` entry as the
 * token. Order doesn't matter; whitespace around commas is allowed.
 */
const SUBPROTOCOL_SELECTOR = 'pushd.v1';
const SUBPROTOCOL_BEARER_PREFIX = 'bearer.';

function parseSubprotocolBearer(
  subprotoHeader: string | undefined,
  maxLength: number,
): string | null {
  if (typeof subprotoHeader !== 'string') return null;
  const protocols = subprotoHeader
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  let selectorPresent = false;
  let token: string | null = null;
  for (const proto of protocols) {
    if (proto === SUBPROTOCOL_SELECTOR) {
      selectorPresent = true;
      continue;
    }
    if (proto.startsWith(SUBPROTOCOL_BEARER_PREFIX)) {
      const candidate = proto.slice(SUBPROTOCOL_BEARER_PREFIX.length);
      if (candidate.length > 0 && candidate.length <= maxLength) {
        token = candidate;
      }
    }
  }
  // Require BOTH: the protocol selector (so we know we're talking
  // pushd.v1) AND the bearer entry. Either alone is malformed.
  return selectorPresent ? token : null;
}

function writeUpgradeError(socket: Duplex, status: number, reason: string): void {
  // Never include the bearer token in the response body, even on
  // failure. The `reason` is shaped by `checkOrigin` / our own short
  // strings — both guaranteed not to contain token material.
  const statusText: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
  };
  const headLine = `HTTP/1.1 ${status} ${statusText[status] ?? 'Error'}`;
  const body = `${reason}\n`;
  socket.write(
    `${headLine}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n` +
      'Connection: close\r\n' +
      '\r\n' +
      body,
  );
  // socket.end() flushes the buffered HTTP response before closing;
  // socket.destroy() can drop the body on the floor if the kernel
  // hasn't drained it yet.
  socket.end();
}

/**
 * Start the WS listener and route authenticated connections to
 * `deps.handleRequest`. Returns a handle for shutdown.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export async function startPushdWs(
  deps: PushdWsAdapterDeps,
  options: PushdWsOptions = {},
): Promise<PushdWsHandle> {
  const host = options.host ?? DEFAULT_HOST;
  // PR 1 policy is loopback-only. The `host` override exists for tests
  // that need to pin a specific loopback form (IPv4 vs IPv6); reject
  // anything that would expose the listener on LAN.
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`pushd-ws refuses non-loopback host: ${host}`);
  }
  const maxTokenLength = options.maxTokenLength ?? DEFAULT_MAX_TOKEN_LENGTH;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const portFilePath = getPortFilePath(options.portFilePath);

  // The HTTP server is only used as a transport for WS upgrades. Any
  // non-upgrade request is refused — pushd is not an HTTP server.
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain', Connection: 'close' });
    res.end('Upgrade Required: pushd accepts WebSocket connections only.\n');
  });

  // noServer mode: we handle the upgrade event ourselves so we can run
  // the auth gate before WSS sees the connection. `handleProtocols`
  // tells ws which Sec-WebSocket-Protocol entry to echo in the
  // response — we always pick `pushd.v1` if the client offered it,
  // so the browser's WebSocket constructor sees its requested
  // protocol confirmed and the upgrade completes. The `bearer.*`
  // entry is intentionally never selected — it carries the token,
  // not a protocol identity, and must not be echoed back.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    handleProtocols: (protocols) =>
      protocols.has(SUBPROTOCOL_SELECTOR) ? SUBPROTOCOL_SELECTOR : false,
  });

  // Phase 3 connection registry. Slice 1 keyed entries by device
  // tokenId; slice 2 introduces attach tokens, so the registry now
  // tracks each connection's full `PushdWsAuthRecord` and indexes
  // by `parentDeviceTokenId` for cascade-revoke and the connected-
  // devices view. The map is updated synchronously on connection /
  // close — there's no async race with the auth check above because
  // both run on the same event-loop tick as the WS upgrade.
  interface ConnectionRegistryEntry {
    ws: WebSocket;
    auth: PushdWsAuthRecord;
  }
  // Keyed by the parent device tokenId. Multiple connections from
  // the same device (each using its own attach token, plus possibly
  // one direct device-token connection) collapse into one bucket so
  // a single-device revoke can fan out cleanly.
  const connectionsByDeviceTokenId = new Map<string, Set<ConnectionRegistryEntry>>();

  // Server-side liveness heartbeat (GOpencode review #2). A paired phone
  // that vanishes on a flaky network leaves its WS half-open — no close
  // frame ever arrives, so the per-connection `cleanup()` (which aborts
  // in-flight sandbox_exec runs and deregisters session clients) would
  // otherwise wait on a TCP timeout. Ping each open connection on an
  // interval and terminate any that missed the previous round's
  // pong/traffic; the terminate synthesizes the close the network never
  // delivered, and the existing close handler runs cleanup promptly.
  //
  // Liveness is tracked per-connection in a map keyed by the socket and
  // mutated by the `pong` handler / message handler (any inbound frame
  // proves the peer is alive). The entry is deleted in `cleanup`.
  const heartbeatLiveness = new Map<WebSocket, { alive: boolean; deviceId: string }>();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  if (heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      for (const ws of wss.clients) {
        const liveness = heartbeatLiveness.get(ws);
        if (!liveness) continue;
        if (ws.readyState !== ws.OPEN) continue;
        // Mid-transfer backlog: link is up but slow. Treat as alive and
        // skip this round rather than risk a false-positive kill.
        if (ws.bufferedAmount > HEARTBEAT_BUFFER_SUSPEND_BYTES) {
          liveness.alive = true;
          continue;
        }
        if (!liveness.alive) {
          // No pong/traffic since the previous tick → half-open. The
          // event name calls out the cause so ops can grep heartbeat
          // kills apart from peer-initiated closes; never logs token
          // material (deviceId is the parent device tokenId, already
          // emitted in the auth.upgrade audit event).
          process.stderr.write(
            `${JSON.stringify({ level: 'warn', event: 'pushd_ws_heartbeat_half_open', deviceId: liveness.deviceId })}\n`,
          );
          try {
            ws.terminate();
          } catch {
            // best-effort — the close handler still runs cleanup
          }
          continue;
        }
        liveness.alive = false;
        try {
          ws.ping();
        } catch {
          // best-effort; a failed ping surfaces as a missed pong next round
        }
      }
    }, heartbeatIntervalMs);
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  }

  httpServer.on('upgrade', async (req, socket, head) => {
    try {
      const rawOrigin = req.headers.origin as string | undefined;
      const authHeader = req.headers.authorization as string | undefined;
      const subprotoHeader = req.headers['sec-websocket-protocol'] as string | undefined;

      // Prefer the Authorization header (CLI / wscat path); fall back
      // to the Sec-WebSocket-Protocol carrier for browser clients
      // which can't set arbitrary headers on a WebSocket. Whichever
      // path matched determines whether we need to echo a confirmed
      // subprotocol back in the upgrade response.
      const token =
        parseBearer(authHeader, maxTokenLength) ??
        parseSubprotocolBearer(subprotoHeader, maxTokenLength);
      if (!token) {
        return writeUpgradeError(socket, 401, 'Missing or malformed bearer token.');
      }

      // Phase 3 slice 2: WS upgrade accepts either a device-attach
      // token (the expected post-pairing case) or a durable device
      // token (the pairing-time case + CLI tooling). Try attach
      // first because:
      //   1. After pairing, the web client stops sending the device
      //      token entirely — virtually every browser-driven upgrade
      //      bears an attach token, so the common path checks attach
      //      first.
      //   2. The two token kinds use distinct prefixes (`pushd_da_`
      //      vs `pushd_`) and each verify short-circuits on the
      //      wrong prefix, so the fallback is cheap when the token
      //      is actually a device token.
      let auth: PushdWsAuthRecord | null = null;
      try {
        const attachRecord: AttachTokenRecord | null = await verifyDeviceAttachToken(token);
        if (attachRecord) {
          auth = {
            kind: 'attach',
            tokenId: attachRecord.tokenId,
            parentDeviceTokenId: attachRecord.parentTokenId,
            boundOrigin: String(attachRecord.boundOrigin),
            lastUsedAt: attachRecord.lastUsedAt,
            deviceRecord: null,
          };
        } else {
          const deviceRecord: DeviceTokenRecord | null = await verifyDeviceToken(token);
          if (deviceRecord) {
            auth = {
              kind: 'device',
              tokenId: deviceRecord.tokenId,
              parentDeviceTokenId: deviceRecord.tokenId,
              boundOrigin: String(deviceRecord.boundOrigin),
              lastUsedAt: deviceRecord.lastUsedAt,
              deviceRecord,
            };
          }
        }
      } catch {
        return writeUpgradeError(socket, 401, 'Token verification failed.');
      }
      if (!auth) {
        // Identical error string regardless of which kind of token
        // the caller intended — a probing attacker can't distinguish
        // "wrong device token" from "expired attach token" from
        // "malformed string".
        return writeUpgradeError(socket, 401, 'Missing or malformed bearer token.');
      }

      const originCheck = checkOrigin(rawOrigin, auth.boundOrigin);
      if (!originCheck.ok) {
        return writeUpgradeError(socket, 403, originCheck.reason);
      }

      // `handleProtocols` on the WSS constructor handles subprotocol
      // echo in the upgrade response — we don't need to inject
      // headers manually here.
      const resolvedAuth = auth;
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, resolvedAuth);
      });
    } catch (err) {
      // Anything unexpected in the auth path: refuse, do not leak.
      try {
        writeUpgradeError(socket, 400, 'Upgrade failed.');
      } catch {
        socket.destroy();
      }
    }
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, auth: PushdWsAuthRecord) => {
    deps.onClientConnected?.();

    // Touch lastUsedAt on the device-token record best-effort. For
    // attach-token principals we ALSO touch the parent device so
    // listing it shows "this device was active recently" even when
    // every connection currently uses attach tokens. For attach
    // tokens themselves, `verifyDeviceAttachToken` already refreshed
    // lastUsedAt during the auth check above, so no extra write is
    // needed here.
    touchLastUsed(auth.parentDeviceTokenId).catch(() => {});

    // Phase 3 slice 3: emit an `auth.upgrade` audit event so the
    // operator's view of "who connected and when" matches the live
    // connection registry. Fire-and-forget; audit failures never
    // block the WS lifecycle.
    void appendAuditEvent({
      type: 'auth.upgrade',
      surface: 'ws',
      deviceId: auth.parentDeviceTokenId,
      attachTokenId: auth.kind === 'attach' ? auth.tokenId : undefined,
      authKind: auth.kind,
      payload: { boundOrigin: auth.boundOrigin },
    });

    // Register this connection. Phase 3 slice 2: indexed by parent
    // device tokenId so a single-device cascade revoke can find every
    // child attach connection too.
    const registryEntry: ConnectionRegistryEntry = { ws, auth };
    let bucket = connectionsByDeviceTokenId.get(auth.parentDeviceTokenId);
    if (!bucket) {
      bucket = new Set();
      connectionsByDeviceTokenId.set(auth.parentDeviceTokenId, bucket);
    }
    bucket.add(registryEntry);

    // Register heartbeat liveness for this connection. Any pong proves
    // the peer is alive; so does any inbound data frame (marked in the
    // message handler below), so a chatty client stays certified even
    // if it never pongs specifically.
    const liveness = { alive: true, deviceId: auth.parentDeviceTokenId };
    heartbeatLiveness.set(ws, liveness);
    ws.on('pong', () => {
      liveness.alive = true;
    });

    const attachedSessions = new Set<string>();
    // Per-connection state plumbed into every handler via the dispatcher
    // context. Today: in-flight sandbox_exec AbortControllers so cancel_run
    // on this connection can interrupt them. Cleaned up on ws close.
    const wsState: PushdWsConnectionState = { activeRuns: new Map() };
    let capabilities: unknown = null;

    const emit = (event: unknown) => {
      if (ws.readyState !== ws.OPEN) return;
      try {
        // Append a trailing newline so a client reusing the Unix-socket
        // NDJSON decoder over WS still sees a frame-terminator. WS
        // framing carries the boundary on its own, but matching the
        // Unix-socket wire keeps both transports decoder-compatible.
        ws.send(`${JSON.stringify(event)}\n`);
      } catch {
        // connection may be closing
      }
    };

    ws.on('message', async (data, isBinary) => {
      // Inbound traffic proves the peer is alive — credit the heartbeat
      // so a busy connection isn't reaped between pings.
      liveness.alive = true;
      if (isBinary) {
        // Mirror Unix-socket behaviour: text/NDJSON only.
        emit(
          deps.makeErrorResponse(
            deps.makeRequestId(),
            'unknown',
            'INVALID_REQUEST',
            'Binary frames are not accepted.',
          ),
        );
        return;
      }
      const text = data.toString('utf8');
      // Each text frame should carry one JSON envelope. Splitting on \n
      // matches the Unix-socket parser so clients with a single shared
      // encoder don't need a separate WS path.
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const req = JSON.parse(trimmed) as {
            type?: string;
            sessionId?: string;
            payload?: { sessionId?: string; capabilities?: unknown };
          };
          if (
            capabilities === null &&
            req.payload &&
            Array.isArray((req.payload as { capabilities?: unknown }).capabilities)
          ) {
            capabilities = (req.payload as { capabilities?: unknown }).capabilities;
          }
          // Pass the authenticated principal + the device record (when
          // available) so daemon_identify and `mint_device_attach_token`
          // can answer without WS-specific state leaking into the
          // dispatcher. `wsState` carries per-connection mutable state
          // (e.g. the active-runs map for daemon-side mid-run cancel).
          // `record` is preserved for back-compat — handlers that only
          // ever ran over a device-token-authed WS still read it.
          const response = (await deps.handleRequest(req, emit, {
            record: auth.deviceRecord ?? undefined,
            auth,
            wsState,
          })) as {
            ok?: boolean;
            sessionId?: string;
            payload?: { sessionId?: string };
          };
          emit(response);

          if (req.type === 'attach_session' && response?.ok) {
            const sid = req.payload?.sessionId;
            if (sid) attachedSessions.add(sid);
          }
          if ((req.type === 'start_session' || req.type === 'send_user_message') && response?.ok) {
            const sid =
              response.sessionId ||
              response.payload?.sessionId ||
              req.sessionId ||
              req.payload?.sessionId;
            if (sid) {
              deps.addSessionClient(sid, emit, capabilities);
              attachedSessions.add(sid);
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'parse error';
          emit(
            deps.makeErrorResponse(
              deps.makeRequestId(),
              'unknown',
              'INVALID_REQUEST',
              `Failed to parse request: ${message}`,
            ),
          );
        }
      }
    });

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      for (const sid of attachedSessions) deps.removeSessionClient(sid, emit);
      attachedSessions.clear();
      // Abort any in-flight sandbox_exec runs tied to this connection.
      // Without this, a client that drops mid-run leaves the child
      // burning CPU/disk until its 60s timeout fires. The signal lets
      // `runCommandInResolvedShell` SIGTERM the child cleanly.
      for (const run of wsState.activeRuns.values()) {
        try {
          run.controller.abort();
        } catch {
          /* ignore */
        }
      }
      wsState.activeRuns.clear();
      // Drop heartbeat liveness for this socket so a terminated/closed
      // connection isn't re-pinged on the next interval tick.
      heartbeatLiveness.delete(ws);
      // Deregister from the parent-device bucket. If this was the
      // last connection for the device, drop the (now empty) bucket
      // so `listConnectedDevices` doesn't surface stale zero-rows.
      const reg = connectionsByDeviceTokenId.get(auth.parentDeviceTokenId);
      if (reg) {
        reg.delete(registryEntry);
        if (reg.size === 0) connectionsByDeviceTokenId.delete(auth.parentDeviceTokenId);
      }
      deps.onClientDisconnected?.();
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  return new Promise<PushdWsHandle>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? 0, host, async () => {
      httpServer.off('error', reject);
      const address = httpServer.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      // Persist the bound port so `push daemon` clients can find it
      // without needing to be told. Best-effort: if the dir doesn't
      // exist yet, the daemon's normal startup path will create it.
      try {
        await fs.mkdir(path.dirname(portFilePath), { recursive: true, mode: 0o700 });
        const handle = await fs.open(portFilePath, 'w', 0o600);
        try {
          await handle.writeFile(`${port}\n`, 'utf8');
          await handle.chmod(0o600);
        } finally {
          await handle.close();
        }
      } catch {
        // non-fatal
      }

      resolve({
        port,
        close: () =>
          new Promise<void>((resolveClose) => {
            if (heartbeatTimer !== null) {
              clearInterval(heartbeatTimer);
              heartbeatTimer = null;
            }
            for (const client of wss.clients) {
              try {
                client.close(1001, 'pushd shutting down');
              } catch {
                /* ignore */
              }
            }
            wss.close(() => {
              httpServer.close(() => {
                fs.unlink(portFilePath).catch(() => {});
                resolveClose();
              });
            });
          }),
        listConnectedDevices: () => {
          const rows: ConnectedDeviceRow[] = [];
          for (const [parentTokenId, bucket] of connectionsByDeviceTokenId) {
            // All entries in a bucket share a parent device, so the
            // boundOrigin is identical across entries. Mix `attach` /
            // `device` counts so the CLI can show "1 attach, 1 device"
            // (a device that hasn't finished the pairing upgrade yet).
            let attachCount = 0;
            let deviceCount = 0;
            let maxLastUsed: number | null = null;
            let boundOrigin = '';
            for (const entry of bucket) {
              if (entry.auth.kind === 'attach') attachCount += 1;
              else deviceCount += 1;
              boundOrigin = entry.auth.boundOrigin;
              if (entry.auth.lastUsedAt !== null) {
                if (maxLastUsed === null || entry.auth.lastUsedAt > maxLastUsed) {
                  maxLastUsed = entry.auth.lastUsedAt;
                }
              }
            }
            rows.push({
              tokenId: parentTokenId,
              boundOrigin,
              connections: bucket.size,
              attachConnections: attachCount,
              deviceConnections: deviceCount,
              lastUsedAt: maxLastUsed,
            });
          }
          rows.sort((a, b) => a.tokenId.localeCompare(b.tokenId));
          return rows;
        },
        disconnectByTokenId: (tokenId: string, reason: string) => {
          // Phase 3 slice 2: `tokenId` is interpreted as the parent
          // DEVICE tokenId, so a cascade revoke (`revoke_device_token`)
          // can disconnect every attach-token-authed child too.
          const bucket = connectionsByDeviceTokenId.get(tokenId);
          if (!bucket) return 0;
          let closed = 0;
          for (const entry of bucket) {
            try {
              // Code 1008 = "policy violation", the canonical close
              // code for "server rejects this connection on policy
              // grounds." Mirrors the close code an authenticated
              // server uses to terminate sessions after a permission
              // change.
              entry.ws.close(1008, reason);
              closed += 1;
            } catch {
              /* ignore — the close cleanup will deregister anyway */
            }
          }
          return closed;
        },
        disconnectByAttachTokenId: (attachTokenId: string, reason: string) => {
          // Walk every bucket but close only the entries whose
          // auth.tokenId matches AND whose kind is 'attach'. This is
          // the narrow surface for `revoke_device_attach_token` — it
          // must NOT also close other attach tokens or the parent
          // device token's direct connection.
          let closed = 0;
          for (const bucket of connectionsByDeviceTokenId.values()) {
            for (const entry of bucket) {
              if (entry.auth.kind === 'attach' && entry.auth.tokenId === attachTokenId) {
                try {
                  entry.ws.close(1008, reason);
                  closed += 1;
                } catch {
                  /* ignore */
                }
              }
            }
          }
          return closed;
        },
      });
    });
  });
}
