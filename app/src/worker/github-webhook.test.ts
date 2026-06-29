import { describe, expect, it, vi } from 'vitest';
import type { DurableObjectId, DurableObjectNamespace } from '@cloudflare/workers-types';
import {
  type GitHubWebhookDeps,
  handleGitHubWebhook,
  isAuthorizedTriggerAssociation,
  isInstallationAllowed,
  parseInstallationAllowlist,
  parseReviewCommand,
  prReviewJobName,
  resolveBotHandle,
  selectReviewableComment,
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

/** issue_comment (conversation-tab) payload with an `@push-agent review` body. */
function issueCommentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'created',
    repository: { full_name: 'octo/repo' },
    installation: { id: 42 },
    issue: { number: 7, pull_request: { url: 'https://api.github.com/.../pulls/7' } },
    comment: {
      id: 555,
      body: '@push-agent review',
      author_association: 'COLLABORATOR',
      user: { type: 'User' },
    },
    ...overrides,
  };
}

/** pull_request_review_comment (inline diff-line) payload. */
function reviewCommentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'created',
    repository: { full_name: 'octo/repo' },
    installation: { id: 42 },
    pull_request: { number: 7 },
    comment: {
      id: 777,
      body: 'hey @push-agent please review again',
      author_association: 'MEMBER',
      user: { type: 'User' },
    },
    ...overrides,
  };
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

describe('parseReviewCommand', () => {
  it('fires when the command directly follows the mention (case-insensitive, please, re-review)', () => {
    expect(parseReviewCommand('@push-agent review', 'push-agent')).toBe(true);
    expect(parseReviewCommand('@push-agent please review again', 'push-agent')).toBe(true);
    expect(parseReviewCommand('hey @push-agent please review', 'push-agent')).toBe(true);
    expect(parseReviewCommand('@PUSH-AGENT Review', 'push-agent')).toBe(true);
    expect(parseReviewCommand('@push-agent: review', 'push-agent')).toBe(true);
    expect(parseReviewCommand('@push-agent re-review', 'push-agent')).toBe(true);
  });

  it('accepts the @<slug>[bot] mention form GitHub autocomplete inserts', () => {
    expect(parseReviewCommand('@push-agent[bot] review', 'push-agent')).toBe(true);
    expect(parseReviewCommand('@push-agent[bot] please review', 'push-agent')).toBe(true);
    expect(parseReviewCommand('hey @push-agent[bot] re-review', 'push-agent')).toBe(true);
    // Case-insensitive — the regex 'i' flag covers a rendered-case [BOT].
    expect(parseReviewCommand('@push-agent[BOT] review', 'push-agent')).toBe(true);
    // The optional [bot] group must NOT weaken the prefix-login guard: a longer
    // login that merely starts with the handle is still rejected.
    expect(parseReviewCommand('@push-agent-helper[bot] review', 'push-agent')).toBe(false);
    // …but the [bot] form still requires the command bound to the mention.
    expect(parseReviewCommand('thanks @push-agent[bot] for the review', 'push-agent')).toBe(false);
  });

  it('does not fire when "review" is not a command bound to the mention (Codex P2)', () => {
    // The command must follow the mention — these talk *about* a review.
    expect(parseReviewCommand('Thanks @push-agent for the review', 'push-agent')).toBe(false);
    expect(parseReviewCommand("I addressed @push-agent's review", 'push-agent')).toBe(false);
    expect(parseReviewCommand('@push-agent the review looks wrong', 'push-agent')).toBe(false);
  });

  it('does not fire on a bare mention, a longer login, an email, or non-command words', () => {
    expect(parseReviewCommand('@push-agent what do you think?', 'push-agent')).toBe(false);
    expect(parseReviewCommand('thanks, reviewed already', 'push-agent')).toBe(false); // no mention
    expect(parseReviewCommand('@push-agent-bot review', 'push-agent')).toBe(false); // longer login
    expect(parseReviewCommand('mail foo@push-agent.io to review', 'push-agent')).toBe(false); // not a boundary
    expect(parseReviewCommand('@push-agent reviewed it', 'push-agent')).toBe(false); // "reviewed" ≠ "review"
    expect(parseReviewCommand('@push-agent review', '')).toBe(false); // no handle
    expect(parseReviewCommand('', 'push-agent')).toBe(false);
  });
});

