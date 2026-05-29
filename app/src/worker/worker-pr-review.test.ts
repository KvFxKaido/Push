import { describe, expect, it, vi } from 'vitest';

const { jwtMock, resolveInstallMock, exchangeMock } = vi.hoisted(() => ({
  jwtMock: vi.fn<(...a: unknown[]) => Promise<string>>(async () => 'jwt'),
  resolveInstallMock: vi.fn<(...a: unknown[]) => Promise<string>>(async () => '42'),
  exchangeMock: vi.fn<(...a: unknown[]) => Promise<{ token: string; expires_at: string }>>(
    async () => ({ token: 'install-tok', expires_at: '' }),
  ),
}));
vi.mock('./worker-infra', () => ({
  generateGitHubAppJWT: (...args: unknown[]) => jwtMock(...args),
  resolveRepoInstallationId: (...args: unknown[]) => resolveInstallMock(...args),
  exchangeForInstallationToken: (...args: unknown[]) => exchangeMock(...args),
}));

const { fetchRefsMock } = vi.hoisted(() => ({
  fetchRefsMock: vi.fn<
    (...a: unknown[]) => Promise<{
      headSha: string;
      headRef: string;
      baseRef: string;
      isCrossFork: boolean;
      state: string;
      draft: boolean;
    }>
  >(async () => ({
    headSha: 'sha-1',
    headRef: 'feature/x',
    baseRef: 'main',
    isCrossFork: false,
    state: 'open',
    draft: false,
  })),
}));
vi.mock('@/lib/github-tools', () => ({
  fetchPullRequestRefs: (...args: unknown[]) => fetchRefsMock(...args),
}));

import { handlePrReviewRoute, matchPrReviewRoute } from './worker-pr-review';
import type { Env } from './worker-middleware';

interface FakeStub {
  fetch: ReturnType<typeof vi.fn>;
}

