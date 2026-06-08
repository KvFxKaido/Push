import { describe, expect, it, vi } from 'vitest';
import type { DurableObjectId, DurableObjectNamespace } from '@cloudflare/workers-types';
import {
  handleGitHubWebhook,
  isInstallationAllowed,
  parseInstallationAllowlist,
  prReviewJobName,
  selectReviewablePullRequest,
  verifyWebhookSignature,
} from './github-webhook';
import type { Env } from './worker-middleware';

const SECRET = 'shhh-webhook-secret';

async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function prPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'opened',
    repository: { full_name: 'octo/repo' },
    installation: { id: 42 },
    pull_request: {
      number: 7,
      draft: false,
      head: { sha: 'deadbeef', ref: 'feature/x', repo: { full_name: 'octo/repo' } },
      base: { ref: 'main' },
    },
    ...overrides,
  };
}

function makeRequest(body: string, headers: Record<string, string>): Request {
  return new Request('https://push.app/api/github/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('verifyWebhookSignature', () => {
  it('accepts a valid signature', async () => {
    const body = JSON.stringify({ a: 1 });
    expect(await verifyWebhookSignature(body, await sign(body, SECRET), SECRET)).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const sig = await sign(JSON.stringify({ a: 1 }), SECRET);
    expect(await verifyWebhookSignature(JSON.stringify({ a: 2 }), sig, SECRET)).toBe(false);
  });

  it('rejects a wrong secret, missing header, and non-sha256 prefix', async () => {
    const body = JSON.stringify({ a: 1 });
    expect(await verifyWebhookSignature(body, await sign(body, 'other'), SECRET)).toBe(false);
    expect(await verifyWebhookSignature(body, null, SECRET)).toBe(false);
    expect(await verifyWebhookSignature(body, 'sha1=abc', SECRET)).toBe(false);
    expect(await verifyWebhookSignature(body, await sign(body, SECRET), '')).toBe(false);
  });
});

describe('installation allowlist', () => {
  it('parses comma/whitespace lists', () => {
    expect([...parseInstallationAllowlist('1, 2  3')]).toEqual(['1', '2', '3']);
    expect(parseInstallationAllowlist(undefined).size).toBe(0);
  });

  it('fails closed on an empty allowlist', () => {
    expect(isInstallationAllowed('1', parseInstallationAllowlist(''))).toBe(false);
    expect(isInstallationAllowed('1', parseInstallationAllowlist('1'))).toBe(true);
    expect(isInstallationAllowed('9', parseInstallationAllowlist('1 2'))).toBe(false);
  });
});

describe('selectReviewablePullRequest', () => {
  it('selects a reviewable PR and extracts fields', () => {
    const r = selectReviewablePullRequest('pull_request', prPayload());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pr).toMatchObject({
        repoFullName: 'octo/repo',
        prNumber: 7,
        headSha: 'deadbeef',
        baseRef: 'main',
        headRef: 'feature/x',
        installationId: '42',
        isCrossFork: false,
      });
    }
  });

  it('flags a cross-fork head', () => {
    const r = selectReviewablePullRequest(
      'pull_request',
      prPayload({
        pull_request: {
          number: 7,
          head: { sha: 's', ref: 'r', repo: { full_name: 'fork/repo' } },
          base: { ref: 'main' },
        },
      }),
    );
    expect(r.ok && r.pr.isCrossFork).toBe(true);
  });

  it('skips non-PR events, non-reviewable actions, drafts, and incomplete payloads', () => {
    expect(selectReviewablePullRequest('push', {})).toMatchObject({
      ok: false,
      reason: 'event:push',
    });
    expect(
      selectReviewablePullRequest('pull_request', prPayload({ action: 'closed' })),
    ).toMatchObject({
      ok: false,
      reason: 'action:closed',
    });
    // `synchronize` (a new commit pushed) is deliberately NOT reviewable — the
    // reviewer only fires on a PR's first open, not on subsequent commits.
    expect(
      selectReviewablePullRequest('pull_request', prPayload({ action: 'synchronize' })),
    ).toMatchObject({
      ok: false,
      reason: 'action:synchronize',
    });
    expect(
      selectReviewablePullRequest(
        'pull_request',
        prPayload({
          pull_request: {
            number: 7,
            draft: true,
            head: { sha: 's', ref: 'r' },
            base: { ref: 'm' },
          },
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'draft' });
    expect(
      selectReviewablePullRequest('pull_request', prPayload({ repository: {} })),
    ).toMatchObject({ ok: false, reason: 'missing_fields' });
  });
});

describe('prReviewJobName', () => {
  it('is stable per PR', () => {
    expect(prReviewJobName('octo/repo', 7)).toBe('octo/repo#7');
  });
});