describe('isAuthorizedTriggerAssociation', () => {
  it('allows write-adjacent roles only', () => {
    for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      expect(isAuthorizedTriggerAssociation(a)).toBe(true);
    }
    for (const a of [
      'CONTRIBUTOR',
      'FIRST_TIME_CONTRIBUTOR',
      'NONE',
      'MANNEQUIN',
      '',
      null,
      undefined,
    ]) {
      expect(isAuthorizedTriggerAssociation(a)).toBe(false);
    }
  });
});

describe('resolveBotHandle', () => {
  it('defaults to the app slug, honors an override, and normalizes it', () => {
    expect(resolveBotHandle({} as Env)).toBe('push-agent');
    expect(resolveBotHandle({ PR_REVIEW_BOT_HANDLE: '@Push-Reviewer[bot]' } as Env)).toBe(
      'push-reviewer',
    );
    // Blank/whitespace coalesces back to the slug (kill-switch is the off lever).
    expect(resolveBotHandle({ PR_REVIEW_BOT_HANDLE: '   ' } as Env)).toBe('push-agent');
  });
});

describe('selectReviewableComment', () => {
  const H = 'push-agent';

  it('selects an issue_comment trigger from a collaborator', () => {
    const r = selectReviewableComment('issue_comment', issueCommentPayload(), H);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request).toMatchObject({
        repoFullName: 'octo/repo',
        prNumber: 7,
        installationId: '42',
        commentId: 555,
        commentKind: 'issue',
      });
    }
  });

  it('selects a pull_request_review_comment trigger with kind "review"', () => {
    const r = selectReviewableComment('pull_request_review_comment', reviewCommentPayload(), H);
    expect(r.ok && r.request.commentKind).toBe('review');
    expect(r.ok && r.request.prNumber).toBe(7);
    expect(r.ok && r.request.commentId).toBe(777);
  });

  it('skips a comment on a plain issue (not a PR)', () => {
    expect(
      selectReviewableComment('issue_comment', issueCommentPayload({ issue: { number: 3 } }), H),
    ).toMatchObject({ ok: false, reason: 'not_pull_request' });
  });

  it('skips non-created actions, bot senders, and a missing trigger phrase', () => {
    expect(
      selectReviewableComment('issue_comment', issueCommentPayload({ action: 'edited' }), H),
    ).toMatchObject({ ok: false, reason: 'action:edited' });
    expect(
      selectReviewableComment(
        'issue_comment',
        issueCommentPayload({
          comment: {
            id: 1,
            body: '@push-agent review',
            author_association: 'COLLABORATOR',
            user: { type: 'Bot' },
          },
        }),
        H,
      ),
    ).toMatchObject({ ok: false, reason: 'bot_sender' });
    expect(
      selectReviewableComment(
        'issue_comment',
        issueCommentPayload({
          comment: { id: 1, body: 'lgtm', author_association: 'OWNER', user: { type: 'User' } },
        }),
        H,
      ),
    ).toMatchObject({ ok: false, reason: 'no_trigger' });
  });

  it('skips an unauthorized author_association even with the trigger', () => {
    expect(
      selectReviewableComment(
        'issue_comment',
        issueCommentPayload({
          comment: {
            id: 1,
            body: '@push-agent review',
            author_association: 'NONE',
            user: { type: 'User' },
          },
        }),
        H,
      ),
    ).toMatchObject({ ok: false, reason: 'association:NONE' });
  });

  it('skips non-comment events and incomplete payloads', () => {
    expect(selectReviewableComment('pull_request', issueCommentPayload(), H)).toMatchObject({
      ok: false,
      reason: 'event:pull_request',
    });
    expect(
      selectReviewableComment('issue_comment', issueCommentPayload({ repository: {} }), H),
    ).toMatchObject({ ok: false, reason: 'missing_fields' });
  });
});

