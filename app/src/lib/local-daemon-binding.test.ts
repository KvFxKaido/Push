/**
 * local-daemon-binding.test.ts — Spins up a real `ws` server in the
 * vitest process and exercises the adapter end-to-end. The auth gate
 * tested here is *test-local* — we recreate the server-side
 * subprotocol negotiation behaviour from `cli/pushd-ws.ts` so the
 * adapter can be validated without booting pushd. The
 * cross-implementation contract is asserted by the matching
 * `cli/tests/pushd-ws.test.mjs` subprotocol cases.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient, WebSocketServer, type WebSocket as WsServerSocket } from 'ws';
import { PROTOCOL_VERSION } from '@push/lib/protocol-schema';
import {
  type ConnectionStatus,
  type SessionEvent,
  createLocalDaemonBinding,
} from './local-daemon-binding';

// Node 22 has globalThis.WebSocket; Node 20 (which CI uses for the
// app test job) does not. The adapter calls `new WebSocket(...)`
// because that's the browser API it runs against in production.
// Shim the global here so this test executes identically on both
// Node versions. The `ws` client implements the W3C interface
// (addEventListener / readyState / send / close) the adapter
// relies on; the call only resolves at function-invocation time,
// so installing the shim here at module top-level — before any
// test calls createLocalDaemonBinding — is sufficient.
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  // Cast through unknown — the `ws` client class is structurally
  // similar to the browser WebSocket but isn't the same nominal type
  // (it extends EventEmitter, exposes once/listenerCount/etc.). For
  // the adapter's purposes the W3C-compatible surface is sufficient.
  (globalThis as unknown as { WebSocket: typeof WsClient }).WebSocket = WsClient;
}

const VALID_TOKEN = 'pushd_test_valid_token_xxxxxxxxxxxxxxxxxxxxxxxxxxx';
const SUBPROTOCOL_SELECTOR = 'pushd.v1';

interface FixtureServer {
  port: number;
  close: () => Promise<void>;
  emit: (frame: string) => void;
}

/**
 * Stand up a stub pushd-shaped WS server that:
 *  - rejects upgrades missing the pushd.v1 subprotocol OR the bearer entry
 *  - rejects upgrades whose bearer != VALID_TOKEN (returns 401)
 *  - on connect, echoes pings back as responses with ok=true
 *  - exposes an `emit` hook for the test to push events to connected clients
 */
async function startStubServer(): Promise<FixtureServer> {
  const wss = new WebSocketServer({
    port: 0,
    handleProtocols: (protocols) =>
      protocols.has(SUBPROTOCOL_SELECTOR) ? SUBPROTOCOL_SELECTOR : false,
    verifyClient: (info, cb) => {
      const subproto = info.req.headers['sec-websocket-protocol'];
      if (typeof subproto !== 'string') return cb(false, 401, 'missing protocol');
      const protocols = subproto.split(',').map((p) => p.trim());
      const hasSelector = protocols.includes(SUBPROTOCOL_SELECTOR);
      const bearer = protocols.find((p) => p.startsWith('bearer.'));
      if (!hasSelector || !bearer) return cb(false, 401, 'malformed bearer');
      const token = bearer.slice('bearer.'.length);
      if (token !== VALID_TOKEN) return cb(false, 401, 'bad token');
      cb(true);
    },
  });

  const clients = new Set<WsServerSocket>();
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('message', (data) => {
      const raw = data.toString('utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = JSON.parse(trimmed);
        if (parsed.kind === 'request' && parsed.type === 'ping') {
          ws.send(
            `${JSON.stringify({
              v: PROTOCOL_VERSION,
              kind: 'response',
              requestId: parsed.requestId,
              type: 'ping',
              sessionId: parsed.sessionId ?? null,
              ok: true,
              payload: { pong: true },
              error: null,
            })}\n`,
          );
        }
      }
    });
    ws.on('close', () => clients.delete(ws));
  });

  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const port = (wss.address() as AddressInfo).port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.close();
        wss.close(() => resolve());
      }),
    emit: (frame: string) => {
      for (const c of clients) c.send(frame);
    },
  };
}

function waitForStatus(
  statuses: ConnectionStatus[],
  predicate: (s: ConnectionStatus) => boolean,
): Promise<ConnectionStatus> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for status')), 3000);
    const check = () => {
      const match = statuses.find(predicate);
      if (match) {
        clearTimeout(timer);
        resolve(match);
      }
    };
    check();
    // Polling the array is fine — the adapter pushes synchronously
    // via onStatus, so by the time the awaiter checks, anything that
    // was going to arrive already has.
    const interval = setInterval(() => {
      const match = statuses.find(predicate);
      if (match) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve(match);
      }
    }, 20);
  });
}

