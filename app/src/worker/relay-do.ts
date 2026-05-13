/**
 * Remote Sessions relay — per-session Durable Object.
 *
 * Phase 2.b scaffold landed the WS accept; 2.c added bearer auth +
 * role-aware byte forwarding; 2.d.1 (this slice) adds:
 *
 *   - Envelope parsing on every incoming text frame. The relay reads
 *     just enough of `lib/protocol-schema.ts` to identify relay-
 *     control envelopes (`relay_phone_allow`, `relay_phone_revoke`)
 *     and consume them in-band. Everything else is forwarded
 *     unchanged — the relay stays dumb about provider routing, tool
 *     semantics, branch state, and approval policy (per the decision
 *     doc's Implementation Rules).
 *
 *   - Per-session allowlist of phone bearer tokens. The DO maintains
 *     `Set<phoneBearer>` updated by pushd's `relay_phone_allow` /
 *     `relay_phone_revoke` envelopes. pushd → phone forwarding is
 *     gated on the receiving phone's bearer being in the allowlist.
 *     This closes Codex #525 P1: a client with a guessed sessionId
 *     and a well-shaped fake `pushd_da_*` token now sees nothing
 *     until pushd explicitly grants its token.
 *
 *   - Per-phone-connection bearer storage. The phone bearer (the
 *     `pushd_da_*` value extracted from `Sec-WebSocket-Protocol`) is
 *     stored alongside each phone connection so the allowlist match
 *     can run on every outbound forward.
 *
 *   - At most one pushd connection per session (carried from 2.c).
 *     Second-pushd attempts return HTTP 409 at the upgrade boundary.
 *
 * Still not in 2.d.1: ring buffer + replay (2.d.2; the `relay_attach`
 * envelope's `lastSeq` is parsed but currently ignored — the schema
 * lands here, the runtime lands in 2.d.2). Pushd outbound dial (2.e),
 * phone client adapter (2.f) also still open.
 *
 * Constraints baked in here (see docs/decisions/Remote Sessions via
 * pushd Relay.md Q#2):
 *
 *   - No WebSocket Hibernation API. Plain `ws.accept()` keeps the DO
 *     instance pinned in memory for the WS lifetime; this is the
 *     reliability claim the in-memory buffer in 2.d.2 will rely on.
 *   - No `state.storage` writes. Connection state lives only in
 *     `this.connections`; loss across DO restart is intentional and
 *     the client recovers via `attach_session` (handled at the daemon
 *     end, not here).
 */

import type { DurableObjectState, WebSocket } from '@cloudflare/workers-types';
import {
  isRelayEnvelope,
  validateRelayEnvelope,
  type RelayEnvelope,
} from '@push/lib/protocol-schema';
import { extractPhoneBearer } from './relay-routes';
import type { Env } from './worker-middleware';

export type RelayConnectionRole = 'pushd' | 'phone';

type ConnectionMeta = { role: 'pushd' } | { role: 'phone'; bearer: string };

