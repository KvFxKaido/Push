/**
 * GitHub App webhook receiver — autonomous PR-review trigger.
 *
 * Design: docs/decisions/Webhook-Triggered PR Review.md
 *
 * GitHub can't attach a Push session, so `/api/github/webhook` is exempt from the
 * session gate (the exempt set in `worker-middleware.ts`). The webhook's own auth
 * is the HMAC signature verified here against `GITHUB_WEBHOOK_SECRET` — the
 * receiver fails closed when that secret is unset. Each gate emits a paired
 * structured log so a dropped delivery is visible to ops rather than silent
 * (CLAUDE.md "Symmetric structured logs").
 *
 * The receiver does cheap, synchronous gating only and hands the actual review
 * to the `PrReviewJob` Durable Object, returning 202 well inside GitHub's ~10s
 * delivery budget. Replay dedupe and same-PR coalescing live in the DO (keyed by
 * `repo#prNumber`), so the receiver stays stateless.
 */

import { timingSafeEqual, type Env } from './worker-middleware';
import { isPrReviewEnabled } from './pr-review-config';
import {
  enqueueReviewForExistingPr,
  mintInstallationToken,
  prReviewJobName,
} from './pr-review-trigger';
import { GITHUB_APP_SLUG } from './worker-infra';
import { addCommentReaction, type CommentReactionKind } from '@/lib/github-tools';

// `prReviewJobName` now lives in pr-review-trigger.ts (single owner of DO
// addressing); re-export it here so existing importers/tests keep their path.
export { prReviewJobName } from './pr-review-trigger';

/**
 * Actions on a `pull_request` event that warrant a fresh review.
 *
 * Deliberately excludes `synchronize` (a new commit pushed to the head branch):
 * the reviewer fires on a PR's first open — and on reopen / draft-becomes-ready,
 * which are the "first review" moment for those flows — but NOT on every
 * subsequent commit. Re-reviewing each push is noisy and the follow-up bots
 * (and the author) don't reliably re-read follow-up reviews anyway.
 */
const REVIEWABLE_ACTIONS = new Set(['opened', 'reopened', 'ready_for_review']);

/** A pull_request event we've decided to review, with everything the DO needs. */
export interface ReviewablePullRequest {
  repoFullName: string;
  prNumber: number;
  /** Head commit SHA — the review target and the coalescing discriminator. */
  headSha: string;
  /** Head branch ref (e.g. `feature/x`). */
  headRef: string;
  /**
   * Base branch ref (e.g. `main`). REVIEW.md guidance is resolved from the base
   * ref, never the head — a fork's head is attacker-controlled (see design doc
   * Security checklist).
   */
  baseRef: string;
  installationId: string;
  /** True when the PR head lives in a different repo (fork). */
  isCrossFork: boolean;
}

function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  ctx: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ level, event, ...ctx }));
}

/**
 * Verify a GitHub webhook HMAC signature. GitHub sends
 * `X-Hub-Signature-256: sha256=<hex>` over the raw request body keyed with the
 * app's webhook secret. Returns false (never throws) on any malformed input so
 * callers can treat the result as a single auth gate.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!secret) return false;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

  // Constant-time compare so a timing side channel can't be used to forge the
  // hex digest byte-by-byte.
  return timingSafeEqual(signatureHeader, expected);
}

/** Parse `GITHUB_ALLOWED_INSTALLATION_IDS` (comma/whitespace separated). */
export function parseInstallationAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * An empty allowlist means "no installation may trigger reviews" — fail closed.
 * This is deliberately stricter than a missing-allowlist-allows-all default: an
 * autonomous agent that posts to GitHub should never be open by omission.
 */
export function isInstallationAllowed(installationId: string, allowlist: Set<string>): boolean {
  return allowlist.size > 0 && allowlist.has(installationId);
}

/**
 * Decide whether a delivered event is a reviewable PR and extract the fields the
 * DO needs. Returns null (with a `reason` logged by the caller) for any event we
 * don't act on: non-PR events, non-reviewable actions, draft PRs, or payloads
 * missing required fields.
 */
