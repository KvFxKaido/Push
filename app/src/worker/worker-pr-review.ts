/**
 * HTTP route for `/api/pr-reviews` — read-only PR review history.
 *
 * Forwards to the `PrReviewJob` Durable Object (bound as `env.PrReviewJob`,
 * named `repo#prNumber`) and returns its `list` of reviews for one PR. The PWA
 * review-history surface polls this while a review is non-terminal.
 *
 * `repo`/`pr` ride in the query string (`?repo=owner/name&pr=7`) so the
 * owner/name slash doesn't collide with path parsing. Fails closed with
 * NOT_CONFIGURED (503) when the DO binding is absent — mirrors `/api/jobs/*`.
 * Origin validation + rate limiting match the jobs router so this read can't
 * bypass CSRF / abuse protections.
 */

import { getClientIp, validateOrigin, type Env } from './worker-middleware';
import { prReviewJobName } from './github-webhook';

const PR_REVIEWS_PATH = '/api/pr-reviews';

/** owner/name — exactly one slash, no path-traversal into the DO name. */
const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

export function matchPrReviewRoute(pathname: string, method: string): boolean {
  return pathname === PR_REVIEWS_PATH && method === 'GET';
}

export async function handlePrReviewRoute(request: Request, env: Env): Promise<Response> {
  if (!env.PrReviewJob) {
    return json(
      { error: 'NOT_CONFIGURED', message: 'PrReviewJob DO binding is not present.' },
      503,
    );
  }

  const requestUrl = new URL(request.url);
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return json({ error: originCheck.error }, 403);
  }

  const { success: rateLimitOk } = await env.RATE_LIMITER.limit({ key: getClientIp(request) });
  if (!rateLimitOk) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded. Try again later.' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'Retry-After': '60' },
    });
  }

  const repo = requestUrl.searchParams.get('repo') ?? '';
  const prRaw = requestUrl.searchParams.get('pr') ?? '';
  const prNumber = Number.parseInt(prRaw, 10);
  // Digits-only so `pr=7abc` is rejected rather than aliased to #7 by parseInt;
  // isSafeInteger guards against overflow on an absurdly long all-digits value.
  if (
    !REPO_RE.test(repo) ||
    !/^\d+$/.test(prRaw) ||
    !Number.isSafeInteger(prNumber) ||
    prNumber <= 0
  ) {
    return json(
      {
        error: 'INVALID_REQUEST',
        message: 'repo (owner/name) and pr (positive integer) required.',
      },
      400,
    );
  }

  const id = env.PrReviewJob.idFromName(prReviewJobName(repo, prNumber));
  const stub = env.PrReviewJob.get(id);
  // CF Workers types diverge from DOM types; cast at this single boundary, same
  // as worker-coder-job.ts.
  return (await (stub as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
    new Request('https://do/list', { method: 'GET' }),
  )) as Response;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
