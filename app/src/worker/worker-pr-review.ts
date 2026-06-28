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

import type { ExecutionContext } from '@cloudflare/workers-types';
import type { AIProviderType } from '@push/lib/provider-contract';
import { getClientIp, validateOrigin, type Env } from './worker-middleware';
import { generateGitHubAppJWT, resolveRepoInstallationId } from './worker-infra';
import { isInstallationAllowed, parseInstallationAllowlist } from './github-webhook';
import { enqueueReviewForExistingPr, forwardToDo } from './pr-review-trigger';
import {
  getPrReviewEffectiveConfig,
  isPrReviewEnabled,
  isValidPrReviewRuntimeConfig,
  setPrReviewEnabled,
  setPrReviewRuntimeConfig,
} from './pr-review-config';
import { evictInflightReview, listInflightReviews } from './pr-review-inflight-index';
import type { PrReviewListItem } from './pr-review-job-do';

const LIST_PATH = '/api/pr-reviews';
const RUN_PATH = '/api/pr-reviews/run';
const CANCEL_PATH = '/api/pr-reviews/cancel';
const INFLIGHT_PATH = '/api/pr-reviews/inflight';
const CONFIG_PATH = '/api/pr-reviews/config';

/** Statuses a review can still be cancelled from; everything else is terminal. */
const NON_TERMINAL_STATUSES = new Set(['queued', 'running']);

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

export type PrReviewRouteAction =
  | 'list'
  | 'inflight'
  | 'run'
  | 'cancel'
  | 'config-get'
  | 'config-set';

export function matchPrReviewRoute(pathname: string, method: string): PrReviewRouteAction | null {
  if (pathname === INFLIGHT_PATH && method === 'GET') return 'inflight';
  if (pathname === LIST_PATH && method === 'GET') return 'list';
  if (pathname === RUN_PATH && method === 'POST') return 'run';
  if (pathname === CANCEL_PATH && method === 'POST') return 'cancel';
  if (pathname === CONFIG_PATH && method === 'GET') return 'config-get';
  if (pathname === CONFIG_PATH && method === 'POST') return 'config-set';
  return null;
}

export async function handlePrReviewRoute(
  request: Request,
  env: Env,
  action: PrReviewRouteAction,
  ctx?: ExecutionContext,
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

  if (action === 'run') return handleRun(request, env, requestUrl);
  if (action === 'cancel') return handleCancel(request, env);
  if (action === 'inflight') return handleInflight(env, requestUrl, ctx);
  return handleList(env, requestUrl);
}

async function handleConfigGet(env: Env): Promise<Response> {
  return json(await getPrReviewEffectiveConfig(env));
}

async function handleConfigSet(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'INVALID_BODY', message: 'POST body must be JSON.' }, 400);
  }

  if (!body || typeof body !== 'object') {
    return json({ error: 'INVALID_REQUEST', message: 'POST body must be an object.' }, 400);
  }

  const payload = body as { enabled?: unknown; provider?: unknown; model?: unknown };
  const hasEnabled = Object.prototype.hasOwnProperty.call(payload, 'enabled');
  const hasModelConfig =
    Object.prototype.hasOwnProperty.call(payload, 'provider') ||
    Object.prototype.hasOwnProperty.call(payload, 'model');

  if (!hasEnabled && !hasModelConfig) {
    return json(
      { error: 'INVALID_REQUEST', message: 'enabled or provider/model is required.' },
      400,
    );
  }

  if (hasEnabled && typeof payload.enabled !== 'boolean') {
    return json({ error: 'INVALID_REQUEST', message: 'enabled must be a boolean.' }, 400);
  }

  if (hasModelConfig) {
    if (typeof payload.provider !== 'string' || typeof payload.model !== 'string') {
      return json(
        { error: 'INVALID_REQUEST', message: 'provider and model must both be strings.' },
        400,
      );
    }
    if (!isValidPrReviewRuntimeConfig(payload.provider, payload.model)) {
      return json(
        {
          error: 'INVALID_REQUEST',
          message: 'provider/model is not available for automated reviews.',
        },
        400,
      );
    }
  }

  const persistedEnabled = hasEnabled
    ? await setPrReviewEnabled(env, payload.enabled as boolean)
    : true;
  const persistedModel = hasModelConfig
    ? await setPrReviewRuntimeConfig(
        env,
        payload.provider as AIProviderType,
        payload.model as string,
      )
    : true;

  if (!persistedEnabled || !persistedModel) {
    return json(
      { error: 'NOT_CONFIGURED', message: 'Config store (SNAPSHOT_INDEX KV) is not bound.' },
      503,
    );
  }

  const next = await getPrReviewEffectiveConfig(env);
  log('info', 'pr_review_config_set', {
    enabled: next.enabled,
    provider: next.provider,
    model: next.model,
  });
  return json(next);
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