export function selectReviewablePullRequest(
  eventName: string | null,
  payload: unknown,
): { ok: true; pr: ReviewablePullRequest } | { ok: false; reason: string } {
  if (eventName !== 'pull_request') return { ok: false, reason: `event:${eventName ?? 'none'}` };

  const p = payload as {
    action?: string;
    repository?: { full_name?: string };
    installation?: { id?: number | string };
    pull_request?: {
      number?: number;
      draft?: boolean;
      head?: { sha?: string; ref?: string; repo?: { full_name?: string } };
      base?: { ref?: string };
    };
  };

  const action = p.action ?? '';
  if (!REVIEWABLE_ACTIONS.has(action)) return { ok: false, reason: `action:${action}` };

  const pr = p.pull_request;
  if (!pr) return { ok: false, reason: 'no_pull_request' };
  if (pr.draft) return { ok: false, reason: 'draft' };

  const repoFullName = p.repository?.full_name;
  const prNumber = pr.number;
  const headSha = pr.head?.sha;
  const headRef = pr.head?.ref;
  const baseRef = pr.base?.ref;
  const installationId = p.installation?.id != null ? String(p.installation.id) : '';

  if (!repoFullName || !prNumber || !headSha || !headRef || !baseRef || !installationId) {
    return { ok: false, reason: 'missing_fields' };
  }

  return {
    ok: true,
    pr: {
      repoFullName,
      prNumber,
      headSha,
      headRef,
      baseRef,
      installationId,
      isCrossFork: pr.head?.repo?.full_name !== repoFullName,
    },
  };
}

// --- Comment-triggered review (`@push-agent review`) ---

/** Comment events that can carry an @-mention trigger. */
const COMMENT_EVENTS = new Set(['issue_comment', 'pull_request_review_comment']);

/**
 * `author_association` values trusted to spend a review. These are the
 * write-adjacent relationships; CONTRIBUTOR / FIRST_TIME_CONTRIBUTOR / NONE /
 * MANNEQUIN are intentionally excluded so a drive-by outsider on a public PR
 * can't burn provider tokens. This gates *who within the repo* may trigger; the
 * installation allowlist (who installed the app) is a separate gate in the
 * handler.
 */
const AUTHORIZED_TRIGGER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function isAuthorizedTriggerAssociation(assoc: string | null | undefined): boolean {
  return !!assoc && AUTHORIZED_TRIGGER_ASSOCIATIONS.has(assoc);
}

/**
 * Resolve the mention handle that triggers a review. Defaults to the App slug
 * (GitHub renders an app mention as `@<slug>`); `PR_REVIEW_BOT_HANDLE` overrides
 * it. Normalizes a configured full login (`@push-agent[bot]`) down to the bare
 * slug and lower-cases for case-insensitive matching. Returns '' when blank so
 * the caller fails closed (can't match a mention it doesn't know).
 */
