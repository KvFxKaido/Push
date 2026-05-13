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

  it('forwards phone → pushd only when phone bearer is in the allowlist (Codex #526 P1)', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phone = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);
    doInstance.acceptPhone(phone as unknown as WebSocket, PHONE_BEARER_A);
    pushd.dispatch('message', {
      data: makeEnvelope('relay_phone_allow', { tokens: [PHONE_BEARER_A] }),
    });

    const sendPushd = vi.spyOn(pushd, 'send');

    phone.dispatch('message', { data: '{"kind":"submit_approval"}' });

    expect(sendPushd).toHaveBeenCalledWith('{"kind":"submit_approval"}');
  });

  it('drops phone → pushd when phone bearer is NOT in the allowlist', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phone = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);
    doInstance.acceptPhone(phone as unknown as WebSocket, PHONE_BEARER_A);
    // No relay_phone_allow sent — phone's bearer is not in allowlist.

    const sendPushd = vi.spyOn(pushd, 'send');

    phone.dispatch('message', { data: '{"kind":"submit_approval"}' });

    expect(sendPushd).not.toHaveBeenCalled();
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

    const closeSpy = vi.spyOn(phone, 'close');

    pushd.dispatch('message', {
      data: makeEnvelope('relay_phone_allow', { tokens: [PHONE_BEARER_A] }),
    });
    pushd.dispatch('message', {
      data: makeEnvelope('relay_phone_revoke', { tokens: [PHONE_BEARER_A] }),
    });

    expect(doInstance.getAllowedPhoneBearers()).toEqual([]);
    // Assert the exact close args: 1008 = policy violation; reason
    // mirrors pushd's device-token revoke path.
    expect(closeSpy).toHaveBeenCalledWith(1008, 'phone bearer revoked');
    expect(phone.readyState).toBe(3);
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

  it('drops malformed relay-control envelopes instead of forwarding (does not leak reserved vocab)', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phone = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);
    doInstance.acceptPhone(phone as unknown as WebSocket, PHONE_BEARER_A);
    pushd.dispatch('message', {
      data: makeEnvelope('relay_phone_allow', { tokens: [PHONE_BEARER_A] }),
    });

    const sendPhone = vi.spyOn(phone, 'send');

    // relay_phone_allow with no `tokens` field — kind matches but
    // validation fails. The frame must be dropped (not forwarded
    // raw), to keep the reserved vocab off the wire to phones.
    pushd.dispatch('message', {
      data: JSON.stringify({ v: 'push.runtime.v1', kind: 'relay_phone_allow', ts: 1 }),
    });

    expect(sendPhone).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// Phase 2.d.2 ring buffer + replay
// ---------------------------------------------------------------------------

function makeEventEnvelope(seq: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 'push.runtime.v1',
    kind: 'event',
    sessionId: 'sess_test',
    seq,
    ts: Date.now(),
    type: 'test.event',
    payload: { n: seq },
    ...extra,
  });
}

function makeDOWithEnv(env: Partial<Env>): RelaySessionDO {
  const state = {} as DurableObjectState;
  return new RelaySessionDO(state, env as Env);
}

