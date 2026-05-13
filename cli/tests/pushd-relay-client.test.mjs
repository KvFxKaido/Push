/**
 * Tests for `cli/pushd-relay-client.ts` (Phase 2.e).
 *
 * Strategy: spin up a real WS server on an ephemeral port + an HTTP
 * server in front of it that controls the upgrade outcome (accept /
 * reject / hang). The relay client treats the Worker as opaque, so a
 * local `ws` server impersonating it is the right harness shape —
 * matches `cli/tests/pushd-ws.test.mjs`'s posture.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { buildRelayUrl, startPushdRelayClient } from '../pushd-relay-client.ts';

const RELAY_TOKEN = 'pushd_relay_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * Build a controllable WS server. The caller can choose to accept the
 * upgrade, reject it (so the client sees a pre-open close), or simply
 * close on the first message. Returns the bound URL plus an inspector
 * to assert on what the server saw.
 */
async function makeServer({ rejectFirstN = 0, captureSubprotocols = [] } = {}) {
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  let upgrades = 0;
  let messages = [];
  let opens = 0;

  httpServer.on('upgrade', (req, socket, head) => {
    upgrades += 1;
    captureSubprotocols.push(req.headers['sec-websocket-protocol'] ?? '');
    if (upgrades <= rejectFirstN) {
      // Closing the raw socket without an HTTP response gives the client
      // a pre-open 1006 — same shape as a Worker rejecting on auth.
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      opens += 1;
      ws.on('message', (data, isBinary) => {
        if (!isBinary) messages.push(data.toString('utf8'));
      });
      // Echo the protocol selector back so the client transitions to
      // 'open'. `ws` handles the protocol echo automatically; we just
      // accept.
    });
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = httpServer.address().port;
  return {
    url: `ws://127.0.0.1:${port}`,
    httpServer,
    wss,
    inspect: () => ({ upgrades, opens, messages: [...messages] }),
    close: () =>
      new Promise((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => httpServer.close(() => resolve()));
      }),
  };
}

function awaitOpen(client, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    if (client.status.state === 'open') return resolve(client.status);
    const timer = setTimeout(() => reject(new Error('open timeout')), timeoutMs);
    const interval = setInterval(() => {
      if (client.status.state === 'open') {
        clearTimeout(timer);
        clearInterval(interval);
        resolve(client.status);
      }
    }, 10);
  });
}

function awaitStatus(client, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('status predicate timeout')), timeoutMs);
    const collected = [];
    const tick = () => {
      collected.push({ ...client.status });
      if (predicate(client.status)) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve(client.status);
      }
    };
    const interval = setInterval(tick, 10);
    tick();
  });
}

// PR #530 review: buildRelayUrl used to blindly append /api/relay/...
// which double-pathed when operator deploymentUrl already had /api.
// New shape uses URL parsing + path replace.
describe('buildRelayUrl (PR #530 normalization)', () => {
  it('replaces the path on a bare https URL', () => {
    assert.equal(
      buildRelayUrl('https://example.com', 'sess-1'),
      'wss://example.com/api/relay/v1/session/sess-1/connect',
    );
  });
  it('replaces an existing /api path prefix (no double-up)', () => {
    assert.equal(
      buildRelayUrl('https://example.com/api', 'sess-1'),
      'wss://example.com/api/relay/v1/session/sess-1/connect',
    );
  });
  it('replaces an existing /v1/api path prefix', () => {
    assert.equal(
      buildRelayUrl('https://example.com/v1/api', 'sess-1'),
      'wss://example.com/api/relay/v1/session/sess-1/connect',
    );
  });
  it('rewrites http(s) → ws(s)', () => {
    assert.equal(
      buildRelayUrl('http://localhost:8787', 'sess-1'),
      'ws://localhost:8787/api/relay/v1/session/sess-1/connect',
    );
  });
  it('tolerates a bare hostname (defaults to wss)', () => {
    assert.equal(
      buildRelayUrl('relay.example.com', 'sess-1'),
      'wss://relay.example.com/api/relay/v1/session/sess-1/connect',
    );
  });
  it('encodes sessionId path component', () => {
    assert.ok(
      buildRelayUrl('https://example.com', 'pushd-host with spaces').endsWith(
        '/session/pushd-host%20with%20spaces/connect',
      ),
    );
  });
});

