/**
 * Unit tests for `RelaySessionDO` (Phase 2.b scaffold).
 *
 * Node doesn't ship a `WebSocketPair`, so we polyfill a minimal pair
 * that supports `accept()`, `addEventListener('message'|'close'|'error')`,
 * and a `simulateClose()` helper for the deregistration test.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DurableObjectState, WebSocket } from '@cloudflare/workers-types';
import { RelaySessionDO } from './relay-do';
import type { Env } from './worker-middleware';

// Workers Response accepts status 101 for WS upgrades; DOM Response (node's
// undici) does not and throws RangeError. Polyfill a subclass that records
// the original status while constructing the underlying Response with a
// node-legal status. The DO's body is unchanged; only the test runtime
// sees the override.
const RealResponse = globalThis.Response;
class WorkersStyleResponse extends RealResponse {
  private readonly __statusOverride?: number;
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    if (init && typeof init.status === 'number' && init.status < 200) {
      const override = init.status;
      super(body, { ...init, status: 200 });
      this.__statusOverride = override;
    } else {
      super(body, init);
    }
  }
  get status(): number {
    return this.__statusOverride ?? super.status;
  }
}

beforeAll(() => {
  globalThis.Response = WorkersStyleResponse as unknown as typeof Response;
});
afterAll(() => {
  globalThis.Response = RealResponse;
});

class FakeWebSocket {
  readyState = 0;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  accept(): void {
    this.readyState = 1;
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
    this.dispatch('close', { code: 1000, reason: '' });
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  dispatch(type: string, event: unknown): void {
    this.listeners.get(type)?.forEach((fn) => fn(event));
  }
}

class FakeWebSocketPair {
  readonly 0: FakeWebSocket;
  readonly 1: FakeWebSocket;

  constructor() {
    this[0] = new FakeWebSocket();
    this[1] = new FakeWebSocket();
  }
}

const originalWebSocketPair = (globalThis as { WebSocketPair?: unknown }).WebSocketPair;

beforeEach(() => {
  (globalThis as { WebSocketPair?: unknown }).WebSocketPair = FakeWebSocketPair;
});

afterEach(() => {
  (globalThis as { WebSocketPair?: unknown }).WebSocketPair = originalWebSocketPair;
});

function makeDO(): RelaySessionDO {
  const state = {} as DurableObjectState;
  const env = {} as Env;
  return new RelaySessionDO(state, env);
}

describe('RelaySessionDO.fetch', () => {
  it('returns 426 when the request is not a WebSocket upgrade', async () => {
    const doInstance = makeDO();
    const res = await doInstance.fetch(new Request('https://example.com/'));
    expect(res.status).toBe(426);
    expect(doInstance.getConnectionCount()).toBe(0);
  });

  it('returns 101 and registers a connection on WS upgrade', async () => {
    const doInstance = makeDO();
    const res = await doInstance.fetch(
      new Request('https://example.com/', { headers: { Upgrade: 'websocket' } }),
    );
    expect(res.status).toBe(101);
    expect(doInstance.getConnectionCount()).toBe(1);
  });
});

describe('RelaySessionDO.acceptConnection', () => {
  it('registers the WebSocket and calls accept()', () => {
    const doInstance = makeDO();
    const ws = new FakeWebSocket();
    doInstance.acceptConnection(ws as unknown as WebSocket);
    expect(ws.readyState).toBe(1);
    expect(doInstance.getConnectionCount()).toBe(1);
  });

  it('deregisters the connection on close', () => {
    const doInstance = makeDO();
    const ws = new FakeWebSocket();
    doInstance.acceptConnection(ws as unknown as WebSocket);
    expect(doInstance.getConnectionCount()).toBe(1);

    ws.close();
    expect(doInstance.getConnectionCount()).toBe(0);
  });

  it('deregisters the connection on error', () => {
    const doInstance = makeDO();
    const ws = new FakeWebSocket();
    doInstance.acceptConnection(ws as unknown as WebSocket);
    ws.dispatch('error', new Error('boom'));
    expect(doInstance.getConnectionCount()).toBe(0);
  });

  it('drops incoming messages (no protocol wired yet in 2.b)', () => {
    const doInstance = makeDO();
    const ws = new FakeWebSocket();
    doInstance.acceptConnection(ws as unknown as WebSocket);
    ws.dispatch('message', { data: 'should be ignored' });
    expect(doInstance.getConnectionCount()).toBe(1);
  });

  it('tracks multiple independent connections', () => {
    const doInstance = makeDO();
    const wsA = new FakeWebSocket();
    const wsB = new FakeWebSocket();
    doInstance.acceptConnection(wsA as unknown as WebSocket);
    doInstance.acceptConnection(wsB as unknown as WebSocket);
    expect(doInstance.getConnectionCount()).toBe(2);

    wsA.close();
    expect(doInstance.getConnectionCount()).toBe(1);

    wsB.close();
    expect(doInstance.getConnectionCount()).toBe(0);
  });
});