describe('RelaySessionDO — ring buffer (2.d.2)', () => {
  it('buffers pushd-originated event envelopes with numeric seq', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);

    pushd.dispatch('message', { data: makeEventEnvelope(1) });
    pushd.dispatch('message', { data: makeEventEnvelope(2) });
    pushd.dispatch('message', { data: makeEventEnvelope(3) });

    const snapshot = doInstance.getBufferSnapshot();
    expect(snapshot.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('does NOT buffer non-event envelopes (responses, relay-control, etc.)', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phone = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);
    doInstance.acceptPhone(phone as unknown as WebSocket, PHONE_BEARER_A);
    pushd.dispatch('message', {
      data: makeEnvelope('relay_phone_allow', { tokens: [PHONE_BEARER_A] }),
    });

    // A response envelope (kind: 'response') — forwarded but not buffered.
    pushd.dispatch('message', {
      data: JSON.stringify({
        v: 'push.runtime.v1',
        kind: 'response',
        requestId: 'req_x',
        type: 'ping',
        sessionId: 'sess_test',
        ok: true,
        payload: {},
        error: null,
      }),
    });
    // An event envelope without numeric seq — forwarded but not buffered.
    pushd.dispatch('message', {
      data: JSON.stringify({
        v: 'push.runtime.v1',
        kind: 'event',
        sessionId: 'sess_test',
        seq: 'not-a-number',
        ts: Date.now(),
        type: 'malformed',
        payload: {},
      }),
    });

    expect(doInstance.getBufferSnapshot()).toEqual([]);
  });

  it('does NOT buffer phone-originated frames (only pushd → phones is replayable)', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phone = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);
    doInstance.acceptPhone(phone as unknown as WebSocket, PHONE_BEARER_A);
    pushd.dispatch('message', {
      data: makeEnvelope('relay_phone_allow', { tokens: [PHONE_BEARER_A] }),
    });

    // Phone emits something that LOOKS like an event envelope. It
    // would be malformed protocol, but the test asserts the relay
    // doesn't accidentally buffer it just because it's a valid
    // envelope shape — only pushd-originated forwards land in the
    // replay buffer.
    phone.dispatch('message', { data: makeEventEnvelope(99) });
    expect(doInstance.getBufferSnapshot()).toEqual([]);
  });

  it('evicts oldest by count when the buffer overflows the cap', () => {
    const doInstance = makeDOWithEnv({ PUSH_RELAY_BUFFER_COUNT: '3' });
    const pushd = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);

    for (let seq = 1; seq <= 5; seq++) {
      pushd.dispatch('message', { data: makeEventEnvelope(seq) });
    }
    const snapshot = doInstance.getBufferSnapshot();
    // With cap=3, the last 3 inserts (seq 3, 4, 5) survive; 1+2 evicted.
    expect(snapshot.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('evicts by age when entries get stale', () => {
    vi.useFakeTimers();
    try {
      const doInstance = makeDOWithEnv({ PUSH_RELAY_BUFFER_AGE_MS: '1000' });
      const pushd = new FakeWebSocket();
      doInstance.acceptPushd(pushd as unknown as WebSocket);

      vi.setSystemTime(new Date('2026-05-13T12:00:00Z'));
      pushd.dispatch('message', { data: makeEventEnvelope(1) });
      pushd.dispatch('message', { data: makeEventEnvelope(2) });
      // Advance past the age cap, then push another. Eviction runs on
      // every insert; the two prior entries are now older than 1000ms
      // and get dropped.
      vi.setSystemTime(new Date('2026-05-13T12:00:01.500Z'));
      pushd.dispatch('message', { data: makeEventEnvelope(3) });

      expect(doInstance.getBufferSnapshot().map((e) => e.seq)).toEqual([3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors PUSH_RELAY_BUFFER_COUNT and PUSH_RELAY_BUFFER_AGE_MS env overrides', () => {
    const doInstance = makeDOWithEnv({
      PUSH_RELAY_BUFFER_COUNT: '42',
      PUSH_RELAY_BUFFER_AGE_MS: '500',
    });
    expect(doInstance.getBufferConfig()).toEqual({ count: 42, ageMs: 500 });
  });

  it('falls back to defaults when env values are malformed (negative, NaN, fractional)', () => {
    expect(makeDOWithEnv({}).getBufferConfig()).toEqual({ count: 256, ageMs: 60_000 });
    expect(
      makeDOWithEnv({
        PUSH_RELAY_BUFFER_COUNT: '-5',
        PUSH_RELAY_BUFFER_AGE_MS: 'oops',
      }).getBufferConfig(),
    ).toEqual({ count: 256, ageMs: 60_000 });
    expect(
      makeDOWithEnv({
        PUSH_RELAY_BUFFER_COUNT: '1.5',
        PUSH_RELAY_BUFFER_AGE_MS: '0',
      }).getBufferConfig(),
    ).toEqual({ count: 256, ageMs: 60_000 });
  });
});

describe('RelaySessionDO — relay_attach replay (2.d.2)', () => {
  it('replays buffered envelopes after lastSeq to the reattaching phone', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phone = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);
    doInstance.acceptPhone(phone as unknown as WebSocket, PHONE_BEARER_A);
    pushd.dispatch('message', {
      data: makeEnvelope('relay_phone_allow', { tokens: [PHONE_BEARER_A] }),
    });

    // Buffer events 1..5.
    for (let seq = 1; seq <= 5; seq++) {
      pushd.dispatch('message', { data: makeEventEnvelope(seq) });
    }

    const sendPhone = vi.spyOn(phone, 'send');
    phone.dispatch('message', {
      data: makeEnvelope('relay_attach', { lastSeq: 2 }),
    });

    // Replays seq 3, 4, 5 in order. FakeWebSocket.send is typed
    // `(): void` so the spy's call-args tuple infers as `[]`; cast
    // through unknown to read the first arg.
    const calls = sendPhone.mock.calls as unknown as Array<[string]>;
    const replayed = calls.map((args) => args[0]);
    expect(replayed).toHaveLength(3);
    expect(replayed[0]).toContain('"seq":3');
    expect(replayed[1]).toContain('"seq":4');
    expect(replayed[2]).toContain('"seq":5');
  });

  it('does not replay anything when relay_attach omits lastSeq (fresh-session shape)', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phone = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);
    doInstance.acceptPhone(phone as unknown as WebSocket, PHONE_BEARER_A);
    pushd.dispatch('message', {
      data: makeEnvelope('relay_phone_allow', { tokens: [PHONE_BEARER_A] }),
    });

    pushd.dispatch('message', { data: makeEventEnvelope(1) });
    pushd.dispatch('message', { data: makeEventEnvelope(2) });

    const sendPhone = vi.spyOn(phone, 'send');
    phone.dispatch('message', { data: makeEnvelope('relay_attach') });

    expect(sendPhone).not.toHaveBeenCalled();
  });

  it('does not replay when the phone is already past the tip', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phone = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);
    doInstance.acceptPhone(phone as unknown as WebSocket, PHONE_BEARER_A);
    pushd.dispatch('message', {
      data: makeEnvelope('relay_phone_allow', { tokens: [PHONE_BEARER_A] }),
    });

    pushd.dispatch('message', { data: makeEventEnvelope(1) });
    pushd.dispatch('message', { data: makeEventEnvelope(2) });

    const sendPhone = vi.spyOn(phone, 'send');
    // Phone claims to be at seq=10 (somehow ahead of the buffer's tip).
    phone.dispatch('message', { data: makeEnvelope('relay_attach', { lastSeq: 10 }) });

    expect(sendPhone).not.toHaveBeenCalled();
  });

  it('emits relay_replay_unavailable when the gap is larger than the buffer', () => {
    const doInstance = makeDOWithEnv({ PUSH_RELAY_BUFFER_COUNT: '3' });
    const pushd = new FakeWebSocket();
    const phone = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);
    doInstance.acceptPhone(phone as unknown as WebSocket, PHONE_BEARER_A);
    pushd.dispatch('message', {
      data: makeEnvelope('relay_phone_allow', { tokens: [PHONE_BEARER_A] }),
    });

    // Push 5 events with cap=3; buffer ends up holding seq 3, 4, 5.
    for (let seq = 1; seq <= 5; seq++) {
      pushd.dispatch('message', { data: makeEventEnvelope(seq) });
    }

    const sendPhone = vi.spyOn(phone, 'send');
    // Phone last saw seq=1 — gap from 2 to (buffer's min seq=3) is
    // larger than the buffer can replay. Expect `relay_replay_unavailable`.
    phone.dispatch('message', { data: makeEnvelope('relay_attach', { lastSeq: 1 }) });

    expect(sendPhone).toHaveBeenCalledTimes(1);
    const calls = sendPhone.mock.calls as unknown as Array<[string]>;
    const frame = calls[0][0];
    expect(frame).toContain('"kind":"relay_replay_unavailable"');
    expect(frame).toContain('"reason"');
  });

  it('ignores relay_attach sent by a pushd connection (protocol violation, no-op)', () => {
    const doInstance = makeDO();
    const pushd = new FakeWebSocket();
    const phone = new FakeWebSocket();
    doInstance.acceptPushd(pushd as unknown as WebSocket);
    doInstance.acceptPhone(phone as unknown as WebSocket, PHONE_BEARER_A);
    pushd.dispatch('message', {
      data: makeEnvelope('relay_phone_allow', { tokens: [PHONE_BEARER_A] }),
    });

    pushd.dispatch('message', { data: makeEventEnvelope(1) });

    const sendPhone = vi.spyOn(phone, 'send');
    const sendPushd = vi.spyOn(pushd, 'send');
    // pushd sending relay_attach is meaningless; relay drops silently.
    pushd.dispatch('message', { data: makeEnvelope('relay_attach', { lastSeq: 0 }) });

    expect(sendPhone).not.toHaveBeenCalled();
    expect(sendPushd).not.toHaveBeenCalled();
  });
});
