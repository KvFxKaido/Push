/**
 * Remote Sessions relay — per-session Durable Object.
 *
 * Phase 2.b scaffold: accepts WebSocket connections, tracks them in an
 * in-memory `Set`, drops any incoming messages. No protocol forwarding,
 * no auth, no replay buffer. 2.c layers auth on the upgrade path,
 * 2.d adds the in-memory ring buffer and replay, 2.e adds pushd
 * outbound dial against this DO.
 *
 * Design constraints baked in here (see docs/decisions/Remote Sessions
 * via pushd Relay.md Q#2):
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

export class RelaySessionDO {
  private readonly connections = new Set<WebSocket>();
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    // 2.b doesn't use either field; held for 2.c (env may surface
    // auth/feature flags) and 2.d (state may schedule waitUntil cleanup
    // for the ring buffer). `void` keeps noUnusedLocals quiet without
    // forcing a synthetic consumer.
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

    const pair = new (
      globalThis as unknown as { WebSocketPair: new () => Record<string, WebSocket> }
    ).WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.acceptConnection(server);

    // Cloudflare extension: Response init accepts `webSocket` to attach a
    // paired socket on upgrade. The DOM Response type doesn't model it, so
    // we cast through `unknown` at this single boundary.
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as unknown as ResponseInit);
  }

  /**
   * Exposed for tests. In production this is only called from `fetch()`
   * with the server end of a fresh `WebSocketPair`.
   */
  acceptConnection(ws: WebSocket): void {
    ws.accept();
    this.connections.add(ws);

    ws.addEventListener('message', () => {
      // Phase 2.b drops every incoming message: no protocol is wired
      // yet, so anything from a client is unexpected. 2.c will replace
      // this with the auth envelope parser; 2.d will add the buffer +
      // forward path.
    });

    const cleanup = () => {
      this.connections.delete(ws);
    };
    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);
  }

  /** Visible for tests. */
  getConnectionCount(): number {
    return this.connections.size;
  }
}
