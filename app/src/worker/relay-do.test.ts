/**
 * Unit tests for `RelaySessionDO` (Phase 2.b scaffold).
 *
 * Node doesn't ship `WebSocketPair`, and node's DOM `Response` rejects
 * status < 200 (the real Workers `Response` accepts 101 for WS
 * upgrades). We patch both globals via `vi.stubGlobal` so they're
 * auto-restored by `vi.unstubAllGlobals()` between tests — direct
 * assignment to `globalThis` could leak across vitest workers that
 * happen to run other files in parallel.
 *
 * The FakeWebSocket polyfill exposes `accept()`, `send()`, `close()`,
 * `addEventListener()`, and a `dispatch(type, event)` helper that
 * tests use to fire `message` / `close` / `error` events at the
 * registered listeners. `WorkersStyleResponse` subclasses the real
 * Response and overrides `status` so a DO returning 101 sees a node-
 * legal underlying status (200) while exposing the original 101 to
 * the test assertions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableObjectState, WebSocket } from '@cloudflare/workers-types';
import { RelaySessionDO } from './relay-do';
import type { Env } from './worker-middleware';

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

beforeEach(() => {
  vi.stubGlobal('Response', WorkersStyleResponse);
  vi.stubGlobal('WebSocketPair', FakeWebSocketPair);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeDO(): RelaySessionDO {
  const state = {} as DurableObjectState;
  const env = {} as Env;
  return new RelaySessionDO(state, env);
}

function wsRequest(role?: 'pushd' | 'phone'): Request {
  const url = new URL('https://example.com/');
  if (role) url.searchParams.set('role', role);
  return new Request(url.toString(), { headers: { Upgrade: 'websocket' } });
}

describe('RelaySessionDO.fetch', () => {
  it('returns 426 when the request is not a WebSocket upgrade', async () => {
    const doInstance = makeDO();
    const res = await doInstance.fetch(new Request('https://example.com/'));
    expect(res.status).toBe(426);
    expect(doInstance.getConnectionCount()).toBe(0);
  });

  it('returns 500 when role query param is missing (route handler must tag)', async () => {
    const doInstance = makeDO();
    const res = await doInstance.fetch(wsRequest());
    expect(res.status).toBe(500);
    expect(doInstance.getConnectionCount()).toBe(0);
  });

  it('returns 101 and registers a phone connection on WS upgrade with role=phone', async () => {
    const doInstance = makeDO();
    const res = await doInstance.fetch(wsRequest('phone'));
    expect(res.status).toBe(101);
    expect(res.headers.get('Sec-WebSocket-Protocol')).toBe('push.relay.v1');
    expect(doInstance.getRoleCounts()).toEqual({ pushd: 0, phone: 1 });
  });

  it('returns 101 and registers a pushd connection on WS upgrade with role=pushd', async () => {
    const doInstance = makeDO();
    const res = await doInstance.fetch(wsRequest('pushd'));
    expect(res.status).toBe(101);
    expect(doInstance.getRoleCounts()).toEqual({ pushd: 1, phone: 0 });
  });

  it('returns 409 when a second pushd tries to attach to the same session', async () => {
    const doInstance = makeDO();
    await doInstance.fetch(wsRequest('pushd'));
    const res = await doInstance.fetch(wsRequest('pushd'));
    expect(res.status).toBe(409);
    expect(doInstance.getRoleCounts()).toEqual({ pushd: 1, phone: 0 });
  });
});

describe('RelaySessionDO.acceptConnection', () => {
  it('registers the WebSocket with its role and calls accept()', () => {
    const doInstance = makeDO();
    const ws = new FakeWebSocket();
    doInstance.acceptConnection(ws as unknown as WebSocket, 'phone');
    expect(ws.readyState).toBe(1);
    expect(doInstance.getRoleCounts()).toEqual({ pushd: 0, phone: 1 });
  });

  it('deregisters the connection on close', () => {
    const doInstance = makeDO();
    const ws = new FakeWebSocket();
    doInstance.acceptConnection(ws as unknown as WebSocket, 'phone');
    ws.close();
    expect(doInstance.getConnectionCount()).toBe(0);
  });

  it('deregisters the connection on error', () => {
    const doInstance = makeDO();
    const ws = new FakeWebSocket();
    doInstance.acceptConnection(ws as unknown as WebSocket, 'pushd');
    ws.dispatch('error', new Error('boom'));
    expect(doInstance.getConnectionCount()).toBe(0);
  });

  it('tracks multiple independent connections', () => {
    const doInstance = makeDO();
    const wsA = new FakeWebSocket();
    const wsB = new FakeWebSocket();
    doInstance.acceptConnection(wsA as unknown as WebSocket, 'pushd');
    doInstance.acceptConnection(wsB as unknown as WebSocket, 'phone');
    expect(doInstance.getRoleCounts()).toEqual({ pushd: 1, phone: 1 });

    wsA.close();
    expect(doInstance.getRoleCounts()).toEqual({ pushd: 0, phone: 1 });

    wsB.close();
    expect(doInstance.getConnectionCount()).toBe(0);
  });
});

describe('RelaySessionDO.forwardMessage', () => {
  it('forwards pushd → all phones, but not back to pushd itself', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phoneA = new FakeWebSocket();
    const phoneB = new FakeWebSocket();
    doInstance.acceptConnection(pushd as unknown as WebSocket, 'pushd');
    doInstance.acceptConnection(phoneA as unknown as WebSocket, 'phone');
    doInstance.acceptConnection(phoneB as unknown as WebSocket, 'phone');

    const sendA = vi.spyOn(phoneA, 'send');
    const sendB = vi.spyOn(phoneB, 'send');
    const sendPushd = vi.spyOn(pushd, 'send');

    pushd.dispatch('message', { data: '{"kind":"hello"}' });

    expect(sendA).toHaveBeenCalledWith('{"kind":"hello"}');
    expect(sendB).toHaveBeenCalledWith('{"kind":"hello"}');
    expect(sendPushd).not.toHaveBeenCalled();
  });

  it('forwards phone → pushd, but not back to phone itself', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phone = new FakeWebSocket();
    doInstance.acceptConnection(pushd as unknown as WebSocket, 'pushd');
    doInstance.acceptConnection(phone as unknown as WebSocket, 'phone');

    const sendPushd = vi.spyOn(pushd, 'send');
    const sendPhone = vi.spyOn(phone, 'send');

    phone.dispatch('message', { data: '{"kind":"submit_approval"}' });

    expect(sendPushd).toHaveBeenCalledWith('{"kind":"submit_approval"}');
    expect(sendPhone).not.toHaveBeenCalled();
  });

  it('drops phone messages when no pushd is attached', () => {
    const doInstance = makeDO();
    const phone = new FakeWebSocket();
    doInstance.acceptConnection(phone as unknown as WebSocket, 'phone');

    const sendPhone = vi.spyOn(phone, 'send');

    phone.dispatch('message', { data: '{"kind":"hello"}' });

    expect(sendPhone).not.toHaveBeenCalled();
  });

  it('drops pushd messages when no phones are attached', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    doInstance.acceptConnection(pushd as unknown as WebSocket, 'pushd');

    const sendPushd = vi.spyOn(pushd, 'send');

    pushd.dispatch('message', { data: '{"kind":"hello"}' });

    expect(sendPushd).not.toHaveBeenCalled();
  });
});
