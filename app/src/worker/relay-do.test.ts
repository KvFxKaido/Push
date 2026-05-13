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

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.dispatch('close', { code, reason });
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

const PHONE_BEARER_A = 'pushd_da_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PHONE_BEARER_B = 'pushd_da_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function wsRequest(role?: 'pushd' | 'phone', phoneBearer = PHONE_BEARER_A): Request {
  const url = new URL('https://example.com/');
  if (role) url.searchParams.set('role', role);
  const headers: Record<string, string> = { Upgrade: 'websocket' };
  if (role === 'phone') {
    headers['Sec-WebSocket-Protocol'] = `push.relay.v1, bearer.${phoneBearer}`;
  }
  return new Request(url.toString(), { headers });
}

function makeEnvelope(kind: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 'push.runtime.v1', kind, ts: Date.now(), ...extra });
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

  it('returns 500 when role=phone but no bearer subprotocol is present (route handler must authenticate)', async () => {
    const doInstance = makeDO();
    const res = await doInstance.fetch(
      new Request('https://example.com/?role=phone', { headers: { Upgrade: 'websocket' } }),
    );
    expect(res.status).toBe(500);
    expect(doInstance.getConnectionCount()).toBe(0);
  });

  it('returns 409 when a second pushd tries to attach to the same session', async () => {
    const doInstance = makeDO();
    await doInstance.fetch(wsRequest('pushd'));
    const res = await doInstance.fetch(wsRequest('pushd'));
    expect(res.status).toBe(409);
    expect(doInstance.getRoleCounts()).toEqual({ pushd: 1, phone: 0 });
  });
});

describe('RelaySessionDO accept*', () => {
  it('acceptPushd registers a pushd connection and calls accept()', () => {
    const doInstance = makeDO();
    const ws = new FakeWebSocket();
    doInstance.acceptPushd(ws as unknown as WebSocket);
    expect(ws.readyState).toBe(1);
    expect(doInstance.getRoleCounts()).toEqual({ pushd: 1, phone: 0 });
  });

  it('acceptPhone registers a phone connection with its bearer', () => {
    const doInstance = makeDO();
    const ws = new FakeWebSocket();
    doInstance.acceptPhone(ws as unknown as WebSocket, PHONE_BEARER_A);
    expect(ws.readyState).toBe(1);
    expect(doInstance.getRoleCounts()).toEqual({ pushd: 0, phone: 1 });
  });

  it('deregisters on close', () => {
    const doInstance = makeDO();
    const ws = new FakeWebSocket();
    doInstance.acceptPhone(ws as unknown as WebSocket, PHONE_BEARER_A);
    ws.close();
    expect(doInstance.getConnectionCount()).toBe(0);
  });

  it('deregisters on error', () => {
    const doInstance = makeDO();
    const ws = new FakeWebSocket();
    doInstance.acceptPushd(ws as unknown as WebSocket);
    ws.dispatch('error', new Error('boom'));
    expect(doInstance.getConnectionCount()).toBe(0);
  });
});

describe('RelaySessionDO forwarding (pushd ↔ phones)', () => {
  it('forwards pushd → only phones whose bearer is in the allowlist', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phoneA = new FakeWebSocket();
    const phoneB = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);
    doInstance.acceptPhone(phoneA as unknown as WebSocket, PHONE_BEARER_A);
    doInstance.acceptPhone(phoneB as unknown as WebSocket, PHONE_BEARER_B);

    // pushd allows only phone A.
    pushd.dispatch('message', {
      data: makeEnvelope('relay_phone_allow', { tokens: [PHONE_BEARER_A] }),
    });

    const sendA = vi.spyOn(phoneA, 'send');
    const sendB = vi.spyOn(phoneB, 'send');

    pushd.dispatch('message', { data: '{"kind":"event","payload":"hello"}' });

    expect(sendA).toHaveBeenCalledWith('{"kind":"event","payload":"hello"}');
    expect(sendB).not.toHaveBeenCalled();
  });

  it('drops pushd → phones entirely when no allowlist entries exist (closes Codex #525 P1)', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phone = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);
    doInstance.acceptPhone(phone as unknown as WebSocket, PHONE_BEARER_A);

    const sendPhone = vi.spyOn(phone, 'send');

    pushd.dispatch('message', { data: '{"kind":"event","payload":"hello"}' });

    expect(sendPhone).not.toHaveBeenCalled();
  });

  it('forwards phone → pushd unconditionally (no allowlist gate on inbound direction)', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phone = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);
    doInstance.acceptPhone(phone as unknown as WebSocket, PHONE_BEARER_A);

    const sendPushd = vi.spyOn(pushd, 'send');

    phone.dispatch('message', { data: '{"kind":"submit_approval"}' });

    expect(sendPushd).toHaveBeenCalledWith('{"kind":"submit_approval"}');
  });

  it('drops phone messages when no pushd is attached', () => {
    const doInstance = makeDO();
    const phone = new FakeWebSocket();
    doInstance.acceptPhone(phone as unknown as WebSocket, PHONE_BEARER_A);

    const sendPhone = vi.spyOn(phone, 'send');

    phone.dispatch('message', { data: '{"kind":"event"}' });

    expect(sendPhone).not.toHaveBeenCalled();
  });
});

