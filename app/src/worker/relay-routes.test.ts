/**
 * Unit tests for `matchRelayRoute` and `handleRelayRequest` (Phase 2.b).
 *
 * Covers the path matcher, the feature-flag gate, the
 * NOT_CONFIGURED gate, and that a flag-on + bound + ws-upgrade request
 * resolves a DO via `idFromName(sessionId)` and forwards to it.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  DurableObjectId,
  DurableObjectNamespace,
  DurableObjectStub,
} from '@cloudflare/workers-types';
import { handleRelayRequest, matchRelayRoute } from './relay-routes';
import type { Env } from './worker-middleware';

describe('matchRelayRoute', () => {
  it('matches the connect path under GET', () => {
    expect(matchRelayRoute('/api/relay/v1/session/abc/connect', 'GET')).toEqual({
      action: 'connect',
      sessionId: 'abc',
    });
  });

  it('rejects non-GET methods on connect', () => {
    expect(matchRelayRoute('/api/relay/v1/session/abc/connect', 'POST')).toBeNull();
  });

  it('rejects paths outside the relay prefix', () => {
    expect(matchRelayRoute('/api/jobs/abc/connect', 'GET')).toBeNull();
  });

  it('rejects malformed segments under the prefix', () => {
    expect(matchRelayRoute('/api/relay/v1/session/abc', 'GET')).toBeNull();
    expect(matchRelayRoute('/api/relay/v1/session/abc/disconnect', 'GET')).toBeNull();
    expect(matchRelayRoute('/api/relay/v1/connect', 'GET')).toBeNull();
  });
});

function makeRelayBinding(stubFetch: (req: Request) => Promise<Response>): {
  binding: DurableObjectNamespace;
  idFromName: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} {
  const idFromName = vi.fn((name: string) => ({ name }) as unknown as DurableObjectId);
  const get = vi.fn(
    () =>
      ({
        fetch: vi.fn(stubFetch),
      }) as unknown as DurableObjectStub,
  );
  return {
    binding: { idFromName, get } as unknown as DurableObjectNamespace,
    idFromName,
    get,
  };
}

describe('handleRelayRequest', () => {
  const wsRequest = () =>
    new Request('https://example.com/api/relay/v1/session/s1/connect', {
      headers: { Upgrade: 'websocket' },
    });

  it('returns 503 NOT_ENABLED when PUSH_RELAY_ENABLED is unset', async () => {
    const env = {} as Env;
    const res = await handleRelayRequest(wsRequest(), env, {
      action: 'connect',
      sessionId: 's1',
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('NOT_ENABLED');
  });

  it('returns 503 NOT_CONFIGURED when the binding is missing despite the flag', async () => {
    const env = { PUSH_RELAY_ENABLED: '1' } as Env;
    const res = await handleRelayRequest(wsRequest(), env, {
      action: 'connect',
      sessionId: 's1',
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('NOT_CONFIGURED');
  });

  it('returns 426 when the flag and binding are set but the request is not a WS upgrade', async () => {
    const { binding } = makeRelayBinding(async () => new Response(null, { status: 200 }));
    const env = { PUSH_RELAY_ENABLED: '1', RELAY_SESSIONS: binding } as Env;
    const res = await handleRelayRequest(
      new Request('https://example.com/api/relay/v1/session/s1/connect'),
      env,
      { action: 'connect', sessionId: 's1' },
    );
    expect(res.status).toBe(426);
  });

  it('forwards a WS upgrade to the DO resolved via idFromName(sessionId)', async () => {
    // The stub returns 200 (not the real 101) because the DOM Response
    // constructor in node rejects status < 200. Real Workers Response
    // accepts 101 for upgrades; the stub here is only proving the
    // handler invokes the DO, not the upgrade semantics (those are
    // exercised in relay-do.test.ts via the WebSocketPair polyfill).
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const { binding, idFromName, get } = makeRelayBinding(stubFetch);
    const env = { PUSH_RELAY_ENABLED: '1', RELAY_SESSIONS: binding } as Env;

    const res = await handleRelayRequest(wsRequest(), env, {
      action: 'connect',
      sessionId: 's1',
    });

    expect(res.status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith('s1');
    expect(get).toHaveBeenCalledTimes(1);
    expect(stubFetch).toHaveBeenCalledTimes(1);
  });

  it('routes two requests with the same sessionId to the same DO id', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const { binding, idFromName } = makeRelayBinding(stubFetch);
    const env = { PUSH_RELAY_ENABLED: '1', RELAY_SESSIONS: binding } as Env;

    await handleRelayRequest(wsRequest(), env, { action: 'connect', sessionId: 'shared' });
    await handleRelayRequest(wsRequest(), env, { action: 'connect', sessionId: 'shared' });

    expect(idFromName).toHaveBeenCalledTimes(2);
    expect(idFromName).toHaveBeenNthCalledWith(1, 'shared');
    expect(idFromName).toHaveBeenNthCalledWith(2, 'shared');
  });
});
