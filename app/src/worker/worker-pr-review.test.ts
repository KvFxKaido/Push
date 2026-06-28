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
  // Pulled in transitively by github-webhook.ts (comment-trigger handle).
  GITHUB_APP_SLUG: 'push-agent',
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
  // Pulled in transitively by github-webhook.ts (comment-trigger 👀 ack).
  addCommentReaction: vi.fn(async () => true),
}));

import type { ExecutionContext } from '@cloudflare/workers-types';
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
  it('maps the list (GET), run (POST), cancel (POST), inflight (GET) routes, rejects others', () => {
    expect(matchPrReviewRoute('/api/pr-reviews', 'GET')).toBe('list');
    expect(matchPrReviewRoute('/api/pr-reviews/run', 'POST')).toBe('run');
    expect(matchPrReviewRoute('/api/pr-reviews/cancel', 'POST')).toBe('cancel');
    expect(matchPrReviewRoute('/api/pr-reviews/inflight', 'GET')).toBe('inflight');
    expect(matchPrReviewRoute('/api/pr-reviews', 'POST')).toBeNull();
    expect(matchPrReviewRoute('/api/pr-reviews/run', 'GET')).toBeNull();
    expect(matchPrReviewRoute('/api/pr-reviews/cancel', 'GET')).toBeNull();
    expect(matchPrReviewRoute('/api/pr-reviews/inflight', 'POST')).toBeNull();
    expect(matchPrReviewRoute('/api/pr-reviews/extra', 'GET')).toBeNull();
  });

  it('maps the config GET/POST routes', () => {
    expect(matchPrReviewRoute('/api/pr-reviews/config', 'GET')).toBe('config-get');
    expect(matchPrReviewRoute('/api/pr-reviews/config', 'POST')).toBe('config-set');
    expect(matchPrReviewRoute('/api/pr-reviews/config', 'DELETE')).toBeNull();
  });
});