describe('handleGitHubWebhook', () => {
  function fakeDoEnv(stubFetch: (r: Request) => Promise<Response>): Env {
    return {
      GITHUB_WEBHOOK_SECRET: SECRET,
      GITHUB_ALLOWED_INSTALLATION_IDS: '42',
      PrReviewJob: {
        idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
        get: () => ({ fetch: stubFetch }),
      } as unknown as DurableObjectNamespace,
    } as unknown as Env;
  }

  it('returns 503 when the secret is unset', async () => {
    const res = await handleGitHubWebhook(makeRequest('{}', {}), {} as Env);
    expect(res.status).toBe(503);
  });

  it('returns 401 on a bad signature', async () => {
    const body = JSON.stringify(prPayload());
    const res = await handleGitHubWebhook(
      makeRequest(body, { 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': 'sha256=bad' }),
      fakeDoEnv(async () => new Response('{}')),
    );
    expect(res.status).toBe(401);
  });

  it('returns 204 for non-reviewable events', async () => {
    const body = JSON.stringify({ action: 'closed' });
    const res = await handleGitHubWebhook(
      makeRequest(body, {
        'X-GitHub-Event': 'pull_request',
        'X-Hub-Signature-256': await sign(body, SECRET),
      }),
      fakeDoEnv(async () => new Response('{}')),
    );
    expect(res.status).toBe(204);
  });

  it('returns 403 when the installation is not allowlisted', async () => {
    const body = JSON.stringify(prPayload({ installation: { id: 999 } }));
    const res = await handleGitHubWebhook(
      makeRequest(body, {
        'X-GitHub-Event': 'pull_request',
        'X-Hub-Signature-256': await sign(body, SECRET),
      }),
      fakeDoEnv(async () => new Response('{}')),
    );
    expect(res.status).toBe(403);
  });

  it('enqueues to the DO and acks 202 on the happy path', async () => {
    const body = JSON.stringify(prPayload());
    const stub = vi.fn<(r: Request) => Promise<Response>>(
      async () => new Response(JSON.stringify({ status: 'queued' }), { status: 202 }),
    );
    const res = await handleGitHubWebhook(
      makeRequest(body, {
        'X-GitHub-Event': 'pull_request',
        'X-GitHub-Delivery': 'delivery-1',
        'X-Hub-Signature-256': await sign(body, SECRET),
      }),
      fakeDoEnv(stub),
    );
    expect(res.status).toBe(202);
    expect(stub).toHaveBeenCalledOnce();
    const forwarded = stub.mock.calls[0]![0];
    expect(new URL(forwarded.url).pathname).toBe('/start');
    const sent = JSON.parse(await forwarded.text());
    expect(sent).toMatchObject({
      deliveryId: 'delivery-1',
      repoFullName: 'octo/repo',
      prNumber: 7,
    });
  });

  it('skips enqueue and acks 202 "disabled" when the reviewer is toggled off', async () => {
    const body = JSON.stringify(prPayload());
    const stub = vi.fn<(r: Request) => Promise<Response>>(
      async () => new Response(JSON.stringify({ status: 'queued' }), { status: 202 }),
    );
    const env = {
      ...fakeDoEnv(stub),
      SNAPSHOT_INDEX: {
        get: async (k: string) => (k === 'config:pr-review-enabled' ? '0' : null),
      } as unknown as Env['SNAPSHOT_INDEX'],
    } as Env;
    const res = await handleGitHubWebhook(
      makeRequest(body, {
        'X-GitHub-Event': 'pull_request',
        'X-GitHub-Delivery': 'delivery-off',
        'X-Hub-Signature-256': await sign(body, SECRET),
      }),
      env,
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'disabled' });
    // The point of the toggle: no DO spun up, so no provider tokens spent.
    expect(stub).not.toHaveBeenCalled();
  });

  it('returns 502 (not 202) when the DO rejects the start', async () => {
    const body = JSON.stringify(prPayload());
    const stub = vi.fn<(r: Request) => Promise<Response>>(
      async () => new Response(JSON.stringify({ error: 'MISSING_FIELDS' }), { status: 400 }),
    );
    const res = await handleGitHubWebhook(
      makeRequest(body, {
        'X-GitHub-Event': 'pull_request',
        'X-Hub-Signature-256': await sign(body, SECRET),
      }),
      fakeDoEnv(stub),
    );
    expect(res.status).toBe(502);
  });

  it('returns 503 when the DO binding is absent', async () => {
    const body = JSON.stringify(prPayload());
    const env = { GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_ALLOWED_INSTALLATION_IDS: '42' } as Env;
    const res = await handleGitHubWebhook(
      makeRequest(body, {
        'X-GitHub-Event': 'pull_request',
        'X-Hub-Signature-256': await sign(body, SECRET),
      }),
      env,
    );
    expect(res.status).toBe(503);
  });
});
