/**
 * Unit tests for `matchRelayRoute` and `handleRelayRequest` (Phase 2.c).
 *
 * Covers the path matcher, every per-route gate
 * (PUSH_RELAY_ENABLED → binding → origin → rate limit → upgrade →
 * bearer auth), and that authenticated requests forward to the DO
 * with the `?role=` query param tagging the connection side.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  DurableObjectId,
  DurableObjectNamespace,
  DurableObjectStub,
  RateLimit,
} from '@cloudflare/workers-types';
import { handleRelayRequest, matchRelayRoute } from './relay-routes';
import type { Env } from './worker-middleware';

const VALID_RELAY_TOKEN = 'pushd_relay_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const VALID_PHONE_TOKEN = 'pushd_da_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PUSHD_BEARER_HEADER = `push.relay.v1, bearer.${VALID_RELAY_TOKEN}`;
const PHONE_BEARER_HEADER = `push.relay.v1, bearer.${VALID_PHONE_TOKEN}`;

function makePassingRateLimiter(): RateLimit {
  return {
    limit: vi.fn(async () => ({ success: true })),
  } as unknown as RateLimit;
}

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
  fetchSpy: ReturnType<typeof vi.fn>;
} {
  const idFromName = vi.fn((name: string) => ({ name }) as unknown as DurableObjectId);
  const fetchSpy = vi.fn(stubFetch);
  const get = vi.fn(
    () =>
      ({
        fetch: fetchSpy,
      }) as unknown as DurableObjectStub,
  );
  return {
    binding: { idFromName, get } as unknown as DurableObjectNamespace,
    idFromName,
    get,
    fetchSpy,
  };
}

function makeEnabledEnv(
  stubFetch: (req: Request) => Promise<Response> = async () => new Response(null, { status: 200 }),
  overrides: Partial<Env> = {},
) {
  const { binding, idFromName, get, fetchSpy } = makeRelayBinding(stubFetch);
  const env = {
    PUSH_RELAY_ENABLED: '1',
    RELAY_SESSIONS: binding,
    RATE_LIMITER: makePassingRateLimiter(),
    PUSH_RELAY_TOKEN: VALID_RELAY_TOKEN,
    ...overrides,
  } as Env;
  return { env, idFromName, get, fetchSpy };
}

describe('handleRelayRequest', () => {
  // Same-origin: getAllowedOrigins always includes the request URL's
  // own origin, so setting Origin to the request host passes
  // validateOrigin without needing an ALLOWED_ORIGINS env var.
  const wsRequest = (headers: Record<string, string> = {}) =>
    new Request('https://example.com/api/relay/v1/session/s1/connect', {
      headers: {
        Upgrade: 'websocket',
        Origin: 'https://example.com',
        'Sec-WebSocket-Protocol': PHONE_BEARER_HEADER,
        ...headers,
      },
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

  it('returns 403 ORIGIN_REJECTED when Origin is absent', async () => {
    const { env } = makeEnabledEnv();
    const res = await handleRelayRequest(
      new Request('https://example.com/api/relay/v1/session/s1/connect', {
        headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PHONE_BEARER_HEADER },
      }),
      env,
      { action: 'connect', sessionId: 's1' },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('ORIGIN_REJECTED');
  });

  it('returns 403 ORIGIN_REJECTED when Origin is cross-origin and not allowlisted', async () => {
    const { env } = makeEnabledEnv();
    const res = await handleRelayRequest(wsRequest({ Origin: 'https://evil.example' }), env, {
      action: 'connect',
      sessionId: 's1',
    });
    expect(res.status).toBe(403);
  });

  it('returns 429 RATE_LIMITED when the rate limiter rejects', async () => {
    const rateLimiter = {
      limit: vi.fn(async () => ({ success: false })),
    } as unknown as RateLimit;
    const { env } = makeEnabledEnv(undefined, { RATE_LIMITER: rateLimiter });
    const res = await handleRelayRequest(wsRequest(), env, {
      action: 'connect',
      sessionId: 's1',
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
  });

  it('returns 426 when the request is not a WS upgrade', async () => {
    const { env } = makeEnabledEnv();
    const res = await handleRelayRequest(
      new Request('https://example.com/api/relay/v1/session/s1/connect', {
        headers: { Origin: 'https://example.com', 'Sec-WebSocket-Protocol': PHONE_BEARER_HEADER },
      }),
      env,
      { action: 'connect', sessionId: 's1' },
    );
    expect(res.status).toBe(426);
  });

  it('returns 401 BEARER_MISSING when Sec-WebSocket-Protocol is absent', async () => {
    const { env } = makeEnabledEnv();
    const res = await handleRelayRequest(
      new Request('https://example.com/api/relay/v1/session/s1/connect', {
        headers: { Upgrade: 'websocket', Origin: 'https://example.com' },
      }),
      env,
      { action: 'connect', sessionId: 's1' },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('BEARER_MISSING');
  });

  it('returns 401 BEARER_MISSING when protocol is present but bearer entry is not', async () => {
    const { env } = makeEnabledEnv();
    const res = await handleRelayRequest(
      wsRequest({ 'Sec-WebSocket-Protocol': 'push.relay.v1' }),
      env,
      { action: 'connect', sessionId: 's1' },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('BEARER_MISSING');
  });

  it('returns 401 BEARER_REJECTED for unknown bearer prefix', async () => {
    const { env } = makeEnabledEnv();
    const res = await handleRelayRequest(
      wsRequest({ 'Sec-WebSocket-Protocol': 'push.relay.v1, bearer.foo_bar_xxxxxxxxxxxxxxxx' }),
      env,
      { action: 'connect', sessionId: 's1' },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('BEARER_REJECTED');
  });

  it('returns 401 BEARER_REJECTED when pushd bearer does not match PUSH_RELAY_TOKEN', async () => {
    const { env } = makeEnabledEnv();
    const res = await handleRelayRequest(
      wsRequest({
        'Sec-WebSocket-Protocol': 'push.relay.v1, bearer.pushd_relay_wrongwrongwrongwrong',
      }),
      env,
      { action: 'connect', sessionId: 's1' },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('BEARER_REJECTED');
  });

  it('returns 401 RELAY_TOKEN_NOT_CONFIGURED when pushd bearer arrives without env.PUSH_RELAY_TOKEN', async () => {
    const { env } = makeEnabledEnv(undefined, { PUSH_RELAY_TOKEN: undefined });
    const res = await handleRelayRequest(
      wsRequest({ 'Sec-WebSocket-Protocol': PUSHD_BEARER_HEADER }),
      env,
      { action: 'connect', sessionId: 's1' },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('RELAY_TOKEN_NOT_CONFIGURED');
  });

  it('returns 401 BEARER_REJECTED when phone token is too short', async () => {
    const { env } = makeEnabledEnv();
    const res = await handleRelayRequest(
      wsRequest({ 'Sec-WebSocket-Protocol': 'push.relay.v1, bearer.pushd_da_short' }),
      env,
      { action: 'connect', sessionId: 's1' },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('BEARER_REJECTED');
  });

  it('forwards a valid phone bearer to the DO with role=phone', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const { env, idFromName, fetchSpy } = makeEnabledEnv(stubFetch);
    const res = await handleRelayRequest(wsRequest(), env, {
      action: 'connect',
      sessionId: 's1',
    });
    expect(res.status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith('s1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const forwarded = fetchSpy.mock.calls[0]?.[0] as Request;
    const forwardedUrl = new URL(forwarded.url);
    expect(forwardedUrl.searchParams.get('role')).toBe('phone');
  });

  it('forwards a valid pushd bearer to the DO with role=pushd', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const { env, fetchSpy } = makeEnabledEnv(stubFetch);
    const res = await handleRelayRequest(
      wsRequest({ 'Sec-WebSocket-Protocol': PUSHD_BEARER_HEADER }),
      env,
      { action: 'connect', sessionId: 's1' },
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const forwarded = fetchSpy.mock.calls[0]?.[0] as Request;
    const forwardedUrl = new URL(forwarded.url);
    expect(forwardedUrl.searchParams.get('role')).toBe('pushd');
  });

  it('routes two requests with the same sessionId to the same DO id', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const { env, idFromName } = makeEnabledEnv(stubFetch);

    await handleRelayRequest(wsRequest(), env, { action: 'connect', sessionId: 'shared' });
    await handleRelayRequest(wsRequest(), env, { action: 'connect', sessionId: 'shared' });

    expect(idFromName).toHaveBeenCalledTimes(2);
    expect(idFromName).toHaveBeenNthCalledWith(1, 'shared');
    expect(idFromName).toHaveBeenNthCalledWith(2, 'shared');
  });
});
