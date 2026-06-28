/**
 * Shared enqueue path for the autonomous PR reviewer.
 *
 * Both the in-app manual re-run route (`worker-pr-review.ts handleRun`) and the
 * webhook comment trigger (`github-webhook.ts`, `@push-agent review`) need the
 * same core: take an open PR we don't have a webhook payload for, fetch its
 * refs, gate reviewability, and forward a `PrReviewStartInput` to the
 * `PrReviewJob` Durable Object. This module owns that core so the two callers
 * can't drift (one reviewability gate, one start-input shape).
 *
 * The DO name helper and the DO-forward live here too so a single module owns
 * everything that addresses a `PrReviewJob` instance; `github-webhook.ts`
 * re-exports `prReviewJobName` for its existing importers.
 */

import { fetchPullRequestRefs } from '@/lib/github-tools';
import { exchangeForInstallationToken, generateGitHubAppJWT } from './worker-infra';
import type { Env } from './worker-middleware';

function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  ctx: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ level, event, ...ctx }));
}

/** Stable DO name so all events for one PR land on the same instance. */
export function prReviewJobName(repoFullName: string, prNumber: number): string {
  return `${repoFullName}#${prNumber}`;
}

/**
 * Mint a short-lived installation token for `installationId`. Returns null
 * (logged) when the App isn't configured or the exchange fails, so callers can
 * treat token acquisition as a single fallible step rather than threading
 * try/catch through the request path.
 */
export async function mintInstallationToken(
  env: Env,
  installationId: string,
): Promise<string | null> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    log('warn', 'pr_review_trigger_token_not_configured', { installationId });
    return null;
  }
  try {
    const jwt = await generateGitHubAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
    const { token } = await exchangeForInstallationToken(jwt, installationId);
    return token;
  } catch (err) {
    log('warn', 'pr_review_trigger_token_mint_failed', {
      installationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Forward a request to the `PrReviewJob` DO instance for `repo#prNumber`. */
export async function forwardToDo(
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

export interface EnqueueReviewOptions {
  repo: string;
  prNumber: number;
  /** Installation that owns the repo — already resolved/authorized by the caller. */
  installationId: string;
  /** Worker origin, threaded to the DO's provider-stream adapter. */
  origin: string;
  /** Dedupe/coalescing key for the DO (`manual-<uuid>` or `comment-<id>`). */
  deliveryId: string;
  /**
   * Pre-minted installation token to reuse for the PR-refs lookup. The comment
   * trigger mints one token up front (it also needs it for the 👀 reaction) and
   * passes it here to avoid a second token exchange; omit it and the helper
   * mints its own (the manual-run path).
   */
  token?: string;
  /**
   * Supersede an in-flight review on the *same* head SHA (latest-wins). Set by
   * the on-demand comment trigger so a re-request cancels the running pass;
   * omit it (manual-run / webhook open) to keep the default "supersede older
   * heads only" coalescing.
   */
  supersedeSameHead?: boolean;
}

export type EnqueueReviewResult =
  | { ok: true; status: string; headSha: string }
  | { ok: false; code: string; message: string; httpStatus: number };

/**
 * Resolve an open PR's refs and enqueue a review on the `PrReviewJob` DO. Mirrors
 * the webhook receiver's gating (open, non-draft PRs only) so a manual/comment
 * trigger can't review a PR the autonomous path intentionally ignores. Returns a
 * discriminated result the caller maps to its own response/log shape — this
 * helper never throws into the request path (lookup failures become a
 * `PR_LOOKUP_FAILED` result).
 *
 * The caller is responsible for the boundary gates (origin/rate-limit for the
 * HTTP route, signature/allowlist/author for the webhook) and for resolving +
 * authorizing `installationId` before calling.
 */
export async function enqueueReviewForExistingPr(
  env: Env,
  opts: EnqueueReviewOptions,
): Promise<EnqueueReviewResult> {
  if (!env.PrReviewJob) {
    return {
      ok: false,
      code: 'NOT_CONFIGURED',
      message: 'PrReviewJob DO is not bound.',
      httpStatus: 503,
    };
  }
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return {
      ok: false,
      code: 'NOT_CONFIGURED',
      message: 'GitHub App is not configured.',
      httpStatus: 503,
    };
  }

  const token = opts.token ?? (await mintInstallationToken(env, opts.installationId));
  if (!token) {
    return {
      ok: false,
      code: 'TOKEN_MINT_FAILED',
      message: 'Could not mint a GitHub installation token.',
      httpStatus: 502,
    };
  }

  let refs: Awaited<ReturnType<typeof fetchPullRequestRefs>>;
  try {
    refs = await fetchPullRequestRefs(opts.repo, opts.prNumber, { token });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('warn', 'pr_review_trigger_pr_lookup_failed', {
      repo: opts.repo,
      pr: opts.prNumber,
      message,
    });
    return { ok: false, code: 'PR_LOOKUP_FAILED', message, httpStatus: 502 };
  }

  // Mirror the webhook's reviewability gate: only open, non-draft PRs. A stale
  // tab, direct call, or comment on a draft shouldn't spend a review on a PR the
  // autonomous path intentionally ignores.
  if (refs.state !== 'open' || refs.draft) {
    log('info', 'pr_review_trigger_not_reviewable', {
      repo: opts.repo,
      pr: opts.prNumber,
      state: refs.state,
      draft: refs.draft,
    });
    return {
      ok: false,
      code: 'NOT_REVIEWABLE',
      message: `PR #${opts.prNumber} is ${
        refs.draft ? 'a draft' : refs.state
      } — only open, non-draft PRs are reviewed.`,
      httpStatus: 409,
    };
  }

  const startBody = JSON.stringify({
    deliveryId: opts.deliveryId,
    repoFullName: opts.repo,
    prNumber: opts.prNumber,
    headSha: refs.headSha,
    headRef: refs.headRef,
    baseRef: refs.baseRef,
    installationId: opts.installationId,
    isCrossFork: refs.isCrossFork,
    origin: opts.origin,
    ...(opts.supersedeSameHead ? { supersedeSameHead: true } : null),
  });
  const doResponse = await forwardToDo(
    env,
    opts.repo,
    opts.prNumber,
    new Request('https://do/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: startBody,
    }),
  );
  const outcome = (await doResponse.json().catch(() => ({}))) as { status?: string };
  if (!doResponse.ok) {
    log('error', 'pr_review_trigger_enqueue_failed', {
      repo: opts.repo,
      pr: opts.prNumber,
      doStatus: doResponse.status,
      outcome: outcome.status ?? 'unknown',
    });
    return {
      ok: false,
      code: 'ENQUEUE_FAILED',
      message: `PrReviewJob rejected the start (${doResponse.status}).`,
      httpStatus: 502,
    };
  }
  return { ok: true, status: outcome.status ?? 'queued', headSha: refs.headSha };
}