describe('handleGitHubWebhook — comment trigger', () => {
  function commentEnv(overrides: Partial<Env> = {}): Env {
    return {
      GITHUB_WEBHOOK_SECRET: SECRET,
      GITHUB_ALLOWED_INSTALLATION_IDS: '42',
      ...overrides,
    } as Env;
  }

  function makeDeps(overrides: Partial<GitHubWebhookDeps> = {}) {
    return {
      enqueueReviewForExistingPr: vi.fn(async () => ({
        ok: true as const,
        status: 'queued',
        headSha: 'sha-9',
      })),
      mintInstallationToken: vi.fn(async () => 'install-tok'),
      addCommentReaction: vi.fn(async () => true),
      ...overrides,
    };
  }

  async function postComment(
    event: string,
    payload: unknown,
    deps: ReturnType<typeof makeDeps>,
    env: Env,
    delivery = 'c-1',
  ): Promise<Response> {
    const body = JSON.stringify(payload);
    // Stub ctx: the reaction is fired via ctx.waitUntil, so addCommentReaction is
    // still invoked synchronously (the promise is constructed before waitUntil).
    const ctx = { waitUntil: () => {} };
    return handleGitHubWebhook(
      makeRequest(body, {
        'X-GitHub-Event': event,
        'X-GitHub-Delivery': delivery,
        'X-Hub-Signature-256': await sign(body, SECRET),
      }),
      env,
      ctx,
      deps as unknown as GitHubWebhookDeps,
    );
  }

  it('enqueues comment-<id> and leaves a 👀 on the happy path', async () => {
    const deps = makeDeps();
    const env = commentEnv();
    const res = await postComment('issue_comment', issueCommentPayload(), deps, env, 'c-happy');
    expect(res.status).toBe(202);
    expect(deps.enqueueReviewForExistingPr).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        repo: 'octo/repo',
        prNumber: 7,
        installationId: '42',
        deliveryId: 'comment-555',
        token: 'install-tok',
        // An on-demand comment is a latest-wins re-request.
        supersedeSameHead: true,
      }),
    );
    expect(deps.addCommentReaction).toHaveBeenCalledWith('octo/repo', 'issue', 555, 'eyes', {
      token: 'install-tok',
    });
  });

  it('defers the 👀 via ctx.waitUntil rather than blocking the 202', async () => {
    const deps = makeDeps();
    const deferred: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        deferred.push(p);
      },
    };
    const body = JSON.stringify(issueCommentPayload());
    const res = await handleGitHubWebhook(
      makeRequest(body, {
        'X-GitHub-Event': 'issue_comment',
        'X-GitHub-Delivery': 'c-defer',
        'X-Hub-Signature-256': await sign(body, SECRET),
      }),
      commentEnv(),
      ctx,
      deps as unknown as GitHubWebhookDeps,
    );
    expect(res.status).toBe(202);
    expect(deferred).toHaveLength(1); // scheduled, not awaited inline
    expect(deps.addCommentReaction).toHaveBeenCalledWith('octo/repo', 'issue', 555, 'eyes', {
      token: 'install-tok',
    });
    await Promise.all(deferred);
  });

  it('awaits the reaction inline when no ctx is provided (defensive fallback)', async () => {
    const deps = makeDeps();
    const body = JSON.stringify(issueCommentPayload());
    const res = await handleGitHubWebhook(
      makeRequest(body, {
        'X-GitHub-Event': 'issue_comment',
        'X-GitHub-Delivery': 'c-noctx',
        'X-Hub-Signature-256': await sign(body, SECRET),
      }),
      commentEnv(),
      undefined,
      deps as unknown as GitHubWebhookDeps,
    );
    expect(res.status).toBe(202);
    expect(deps.addCommentReaction).toHaveBeenCalledWith('octo/repo', 'issue', 555, 'eyes', {
      token: 'install-tok',
    });
  });

  it('contains a rejecting reaction (inline-await path still acks 202)', async () => {
    // The no-ctx path awaits the reaction, so a reject would otherwise throw into
    // the handler and 500 the webhook. The .catch must contain it.
    const deps = makeDeps({
      addCommentReaction: vi.fn(async () => {
        throw new Error('reaction endpoint boom');
      }),
    });
    const body = JSON.stringify(issueCommentPayload());
    const res = await handleGitHubWebhook(
      makeRequest(body, {
        'X-GitHub-Event': 'issue_comment',
        'X-GitHub-Delivery': 'c-reject',
        'X-Hub-Signature-256': await sign(body, SECRET),
      }),
      commentEnv(),
      undefined,
      deps as unknown as GitHubWebhookDeps,
    );
    expect(res.status).toBe(202);
    expect(deps.addCommentReaction).toHaveBeenCalled();
  });

  it('reacts on the inline review-comment endpoint kind', async () => {
    const deps = makeDeps();
    const res = await postComment(
      'pull_request_review_comment',
      reviewCommentPayload(),
      deps,
      commentEnv(),
    );
    expect(res.status).toBe(202);
    expect(deps.addCommentReaction).toHaveBeenCalledWith('octo/repo', 'review', 777, 'eyes', {
      token: 'install-tok',
    });
  });

  it('skips (204) a comment without the trigger and never mints/enqueues', async () => {
    const deps = makeDeps();
    const res = await postComment(
      'issue_comment',
      issueCommentPayload({
        comment: { id: 9, body: 'nice work', author_association: 'OWNER', user: { type: 'User' } },
      }),
      deps,
      commentEnv(),
    );
    expect(res.status).toBe(204);
    expect(deps.mintInstallationToken).not.toHaveBeenCalled();
    expect(deps.enqueueReviewForExistingPr).not.toHaveBeenCalled();
  });

  it('skips (204) an unauthorized author even with the trigger', async () => {
    const deps = makeDeps();
    const res = await postComment(
      'issue_comment',
      issueCommentPayload({
        comment: {
          id: 9,
          body: '@push-agent review',
          author_association: 'NONE',
          user: { type: 'User' },
        },
      }),
      deps,
      commentEnv(),
    );
    expect(res.status).toBe(204);
    expect(deps.enqueueReviewForExistingPr).not.toHaveBeenCalled();
  });

  it('rejects (403) a non-allowlisted installation', async () => {
    const deps = makeDeps();
    const res = await postComment(
      'issue_comment',
      issueCommentPayload({ installation: { id: 999 } }),
      deps,
      commentEnv(),
    );
    expect(res.status).toBe(403);
    expect(deps.enqueueReviewForExistingPr).not.toHaveBeenCalled();
  });

  it('acks 202 "disabled" without enqueue when the reviewer is off', async () => {
    const deps = makeDeps();
    const env = commentEnv({
      SNAPSHOT_INDEX: {
        get: async (k: string) => (k === 'config:pr-review-enabled' ? '0' : null),
      } as unknown as Env['SNAPSHOT_INDEX'],
    });
    const res = await postComment('issue_comment', issueCommentPayload(), deps, env);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'disabled' });
    expect(deps.enqueueReviewForExistingPr).not.toHaveBeenCalled();
  });

  it('acks 204 and leaves a 😕 when the PR is not reviewable', async () => {
    const deps = makeDeps({
      enqueueReviewForExistingPr: vi.fn(async () => ({
        ok: false as const,
        code: 'NOT_REVIEWABLE',
        message: 'PR #7 is closed — only open, non-draft PRs are reviewed.',
        httpStatus: 409,
      })),
    });
    const res = await postComment('issue_comment', issueCommentPayload(), deps, commentEnv());
    expect(res.status).toBe(204);
    // A 'confused' reaction signals received-but-skipped rather than silent ignore.
    expect(deps.addCommentReaction).toHaveBeenCalledWith('octo/repo', 'issue', 555, 'confused', {
      token: 'install-tok',
    });
  });

  it('returns 502 when token minting fails (and does not enqueue)', async () => {
    const deps = makeDeps({ mintInstallationToken: vi.fn(async () => null) });
    const res = await postComment('issue_comment', issueCommentPayload(), deps, commentEnv());
    expect(res.status).toBe(502);
    expect(deps.enqueueReviewForExistingPr).not.toHaveBeenCalled();
  });
});
