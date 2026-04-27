import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleJobsRoute, matchJobsRoute } from './worker-coder-job';
import type { Env } from './worker-middleware';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeStub {
  fetch: ReturnType<typeof vi.fn>;
}

function makeFakeStub(response: Response | (() => Response) = new Response('{}')): FakeStub {
  return {
    fetch: vi.fn(async () => (typeof response === 'function' ? response() : response)),
  };
}

function makeCoderJobNamespace(stub: FakeStub) {
  return {
    idFromName: vi.fn((name: string) => ({
      toString: () => name,
    })),
    get: vi.fn(() => stub as unknown),
  } as unknown as NonNullable<Env['CoderJob']>;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    RATE_LIMITER: {
      limit: vi.fn(async () => ({ success: true })),
    } as unknown as Env['RATE_LIMITER'],
    ASSETS: {} as Env['ASSETS'],
    ALLOWED_ORIGINS: 'https://push.example.test',
    ...overrides,
  };
}

function makeRequest(
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://push.example.test${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      // Default to a matching Origin so tests hit the happy path;
      // individual tests that exercise origin validation override this.
      Origin: 'https://push.example.test',
      ...headers,
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
}

function makeRequestWithoutOrigin(
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Request {
  return new Request(`https://push.example.test${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
}

// ---------------------------------------------------------------------------
// matchJobsRoute — path parser
// ---------------------------------------------------------------------------

describe('matchJobsRoute', () => {
  it('matches POST /api/jobs/start', () => {
    expect(matchJobsRoute('/api/jobs/start', 'POST')).toEqual({ action: 'start', jobId: null });
  });

  it('matches GET /api/jobs/:id (status snapshot)', () => {
    expect(matchJobsRoute('/api/jobs/abc123', 'GET')).toEqual({
      action: 'status',
      jobId: 'abc123',
    });
  });

  it('matches GET /api/jobs/:id/events', () => {
    expect(matchJobsRoute('/api/jobs/abc123/events', 'GET')).toEqual({
      action: 'events',
      jobId: 'abc123',
    });
  });

  it('matches POST /api/jobs/:id/cancel', () => {
    expect(matchJobsRoute('/api/jobs/abc123/cancel', 'POST')).toEqual({
      action: 'cancel',
      jobId: 'abc123',
    });
  });

  it('rejects non-jobs prefix', () => {
    expect(matchJobsRoute('/api/sandbox/create', 'POST')).toBeNull();
    expect(matchJobsRoute('/api/jobs', 'GET')).toBeNull();
  });

  it('rejects method mismatches', () => {
    expect(matchJobsRoute('/api/jobs/abc/events', 'POST')).toBeNull();
    expect(matchJobsRoute('/api/jobs/start', 'GET')).toBeNull();
    expect(matchJobsRoute('/api/jobs/abc/cancel', 'GET')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleJobsRoute — HTTP-level dispatch to the DO stub
// ---------------------------------------------------------------------------

describe('handleJobsRoute', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 503 NOT_CONFIGURED when env.CoderJob is missing', async () => {
    const response = await handleJobsRoute(
      makeRequest('/api/jobs/start', 'POST', validStartBody()),
      makeEnv(),
      { action: 'start', jobId: null },
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('NOT_CONFIGURED');
  });

  it('forwards POST /start to the DO with a server-generated jobId + origin', async () => {
    const stub = makeFakeStub(new Response('{"jobId":"stub-ok"}', { status: 202 }));
    const env = makeEnv({ CoderJob: makeCoderJobNamespace(stub) });
    const response = await handleJobsRoute(
      makeRequest('/api/jobs/start', 'POST', validStartBody()),
      env,
      { action: 'start', jobId: null },
    );
    expect(response.status).toBe(202);
    expect(stub.fetch).toHaveBeenCalledTimes(1);
    const forwarded = stub.fetch.mock.calls[0]![0] as Request;
    expect(forwarded.method).toBe('POST');
    expect(forwarded.url).toMatch(/\/start\?jobId=/);
    const forwardedBody = JSON.parse(await forwarded.text()) as {
      jobId: string;
      origin: string;
    };
    expect(forwardedBody.jobId).toMatch(/^[0-9a-f-]{30,}$/);
    expect(forwardedBody.origin).toBe('https://push.example.test');
  });

  it('ignores client-supplied jobId + origin on /start (SSRF + id-guess hardening)', async () => {
    const stub = makeFakeStub(new Response('{"ok":true}', { status: 202 }));
    const env = makeEnv({ CoderJob: makeCoderJobNamespace(stub) });
    const body = {
      ...validStartBody(),
      jobId: 'attacker-guessable-id',
      origin: 'https://evil.example.com',
    };
    await handleJobsRoute(makeRequest('/api/jobs/start', 'POST', body), env, {
      action: 'start',
      jobId: null,
    });
    const forwarded = stub.fetch.mock.calls[0]![0] as Request;
    const forwardedBody = JSON.parse(await forwarded.text()) as {
      jobId: string;
      origin: string;
    };
    expect(forwardedBody.jobId).not.toBe('attacker-guessable-id');
    expect(forwardedBody.jobId).toMatch(/^[0-9a-f-]{30,}$/);
    expect(forwardedBody.origin).toBe('https://push.example.test');
    expect(forwardedBody.origin).not.toBe('https://evil.example.com');
  });

  it('returns 403 when Origin header is missing', async () => {
    const stub = makeFakeStub();
    const env = makeEnv({ CoderJob: makeCoderJobNamespace(stub) });
    const response = await handleJobsRoute(
      makeRequestWithoutOrigin('/api/jobs/start', 'POST', validStartBody()),
      env,
      { action: 'start', jobId: null },
    );
    expect(response.status).toBe(403);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('returns 429 when the rate limiter rejects the request', async () => {
    const stub = makeFakeStub();
    const env = makeEnv({
      CoderJob: makeCoderJobNamespace(stub),
      RATE_LIMITER: {
        limit: vi.fn(async () => ({ success: false })),
      } as unknown as Env['RATE_LIMITER'],
    });
    const response = await handleJobsRoute(
      makeRequest('/api/jobs/start', 'POST', validStartBody()),
      env,
      { action: 'start', jobId: null },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('rejects /start with a non-object JSON body (400)', async () => {
    const stub = makeFakeStub();
    const env = makeEnv({ CoderJob: makeCoderJobNamespace(stub) });
    // Bypass makeRequest's object body — directly craft a request with a
    // JSON primitive. validateOrigin still needs Origin.
    const response = await handleJobsRoute(
      new Request('https://push.example.test/api/jobs/start', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: 'https://push.example.test',
        },
        body: 'null',
      }),
      env,
      { action: 'start', jobId: null },
    );
    expect(response.status).toBe(400);
    const parsed = (await response.json()) as { error: string };
    expect(parsed.error).toBe('INVALID_BODY');
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('rejects /start with missing required fields (400)', async () => {
    const stub = makeFakeStub();
    const env = makeEnv({ CoderJob: makeCoderJobNamespace(stub) });
    const body = { ...validStartBody(), chatId: '' };
    const response = await handleJobsRoute(makeRequest('/api/jobs/start', 'POST', body), env, {
      action: 'start',
      jobId: null,
    });
    expect(response.status).toBe(400);
    const parsed = (await response.json()) as { error: string; fields: string[] };
    expect(parsed.error).toBe('MISSING_FIELDS');
    expect(parsed.fields).toContain('chatId');
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('defaults missing role to coder and forwards (rolling-deploy compat)', async () => {
    // Old clients (cached service-worker bundles, in-flight tabs across
    // a deploy) post bodies without a role field. Strict reject would
    // silently drop those jobs; the route-layer default keeps them
    // working until the legacy client ages out. PR 2 can tighten this
    // to MISSING_FIELDS once the contract is universally deployed.
    const stub = makeFakeStub(new Response('{"jobId":"stub-ok"}', { status: 202 }));
    const env = makeEnv({ CoderJob: makeCoderJobNamespace(stub) });
    const { role: _omitted, ...bodyWithoutRole } = validStartBody();
    void _omitted;
    const response = await handleJobsRoute(
      makeRequest('/api/jobs/start', 'POST', bodyWithoutRole),
      env,
      { action: 'start', jobId: null },
    );
    expect(response.status).toBe(202);
    const forwarded = stub.fetch.mock.calls[0]![0] as Request;
    const forwardedBody = JSON.parse(await forwarded.text()) as { role: string };
    expect(forwardedBody.role).toBe('coder');
  });

  it('rejects /start with an unsupported role (400 UNSUPPORTED_ROLE)', async () => {
    const stub = makeFakeStub();
    const env = makeEnv({ CoderJob: makeCoderJobNamespace(stub) });
    // Pin the route-layer guard against future-role envelopes that the
    // DO can't dispatch yet. This protects against a half-persisted
    // run for a role we haven't wired.
    const body = { ...validStartBody(), role: 'planner' };
    const response = await handleJobsRoute(makeRequest('/api/jobs/start', 'POST', body), env, {
      action: 'start',
      jobId: null,
    });
    expect(response.status).toBe(400);
    const parsed = (await response.json()) as { error: string; role: string };
    expect(parsed.error).toBe('UNSUPPORTED_ROLE');
    expect(parsed.role).toBe('planner');
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('forwards chatRef on /start untouched (PR 2 wire-shape)', async () => {
    // The route persists chatRef inside input_json without dereferencing
    // it. PR 3 adds the loader; PR 2 just guarantees the field survives
    // the route-layer pass-through.
    const stub = makeFakeStub(new Response('{"jobId":"stub-ok"}', { status: 202 }));
    const env = makeEnv({ CoderJob: makeCoderJobNamespace(stub) });
    const body = {
      ...validStartBody(),
      chatRef: {
        chatId: 'chat-1',
        repoFullName: 'acme/app',
        branch: 'feature/x',
        checkpointId: 'ck-7',
      },
    };
    await handleJobsRoute(makeRequest('/api/jobs/start', 'POST', body), env, {
      action: 'start',
      jobId: null,
    });
    const forwarded = stub.fetch.mock.calls[0]![0] as Request;
    const forwardedBody = JSON.parse(await forwarded.text()) as {
      chatRef?: { chatId: string; repoFullName: string; branch: string; checkpointId?: string };
    };
    expect(forwardedBody.chatRef).toEqual({
      chatId: 'chat-1',
      repoFullName: 'acme/app',
      branch: 'feature/x',
      checkpointId: 'ck-7',
    });
  });

  it('forwards role=coder through to the DO body untouched', async () => {
    const stub = makeFakeStub(new Response('{"jobId":"stub-ok"}', { status: 202 }));
    const env = makeEnv({ CoderJob: makeCoderJobNamespace(stub) });
    await handleJobsRoute(makeRequest('/api/jobs/start', 'POST', validStartBody()), env, {
      action: 'start',
      jobId: null,
    });
    const forwarded = stub.fetch.mock.calls[0]![0] as Request;
    const forwardedBody = JSON.parse(await forwarded.text()) as { role: string };
    expect(forwardedBody.role).toBe('coder');
  });

  it('forwards /events to the DO as GET and passes Last-Event-ID through', async () => {
    const stub = makeFakeStub(
      new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const env = makeEnv({ CoderJob: makeCoderJobNamespace(stub) });
    const response = await handleJobsRoute(
      makeRequest('/api/jobs/abc-123/events', 'GET', undefined, {
        'Last-Event-ID': 'evt-42',
      }),
      env,
      { action: 'events', jobId: 'abc-123' },
    );
    expect(response.status).toBe(200);
    const forwarded = stub.fetch.mock.calls[0]![0] as Request;
    expect(forwarded.method).toBe('GET');
    expect(forwarded.url).toMatch(/\/events\?jobId=abc-123/);
    expect(forwarded.headers.get('Last-Event-ID')).toBe('evt-42');
  });

  it('forwards /cancel and /status with the jobId query', async () => {
    const stub = makeFakeStub(new Response('{"jobId":"abc","cancelled":true}'));
    const env = makeEnv({ CoderJob: makeCoderJobNamespace(stub) });
    const cancelResponse = await handleJobsRoute(makeRequest('/api/jobs/abc/cancel', 'POST'), env, {
      action: 'cancel',
      jobId: 'abc',
    });
    expect(cancelResponse.status).toBe(200);
    expect((stub.fetch.mock.calls[0]![0] as Request).url).toMatch(/\/cancel\?jobId=abc/);

    const statusResponse = await handleJobsRoute(makeRequest('/api/jobs/abc', 'GET'), env, {
      action: 'status',
      jobId: 'abc',
    });
    expect(statusResponse.status).toBe(200);
    expect((stub.fetch.mock.calls[1]![0] as Request).url).toMatch(/\/status\?jobId=abc/);
  });
});

function validStartBody() {
  return {
    role: 'coder' as const,
    chatId: 'chat-1',
    repoFullName: 'acme/app',
    branch: 'main',
    sandboxId: 'sb-1',
    ownerToken: 'tok-1',
    envelope: {
      task: 'do the thing',
      files: [],
      provider: 'openrouter',
    },
    provider: 'openrouter',
    model: 'sonnet-4.6',
    userProfile: null,
  };
}
