/**
 * HTTP routes for PR review history + manual re-run.
 *
 *   GET  /api/pr-reviews?repo=owner/name&pr=7   — read-only review history
 *   POST /api/pr-reviews/run  { repo, pr }      — trigger a fresh review now
 *
 * Both forward to the `PrReviewJob` Durable Object (named `repo#prNumber`).
 * `repo`/`pr` for the read ride in the query string so the owner/name slash
 * doesn't collide with path parsing. Fails closed with NOT_CONFIGURED (503)
 * when the DO binding is absent. Origin validation + rate limiting match the
 * jobs router so neither path can bypass CSRF / abuse protections.
 *
 * The run trigger resolves the GitHub App installation for the repo
 * server-side (via the app JWT) rather than trusting a client-supplied id, then
 * gates it on the installation allowlist before minting a token — same boundary
 * the webhook receiver enforces.
 */

import { getClientIp, validateOrigin, type Env } from './worker-middleware';
import {
  exchangeForInstallationToken,
  generateGitHubAppJWT,
  resolveRepoInstallationId,
} from './worker-infra';
import {
  isInstallationAllowed,
  parseInstallationAllowlist,
  prReviewJobName,
} from './github-webhook';
import { fetchPullRequestRefs } from '@/lib/github-tools';

const LIST_PATH = '/api/pr-reviews';
const RUN_PATH = '/api/pr-reviews/run';

/** owner/name — exactly one slash, no path-traversal into the DO name. */
const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

export type PrReviewRouteAction = 'list' | 'run';

export function matchPrReviewRoute(pathname: string, method: string): PrReviewRouteAction | null {
  if (pathname === LIST_PATH && method === 'GET') return 'list';
  if (pathname === RUN_PATH && method === 'POST') return 'run';
  return null;
}

export async function handlePrReviewRoute(
  request: Request,
  env: Env,
  action: PrReviewRouteAction,
): Promise<Response> {
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

  return action === 'run' ? handleRun(request, env) : handleList(request, env);
}

/** Validate an owner/name + positive-integer PR, returning them or null. */
function parseRepoPr(repo: string, prRaw: string): { repo: string; prNumber: number } | null {
  const prNumber = Number.parseInt(prRaw, 10);
  if (
    !REPO_RE.test(repo) ||
    !/^\d+$/.test(prRaw) ||
    !Number.isSafeInteger(prNumber) ||
    prNumber <= 0
  ) {
    return null;
  }
  return { repo, prNumber };
}

async function handleList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseRepoPr(url.searchParams.get('repo') ?? '', url.searchParams.get('pr') ?? '');
  if (!parsed) {
    return json(
      {
        error: 'INVALID_REQUEST',
        message: 'repo (owner/name) and pr (positive integer) required.',
      },
      400,
    );
  }
  return forwardToDo(
    env,
    parsed.repo,
    parsed.prNumber,
    new Request('https://do/list', { method: 'GET' }),
  );
}

async function handleRun(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return json({ error: 'NOT_CONFIGURED', message: 'GitHub App is not configured.' }, 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'INVALID_BODY', message: 'POST body must be JSON.' }, 400);
  }
  const { repo: rawRepo, pr } = (body ?? {}) as { repo?: unknown; pr?: unknown };
  const parsed = parseRepoPr(typeof rawRepo === 'string' ? rawRepo : '', String(pr ?? ''));
  if (!parsed) {
    return json(
      {
        error: 'INVALID_REQUEST',
        message: 'repo (owner/name) and pr (positive integer) required.',
      },
      400,
    );
  }
  const { repo, prNumber } = parsed;

  // Resolve the installation for this repo server-side (authoritative), gate it
  // on the allowlist, then mint a scoped token — mirrors the webhook boundary.
  const jwt = await generateGitHubAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  let installationId: string;
  try {
    installationId = await resolveRepoInstallationId(jwt, repo);
  } catch {
    return json(
      { error: 'INSTALLATION_LOOKUP_FAILED', message: `No app installation for ${repo}.` },
      502,
    );
  }
  if (
    !isInstallationAllowed(
      installationId,
      parseInstallationAllowlist(env.GITHUB_ALLOWED_INSTALLATION_IDS),
    )
  ) {
    return json({ error: 'INSTALLATION_NOT_ALLOWED' }, 403);
  }

  let refs: Awaited<ReturnType<typeof fetchPullRequestRefs>>;
  try {
    const { token } = await exchangeForInstallationToken(jwt, installationId);
    refs = await fetchPullRequestRefs(repo, prNumber, { token });
  } catch (err) {
    return json(
      { error: 'PR_LOOKUP_FAILED', message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }

  const startBody = JSON.stringify({
    deliveryId: `manual-${crypto.randomUUID()}`,
    repoFullName: repo,
    prNumber,
    headSha: refs.headSha,
    headRef: refs.headRef,
    baseRef: refs.baseRef,
    installationId,
    isCrossFork: refs.isCrossFork,
    origin: requestUrlOrigin(request),
  });
  const doResponse = await forwardToDo(
    env,
    repo,
    prNumber,
    new Request('https://do/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: startBody,
    }),
  );
  const outcome = (await doResponse
    .clone()
    .json()
    .catch(() => ({}))) as { status?: string };
  if (!doResponse.ok) {
    return json({ error: 'ENQUEUE_FAILED', status: outcome.status }, 502);
  }
  return json({ ok: true, status: outcome.status ?? 'queued' }, 202);
}

function requestUrlOrigin(request: Request): string {
  return new URL(request.url).origin;
}

async function forwardToDo(
  env: Env,
  repo: string,
  prNumber: number,
  doRequest: Request,
): Promise<Response> {
  const id = env.PrReviewJob!.idFromName(prReviewJobName(repo, prNumber));
  const stub = env.PrReviewJob!.get(id);
  // CF Workers types diverge from DOM types; cast at this single boundary, same
  // as worker-coder-job.ts.
  return (await (stub as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
    doRequest,
  )) as Response;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