function makeFakeStub(response: Response = new Response('{}')): FakeStub {
  return { fetch: vi.fn(async () => response) };
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

function makePost(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://push.example.test${path}`, {
    method: 'POST',
    headers: {
      Origin: 'https://push.example.test',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function runEnv(overrides: Partial<Env> = {}): Env {
  return makeEnv({
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'key',
    GITHUB_ALLOWED_INSTALLATION_IDS: '42',
    PrReviewJob: makePrReviewNamespace(
      makeFakeStub(new Response(JSON.stringify({ status: 'queued' }), { status: 202 })),
    ),
    ...overrides,
  });
}

describe('matchPrReviewRoute', () => {
  it('maps the list (GET) and run (POST) routes, rejects others', () => {
    expect(matchPrReviewRoute('/api/pr-reviews', 'GET')).toBe('list');
    expect(matchPrReviewRoute('/api/pr-reviews/run', 'POST')).toBe('run');
    expect(matchPrReviewRoute('/api/pr-reviews', 'POST')).toBeNull();
    expect(matchPrReviewRoute('/api/pr-reviews/run', 'GET')).toBeNull();
    expect(matchPrReviewRoute('/api/pr-reviews/extra', 'GET')).toBeNull();
  });
});

describe('handlePrReviewRoute — list', () => {
  it('fails closed with 503 when the DO binding is absent', async () => {
    const res = await handlePrReviewRoute(
      makeRequest('/api/pr-reviews?repo=octo/repo&pr=7'),
      makeEnv(),
      'list',
    );
    expect(res.status).toBe(503);
  });

  it('rejects a disallowed origin (403)', async () => {
    const stub = makeFakeStub();
    const res = await handlePrReviewRoute(
      makeRequest('/api/pr-reviews?repo=octo/repo&pr=7', { Origin: 'https://evil.test' }),
      makeEnv({ PrReviewJob: makePrReviewNamespace(stub) }),
      'list',
    );
    expect(res.status).toBe(403);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed repo/pr (400), including pr=7abc', async () => {
    const stub = makeFakeStub();
    const env = makeEnv({ PrReviewJob: makePrReviewNamespace(stub) });
    for (const q of [
      'repo=octo&pr=7',
      'repo=octo/repo&pr=0',
      'repo=a/b/c&pr=7',
      'repo=octo/repo&pr=7abc',
    ]) {
      expect(
        (await handlePrReviewRoute(makeRequest(`/api/pr-reviews?${q}`), env, 'list')).status,
      ).toBe(400);
    }
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
      'list',
    );
    expect(res.status).toBe(429);
  });

  it('forwards to the DO list action by repo#prNumber', async () => {
    const stub = makeFakeStub(
      new Response(JSON.stringify({ reviews: [{ deliveryId: 'd1' }] }), { status: 200 }),
    );
    const namespace = makePrReviewNamespace(stub);
    const res = await handlePrReviewRoute(
      makeRequest('/api/pr-reviews?repo=octo/repo&pr=7'),
      makeEnv({ PrReviewJob: namespace }),
      'list',
    );
    expect(res.status).toBe(200);
    expect(namespace.idFromName as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('octo/repo#7');
    expect(new URL(stub.fetch.mock.calls[0]![0].url).pathname).toBe('/list');
  });
});

describe('handlePrReviewRoute — run', () => {
  it('resolves the installation, fetches refs, and enqueues a manual start', async () => {
    const stub = makeFakeStub(new Response(JSON.stringify({ status: 'queued' }), { status: 202 }));
    const namespace = makePrReviewNamespace(stub);
    const res = await handlePrReviewRoute(
      makePost('/api/pr-reviews/run', { repo: 'octo/repo', pr: 7 }),
      runEnv({ PrReviewJob: namespace }),
      'run',
    );
    expect(res.status).toBe(202);
    expect(resolveInstallMock).toHaveBeenCalledWith('jwt', 'octo/repo');
    const forwarded = stub.fetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/start');
    const sent = JSON.parse(await forwarded.text());
    expect(sent).toMatchObject({
      repoFullName: 'octo/repo',
      prNumber: 7,
      headSha: 'sha-1',
      installationId: '42',
    });
    expect(sent.deliveryId).toMatch(/^manual-/);
  });

  it('rejects when the resolved installation is not allowlisted (403)', async () => {
    resolveInstallMock.mockResolvedValueOnce('999');
    const res = await handlePrReviewRoute(
      makePost('/api/pr-reviews/run', { repo: 'octo/repo', pr: 7 }),
      runEnv(),
      'run',
    );
    expect(res.status).toBe(403);
  });

  it('returns 503 when the GitHub App is not configured', async () => {
    const res = await handlePrReviewRoute(
      makePost('/api/pr-reviews/run', { repo: 'octo/repo', pr: 7 }),
      runEnv({ GITHUB_APP_ID: undefined }),
      'run',
    );
    expect(res.status).toBe(503);
  });

  it('rejects a draft or closed PR (409) without enqueueing', async () => {
    fetchRefsMock.mockResolvedValueOnce({
      headSha: 'sha-1',
      headRef: 'feature/x',
      baseRef: 'main',
      isCrossFork: false,
      state: 'open',
      draft: true,
    });
    const stub = makeFakeStub();
    const res = await handlePrReviewRoute(
      makePost('/api/pr-reviews/run', { repo: 'octo/repo', pr: 7 }),
      runEnv({ PrReviewJob: makePrReviewNamespace(stub) }),
      'run',
    );
    expect(res.status).toBe(409);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('rejects a repo with URL-delimiter characters (400)', async () => {
    const res = await handlePrReviewRoute(
      makePost('/api/pr-reviews/run', { repo: 'octo/re?po', pr: 7 }),
      runEnv(),
      'run',
    );
    // Rejected at validation (tightened REPO_RE) before any GitHub work.
    expect(res.status).toBe(400);
  });

  it('rejects a malformed body (400)', async () => {
    const res = await handlePrReviewRoute(
      makePost('/api/pr-reviews/run', { repo: 'octo', pr: 'nope' }),
      runEnv(),
      'run',
    );
    expect(res.status).toBe(400);
  });
});
