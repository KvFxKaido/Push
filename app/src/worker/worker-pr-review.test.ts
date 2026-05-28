import { describe, expect, it, vi } from 'vitest';
import { handlePrReviewRoute, matchPrReviewRoute } from './worker-pr-review';
import type { Env } from './worker-middleware';

interface FakeStub {
  fetch: ReturnType<typeof vi.fn>;
}

function makeFakeStub(response: Response | (() => Response) = new Response('{}')): FakeStub {
  return { fetch: vi.fn(async () => (typeof response === 'function' ? response() : response)) };
}

function makePrReviewNamespace(stub: FakeStub) {
  return {
    idFromName: vi.fn((name: string) => ({ toString: () => name })),
    get: vi.fn(() => stub as unknown),
  } as unknown as NonNullable<Env['PrReviewJob']>;
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

function makeRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://push.example.test${path}`, {
    method: 'GET',
    headers: { Origin: 'https://push.example.test', ...headers },
  });
}

describe('matchPrReviewRoute', () => {
  it('matches GET /api/pr-reviews only', () => {
    expect(matchPrReviewRoute('/api/pr-reviews', 'GET')).toBe(true);
    expect(matchPrReviewRoute('/api/pr-reviews', 'POST')).toBe(false);
    expect(matchPrReviewRoute('/api/pr-reviews/extra', 'GET')).toBe(false);
    expect(matchPrReviewRoute('/api/jobs/start', 'GET')).toBe(false);
  });
});

describe('handlePrReviewRoute', () => {
  it('fails closed with 503 when the DO binding is absent', async () => {
    const res = await handlePrReviewRoute(
      makeRequest('/api/pr-reviews?repo=octo/repo&pr=7'),
      makeEnv(),
    );
    expect(res.status).toBe(503);
  });

  it('rejects a request with a disallowed origin (403)', async () => {
    const stub = makeFakeStub();
    const res = await handlePrReviewRoute(
      makeRequest('/api/pr-reviews?repo=octo/repo&pr=7', { Origin: 'https://evil.test' }),
      makeEnv({ PrReviewJob: makePrReviewNamespace(stub) }),
    );
    expect(res.status).toBe(403);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('rejects a malformed repo or pr (400)', async () => {
    const stub = makeFakeStub();
    const env = makeEnv({ PrReviewJob: makePrReviewNamespace(stub) });
    expect(
      (await handlePrReviewRoute(makeRequest('/api/pr-reviews?repo=octo&pr=7'), env)).status,
    ).toBe(400);
    expect(
      (await handlePrReviewRoute(makeRequest('/api/pr-reviews?repo=octo/repo&pr=0'), env)).status,
    ).toBe(400);
    expect(
      (await handlePrReviewRoute(makeRequest('/api/pr-reviews?repo=a/b/c&pr=7'), env)).status,
    ).toBe(400);
    // parseInt would alias "7abc" -> 7; the digits-only guard rejects it.
    expect(
      (await handlePrReviewRoute(makeRequest('/api/pr-reviews?repo=octo/repo&pr=7abc'), env))
        .status,
    ).toBe(400);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('returns 429 when rate limited', async () => {
    const res = await handlePrReviewRoute(
      makeRequest('/api/pr-reviews?repo=octo/repo&pr=7'),
      makeEnv({
        PrReviewJob: makePrReviewNamespace(makeFakeStub()),
        RATE_LIMITER: {
          limit: vi.fn(async () => ({ success: false })),
        } as unknown as Env['RATE_LIMITER'],
      }),
    );
    expect(res.status).toBe(429);
  });

  it('forwards to the DO list action by repo#prNumber and returns its response', async () => {
    const stub = makeFakeStub(
      new Response(JSON.stringify({ reviews: [{ deliveryId: 'd1' }] }), { status: 200 }),
    );
    const namespace = makePrReviewNamespace(stub);
    const res = await handlePrReviewRoute(
      makeRequest('/api/pr-reviews?repo=octo/repo&pr=7'),
      makeEnv({ PrReviewJob: namespace }),
    );
    expect(res.status).toBe(200);
    expect(namespace.idFromName as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('octo/repo#7');
    const forwarded = stub.fetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/list');
    expect((await res.json()).reviews).toHaveLength(1);
  });
});