export class RelaySessionDO {
  private readonly connections = new Map<WebSocket, ConnectionMeta>();
  private readonly allowedPhoneBearers = new Set<string>();
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    // 2.d.1 doesn't use either field; held for 2.d.2 (state may
    // schedule waitUntil cleanup for the ring buffer). `void` keeps
    // noUnusedLocals quiet without forcing a synthetic consumer.
    this.state = state;
    this.env = env;
    void this.state;
    void this.env;
  }

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get('Upgrade')?.toLowerCase();
    if (upgrade !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const url = new URL(request.url);
    const roleParam = url.searchParams.get('role');
    if (roleParam !== 'pushd' && roleParam !== 'phone') {
      return new Response('Role missing on DO request — route handler must tag', {
        status: 500,
      });
    }
    const role = roleParam;

    if (role === 'pushd' && this.getPushdConnection() !== null) {
      // Reject the second pushd at the upgrade boundary — no WS pair
      // has been created yet, so we return an HTTP 409 (not a close
      // code). The first pushd stays authoritative; reconnect path is
      // "old WS closes, then new pushd opens."
      return new Response('Pushd already attached to this session', { status: 409 });
    }

    // For phones, re-extract the bearer from the subprotocol so the
    // DO can store it alongside the connection. The route handler
    // already validated the bearer's format at upgrade — the DO
    // trusts that decision but needs the value itself for the
    // allowlist check on every outbound forward.
    let phoneBearer: string | null = null;
    if (role === 'phone') {
      phoneBearer = extractPhoneBearer(request.headers.get('Sec-WebSocket-Protocol'));
      if (!phoneBearer) {
        return new Response('Phone bearer missing — route handler must authenticate', {
          status: 500,
        });
      }
    }

    const pair = new (
      globalThis as unknown as { WebSocketPair: new () => Record<string, WebSocket> }
    ).WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    if (role === 'pushd') {
      this.acceptPushd(server);
    } else {
      this.acceptPhone(server, phoneBearer!);
    }

    return new Response(null, {
      status: 101,
      // @ts-expect-error — Cloudflare extension: Response init accepts `webSocket` to attach a paired socket on upgrade.
      webSocket: client,
      headers: new Headers([['Sec-WebSocket-Protocol', 'push.relay.v1']]),
    });
  }

  /** Exposed for tests. */
  acceptPushd(ws: WebSocket): void {
    ws.accept();
    this.connections.set(ws, { role: 'pushd' });
    this.wireConnectionLifecycle(ws);
  }

  /** Exposed for tests. */
  acceptPhone(ws: WebSocket, bearer: string): void {
    ws.accept();
    this.connections.set(ws, { role: 'phone', bearer });
    this.wireConnectionLifecycle(ws);
  }

  private wireConnectionLifecycle(ws: WebSocket): void {
    ws.addEventListener('message', (event) => {
      // DOM `MessageEvent` and Workers `MessageEvent` types diverge;
      // both expose `.data`, so we lean on the structural shape rather
      // than picking a side.
      this.handleMessage(ws, event as unknown as { data: unknown });
    });

    const cleanup = () => {
      this.connections.delete(ws);
    };
    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);
  }

  /**
   * Top-level message handler. Tries to parse the frame as a relay-
   * control envelope; if it matches one of `RELAY_ENVELOPE_KINDS`
   * the relay consumes it in-band. Otherwise the frame is forwarded
   * unchanged to the opposite role(s).
   *
   * Malformed JSON is forwarded as-is (the receiving side will reject
   * it). This keeps the relay dumb about non-relay-control payloads.
   */
  private handleMessage(sender: WebSocket, event: { data: unknown }): void {
    const senderMeta = this.connections.get(sender);
    if (!senderMeta) return;
    const data = event.data;
    if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) {
      // Workers WS frames are string or ArrayBuffer. Anything else
      // (Blob, etc.) shouldn't reach us; drop defensively.
      return;
    }

    // Only attempt to parse string frames — relay-control envelopes
    // are JSON text. Binary frames are forwarded raw.
    if (typeof data === 'string') {
      const classified = classifyRelayFrame(data);
      if (classified === 'drop') {
        // Malformed envelope with a relay-control `kind` — drop
        // rather than forward the reserved vocabulary to the
        // counterparty (Copilot #526 hardening).
        return;
      }
      if (classified) {
        this.handleRelayControl(senderMeta, classified);
        return;
      }
    }

    this.forwardData(sender, senderMeta, data);
  }

  private handleRelayControl(senderMeta: ConnectionMeta, envelope: RelayEnvelope): void {
    // Allowlist mutations are pushd-only — a phone sending a
    // `relay_phone_allow` would otherwise be able to grant itself
    // access. Drop and log (defensive: pushd is the authority).
    if (envelope.kind === 'relay_phone_allow' || envelope.kind === 'relay_phone_revoke') {
      if (senderMeta.role !== 'pushd') {
        // Silent drop — the protocol doesn't define an error response
        // for unauthorized control envelopes, and forwarding to pushd
        // would surface the bogus envelope to it. 2.d.2's per-conn
        // metrics can light this up later.
        return;
      }
      if (envelope.kind === 'relay_phone_allow') {
        for (const token of envelope.tokens) {
          this.allowedPhoneBearers.add(token);
        }
      } else {
        const revokedTokens = new Set(envelope.tokens);
        for (const token of revokedTokens) {
          this.allowedPhoneBearers.delete(token);
        }
        // Drop any currently-connected phone whose bearer was revoked.
        // Close code 1008 mirrors the device-token revoke path in pushd.
        for (const [ws, meta] of this.connections) {
          if (meta.role === 'phone' && revokedTokens.has(meta.bearer)) {
            ws.close(1008, 'phone bearer revoked');
          }
        }
      }
      return;
    }

    // `relay_attach` lands here in 2.d.1 but the buffer / replay
    // runtime is 2.d.2. Drop with no side effect for now; the schema
    // is pinned so 2.d.2 can flip it on without protocol drift.
    if (envelope.kind === 'relay_attach') {
      return;
    }

    // `relay_replay_unavailable` is server → client — if a client
    // ever sent it back, drop. Defensive only.
  }

  private forwardData(
    sender: WebSocket,
    senderMeta: ConnectionMeta,
    data: string | ArrayBuffer,
  ): void {
    if (senderMeta.role === 'pushd') {
      // pushd → phones, gated on the phone's bearer being in the
      // pushd-controlled allowlist. Closes Codex #525 P1.
      for (const [ws, meta] of this.connections) {
        if (
          ws !== sender &&
          meta.role === 'phone' &&
          this.allowedPhoneBearers.has(meta.bearer) &&
          ws.readyState === 1
        ) {
          ws.send(data as string | ArrayBuffer);
        }
      }
    } else {
      // phone → pushd, also gated on the phone's bearer being in the
      // allowlist (closes Codex #526 P1: pushd can't see the
      // originating bearer on a forwarded frame, so the relay is the
      // only place that can enforce this direction). Asymmetric
      // gating was the wrong call — both directions need the same
      // boundary.
      if (!this.allowedPhoneBearers.has(senderMeta.bearer)) {
        return;
      }
      const pushd = this.getPushdConnection();
      if (pushd && pushd !== sender && pushd.readyState === 1) {
        pushd.send(data as string | ArrayBuffer);
      }
    }
  }

  private getPushdConnection(): WebSocket | null {
    for (const [ws, meta] of this.connections) {
      if (meta.role === 'pushd') return ws;
    }
    return null;
  }

  /** Visible for tests. */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /** Visible for tests. */
  getRoleCounts(): { pushd: number; phone: number } {
    let pushd = 0;
    let phone = 0;
    for (const meta of this.connections.values()) {
      if (meta.role === 'pushd') pushd += 1;
      else phone += 1;
    }
    return { pushd, phone };
  }

  /** Visible for tests. */
  getAllowedPhoneBearers(): readonly string[] {
    return Array.from(this.allowedPhoneBearers);
  }
}

/**
 * Three-way classifier on a text frame:
 *
 *   - returns a typed envelope when the frame parses as a valid
 *     relay-control envelope (caller consumes in-band);
 *   - returns `'drop'` when the frame's `kind` looks like a relay
 *     envelope but validation fails — caller drops the frame
 *     entirely rather than forwarding the reserved vocabulary to
 *     the counterparty (Copilot #526 hardening);
 *   - returns null otherwise (caller forwards raw — non-control
 *     payloads and malformed JSON both fall here).
 */
function classifyRelayFrame(text: string): RelayEnvelope | 'drop' | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRelayEnvelope(parsed)) return null;
  if (validateRelayEnvelope(parsed).length > 0) return 'drop';
  return parsed;
}
