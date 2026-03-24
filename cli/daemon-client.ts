/**
 * daemon-client.ts — Reusable NDJSON socket client for pushd.
 *
 * Usage:
 *   const client = await connect(socketPath);
 *   const res = await client.request('hello', {});
 *   client.onEvent((event) => { ... });
 *   client.close();
 */
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { PROTOCOL_VERSION } from './session-store.js';

interface DaemonError {
  message?: string;
  code?: string;
  retryable?: boolean;
}

interface ResponseEnvelope {
  v: string;
  kind: 'response';
  requestId: string;
  type: string;
  sessionId: string | null;
  ok: boolean;
  payload: unknown;
  error?: DaemonError;
}

interface EventEnvelope {
  v: string;
  kind: 'event';
  type: string;
  sessionId?: string | null;
  payload: unknown;
}

type DaemonMessage = ResponseEnvelope | EventEnvelope;

type EventCallback = (event: EventEnvelope) => void;

interface PendingRequest {
  resolve: (value: ResponseEnvelope) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RequestError extends Error {
  code: string;
  retryable: boolean;
}

export interface DaemonClient {
  readonly connected: boolean;
  request(
    type: string,
    payload?: Record<string, unknown>,
    sessionId?: string | null,
    timeoutMs?: number,
  ): Promise<ResponseEnvelope>;
  onEvent(callback: EventCallback): () => void;
  close(): void;
  /** Raw socket for advanced use (e.g. detecting disconnect) */
  _socket: net.Socket;
}

function makeRequestId(): string {
  return `req_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

/**
 * Connect to a pushd Unix socket. Returns a client object with:
 *   request(type, payload, sessionId?, timeoutMs?) → Promise<response envelope>
 *     Resolves the full response envelope ({ v, kind, requestId, type, sessionId, ok, payload, error }).
 *     Rejects with an Error (with .code and .retryable) on non-ok responses.
 *   onEvent(callback) → unsubscribe function
 *   close() → disconnect
 *   connected (boolean getter)
 */
export function connect(socketPath: string): Promise<DaemonClient> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    let connected = true;
    const pendingRequests = new Map<string, PendingRequest>();
    const eventListeners = new Set<EventCallback>();

    function processLine(line: string): void {
      if (!line.trim()) return;
      let msg: DaemonMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }

      if (msg.kind === 'response' && (msg as ResponseEnvelope).requestId && pendingRequests.has((msg as ResponseEnvelope).requestId)) {
        const responseMsg = msg as ResponseEnvelope;
        const pending = pendingRequests.get(responseMsg.requestId)!;
        pendingRequests.delete(responseMsg.requestId);
        clearTimeout(pending.timer);
        if (responseMsg.ok) {
          pending.resolve(responseMsg);
        } else {
          const err = new Error(responseMsg.error?.message || 'Request failed') as RequestError;
          err.code = responseMsg.error?.code || 'UNKNOWN';
          err.retryable = responseMsg.error?.retryable || false;
          pending.reject(err);
        }
      } else if (msg.kind === 'event') {
        for (const listener of eventListeners) {
          try { listener(msg as EventEnvelope); } catch { /* consumer error */ }
        }
      }
    }

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        processLine(line);
      }
    });

    socket.on('error', (err: Error) => {
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
      const client: DaemonClient = {
        get connected() { return connected; },

        request(
          type: string,
          payload: Record<string, unknown> = {},
          sessionId: string | null = null,
          timeoutMs: number = 30000,
        ): Promise<ResponseEnvelope> {
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
              kind: 'request' as const,
              requestId,
              type,
              sessionId,
              payload,
            };
            socket.write(JSON.stringify(envelope) + '\n');
          });
        },

        onEvent(callback: EventCallback): () => void {
          eventListeners.add(callback);
          return () => { eventListeners.delete(callback); };
        },

        close(): void {
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
export async function tryConnect(socketPath: string, timeoutMs: number = 2000): Promise<DaemonClient | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connectPromise: Promise<DaemonClient> | undefined;
  try {
    connectPromise = connect(socketPath);
    const client = await Promise.race([
      connectPromise,
      new Promise<never>((_, reject) => {
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

interface WaitForReadyOptions {
  maxWaitMs?: number;
  intervalMs?: number;
}

/**
 * Wait for pushd to become ready by polling with ping.
 * Returns true if daemon responded, false if timeout exceeded.
 */
export async function waitForReady(
  socketPath: string,
  { maxWaitMs = 3000, intervalMs = 200 }: WaitForReadyOptions = {},
): Promise<boolean> {
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
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  return false;
}
