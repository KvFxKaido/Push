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
    headers: { 'content-type': 'application/json', ...headers },
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

  it('forwards POST /start to the DO with a generated jobId and request origin', async () => {
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