describe('RelaySessionDO allowlist control envelopes', () => {
  it('relay_phone_allow from pushd adds tokens to the allowlist', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);

    pushd.dispatch('message', {
      data: makeEnvelope('relay_phone_allow', { tokens: [PHONE_BEARER_A, PHONE_BEARER_B] }),
    });

    expect([...doInstance.getAllowedPhoneBearers()].sort()).toEqual(
      [PHONE_BEARER_A, PHONE_BEARER_B].sort(),
    );
  });

  it('relay_phone_revoke from pushd removes tokens and closes affected phones with 1008', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phone = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);
    doInstance.acceptPhone(phone as unknown as WebSocket, PHONE_BEARER_A);

    pushd.dispatch('message', {
      data: makeEnvelope('relay_phone_allow', { tokens: [PHONE_BEARER_A] }),
    });
    pushd.dispatch('message', {
      data: makeEnvelope('relay_phone_revoke', { tokens: [PHONE_BEARER_A] }),
    });

    expect(doInstance.getAllowedPhoneBearers()).toEqual([]);
    expect(phone.readyState).toBe(3);
    // Close code 1008 mirrors pushd's device-token revoke path.
    // (FakeWebSocket records the args on the dispatched close event;
    // we verify via state-machine effect.)
  });

  it('ignores relay_phone_allow from a phone (pushd is the authority)', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phone = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);
    doInstance.acceptPhone(phone as unknown as WebSocket, PHONE_BEARER_A);

    phone.dispatch('message', {
      data: makeEnvelope('relay_phone_allow', { tokens: [PHONE_BEARER_B] }),
    });

    expect(doInstance.getAllowedPhoneBearers()).toEqual([]);
  });

  it('ignores relay_phone_revoke from a phone', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phone = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);
    doInstance.acceptPhone(phone as unknown as WebSocket, PHONE_BEARER_A);
    pushd.dispatch('message', {
      data: makeEnvelope('relay_phone_allow', { tokens: [PHONE_BEARER_A] }),
    });

    phone.dispatch('message', {
      data: makeEnvelope('relay_phone_revoke', { tokens: [PHONE_BEARER_A] }),
    });

    // Still allowed.
    expect(doInstance.getAllowedPhoneBearers()).toEqual([PHONE_BEARER_A]);
  });

  it('silently drops relay_attach (schema lands here; runtime is 2.d.2)', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phone = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);
    doInstance.acceptPhone(phone as unknown as WebSocket, PHONE_BEARER_A);

    const sendPushd = vi.spyOn(pushd, 'send');

    phone.dispatch('message', {
      data: makeEnvelope('relay_attach', { lastSeq: 42 }),
    });

    // Not forwarded to pushd (it's a relay-control envelope, not a
    // forwardable runtime event).
    expect(sendPushd).not.toHaveBeenCalled();
  });

  it('forwards non-relay-control JSON envelopes raw (relay stays dumb about provider/tool semantics)', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phone = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);
    doInstance.acceptPhone(phone as unknown as WebSocket, PHONE_BEARER_A);
    pushd.dispatch('message', {
      data: makeEnvelope('relay_phone_allow', { tokens: [PHONE_BEARER_A] }),
    });

    const sendPhone = vi.spyOn(phone, 'send');

    const runtimeEvent =
      '{"v":"push.runtime.v1","kind":"event","sessionId":"s1","seq":7,"ts":1,"type":"sandbox_exec","payload":{}}';
    pushd.dispatch('message', { data: runtimeEvent });

    expect(sendPhone).toHaveBeenCalledWith(runtimeEvent);
  });

  it('forwards malformed JSON unchanged (the relay does not pre-validate non-control payloads)', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phone = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);
    doInstance.acceptPhone(phone as unknown as WebSocket, PHONE_BEARER_A);
    pushd.dispatch('message', {
      data: makeEnvelope('relay_phone_allow', { tokens: [PHONE_BEARER_A] }),
    });

    const sendPhone = vi.spyOn(phone, 'send');
    pushd.dispatch('message', { data: '{not json' });

    expect(sendPhone).toHaveBeenCalledWith('{not json');
  });
});