describe('handlePrReviewRoute — config (reviewer on/off)', () => {
  function kvEnv(initial?: string): Env {
    const store = new Map<string, string>();
    if (initial !== undefined) store.set('config:pr-review-enabled', initial);
    return makeEnv({
      SNAPSHOT_INDEX: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => {
          store.set(k, v);
        },
      } as unknown as Env['SNAPSHOT_INDEX'],
    });
  }

  it('GET returns enabled (default true) — and works without a PrReviewJob DO binding', async () => {
    const res = await handlePrReviewRoute(
      makeRequest('/api/pr-reviews/config'),
      kvEnv(),
      'config-get',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      provider: 'sakana',
      model: 'fugu',
    });
  });

  it('POST persists the flag and a subsequent GET reflects it', async () => {
    const env = kvEnv();
    const set = await handlePrReviewRoute(
      makePost('/api/pr-reviews/config', { enabled: false }),
      env,
      'config-set',
    );
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({
      enabled: false,
      provider: 'sakana',
      model: 'fugu',
    });
    const get = await handlePrReviewRoute(makeRequest('/api/pr-reviews/config'), env, 'config-get');
    expect(await get.json()).toEqual({
      enabled: false,
      provider: 'sakana',
      model: 'fugu',
    });
  });

  it('POST persists provider/model and a subsequent GET reflects it', async () => {
    const env = kvEnv();
    const set = await handlePrReviewRoute(
      makePost('/api/pr-reviews/config', { provider: 'openai', model: 'gpt-5.4' }),
      env,
      'config-set',
    );
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ enabled: true, provider: 'openai', model: 'gpt-5.4' });

    const get = await handlePrReviewRoute(makeRequest('/api/pr-reviews/config'), env, 'config-get');
    expect(await get.json()).toEqual({ enabled: true, provider: 'openai', model: 'gpt-5.4' });
  });

  it('POST rejects a non-boolean enabled (400)', async () => {
    const res = await handlePrReviewRoute(
      makePost('/api/pr-reviews/config', { enabled: 'nope' }),
      kvEnv(),
      'config-set',
    );
    expect(res.status).toBe(400);
  });

  it('rejects a disallowed origin (403) before touching the flag', async () => {
    const res = await handlePrReviewRoute(
      makePost('/api/pr-reviews/config', { enabled: false }, { Origin: 'https://evil.test' }),
      kvEnv(),
      'config-set',
    );
    expect(res.status).toBe(403);
  });

  it('blocks a manual run (409) and does not enqueue when the reviewer is off', async () => {
    const stub = makeFakeStub(new Response(JSON.stringify({ status: 'queued' }), { status: 202 }));
    const env = runEnv({
      PrReviewJob: makePrReviewNamespace(stub),
      SNAPSHOT_INDEX: {
        get: async () => '0',
        put: async () => {},
      } as unknown as Env['SNAPSHOT_INDEX'],
    });
    const res = await handlePrReviewRoute(
      makePost('/api/pr-reviews/run', { repo: 'octo/repo', pr: 7 }),
      env,
      'run',
    );
    expect(res.status).toBe(409);
    expect(stub.fetch).not.toHaveBeenCalled();
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

describe('handlePrReviewRoute — cancel', () => {
  it('forwards a cancel to the DO by repo#prNumber with the deliveryId', async () => {
    const stub = makeFakeStub(
      new Response(JSON.stringify({ status: 'cancelled' }), { status: 200 }),
    );
    const namespace = makePrReviewNamespace(stub);
    const res = await handlePrReviewRoute(
      makePost('/api/pr-reviews/cancel', { repo: 'octo/repo', pr: 7, deliveryId: 'manual-abc' }),
      makeEnv({ PrReviewJob: namespace }),
      'cancel',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'cancelled' });
    expect(namespace.idFromName as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('octo/repo#7');
    const forwarded = stub.fetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/cancel');
    expect(JSON.parse(await forwarded.text())).toEqual({ deliveryId: 'manual-abc' });
  });

  it('passes the DO status through on a terminal-race (409)', async () => {
    const stub = makeFakeStub(
      new Response(JSON.stringify({ error: 'NOT_CANCELLABLE' }), { status: 409 }),
    );
    const res = await handlePrReviewRoute(
      makePost('/api/pr-reviews/cancel', { repo: 'octo/repo', pr: 7, deliveryId: 'manual-abc' }),
      makeEnv({ PrReviewJob: makePrReviewNamespace(stub) }),
      'cancel',
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'NOT_CANCELLABLE' });
  });

  it('works even when the reviewer is turned off (no kill-switch gate)', async () => {
    const stub = makeFakeStub(
      new Response(JSON.stringify({ status: 'cancelled' }), { status: 200 }),
    );
    const res = await handlePrReviewRoute(
      makePost('/api/pr-reviews/cancel', { repo: 'octo/repo', pr: 7, deliveryId: 'manual-abc' }),
      makeEnv({
        PrReviewJob: makePrReviewNamespace(stub),
        // Reviewer kill-switch off — cancel must still reach the DO.
        SNAPSHOT_INDEX: {
          get: async () => '0',
          put: async () => {},
        } as unknown as Env['SNAPSHOT_INDEX'],
      }),
      'cancel',
    );
    expect(res.status).toBe(200);
    expect(stub.fetch).toHaveBeenCalledOnce();
  });

  it('rejects a missing/invalid deliveryId (400) without forwarding', async () => {
    const stub = makeFakeStub();
    const env = makeEnv({ PrReviewJob: makePrReviewNamespace(stub) });
    for (const body of [
      { repo: 'octo/repo', pr: 7 }, // no deliveryId
      { repo: 'octo/repo', pr: 7, deliveryId: 'has spaces' },
      { repo: 'octo/repo', pr: 7, deliveryId: '' },
      { repo: 'octo', pr: 7, deliveryId: 'manual-abc' }, // bad repo
    ]) {
      const res = await handlePrReviewRoute(
        makePost('/api/pr-reviews/cancel', body),
        env,
        'cancel',
      );
      expect(res.status).toBe(400);
    }
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the DO binding is absent', async () => {
    const res = await handlePrReviewRoute(
      makePost('/api/pr-reviews/cancel', { repo: 'octo/repo', pr: 7, deliveryId: 'manual-abc' }),
      makeEnv(),
      'cancel',
    );
    expect(res.status).toBe(503);
  });

  it('rejects a disallowed origin (403) before forwarding', async () => {
    const stub = makeFakeStub();
    const res = await handlePrReviewRoute(
      makePost(
        '/api/pr-reviews/cancel',
        { repo: 'octo/repo', pr: 7, deliveryId: 'manual-abc' },
        { Origin: 'https://evil.test' },
      ),
      makeEnv({ PrReviewJob: makePrReviewNamespace(stub) }),
      'cancel',
    );
    expect(res.status).toBe(403);
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});

describe('handlePrReviewRoute — inflight (cross-PR active reviews)', () => {
  // KV mock with the list/get/delete surface the index reader uses.
  function makeKv(entries: Record<string, unknown>) {
    const store = new Map<string, string>(
      Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]),
    );
    return {
      kv: {
        list: async ({ prefix }: { prefix: string }) => ({
          keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        }),
        get: async (k: string) => store.get(k) ?? null,
        delete: async (k: string) => {
          store.delete(k);
        },
        put: async (k: string, v: string) => {
          store.set(k, v);
        },
      } as unknown as Env['SNAPSHOT_INDEX'],
      store,
    };
  }

  // DO stub that answers /status?deliveryId=<id> from a per-delivery status map.
  // A missing entry returns 404 (NOT_FOUND), mirroring the real DO.
  function makeStatusStub(statuses: Record<string, string>): FakeStub {
    return {
      fetch: vi.fn(async (req: Request) => {
        const id = new URL(req.url).searchParams.get('deliveryId') ?? '';
        const status = statuses[id];
        if (!status) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
        return new Response(
          JSON.stringify({ deliveryId: id, prNumber: 7, status, startedAt: 1, createdAt: 1 }),
          { status: 200 },
        );
      }),
    };
  }

  const KEY = (pr: number, id: string) => `inflight:pr-review:octo/repo#${pr}#${id}`;

  it('returns only queued/running reviews and lazily evicts terminal/not-found entries', async () => {
    const { kv, store } = makeKv({
      [KEY(7, 'd-run')]: {
        repo: 'octo/repo',
        prNumber: 7,
        deliveryId: 'd-run',
        headSha: 'a',
        createdAt: 3,
      },
      [KEY(8, 'd-done')]: {
        repo: 'octo/repo',
        prNumber: 8,
        deliveryId: 'd-done',
        headSha: 'b',
        createdAt: 2,
      },
      [KEY(9, 'd-gone')]: {
        repo: 'octo/repo',
        prNumber: 9,
        deliveryId: 'd-gone',
        headSha: 'c',
        createdAt: 1,
      },
    });
    const stub = makeStatusStub({ 'd-run': 'running', 'd-done': 'completed' }); // d-gone → 404
    const res = await handlePrReviewRoute(
      makeRequest('/api/pr-reviews/inflight?repo=octo/repo'),
      makeEnv({ PrReviewJob: makePrReviewNamespace(stub), SNAPSHOT_INDEX: kv }),
      'inflight',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reviews: Array<{ deliveryId: string }> };
    expect(body.reviews.map((r) => r.deliveryId)).toEqual(['d-run']);
    // Terminal + not-found entries are evicted (await-fallback when no ctx); the
    // live one stays.
    expect(store.has(KEY(7, 'd-run'))).toBe(true);
    expect(store.has(KEY(8, 'd-done'))).toBe(false);
    expect(store.has(KEY(9, 'd-gone'))).toBe(false);
  });

  it('defers eviction to ctx.waitUntil (off the response path) when a context is threaded', async () => {
    const { kv, store } = makeKv({
      [KEY(8, 'd-done')]: {
        repo: 'octo/repo',
        prNumber: 8,
        deliveryId: 'd-done',
        headSha: 'b',
        createdAt: 2,
      },
    });
    const stub = makeStatusStub({ 'd-done': 'completed' });
    const deferred: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => deferred.push(p),
    } as unknown as ExecutionContext;
    const res = await handlePrReviewRoute(
      makeRequest('/api/pr-reviews/inflight?repo=octo/repo'),
      makeEnv({ PrReviewJob: makePrReviewNamespace(stub), SNAPSHOT_INDEX: kv }),
      'inflight',
      ctx,
    );
    expect(res.status).toBe(200);
    // Eviction is parked in waitUntil (off the response path) rather than awaited
    // inline — proven by it landing in the ctx's deferred queue.
    expect(deferred.length).toBe(1);
    await Promise.all(deferred);
    expect(store.has(KEY(8, 'd-done'))).toBe(false);
  });

  it('rejects a malformed repo (400) without touching the DO', async () => {
    const stub = makeFakeStub();
    const res = await handlePrReviewRoute(
      makeRequest('/api/pr-reviews/inflight?repo=not-a-repo'),
      makeEnv({ PrReviewJob: makePrReviewNamespace(stub), SNAPSHOT_INDEX: makeKv({}).kv }),
      'inflight',
    );
    expect(res.status).toBe(400);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('returns 503 when the PrReviewJob DO binding is absent', async () => {
    const res = await handlePrReviewRoute(
      makeRequest('/api/pr-reviews/inflight?repo=octo/repo'),
      makeEnv(),
      'inflight',
    );
    expect(res.status).toBe(503);
  });

  it('returns an empty list (200) when nothing is indexed', async () => {
    const stub = makeFakeStub();
    const res = await handlePrReviewRoute(
      makeRequest('/api/pr-reviews/inflight?repo=octo/repo'),
      makeEnv({ PrReviewJob: makePrReviewNamespace(stub), SNAPSHOT_INDEX: makeKv({}).kv }),
      'inflight',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reviews: [] });
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});
