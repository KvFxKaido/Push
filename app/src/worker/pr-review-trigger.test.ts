import { beforeEach, describe, expect, it, vi } from 'vitest';

const { jwtMock, exchangeMock } = vi.hoisted(() => ({
  jwtMock: vi.fn<(...a: unknown[]) => Promise<string>>(async () => 'jwt'),
  exchangeMock: vi.fn<(...a: unknown[]) => Promise<{ token: string; expires_at: string }>>(
    async () => ({ token: 'install-tok', expires_at: '' }),
  ),
}));
vi.mock('./worker-infra', () => ({
  generateGitHubAppJWT: (...args: unknown[]) => jwtMock(...args),
  exchangeForInstallationToken: (...args: unknown[]) => exchangeMock(...args),
}));

const { fetchRefsMock } = vi.hoisted(() => ({
  fetchRefsMock: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({
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

import {
  enqueueReviewForExistingPr,
  mintInstallationToken,
  prReviewJobName,
} from './pr-review-trigger';
import type { Env } from './worker-middleware';

interface FakeStub {
  fetch: ReturnType<typeof vi.fn>;
}
function makeFakeStub(
  response: Response = new Response(JSON.stringify({ status: 'queued' }), { status: 202 }),
): FakeStub {
  return { fetch: vi.fn(async () => response) };
}
function makeNamespace(stub: FakeStub) {
  return {
    idFromName: vi.fn((name: string) => ({ toString: () => name })),
    get: vi.fn(() => stub as unknown),
  } as unknown as NonNullable<Env['PrReviewJob']>;
}
function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'key',
    PrReviewJob: makeNamespace(makeFakeStub()),
    ...overrides,
  } as Env;
}

beforeEach(() => {
  jwtMock.mockClear();
  exchangeMock.mockClear();
  fetchRefsMock.mockClear();
});

describe('prReviewJobName', () => {
  it('is stable per PR', () => {
    expect(prReviewJobName('octo/repo', 7)).toBe('octo/repo#7');
  });
});

describe('mintInstallationToken', () => {
  it('mints a token via the App JWT', async () => {
    expect(await mintInstallationToken(baseEnv(), '42')).toBe('install-tok');
    expect(jwtMock).toHaveBeenCalledWith('1', 'key');
    expect(exchangeMock).toHaveBeenCalledWith('jwt', '42');
  });

  it('returns null when the App is not configured', async () => {
    expect(await mintInstallationToken(baseEnv({ GITHUB_APP_ID: undefined }), '42')).toBeNull();
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it('returns null when the token exchange fails', async () => {
    exchangeMock.mockRejectedValueOnce(new Error('boom'));
    expect(await mintInstallationToken(baseEnv(), '42')).toBeNull();
  });
});

describe('enqueueReviewForExistingPr', () => {
  it('forwards a start with the resolved refs and reuses a caller token', async () => {
    const stub = makeFakeStub();
    const env = baseEnv({ PrReviewJob: makeNamespace(stub) });
    const res = await enqueueReviewForExistingPr(env, {
      repo: 'octo/repo',
      prNumber: 7,
      installationId: '42',
      origin: 'https://push.app',
      deliveryId: 'comment-555',
      token: 'pre-minted',
    });
    expect(res).toMatchObject({ ok: true, status: 'queued', headSha: 'sha-1' });
    // A caller-supplied token skips the internal mint.
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(fetchRefsMock).toHaveBeenCalledWith('octo/repo', 7, { token: 'pre-minted' });
    const forwarded = stub.fetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/start');
    const sent = JSON.parse(await forwarded.text());
    expect(sent).toMatchObject({
      deliveryId: 'comment-555',
      repoFullName: 'octo/repo',
      prNumber: 7,
      headSha: 'sha-1',
      headRef: 'feature/x',
      baseRef: 'main',
      installationId: '42',
      isCrossFork: false,
      origin: 'https://push.app',
    });
    // Not requested here → the coalescing flag is omitted (default behavior).
    expect(sent).not.toHaveProperty('supersedeSameHead');
  });

  it('forwards supersedeSameHead when latest-wins coalescing is requested', async () => {
    const stub = makeFakeStub();
    const res = await enqueueReviewForExistingPr(baseEnv({ PrReviewJob: makeNamespace(stub) }), {
      repo: 'octo/repo',
      prNumber: 7,
      installationId: '42',
      origin: 'https://push.app',
      deliveryId: 'comment-555',
      token: 'pre-minted',
      supersedeSameHead: true,
    });
    expect(res.ok).toBe(true);
    const forwarded = stub.fetch.mock.calls[0]![0] as Request;
    expect(JSON.parse(await forwarded.text())).toMatchObject({ supersedeSameHead: true });
  });

  it('mints its own token when none is supplied (manual-run path)', async () => {
    const res = await enqueueReviewForExistingPr(baseEnv(), {
      repo: 'octo/repo',
      prNumber: 7,
      installationId: '42',
      origin: 'https://push.app',
      deliveryId: 'manual-abc',
    });
    expect(res.ok).toBe(true);
    expect(exchangeMock).toHaveBeenCalledWith('jwt', '42');
    expect(fetchRefsMock).toHaveBeenCalledWith('octo/repo', 7, { token: 'install-tok' });
  });

  it('rejects a draft/closed PR (NOT_REVIEWABLE) without forwarding', async () => {
    fetchRefsMock.mockResolvedValueOnce({
      headSha: 'sha-1',
      headRef: 'feature/x',
      baseRef: 'main',
      isCrossFork: false,
      state: 'open',
      draft: true,
    });
    const stub = makeFakeStub();
    const res = await enqueueReviewForExistingPr(baseEnv({ PrReviewJob: makeNamespace(stub) }), {
      repo: 'octo/repo',
      prNumber: 7,
      installationId: '42',
      origin: 'https://push.app',
      deliveryId: 'comment-1',
      token: 't',
    });
    expect(res).toMatchObject({ ok: false, code: 'NOT_REVIEWABLE', httpStatus: 409 });
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('fails closed (NOT_CONFIGURED, 503) when the DO binding is absent', async () => {
    const res = await enqueueReviewForExistingPr(baseEnv({ PrReviewJob: undefined }), {
      repo: 'octo/repo',
      prNumber: 7,
      installationId: '42',
      origin: 'https://push.app',
      deliveryId: 'comment-1',
      token: 't',
    });
    expect(res).toMatchObject({ ok: false, code: 'NOT_CONFIGURED', httpStatus: 503 });
  });

  it('surfaces a PR lookup failure as PR_LOOKUP_FAILED (502)', async () => {
    fetchRefsMock.mockRejectedValueOnce(new Error('404'));
    const res = await enqueueReviewForExistingPr(baseEnv(), {
      repo: 'octo/repo',
      prNumber: 7,
      installationId: '42',
      origin: 'https://push.app',
      deliveryId: 'comment-1',
      token: 't',
    });
    expect(res).toMatchObject({ ok: false, code: 'PR_LOOKUP_FAILED', httpStatus: 502 });
  });

  it('maps a TOKEN_MINT_FAILED when minting yields no token', async () => {
    exchangeMock.mockRejectedValueOnce(new Error('boom'));
    const res = await enqueueReviewForExistingPr(baseEnv(), {
      repo: 'octo/repo',
      prNumber: 7,
      installationId: '42',
      origin: 'https://push.app',
      deliveryId: 'manual-x',
    });
    expect(res).toMatchObject({ ok: false, code: 'TOKEN_MINT_FAILED', httpStatus: 502 });
  });

  it('returns ENQUEUE_FAILED (502) when the DO rejects the start', async () => {
    const stub = makeFakeStub(
      new Response(JSON.stringify({ error: 'MISSING_FIELDS' }), { status: 400 }),
    );
    const res = await enqueueReviewForExistingPr(baseEnv({ PrReviewJob: makeNamespace(stub) }), {
      repo: 'octo/repo',
      prNumber: 7,
      installationId: '42',
      origin: 'https://push.app',
      deliveryId: 'comment-1',
      token: 't',
    });
    expect(res).toMatchObject({ ok: false, code: 'ENQUEUE_FAILED', httpStatus: 502 });
  });
});