/**
 * Cross-PR in-flight view: list every `queued`/`running` review for a repo,
 * regardless of which branch's PR it belongs to — the surface that makes Cancel
 * reachable for a review on a PR other than the one the active branch resolves
 * to. The KV discovery index (written at enqueue) supplies the candidate set;
 * each candidate's owning DO is then asked for authoritative status so the list
 * never shows a stale "running" for a review that already finished. Candidates
 * whose DO reports terminal / not-found are lazily evicted from the index here,
 * so it self-heals without the DO having to delete on every terminal path.
 */
async function handleInflight(
  env: Env,
  requestUrl: URL,
  ctx?: ExecutionContext,
): Promise<Response> {
  const repo = requestUrl.searchParams.get('repo') ?? '';
  if (!REPO_RE.test(repo)) {
    return json({ error: 'INVALID_REQUEST', message: 'repo (owner/name) required.' }, 400);
  }

  const candidates = await listInflightReviews(env, repo);
  // Eviction of terminal/not-found entries is best-effort cleanup, not part of
  // the answer — collect the targets and reap them off the response path so a
  // burst of just-finished reviews doesn't add KV-delete latency to the poll.
  const toEvict: Array<{ prNumber: number; deliveryId: string }> = [];
  const resolved = await Promise.all(
    candidates.map(async (entry) => {
      try {
        const doResponse = await forwardToDo(
          env,
          entry.repo,
          entry.prNumber,
          new Request(`https://do/status?deliveryId=${encodeURIComponent(entry.deliveryId)}`, {
            method: 'GET',
          }),
        );
        if (doResponse.status === 404) {
          // The DO has no such row (evicted before the index entry expired).
          toEvict.push({ prNumber: entry.prNumber, deliveryId: entry.deliveryId });
          return null;
        }
        if (!doResponse.ok) return null; // transient — keep the index entry, retry next poll
        const item = (await doResponse.json()) as PrReviewListItem;
        if (NON_TERMINAL_STATUSES.has(item.status)) return item;
        // Terminal: drop it from the index so the next poll skips the round-trip.
        toEvict.push({ prNumber: entry.prNumber, deliveryId: entry.deliveryId });
        return null;
      } catch {
        return null; // transient DO/network failure — leave the index entry alone
      }
    }),
  );

  if (toEvict.length > 0) {
    const evictAll = Promise.all(
      toEvict.map((e) => evictInflightReview(env, repo, e.prNumber, e.deliveryId)),
    );
    // waitUntil keeps the cleanup alive past the response; fall back to awaiting
    // when no ExecutionContext is threaded (e.g. unit tests) so it still runs.
    if (ctx) ctx.waitUntil(evictAll);
    else await evictAll;
  }

  const reviews = resolved
    .filter((r): r is PrReviewListItem => r !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
  log('info', 'pr_review_inflight_listed', {
    repo,
    candidates: candidates.length,
    inflight: reviews.length,
  });
  return json({ reviews }, 200);
}

async function handleRun(request: Request, env: Env, requestUrl: URL): Promise<Response> {
  // Honor the reviewer kill-switch on the manual path too — "off" means no
  // reviews spend quota, whether webhook- or user-triggered. The PWA disables
  // the re-run control when off; this is the server-side backstop.
  if (!(await isPrReviewEnabled(env))) {
    log('info', 'pr_review_run_disabled', {});
    return json(
      { error: 'REVIEWER_DISABLED', message: 'The automated reviewer is turned off.' },
      409,
    );
  }
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

  // Shared with the webhook comment trigger: fetch refs, gate reviewability,
  // and forward the start to the DO. handleRun owns the installation
  // resolution + allowlist above; the helper owns everything from refs onward.
  const result = await enqueueReviewForExistingPr(env, {
    repo,
    prNumber,
    installationId,
    origin: requestUrl.origin,
    deliveryId: `manual-${crypto.randomUUID()}`,
  });
  if (!result.ok) {
    log('warn', 'pr_review_run_enqueue_rejected', {
      repo,
      pr: prNumber,
      code: result.code,
    });
    return json({ error: result.code, message: result.message }, result.httpStatus);
  }
  log('info', 'pr_review_run_enqueued', {
    repo,
    pr: prNumber,
    headSha: result.headSha,
    status: result.status,
  });
  return json({ ok: true, status: result.status }, 202);
}

/**
 * deliveryId charset guard. The DO binds it as a SQL parameter (so it's
 * injection-safe regardless), but constraining it at the edge rejects obviously
 * malformed input with a clear 400 and bounds the value that rides into the DO
 * name-scoped lookup. Covers GitHub delivery UUIDs and our `manual-<uuid>` ids.
 */
const DELIVERY_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * Cancel an in-flight review. Addressed by repo#pr (to reach the DO) plus the
 * review's `deliveryId` (to identify which review within it). Deliberately not
 * gated on the reviewer kill-switch or App creds: cancelling a running review
 * must work even after the reviewer was turned off, and the DO's check-run close
 * is best-effort/token-gated. Origin + rate-limit gating already ran in the
 * caller, same as every other action.
 */
async function handleCancel(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    log('warn', 'pr_review_cancel_invalid_body', {});
    return json({ error: 'INVALID_BODY', message: 'POST body must be JSON.' }, 400);
  }
  const {
    repo: rawRepo,
    pr,
    deliveryId: rawDeliveryId,
  } = (body ?? {}) as { repo?: unknown; pr?: unknown; deliveryId?: unknown };
  const parsed = parseRepoPr(typeof rawRepo === 'string' ? rawRepo : '', String(pr ?? ''));
  const deliveryId = typeof rawDeliveryId === 'string' ? rawDeliveryId : '';
  if (!parsed || !DELIVERY_ID_RE.test(deliveryId)) {
    log('warn', 'pr_review_cancel_invalid_request', {
      repo: String(rawRepo ?? ''),
      pr: String(pr ?? ''),
    });
    return json(
      {
        error: 'INVALID_REQUEST',
        message: 'repo (owner/name), pr (positive integer), and deliveryId are required.',
      },
      400,
    );
  }

  const doResponse = await forwardToDo(
    env,
    parsed.repo,
    parsed.prNumber,
    new Request('https://do/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryId }),
    }),
  );
  // Pass the DO's status through (200 cancelled / 404 not-found / 409 terminal)
  // so the client can distinguish a successful cancel from a stale-tab race.
  // The original response body is never read again, so no clone is needed.
  const outcome = (await doResponse.json().catch(() => ({}))) as {
    status?: string;
    error?: string;
  };
  log(doResponse.ok ? 'info' : 'warn', 'pr_review_cancel_forwarded', {
    repo: parsed.repo,
    pr: parsed.prNumber,
    doStatus: doResponse.status,
    status: outcome.status ?? outcome.error ?? null,
  });
  return json(
    doResponse.ok ? { ok: true, status: outcome.status ?? 'cancelled' } : outcome,
    doResponse.status,
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
