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
import { isPrReviewEnabled, setPrReviewEnabled } from './pr-review-config';

const LIST_PATH = '/api/pr-reviews';
const RUN_PATH = '/api/pr-reviews/run';
const CONFIG_PATH = '/api/pr-reviews/config';

/**
 * owner/name with GitHub-valid characters only (alphanumeric, `.`, `_`, `-`).
 * Forbids `/`, whitespace, and URL delimiters (`?`, `#`) so the value can't
 * traverse the DO name or alter an interpolated GitHub API path.
 */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  ctx: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ level, event, ...ctx }));
}

export type PrReviewRouteAction = 'list' | 'run' | 'config-get' | 'config-set';

export function matchPrReviewRoute(pathname: string, method: string): PrReviewRouteAction | null {
  if (pathname === LIST_PATH && method === 'GET') return 'list';
  if (pathname === RUN_PATH && method === 'POST') return 'run';
  if (pathname === CONFIG_PATH && method === 'GET') return 'config-get';
  if (pathname === CONFIG_PATH && method === 'POST') return 'config-set';
  return null;
}

export async function handlePrReviewRoute(
  request: Request,
  env: Env,
  action: PrReviewRouteAction,
): Promise<Response> {
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

  // The reviewer on/off flag lives in KV, independent of the DO — handle it
  // before the PrReviewJob binding check so the toggle works even if the DO
  // weren't bound.
  if (action === 'config-get') return handleConfigGet(env);
  if (action === 'config-set') return handleConfigSet(request, env);

  if (!env.PrReviewJob) {
    return json(
      { error: 'NOT_CONFIGURED', message: 'PrReviewJob DO binding is not present.' },
      503,
    );
  }

  return action === 'run' ? handleRun(request, env, requestUrl) : handleList(env, requestUrl);
}

async function handleConfigGet(env: Env): Promise<Response> {
  return json({ enabled: await isPrReviewEnabled(env) });
}

async function handleConfigSet(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'INVALID_BODY', message: 'POST body must be JSON.' }, 400);
  }
  const enabled = (body as { enabled?: unknown })?.enabled;
  if (typeof enabled !== 'boolean') {
    return json({ error: 'INVALID_REQUEST', message: 'enabled (boolean) is required.' }, 400);
  }
  const persisted = await setPrReviewEnabled(env, enabled);
  if (!persisted) {
    return json(
      { error: 'NOT_CONFIGURED', message: 'Config store (SNAPSHOT_INDEX KV) is not bound.' },
      503,
    );
  }
  log('info', 'pr_review_config_set', { enabled });
  return json({ enabled });
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

async function handleList(env: Env, requestUrl: URL): Promise<Response> {
  const parsed = parseRepoPr(
    requestUrl.searchParams.get('repo') ?? '',
    requestUrl.searchParams.get('pr') ?? '',
  );
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

async function handleRun(request: Request, env: Env, requestUrl: URL): Promise<Response> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    log('error', 'pr_review_run_not_configured', {});
    return json({ error: 'NOT_CONFIGURED', message: 'GitHub App is not configured.' }, 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    log('warn', 'pr_review_run_invalid_body', {});
    return json({ error: 'INVALID_BODY', message: 'POST body must be JSON.' }, 400);
  }
  const { repo: rawRepo, pr } = (body ?? {}) as { repo?: unknown; pr?: unknown };
  const parsed = parseRepoPr(typeof rawRepo === 'string' ? rawRepo : '', String(pr ?? ''));
  if (!parsed) {
    log('warn', 'pr_review_run_invalid_request', {
      repo: String(rawRepo ?? ''),
      pr: String(pr ?? ''),
    });
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
    log('warn', 'pr_review_run_installation_lookup_failed', { repo });
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
    log('warn', 'pr_review_run_installation_denied', { repo, installationId });
    return json({ error: 'INSTALLATION_NOT_ALLOWED' }, 403);
  }

  let refs: Awaited<ReturnType<typeof fetchPullRequestRefs>>;
  try {
    const { token } = await exchangeForInstallationToken(jwt, installationId);
    refs = await fetchPullRequestRefs(repo, prNumber, { token });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('warn', 'pr_review_run_pr_lookup_failed', { repo, pr: prNumber, message });
    return json({ error: 'PR_LOOKUP_FAILED', message }, 502);
  }

  // Mirror the webhook's reviewability gate: only open, non-draft PRs. A stale
  // tab or direct call shouldn't spend a review on a PR the autonomous path
  // intentionally ignores.
  if (refs.state !== 'open' || refs.draft) {
    log('info', 'pr_review_run_not_reviewable', {
      repo,
      pr: prNumber,
      state: refs.state,
      draft: refs.draft,
    });
    return json(
      {
        error: 'NOT_REVIEWABLE',
        message: `PR #${prNumber} is ${refs.draft ? 'a draft' : refs.state} — only open, non-draft PRs are reviewed.`,
      },
      409,
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
    origin: requestUrl.origin,
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
    log('error', 'pr_review_run_enqueue_failed', {
      repo,
      pr: prNumber,
      doStatus: doResponse.status,
    });
    return json({ error: 'ENQUEUE_FAILED', status: outcome.status }, 502);
  }
  log('info', 'pr_review_run_enqueued', {
    repo,
    pr: prNumber,
    headSha: refs.headSha,
    status: outcome.status ?? 'queued',
  });
  return json({ ok: true, status: outcome.status ?? 'queued' }, 202);
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