export function resolveBotHandle(env: Env): string {
  // A blank/whitespace override coalesces back to the slug — the reviewer
  // kill-switch (isPrReviewEnabled) is the lever for turning triggering off, not
  // an empty handle.
  const raw = env.PR_REVIEW_BOT_HANDLE?.trim() || GITHUB_APP_SLUG;
  return raw
    .replace(/^@/, '')
    .replace(/\[bot\]$/i, '')
    .trim()
    .toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when a comment body @-mentions the bot AND carries the `review` command —
 * `@push-agent review`, `@push-agent please review again`, `@push-agent re-review`.
 * The mention must sit at a word boundary (start-of-line or after whitespace) and
 * not be a prefix of a longer login (`@push-agent-bot` ≠ `@push-agent`), so an
 * incidental mention or an email-looking string doesn't fire. The command word
 * is a standalone `review` (so "reviewed"/"preview" don't match).
 */
export function parseReviewCommand(body: string | null | undefined, handle: string): boolean {
  if (!body || !handle) return false;
  const mention = new RegExp(`(?:^|\\s)@${escapeRegExp(handle)}(?![a-z0-9-])`, 'im');
  if (!mention.test(body)) return false;
  return /\breview\b/i.test(body);
}

/** A PR comment we've decided is a review trigger, with what the enqueue needs. */
export interface CommentReviewRequest {
  repoFullName: string;
  prNumber: number;
  installationId: string;
  commentId: number;
  /** Which reaction endpoint to use when acking (conversation vs inline comment). */
  commentKind: CommentReactionKind;
}

/**
 * Decide whether a comment event is a review trigger and extract the fields the
 * enqueue needs. Returns a `reason` (logged by the caller) for every non-trigger
 * path: non-comment event; unknown handle; non-`created` action; bot sender;
 * comment on a plain issue (not a PR); no trigger phrase; unauthorized
 * association; missing fields. The trigger-phrase check precedes the
 * authorization check on purpose — only comments that actually invoked the bot
 * get an `association:*` skip logged, so ordinary chatter stays quiet.
 */
export function selectReviewableComment(
  eventName: string | null,
  payload: unknown,
  handle: string,
): { ok: true; request: CommentReviewRequest } | { ok: false; reason: string } {
  if (!eventName || !COMMENT_EVENTS.has(eventName)) {
    return { ok: false, reason: `event:${eventName ?? 'none'}` };
  }
  if (!handle) return { ok: false, reason: 'no_handle' };

  const p = payload as {
    action?: string;
    repository?: { full_name?: string };
    installation?: { id?: number | string };
    comment?: {
      id?: number;
      body?: string;
      author_association?: string;
      user?: { type?: string };
    };
    issue?: { number?: number; pull_request?: unknown };
    pull_request?: { number?: number };
  };

  // Only newly-created comments trigger. Edits/deletes are ignored so editing an
  // old comment (or a re-delivered edit) can't silently re-spend a review.
  if (p.action !== 'created') return { ok: false, reason: `action:${p.action ?? ''}` };

  const comment = p.comment;
  if (!comment) return { ok: false, reason: 'no_comment' };

  // Never act on a bot's comment — keeps the reviewer's own posts (or any other
  // bot) from triggering a review loop.
  if (comment.user?.type === 'Bot') return { ok: false, reason: 'bot_sender' };

  // issue_comment fires for plain issues too; only PR comments carry
  // `issue.pull_request`. pull_request_review_comment is always on a PR.
  const isReview = eventName === 'pull_request_review_comment';
  if (!isReview && !p.issue?.pull_request) return { ok: false, reason: 'not_pull_request' };

  if (!parseReviewCommand(comment.body, handle)) return { ok: false, reason: 'no_trigger' };

  if (!isAuthorizedTriggerAssociation(comment.author_association)) {
    return { ok: false, reason: `association:${comment.author_association ?? 'none'}` };
  }

  const repoFullName = p.repository?.full_name;
  const prNumber = isReview ? p.pull_request?.number : p.issue?.number;
  const installationId = p.installation?.id != null ? String(p.installation.id) : '';
  const commentId = comment.id;

  if (!repoFullName || !prNumber || !installationId || !commentId) {
    return { ok: false, reason: 'missing_fields' };
  }

  return {
    ok: true,
    request: {
      repoFullName,
      prNumber,
      installationId,
      commentId,
      commentKind: isReview ? 'review' : 'issue',
    },
  };
}

/**
 * Network-touching collaborators of the comment-trigger path, injectable so unit
 * tests can exercise the routing without minting GitHub tokens or posting
 * reactions. Defaults to the real implementations.
 */
export interface GitHubWebhookDeps {
  enqueueReviewForExistingPr: typeof enqueueReviewForExistingPr;
  mintInstallationToken: typeof mintInstallationToken;
  addCommentReaction: typeof addCommentReaction;
}

const DEFAULT_DEPS: GitHubWebhookDeps = {
  enqueueReviewForExistingPr,
  mintInstallationToken,
  addCommentReaction,
};

/**
 * `/api/github/webhook` handler. Gates the delivery (signature → parse →
 * event-select → allowlist), then enqueues to the `PrReviewJob` DO and acks 202.
 * `pull_request` opens fire a review directly; `issue_comment` /
 * `pull_request_review_comment` carrying `@<bot> review` route through the
 * comment trigger.
 */
export async function handleGitHubWebhook(
  request: Request,
  env: Env,
  deps: GitHubWebhookDeps = DEFAULT_DEPS,
): Promise<Response> {
  const deliveryId = request.headers.get('X-GitHub-Delivery') ?? '';
  const eventName = request.headers.get('X-GitHub-Event');

  const secret = (env.GITHUB_WEBHOOK_SECRET ?? '').trim();
  if (!secret) {
    // Fail closed: without a secret we can't authenticate GitHub, so we refuse
    // rather than process unauthenticated payloads.
    log('error', 'webhook_not_configured', { deliveryId });
    return json({ error: 'NOT_CONFIGURED', message: 'Webhook secret is not set.' }, 503);
  }

  const rawBody = await request.text();
  const signature = request.headers.get('X-Hub-Signature-256');
  if (!(await verifyWebhookSignature(rawBody, signature, secret))) {
    log('warn', 'webhook_rejected_signature', { deliveryId, eventName });
    return json({ error: 'INVALID_SIGNATURE' }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    log('warn', 'webhook_rejected_body', { deliveryId, eventName });
    return json({ error: 'INVALID_BODY' }, 400);
  }

  // Comment events (`@push-agent review`) route through the comment trigger; the
  // signature + body parse above are shared with the pull_request path.
  if (eventName && COMMENT_EVENTS.has(eventName)) {
    return handleCommentReviewTrigger(
      env,
      deps,
      payload,
      eventName,
      deliveryId,
      new URL(request.url).origin,
    );
  }

  const selected = selectReviewablePullRequest(eventName, payload);
  if (!selected.ok) {
    log('debug', 'webhook_skipped_event', { deliveryId, eventName, reason: selected.reason });
    // 204 must not carry a body (the Response constructor rejects one); the
    // reason is in the structured log above.
    return new Response(null, { status: 204 });
  }
  const pr = selected.pr;

  const allowlist = parseInstallationAllowlist(env.GITHUB_ALLOWED_INSTALLATION_IDS);
  if (!isInstallationAllowed(pr.installationId, allowlist)) {
    log('warn', 'webhook_rejected_installation', {
      deliveryId,
      installationId: pr.installationId,
      repo: pr.repoFullName,
    });
    return json({ error: 'INSTALLATION_NOT_ALLOWED' }, 403);
  }

  // Reviewer kill-switch (in-app toggle). Checked before any DO work so a
  // disabled reviewer spins up nothing and spends no provider tokens. Ack 202
  // (not a retry-worthy error — the skip is intentional).
  if (!(await isPrReviewEnabled(env))) {
    log('info', 'webhook_skipped_disabled', {
      deliveryId,
      repo: pr.repoFullName,
      pr: pr.prNumber,
    });
    return json({ ok: true, status: 'disabled' }, 202);
  }

  if (!env.PrReviewJob) {
    log('error', 'webhook_not_configured', { deliveryId, reason: 'no_do_binding' });
    return json({ error: 'NOT_CONFIGURED', message: 'PrReviewJob DO is not bound.' }, 503);
  }

  try {
    const id = env.PrReviewJob.idFromName(prReviewJobName(pr.repoFullName, pr.prNumber));
    const stub = env.PrReviewJob.get(id);
    const body = JSON.stringify({ ...pr, deliveryId, origin: new URL(request.url).origin });
    const doResponse = await (
      stub as unknown as { fetch: (r: Request) => Promise<Response> }
    ).fetch(
      new Request('https://do/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    const outcome = (await doResponse.json().catch(() => ({}))) as { status?: string };
    if (!doResponse.ok) {
      // The DO rejected/failed the start (e.g. malformed payload, storage
      // error). Don't ack 202 — return 502 so GitHub retries the delivery
      // rather than dropping it as accepted.
      log('error', 'webhook_enqueue_rejected', {
        deliveryId,
        repo: pr.repoFullName,
        pr: pr.prNumber,
        doStatus: doResponse.status,
        outcome: outcome.status ?? 'unknown',
      });
      return json({ error: 'ENQUEUE_REJECTED', doStatus: doResponse.status }, 502);
    }
    log('info', 'webhook_enqueued', {
      deliveryId,
      repo: pr.repoFullName,
      pr: pr.prNumber,
      headSha: pr.headSha,
      outcome: outcome.status ?? 'enqueued',
    });
    return json({ ok: true, status: outcome.status ?? 'enqueued' }, 202);
  } catch (err) {
    log('error', 'webhook_enqueue_failed', {
      deliveryId,
      repo: pr.repoFullName,
      pr: pr.prNumber,
      message: err instanceof Error ? err.message : String(err),
    });
    return json({ error: 'ENQUEUE_FAILED' }, 502);
  }
}

/**
 * Comment-trigger path: a collaborator @-mentioned the bot with `review`. Gates
 * (select → installation allowlist → kill-switch), then enqueues a review for the
 * PR's *current* head (refs are fetched fresh in the enqueue helper) and leaves a
 * 👀 reaction so the commenter sees it landed. `deliveryId: comment-<id>` dedupes
 * a re-delivered comment in the DO while letting a genuinely new comment request
 * another review.
 */
async function handleCommentReviewTrigger(
  env: Env,
  deps: GitHubWebhookDeps,
  payload: unknown,
  eventName: string,
  deliveryId: string,
  origin: string,
): Promise<Response> {
  const handle = resolveBotHandle(env);
  const selected = selectReviewableComment(eventName, payload, handle);
  if (!selected.ok) {
    log('debug', 'webhook_comment_skipped', { deliveryId, eventName, reason: selected.reason });
    return new Response(null, { status: 204 });
  }
  const req = selected.request;

  const allowlist = parseInstallationAllowlist(env.GITHUB_ALLOWED_INSTALLATION_IDS);
  if (!isInstallationAllowed(req.installationId, allowlist)) {
    log('warn', 'webhook_comment_rejected_installation', {
      deliveryId,
      installationId: req.installationId,
      repo: req.repoFullName,
    });
    return json({ error: 'INSTALLATION_NOT_ALLOWED' }, 403);
  }

  // Reviewer kill-switch — same gate the pull_request path honors. Ack 202; the
  // skip is intentional, not retry-worthy.
  if (!(await isPrReviewEnabled(env))) {
    log('info', 'webhook_comment_skipped_disabled', {
      deliveryId,
      repo: req.repoFullName,
      pr: req.prNumber,
    });
    return json({ ok: true, status: 'disabled' }, 202);
  }

  log('info', 'webhook_comment_trigger', {
    deliveryId,
    repo: req.repoFullName,
    pr: req.prNumber,
    kind: req.commentKind,
  });

  // One installation token, reused for the refs lookup AND the 👀 ack.
  const token = await deps.mintInstallationToken(env, req.installationId);
  if (!token) {
    log('error', 'webhook_comment_enqueue_failed', {
      deliveryId,
      repo: req.repoFullName,
      pr: req.prNumber,
      code: 'TOKEN_MINT_FAILED',
    });
    return json({ error: 'TOKEN_MINT_FAILED' }, 502);
  }

  const result = await deps.enqueueReviewForExistingPr(env, {
    repo: req.repoFullName,
    prNumber: req.prNumber,
    installationId: req.installationId,
    origin,
    deliveryId: `comment-${req.commentId}`,
    token,
    // An explicit "review again" cancels any in-flight pass on this PR — even on
    // the same commit — so the latest request wins.
    supersedeSameHead: true,
  });

  if (!result.ok) {
    if (result.code === 'NOT_REVIEWABLE') {
      // The PR is closed/draft — a valid trigger but nothing to review. Ack 204
      // (no body); the detail is in the log, and no 👀 is left since we did
      // nothing.
      log('info', 'webhook_comment_not_reviewable', {
        deliveryId,
        repo: req.repoFullName,
        pr: req.prNumber,
        message: result.message,
      });
      return new Response(null, { status: 204 });
    }
    log('error', 'webhook_comment_enqueue_failed', {
      deliveryId,
      repo: req.repoFullName,
      pr: req.prNumber,
      code: result.code,
    });
    return json({ error: result.code }, result.httpStatus);
  }

  // Best-effort ack. Awaited (the handler has no ExecutionContext.waitUntil) but
  // it's a single fast POST inside the delivery budget; a failure is logged, never
  // thrown (addCommentReaction returns false rather than rejecting).
  const reacted = await deps.addCommentReaction(
    req.repoFullName,
    req.commentKind,
    req.commentId,
    'eyes',
    { token },
  );
  if (!reacted) {
    log('warn', 'webhook_comment_reaction_failed', {
      deliveryId,
      repo: req.repoFullName,
      commentId: req.commentId,
    });
  }

  log('info', 'webhook_comment_enqueued', {
    deliveryId,
    repo: req.repoFullName,
    pr: req.prNumber,
    headSha: result.headSha,
    status: result.status,
  });
  return json({ ok: true, status: result.status }, 202);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
