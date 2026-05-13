/**
 * Remote Sessions relay — per-session Durable Object.
 *
 * Phase 2.b scaffold landed the WS accept; 2.c adds:
 *
 *   - Per-connection role tagging (`pushd` | `phone`), read from the
 *     `?role=` query param the route handler sets after bearer auth.
 *   - Byte-level forwarding between roles:
 *       pushd → all phone connections in this session
 *       phone → the pushd connection in this session (if any)
 *     Forwarding is raw — the DO does not parse envelopes. Per the
 *     decision doc's "forward NDJSON envelopes unchanged" rule, the
 *     relay validates that the protocol surface exists (bearer auth +
 *     role gating) but does not interpret semantics.
 *   - At most one pushd connection per session. A second pushd arrival
 *     closes the new connection with code 4001 — the old pushd stays
 *     authoritative. (Reconnect path: old WS closes first, then new
 *     pushd opens.)
 *
 * Still not in 2.c: envelope parsing (2.d, where the buffer needs seq
 * numbers from envelopes), persistent state (Q#2 forbids it), pushd
 * outbound dial (2.e), phone client adapter (2.f).
 *
 * Constraints baked in here (see docs/decisions/Remote Sessions via
 * pushd Relay.md Q#2):
 *
 *   - No WebSocket Hibernation API. Plain `ws.accept()` keeps the DO
 *     instance pinned in memory for the WS lifetime; this is the
 *     reliability claim the in-memory buffer in 2.d will rely on.
 *   - No `state.storage` writes. Connection state lives only in
 *     `this.connections`; loss across DO restart is intentional and
 *     the client recovers via `attach_session` (handled at the daemon
 *     end, not here).
 */

import type { DurableObjectState, WebSocket } from '@cloudflare/workers-types';
import type { Env } from './worker-middleware';

export type RelayConnectionRole = 'pushd' | 'phone';

interface ConnectionMeta {
  role: RelayConnectionRole;
}

export class RelaySessionDO {
  private readonly connections = new Map<WebSocket, ConnectionMeta>();
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    // 2.c doesn't use either field; held for 2.d (state may schedule
    // waitUntil cleanup for the ring buffer). `void` keeps
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
      // Reject the second pushd. Close code 4001 = "pushd already
      // attached." The first pushd stays authoritative.
      return new Response('Pushd already attached to this session', { status: 409 });
    }

    const pair = new (
      globalThis as unknown as { WebSocketPair: new () => Record<string, WebSocket> }
    ).WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.acceptConnection(server, role);

    return new Response(null, {
      status: 101,
      // @ts-expect-error — Cloudflare extension: Response init accepts `webSocket` to attach a paired socket on upgrade.
      webSocket: client,
      headers: new Headers([['Sec-WebSocket-Protocol', 'push.relay.v1']]),
    });
  }

  /**
   * Exposed for tests. In production this is only called from `fetch()`
   * with the server end of a fresh `WebSocketPair`.
   */
  acceptConnection(ws: WebSocket, role: RelayConnectionRole): void {
    ws.accept();
    this.connections.set(ws, { role });

    ws.addEventListener('message', (event) => {
      // DOM `MessageEvent` and Workers `MessageEvent` types diverge;
      // both expose `.data`, so we lean on the structural shape rather
      // than picking a side.
      this.forwardMessage(ws, event as unknown as { data: unknown });
    });

    const cleanup = () => {
      this.connections.delete(ws);
    };
    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);
  }

  /** Forward a message from `sender` to the opposite role(s). */
  private forwardMessage(sender: WebSocket, event: { data: unknown }): void {
    const senderMeta = this.connections.get(sender);
    if (!senderMeta) return; // sender already removed; drop
    const data = event.data;
    if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) {
      // Workers WS frames are string or ArrayBuffer. Anything else
      // (Blob, etc.) shouldn't reach us; drop defensively.
      return;
    }
    if (senderMeta.role === 'pushd') {
      // pushd → all phones
      for (const [ws, meta] of this.connections) {
        if (ws !== sender && meta.role === 'phone' && ws.readyState === 1) {
          ws.send(data as string);
        }
      }
    } else {
      // phone → the pushd
      const pushd = this.getPushdConnection();
      if (pushd && pushd !== sender && pushd.readyState === 1) {
        pushd.send(data as string);
      }
      // If no pushd is attached, drop. Phone messages with no
      // counterparty are not buffered in 2.c — 2.d adds the ring
      // buffer which handles brief pushd disconnects.
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
}
