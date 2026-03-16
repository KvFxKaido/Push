/**
 * daemon-client.mjs — Reusable NDJSON socket client for pushd.
 *
 * Usage:
 *   const client = await connect(socketPath);
 *   const res = await client.request('hello', {});
 *   client.onEvent((event) => { ... });
 *   client.close();
 */
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { PROTOCOL_VERSION } from './session-store.mjs';

function makeRequestId() {
  return `req_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

/**
 * Connect to a pushd Unix socket. Returns a client object with:
 *   request(type, payload, sessionId?) → Promise<response payload>
 *   onEvent(callback) → unsubscribe function
 *   close() → disconnect
 *   connected (boolean getter)
 */
export function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    let connected = true;
    const pendingRequests = new Map(); // requestId → { resolve, reject, timer }
    const eventListeners = new Set();

    function processLine(line) {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }

      if (msg.kind === 'response' && msg.requestId && pendingRequests.has(msg.requestId)) {
        const pending = pendingRequests.get(msg.requestId);
        pendingRequests.delete(msg.requestId);
        clearTimeout(pending.timer);
        if (msg.ok) {
          pending.resolve(msg);
        } else {
          const err = new Error(msg.error?.message || 'Request failed');
          err.code = msg.error?.code || 'UNKNOWN';
          err.retryable = msg.error?.retryable || false;
          pending.reject(err);
        }
      } else if (msg.kind === 'event') {
        for (const listener of eventListeners) {
          try { listener(msg); } catch { /* consumer error */ }
        }
      }
    }

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        processLine(line);
      }
    });

    socket.on('error', (err) => {
      connected = false;
      // Reject all pending requests
      for (const [, pending] of pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      pendingRequests.clear();
      reject(err);
    });

    socket.on('close', () => {
      connected = false;
      for (const [, pending] of pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Connection closed'));
      }
      pendingRequests.clear();
    });

    socket.on('connect', () => {
      const client = {
        get connected() { return connected; },

        request(type, payload = {}, sessionId = null, timeoutMs = 30000) {
          return new Promise((res, rej) => {
            if (!connected) {
              rej(new Error('Not connected'));
              return;
            }
            const requestId = makeRequestId();
            const timer = setTimeout(() => {
              pendingRequests.delete(requestId);
              rej(new Error(`Request ${type} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            pendingRequests.set(requestId, { resolve: res, reject: rej, timer });

            const envelope = {
              v: PROTOCOL_VERSION,
              kind: 'request',
              requestId,
              type,
              sessionId,
              payload,
            };
            socket.write(JSON.stringify(envelope) + '\n');
          });
        },

        onEvent(callback) {
          eventListeners.add(callback);
          return () => eventListeners.delete(callback);
        },

        close() {
          connected = false;
          socket.end();
        },

        /** Raw socket for advanced use (e.g. detecting disconnect) */
        _socket: socket,
      };

      resolve(client);
    });
  });
}

/**
 * Try to connect to pushd with a short timeout.
 * Returns the client or null if connection fails.
 */
export async function tryConnect(socketPath, timeoutMs = 2000) {
  let timer;
  let connectPromise;
  try {
    connectPromise = connect(socketPath);
    const client = await Promise.race([
      connectPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Connection timeout')), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    return client;
  } catch {
    clearTimeout(timer);
    // If connect resolves late, close the leaked socket
    if (connectPromise) {
      connectPromise.then((client) => client.close()).catch(() => {});
    }
    return null;
  }
}

/**
 * Wait for pushd to become ready by polling with ping.
 * Returns true if daemon responded, false if timeout exceeded.
 */
export async function waitForReady(socketPath, { maxWaitMs = 3000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const client = await tryConnect(socketPath, intervalMs);
    if (client) {
      try {
        const res = await client.request('ping', {}, null, intervalMs);
        client.close();
        return res.ok === true;
      } catch {
        client.close();
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