describe('pushd-relay-client', () => {
  it('opens an outbound WS and carries the bearer in Sec-WebSocket-Protocol', async () => {
    const captured = [];
    const server = await makeServer({ captureSubprotocols: captured });
    try {
      const client = startPushdRelayClient({
        deploymentUrl: server.url,
        sessionId: 'sess-1',
        token: RELAY_TOKEN,
      });
      await awaitOpen(client);
      assert.equal(server.inspect().opens, 1);
      const proto = captured[0];
      // The Worker route looks for both `push.relay.v1` and
      // `bearer.<token>` entries. Order is up to the client; assert
      // both are present.
      assert.ok(proto.includes('push.relay.v1'), `protocol selector missing: ${proto}`);
      assert.ok(proto.includes(`bearer.${RELAY_TOKEN}`), `bearer entry missing: ${proto}`);
      client.close();
    } finally {
      await server.close();
    }
  });

  it('reconnects on close-before-open using the supplied backoff schedule', async () => {
    // Reject the first 2 upgrades so the client walks the ladder
    // twice before succeeding on the 3rd dial.
    const server = await makeServer({ rejectFirstN: 2 });
    try {
      const statuses = [];
      const client = startPushdRelayClient({
        deploymentUrl: server.url,
        sessionId: 'sess-2',
        token: RELAY_TOKEN,
        backoffScheduleMs: [10, 20, 40],
        maxReconnectAttempts: 6,
        onStatus: (s) => statuses.push({ ...s }),
      });
      await awaitOpen(client, 3000);
      // 3 upgrades = initial + 2 rejections retried.
      assert.equal(server.inspect().upgrades, 3);
      // Should have seen at least one `unreachable` with attempt > 0
      // before transitioning to open.
      const sawRetry = statuses.some(
        (s) => s.state === 'unreachable' && s.attempt > 0 && !s.exhausted,
      );
      assert.ok(
        sawRetry,
        `expected an unreachable-with-attempt status; got ${JSON.stringify(statuses)}`,
      );
      client.close();
    } finally {
      await server.close();
    }
  });

  it('exhausts after maxReconnectAttempts and stops dialling', async () => {
    // Reject every upgrade.
    const server = await makeServer({ rejectFirstN: 999 });
    try {
      let exhaustedStatus = null;
      const client = startPushdRelayClient({
        deploymentUrl: server.url,
        sessionId: 'sess-3',
        token: RELAY_TOKEN,
        backoffScheduleMs: [5, 5, 5],
        maxReconnectAttempts: 3,
        onStatus: (s) => {
          if (s.state === 'unreachable' && s.exhausted) exhaustedStatus = { ...s };
        },
      });
      await awaitStatus(client, (s) => s.state === 'unreachable' && s.exhausted, 3000);
      assert.ok(exhaustedStatus, 'expected an exhausted status');
      const upgradesAtExhaust = server.inspect().upgrades;
      // initial + 3 retries = 4 upgrades attempted before exhaustion.
      assert.equal(upgradesAtExhaust, 4);
      // Give the loop another 60ms to confirm no further dials fire.
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(server.inspect().upgrades, upgradesAtExhaust, 'no dials after exhaustion');
      client.close();
    } finally {
      await server.close();
    }
  });

  it('buffers pre-open frames and flushes them on connect', async () => {
    const server = await makeServer();
    try {
      const client = startPushdRelayClient({
        deploymentUrl: server.url,
        sessionId: 'sess-4',
        token: RELAY_TOKEN,
      });
      // Send before open — should queue.
      client.send('frame-1\n');
      client.send('frame-2\n');
      await awaitOpen(client);
      // Give the server's message handler a tick to receive.
      await new Promise((r) => setTimeout(r, 50));
      const received = server.inspect().messages;
      assert.deepEqual(received, ['frame-1\n', 'frame-2\n']);
      client.close();
    } finally {
      await server.close();
    }
  });

  it('does not leak the bearer in any status or close payload', async () => {
    const server = await makeServer({ rejectFirstN: 1 });
    try {
      const statuses = [];
      const client = startPushdRelayClient({
        deploymentUrl: server.url,
        sessionId: 'sess-5',
        token: RELAY_TOKEN,
        backoffScheduleMs: [10],
        maxReconnectAttempts: 2,
        onStatus: (s) => statuses.push({ ...s }),
      });
      await awaitOpen(client, 2000);
      // Dump every status object to a string and assert the token
      // substring never appears.
      const dumped = JSON.stringify(statuses);
      assert.ok(
        !dumped.includes(RELAY_TOKEN),
        `bearer token leaked into status payload: ${dumped}`,
      );
      assert.ok(
        !dumped.includes(RELAY_TOKEN.slice('pushd_relay_'.length)),
        `bearer body leaked into status payload: ${dumped}`,
      );
      client.close();
    } finally {
      await server.close();
    }
  });

  it('invokes onOpen with a send fn on every successful open', async () => {
    const server = await makeServer({ rejectFirstN: 1 });
    try {
      let openCallbackInvocations = 0;
      const client = startPushdRelayClient({
        deploymentUrl: server.url,
        sessionId: 'sess-6',
        token: RELAY_TOKEN,
        backoffScheduleMs: [10],
        maxReconnectAttempts: 6,
        onOpen: (send) => {
          openCallbackInvocations += 1;
          send('hello\n');
        },
      });
      await awaitOpen(client, 2000);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(openCallbackInvocations, 1);
      assert.ok(server.inspect().messages.includes('hello\n'));
      client.close();
    } finally {
      await server.close();
    }
  });

  // PR #529 review fix (Copilot): post-open reconnect failures must
  // report `state: 'closed'` (server reachable, just not right now),
  // NOT `state: 'unreachable'`. The previous per-dial `everOpened`
  // reset mis-classified them.
  it('reports closed (not unreachable) after a successful open then drop', async () => {
    // Server accepts once, then drops on every subsequent dial.
    let dialsSeen = 0;
    const httpServer = (await import('node:http')).createServer();
    const wssMod = await import('ws');
    const wss = new wssMod.WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => {
      dialsSeen += 1;
      if (dialsSeen === 1) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          // Close right after open so the client transitions to
          // post-open then sees the drop.
          setTimeout(() => ws.terminate(), 20);
        });
      } else {
        socket.destroy();
      }
    });
    await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
    const port = httpServer.address().port;
    try {
      const statuses = [];
      const client = startPushdRelayClient({
        deploymentUrl: `ws://127.0.0.1:${port}`,
        sessionId: 'sess-state',
        token: RELAY_TOKEN,
        backoffScheduleMs: [10, 10, 10],
        maxReconnectAttempts: 3,
        onStatus: (s) => statuses.push({ ...s }),
      });
      // Wait for the post-open drop reconnect cycle to play out and
      // hit exhausted on the SECOND-AND-LATER dials. After the first
      // success, every subsequent terminal status should be 'closed'
      // (because hasEverOpened is true).
      await awaitStatus(client, (s) => s.exhausted === true, 3000);
      const postSuccessTerminals = statuses.filter(
        (s) => (s.state === 'closed' || s.state === 'unreachable') && s.attempt > 0,
      );
      assert.ok(postSuccessTerminals.length > 0, 'expected at least one post-success terminal');
      for (const s of postSuccessTerminals) {
        assert.equal(
          s.state,
          'closed',
          `post-open reconnect should report 'closed', got '${s.state}' (status=${JSON.stringify(s)})`,
        );
      }
      client.close();
    } finally {
      for (const c of wss.clients) c.terminate();
      wss.close();
      httpServer.close();
    }
  });

  it('manual reconnect() resets attempt counter and re-dials', async () => {
    // Reject the first 5 so we hit exhaustion at maxAttempts=3, then
    // the manual reconnect should re-dial against a now-accepting
    // server.
    const server = await makeServer({ rejectFirstN: 5 });
    try {
      const client = startPushdRelayClient({
        deploymentUrl: server.url,
        sessionId: 'sess-7',
        token: RELAY_TOKEN,
        backoffScheduleMs: [5],
        maxReconnectAttempts: 3,
      });
      await awaitStatus(client, (s) => s.state === 'unreachable' && s.exhausted, 2000);
      // Now reconnect — should re-dial and succeed (6th and beyond
      // attempts pass the rejectFirstN=5 gate).
      client.reconnect();
      await awaitOpen(client, 2000);
      assert.equal(client.status.state, 'open');
      client.close();
    } finally {
      await server.close();
    }
  });
});