describe('local-daemon-binding', () => {
  let server: FixtureServer;

  beforeEach(async () => {
    server = await startStubServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('connects and round-trips a ping', async () => {
    const statuses: ConnectionStatus[] = [];
    const binding = createLocalDaemonBinding({
      port: server.port,
      token: VALID_TOKEN,
      onStatus: (s) => statuses.push(s),
    });
    await waitForStatus(statuses, (s) => s.state === 'open');
    const response = await binding.request({ type: 'ping' });
    expect(response.ok).toBe(true);
    expect((response.payload as { pong: boolean }).pong).toBe(true);
    binding.close();
  });

  it('surfaces auth failure as auth-failed status (bad token)', async () => {
    const statuses: ConnectionStatus[] = [];
    const binding = createLocalDaemonBinding({
      port: server.port,
      token: 'pushd_wrong_token_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      onStatus: (s) => statuses.push(s),
    });
    const status = await waitForStatus(statuses, (s) => s.state === 'auth-failed');
    expect(status.state).toBe('auth-failed');
    binding.close();
  });

  it('rejects request() when not open', async () => {
    const binding = createLocalDaemonBinding({
      port: server.port,
      token: VALID_TOKEN,
    });
    // Call request before the open event fires.
    await expect(binding.request({ type: 'ping' })).rejects.toThrow(/not open/);
    binding.close();
  });

  it('correlates concurrent requests by requestId', async () => {
    const statuses: ConnectionStatus[] = [];
    const binding = createLocalDaemonBinding({
      port: server.port,
      token: VALID_TOKEN,
      onStatus: (s) => statuses.push(s),
    });
    await waitForStatus(statuses, (s) => s.state === 'open');
    const [a, b, c] = await Promise.all([
      binding.request({ type: 'ping' }),
      binding.request({ type: 'ping' }),
      binding.request({ type: 'ping' }),
    ]);
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);
    // Every response should have a unique requestId echoed back.
    expect(new Set([a.requestId, b.requestId, c.requestId]).size).toBe(3);
    binding.close();
  });

  it('delivers validated event envelopes via onEvent', async () => {
    const statuses: ConnectionStatus[] = [];
    const events: SessionEvent[] = [];
    const binding = createLocalDaemonBinding({
      port: server.port,
      token: VALID_TOKEN,
      onStatus: (s) => statuses.push(s),
      onEvent: (ev) => events.push(ev),
    });
    await waitForStatus(statuses, (s) => s.state === 'open');
    const event: SessionEvent = {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId: 'sess_test_abcdef',
      seq: 1,
      ts: Date.now(),
      type: 'assistant_token',
      payload: { delta: 'hi' },
    };
    server.emit(`${JSON.stringify(event)}\n`);
    // Give the message a microtask to be delivered.
    await new Promise((r) => setTimeout(r, 50));
    expect(events.length).toBe(1);
    expect(events[0].sessionId).toBe('sess_test_abcdef');
    binding.close();
  });

  it('rejects malformed incoming envelopes via onMalformed without closing', async () => {
    const statuses: ConnectionStatus[] = [];
    const malformed: string[] = [];
    const binding = createLocalDaemonBinding({
      port: server.port,
      token: VALID_TOKEN,
      onStatus: (s) => statuses.push(s),
      onMalformed: (raw) => malformed.push(raw),
    });
    await waitForStatus(statuses, (s) => s.state === 'open');
    server.emit('{not json\n');
    server.emit(`${JSON.stringify({ v: 'wrong.version', kind: 'event' })}\n`);
    await new Promise((r) => setTimeout(r, 50));
    expect(malformed.length).toBeGreaterThanOrEqual(2);
    expect(binding.status.state).toBe('open');
    binding.close();
  });

  it('rejects pending requests when the connection closes', async () => {
    const statuses: ConnectionStatus[] = [];
    const binding = createLocalDaemonBinding({
      port: server.port,
      token: VALID_TOKEN,
      onStatus: (s) => statuses.push(s),
    });
    await waitForStatus(statuses, (s) => s.state === 'open');
    // Fire a request whose response we will deliberately not deliver
    // (the stub server only answers 'ping'). Close from the server
    // side mid-flight.
    const pending = binding.request({ type: 'never_answered', timeoutMs: 5000 });
    // Attach the rejection assertion *before* closing the server so
    // vitest doesn't trip its unhandled-rejection trap during the
    // gap between rejection and the test's await.
    const assertion = expect(pending).rejects.toThrow(/connection closed/);
    await server.close();
    await assertion;
  });
});
