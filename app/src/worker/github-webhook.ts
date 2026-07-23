/**
 * GitHub App webhook receiver — routine activation.
 *
 * Design: docs/decisions/Webhook-Triggered PR Review.md (the PR reviewer);
 * docs/decisions/Watch-Schedule Activation — Proactive Routines Feed the Lead.md
 * (the activation layer this receiver dispatches through).
 *
 * GitHub can't attach a Push session, so `/api/github/webhook` is exempt from the
 * session gate (the exempt set in `worker-middleware.ts`). The webhook's own auth
 * is the HMAC signature verified here against `GITHUB_WEBHOOK_SECRET` — the
 * receiver fails closed when that secret is unset. Each gate emits a paired
 * structured log so a dropped delivery is visible to ops rather than silent
 * (CLAUDE.md "Symmetric structured logs").
 *
 * The receiver does cheap, synchronous gating only and hands the actual work to a
 * Durable Object, returning 202 well inside GitHub's ~10s delivery budget. It
 * gates the delivery, classifies it into the shared watch vocabulary
 * (`lib/routine-activation.ts`), and hands off to the routine that claims it —
 * `WEBHOOK_ROUTINES` is the whole dispatch table. Classification and matching are
 * pure, which is what keeps the hand-off cheap; a routine owns its own selection,
 * gates, and enqueue. Replay dedupe and same-PR coalescing live in the DO (keyed
 * by `repo#prNumber`), so the receiver stays stateless.
 */

import { timingSafeEqual, type Env } from './worker-middleware';
import { isPrReviewEnabled } from './pr-review-config';
import {
  enqueueReviewForExistingPr,
  type EnqueueReviewResult,
  mintInstallationToken,
  prReviewJobName,
} from './pr-review-trigger';
import { GITHUB_APP_SLUG } from './worker-infra';
import {
  addCommentReaction,
  type CommentReactionKind,
  postPullRequestComment,
} from '@/lib/github-tools';
import {
  classifyPullRequestAction,
  classifyWebhookEvent,
  matchRoutines,
  type RoutineDescriptor,
  type RoutineLike,
} from '@push/lib/routine-activation';

// `prReviewJobName` now lives in pr-review-trigger.ts (single owner of DO
// addressing); re-export it here so existing importers/tests keep their path.
export { prReviewJobName } from './pr-review-trigger';

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

  // Which actions are reviewable is the shared vocabulary's call (including the
  // deliberate `synchronize` exclusion) — this gate reads that table rather than
  // keeping a parallel set that could drift from what the receiver classifies.
  const action = p.action ?? '';
  if (!classifyPullRequestAction(action)) return { ok: false, reason: `action:${action}` };

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
 * True when a comment issues the `review` command **to** the bot — the command
 * must directly follow the mention (only whitespace/punctuation and an optional
 * `please`/`kindly` filler between), matching `@push-agent review`,
 * `@push-agent please review`, `@push-agent re-review`.
 *
 * Accepts both mention shapes GitHub produces: the bare app slug `@push-agent`
 * (what a user types, the Dependabot-style command convention) AND the full bot
 * login `@push-agent[bot]` (what GitHub's @-autocomplete inserts, since the bot's
 * actual login carries the `[bot]` suffix). The handle is normalized to the bare
 * slug by `resolveBotHandle`; the optional `[bot]` is matched here.
 *
 * Binding the command to the mention is deliberate: checking `review` *anywhere*
 * after the mention let "thanks @push-agent for the review" or "@push-agent's
 * review" trigger a run (Codex P2). Other guards: the mention sits at a word
 * boundary (start-of-line or after whitespace) and isn't a prefix of a longer
 * login (`@push-agent-bot` ≠ `@push-agent`); `review` is a standalone word so
 * "reviewed"/"preview" don't match.
 */
export function parseReviewCommand(body: string | null | undefined, handle: string): boolean {
  if (!body || !handle) return false;
  const re = new RegExp(
    `(?:^|\\s)@${escapeRegExp(handle)}(?:\\[bot\\])?(?![a-z0-9-])[\\s:,>-]*(?:(?:please|pls|plz|kindly)\\s+)?(?:re-?)?review\\b`,
    'im',
  );
  return re.test(body);
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
  // "Is this a comment event" is the shared vocabulary's call, for the same
  // no-drift reason as the reviewable-action gate above.
  const classified = classifyWebhookEvent(eventName, payload);
  if (!classified.ok || classified.event !== 'pr_comment') {
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
  postPullRequestComment: typeof postPullRequestComment;
  /** Injectable timer so tests can run the transient-failure retry instantly. */
  delay: (ms: number) => Promise<void>;
}

const DEFAULT_DEPS: GitHubWebhookDeps = {
  enqueueReviewForExistingPr,
  mintInstallationToken,
  addCommentReaction,
  postPullRequestComment,
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * The slice of `ExecutionContext` the comment path needs — just `waitUntil`, to
 * defer the best-effort reaction past the 202 ack. Kept structural so unit tests
 * can pass a stub without the full Workers runtime type.
 */
export interface WebhookExecutionCtx {
  waitUntil(promise: Promise<unknown>): void;
}

/** Everything a webhook-activated routine needs to act on one delivery. */
export interface WebhookRoutineContext {
  env: Env;
  ctx: WebhookExecutionCtx | undefined;
  deps: GitHubWebhookDeps;
  payload: unknown;
  eventName: string;
  deliveryId: string;
  origin: string;
}

/** A routine the receiver can activate: its machine contract plus a handler. */
export interface WebhookRoutine extends RoutineLike {
  descriptor: RoutineDescriptor;
  handle(c: WebhookRoutineContext): Promise<Response>;
}

/**
 * The built-in routine registry — the receiver's whole dispatch table.
 *
 * The autonomous PR reviewer is expressed here as the first two routines rather
 * than as a hardcoded fork in `handleGitHubWebhook`. It is two entries, not one
 * with an internal branch, because its two activations are genuinely different
 * shapes: a fresh PR is a condition the reviewer notices, an `@<bot> review`
 * comment is a command someone issues. Disjoint `watch:` sets and separate
 * handlers keep the registry an actual dispatch table instead of a lookup that
 * hides an `if`.
 *
 * Repo-committed `.push/routines/*.md` join this list later. When they do,
 * matching needs a base-ref fetch and moves behind a DO — the receiver keeps its
 * cheap-and-synchronous contract, and this table becomes its built-in half.
 */
export const WEBHOOK_ROUTINES: readonly WebhookRoutine[] = [
  {
    descriptor: {
      name: 'pr-review',
      description: 'Review a newly opened, reopened, or ready-for-review pull request',
      watch: ['pr_opened', 'pr_reopened', 'pr_ready_for_review'],
    },
    handle: (c) => handlePullRequestReviewRoutine(c),
  },
  {
    descriptor: {
      name: 'pr-review-command',
      description: 'Review a pull request on an @-mention command in a comment',
      watch: ['pr_comment'],
    },
    handle: (c) =>
      handleCommentReviewTrigger(
        c.env,
        c.ctx,
        c.deps,
        c.payload,
        c.eventName,
        c.deliveryId,
        c.origin,
      ),
  },
];

/**
 * `/api/github/webhook` handler. Gates the delivery (signature → parse →
 * classify → match), then hands off to the matching routine, which owns its own
 * selection, allowlist, and enqueue.
 */
export async function handleGitHubWebhook(
  request: Request,
  env: Env,
  ctx?: WebhookExecutionCtx,
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

  // Classify the delivery into the shared watch vocabulary, then let the
  // registry say who wants it. Both steps are pure — no I/O joins the gate path,
  // so the receiver keeps the cheap-and-synchronous contract in the header.
  const classified = classifyWebhookEvent(eventName, payload);
  if (!classified.ok) {
    log('debug', 'webhook_skipped_event', { deliveryId, eventName, reason: classified.reason });
    // 200-with-body, not a bare 204. The reason IS logged above — but this Worker's
    // observability captures HTTP traces, not console.log, so that line is
    // unreadable in practice. GitHub's own delivery log renders the response body,
    // and it is the one sink an operator can actually see; a skip that says nothing
    // there is indistinguishable from a reviewer that is broken. (Cost us an outage:
    // every PR event skipped silently, with a green 2xx on every delivery.)
    return json({ ok: true, status: 'skipped', event: eventName, reason: classified.reason }, 200);
  }

  const matched = matchRoutines(classified.event, WEBHOOK_ROUTINES);
  if (matched.length === 0) {
    // Unreachable while every event in the vocabulary is watched by a built-in,
    // but the pairing is the point: an event the App subscribes to and no
    // routine claims must say so where the classify-miss says so, or it becomes
    // the same silent-2xx outage in a new place.
    log('debug', 'webhook_skipped_no_routine', {
      deliveryId,
      eventName,
      watchEvent: classified.event,
    });
    return json(
      { ok: true, status: 'skipped', event: eventName, reason: `no_routine:${classified.event}` },
      200,
    );
  }
  if (matched.length > 1) {
    // Single-dispatch is this slice's real limit: a routine handler returns the
    // Response that acks GitHub, and there is only one ack. Loud rather than
    // silent — the second routine to claim an event must land with fan-out, and
    // a dropped firing that logged nothing is exactly what the design doc calls
    // invisible to ops.
    log('error', 'webhook_routine_fanout_unsupported', {
      deliveryId,
      eventName,
      watchEvent: classified.event,
      matched: matched.map((r) => r.descriptor.name),
      dispatched: matched[0].descriptor.name,
    });
  }

  return matched[0].handle({
    env,
    ctx,
    deps,
    payload,
    // A falsy event name classifies as `event:none`, so reaching an ok
    // classification proves this is a non-empty string — an invariant of
    // `classifyWebhookEvent` the type system can't carry across the call.
    eventName: eventName as string,
    deliveryId,
    origin: new URL(request.url).origin,
  });
}

/**
 * The `pr-review` routine: a fresh PR warrants a review. Owns the selection it
 * needs off the payload, its allowlist and kill-switch gates, and the enqueue to
 * the `PrReviewJob` DO.
 */
async function handlePullRequestReviewRoutine(c: WebhookRoutineContext): Promise<Response> {
  const { env, payload, eventName, deliveryId, origin } = c;

  const selected = selectReviewablePullRequest(eventName, payload);
  if (!selected.ok) {
    // Classification passed (the action is reviewable) but this PR still isn't —
    // a draft, or a payload missing fields the DO needs. Same skip shape as a
    // classify miss: named, in the body, where GitHub's delivery log shows it.
    log('debug', 'webhook_skipped_event', { deliveryId, eventName, reason: selected.reason });
    return json({ ok: true, status: 'skipped', event: eventName, reason: selected.reason }, 200);
  }
  const pr = selected.pr;

  const allowlist = parseInstallationAllowlist(env.GITHUB_ALLOWED_INSTALLATION_IDS);
  if (!isInstallationAllowed(pr.installationId, allowlist)) {
    log('warn', 'webhook_rejected_installation', {
      deliveryId,
      installationId: pr.installationId,
      repo: pr.repoFullName,
    });
    // Carry the DENIED id and whether the allowlist is even populated. This gate
    // fails CLOSED (`allowlist.size > 0 && allowlist.has(id)`), so an empty or stale
    // GITHUB_ALLOWED_INSTALLATION_IDS silently denies every PR — and the operator's
    // only visible signal is this response body. Naming the id turns "the reviewer
    // stopped working" into a one-line fix. Neither value is a secret: the id is in
    // the webhook payload GitHub just sent us, and the count leaks nothing.
    return json(
      {
        error: 'INSTALLATION_NOT_ALLOWED',
        installationId: pr.installationId,
        allowlistConfigured: allowlist.size > 0,
      },
      403,
    );
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
    const body = JSON.stringify({ ...pr, deliveryId, origin });
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
 * Delay before the single transient-failure retry. `waitUntil` gives the whole
 * request 30 seconds after the response, shared across every deferred task, so
 * the arithmetic must close: 8s delay + a 10s-bounded attempt leaves ~12s for
 * the feedback POSTs, which register as parallel sibling `waitUntil` tasks
 * (the reaction/notice helpers return at registration when a ctx exists) and
 * are 15s-capped, non-retrying (`retry: false`), typically sub-second calls.
 * The margin is engineering headroom, not proof — a GitHub degradation slow
 * enough to eat it loses the feedback at the budget edge, with the runtime's
 * own "waitUntil() tasks did not complete" warning as the ops signal; the
 * fully-enforced alternative is durable scheduling in the DO, deliberately out
 * of scope here. GitHub's secondary-limit guidance prefers a 60s wait, which
 * doesn't fit the runtime at all; one delayed attempt plus a visible failure
 * notice is the tradeoff (#1584).
 */
export const COMMENT_RETRY_DELAY_MS = 8_000;

/**
 * Hard bound on the retry attempt itself. An unbounded attempt can outspend
 * the whole budget on its own — `githubFetch` allows 15s per call with up to 3
 * retries — and a `waitUntil` cancellation at the budget edge would kill the
 * task *before the feedback posts*, recreating the silent failure this path
 * exists to eliminate. Feedback wins over completion.
 */
export const COMMENT_RETRY_ATTEMPT_BUDGET_MS = 10_000;

/**
 * Failure codes worth one retry: a failed refs lookup (the #1584 incident was
 * a secondary-rate-limit 403 there) and a rejected DO transport — both
 * GitHub/infra-transient shapes reached *with a minted token in hand*, so the
 * retry can always post feedback about its own outcome. `TOKEN_MINT_FAILED`
 * is deliberately terminal: `mintInstallationToken` collapses deterministic
 * failures (missing or unusable credentials, a rejected exchange) and
 * transient ones into the same `null`, and with no token the retry could
 * never surface its result on the PR — a doomed retry's 202 would just be a
 * slower, more misleading version of the honest 502 (Codex P2 ×2 on #1585).
 * `ENQUEUE_FAILED` (the DO *answered* with a rejection) and `NOT_CONFIGURED`
 * are deterministic — a retry replays the same answer.
 */
const RETRYABLE_COMMENT_FAILURE_CODES = new Set(['PR_LOOKUP_FAILED', 'ENQUEUE_UNREACHABLE']);

/**
 * Comment-trigger path: a collaborator @-mentioned the bot with `review`. Gates
 * (select → installation allowlist → kill-switch), then enqueues a review for the
 * PR's *current* head (refs are fetched fresh in the enqueue helper) and leaves a
 * 👀 reaction so the commenter sees it landed. `deliveryId: comment-<id>` dedupes
 * a re-delivered comment in the DO while letting a genuinely new comment request
 * another review.
 *
 * A matched trigger never fails invisibly (#1584): transient failures get one
 * deferred retry, and every terminal failure posts a 😕 plus a notice comment
 * naming the code — except when no installation token could be minted at all,
 * where nothing can reach GitHub and the structured log is the whole story.
 */
async function handleCommentReviewTrigger(
  env: Env,
  ctx: WebhookExecutionCtx | undefined,
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

  // Best-effort comment reaction, deferred via waitUntil so it never blocks the
  // 202 (it's a second sequential GitHub call after the enqueue). With no
  // ExecutionContext (defensive / unit tests) it's awaited inline instead.
  // addCommentReaction returns false rather than throwing, so a failure only logs.
  const ackReaction = async (content: 'eyes' | 'confused', token: string): Promise<void> => {
    const posted = deps
      .addCommentReaction(req.repoFullName, req.commentKind, req.commentId, content, { token })
      .then((reacted) => {
        if (!reacted) {
          log('warn', 'webhook_comment_reaction_failed', {
            deliveryId,
            repo: req.repoFullName,
            commentId: req.commentId,
            content,
          });
        }
      })
      .catch((err) => {
        // addCommentReaction is contracted not to throw, but harden regardless:
        // a best-effort ack must never reject into the deferred waitUntil task
        // (an unhandled rejection) nor throw on the inline-await fallback (which
        // would 500 the webhook). Contain it here so `posted` never rejects.
        log('warn', 'webhook_comment_reaction_failed', {
          deliveryId,
          repo: req.repoFullName,
          commentId: req.commentId,
          content,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    if (ctx) ctx.waitUntil(posted);
    else await posted;
  };

  // Terminal-failure notice: the reaction says "something went wrong", the
  // comment says *what* — without it a 😕 is indistinguishable from
  // not-reviewable, and the commenter can't know a re-request would help. Same
  // best-effort containment as the reaction. The text deliberately avoids the
  // literal trigger phrase (`bot_sender` already blocks self-triggering, but
  // the notice shouldn't read like a command either).
  const postFailureNotice = async (
    code: string,
    retried: boolean,
    token: string,
  ): Promise<void> => {
    const body = `⚠️ Push review couldn't start: \`${code}\`${
      retried ? ' (a retry also failed)' : ''
    }. Comment the review command again to retry.`;
    const posted = deps
      .postPullRequestComment(req.repoFullName, req.prNumber, body, { token })
      .then((ok) => {
        if (!ok) {
          log('warn', 'webhook_comment_notice_failed', {
            deliveryId,
            repo: req.repoFullName,
            pr: req.prNumber,
            code,
          });
        }
      })
      .catch((err) => {
        log('warn', 'webhook_comment_notice_failed', {
          deliveryId,
          repo: req.repoFullName,
          pr: req.prNumber,
          code,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    if (ctx) ctx.waitUntil(posted);
    else await posted;
  };

  // One installation token per attempt, reused for the refs lookup AND the
  // reactions. The enqueue helper is contracted never to throw, but this seam is
  // injectable — contain a rejection as the transient `ENQUEUE_UNREACHABLE`
  // rather than letting it 500 the webhook.
  const attempt = async (): Promise<{
    token: string | null;
    result: EnqueueReviewResult;
  }> => {
    const token = await deps.mintInstallationToken(env, req.installationId);
    if (!token) {
      return {
        token: null,
        result: {
          ok: false,
          code: 'TOKEN_MINT_FAILED',
          message: 'Could not mint a GitHub installation token.',
          httpStatus: 502,
        },
      };
    }
    try {
      const result = await deps.enqueueReviewForExistingPr(env, {
        repo: req.repoFullName,
        prNumber: req.prNumber,
        installationId: req.installationId,
        origin,
        deliveryId: `comment-${req.commentId}`,
        token,
        // An explicit "review again" cancels any in-flight pass on this PR —
        // even on the same commit — so the latest request wins.
        supersedeSameHead: true,
      });
      return { token, result };
    } catch (err) {
      return {
        token,
        result: {
          ok: false,
          code: 'ENQUEUE_UNREACHABLE',
          message: err instanceof Error ? err.message : String(err),
          httpStatus: 502,
        },
      };
    }
  };

  const first = await attempt();

  if (first.result.ok) {
    // 👀 to confirm the request landed — deferred so it doesn't delay the 202.
    await ackReaction('eyes', first.token as string);
    log('info', 'webhook_comment_enqueued', {
      deliveryId,
      repo: req.repoFullName,
      pr: req.prNumber,
      headSha: first.result.headSha,
      status: first.result.status,
    });
    return json({ ok: true, status: first.result.status }, 202);
  }

  if (first.result.code === 'NOT_REVIEWABLE') {
    // The PR is closed/draft — a valid trigger but nothing to review. Leave a
    // 😕 so the commenter sees it was received-but-skipped (a silent 204 is
    // indistinguishable from the bot ignoring them), then ack 204. No notice:
    // the PR's own state explains itself.
    log('info', 'webhook_comment_not_reviewable', {
      deliveryId,
      repo: req.repoFullName,
      pr: req.prNumber,
      message: first.result.message,
    });
    await ackReaction('confused', first.token as string);
    return new Response(null, { status: 204 });
  }

  if (RETRYABLE_COMMENT_FAILURE_CODES.has(first.result.code)) {
    log('info', 'webhook_comment_retry_scheduled', {
      deliveryId,
      repo: req.repoFullName,
      pr: req.prNumber,
      code: first.result.code,
      delayMs: COMMENT_RETRY_DELAY_MS,
    });
    const retryTask = (async () => {
      await deps.delay(COMMENT_RETRY_DELAY_MS);
      // Bounded attempt: on timeout the feedback posts now instead of dying in
      // a waitUntil cancellation at the budget edge. The losing attempt is not
      // cancelled (no abort seam through the enqueue helper) but it stays
      // OBSERVED: a late success logs and posts the 👀 so the state
      // self-corrects rather than leaving contradictory 😕-plus-review
      // feedback (fugu WARNING on #1585).
      const attemptPromise = attempt();
      const second = await Promise.race([
        attemptPromise,
        deps.delay(COMMENT_RETRY_ATTEMPT_BUDGET_MS).then(() => 'timeout' as const),
      ]);
      if (second === 'timeout') {
        log('error', 'webhook_comment_retry_failed', {
          deliveryId,
          repo: req.repoFullName,
          pr: req.prNumber,
          code: 'RETRY_TIMED_OUT',
        });
        const lateObserver = attemptPromise
          .then(async (late) => {
            if (!late.result.ok) return;
            log('info', 'webhook_comment_late_success', {
              deliveryId,
              repo: req.repoFullName,
              pr: req.prNumber,
              headSha: late.result.headSha,
              status: late.result.status,
            });
            await ackReaction('eyes', late.token as string);
          })
          .catch((err) => {
            log('warn', 'webhook_comment_late_observer_failed', {
              deliveryId,
              repo: req.repoFullName,
              pr: req.prNumber,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        // Registered separately so the retry task itself can finish now; with
        // no ctx (unit tests / defensive) the observer floats, contained by
        // the catch above — awaiting it would hang on a truly stuck attempt.
        if (ctx) ctx.waitUntil(lateObserver);
        // Retryable codes imply the first mint succeeded, so a token exists;
        // the null check is type narrowing, not a reachable branch.
        if (!first.token) return;
        await ackReaction('confused', first.token);
        await postFailureNotice('RETRY_TIMED_OUT', true, first.token);
        return;
      }
      if (second.result.ok) {
        log('info', 'webhook_comment_retry_succeeded', {
          deliveryId,
          repo: req.repoFullName,
          pr: req.prNumber,
          headSha: second.result.headSha,
          status: second.result.status,
        });
        await ackReaction('eyes', second.token as string);
        return;
      }
      if (second.token && second.result.code === 'NOT_REVIEWABLE') {
        // The PR closed between attempts — received-but-skipped, not a failure.
        log('info', 'webhook_comment_not_reviewable', {
          deliveryId,
          repo: req.repoFullName,
          pr: req.prNumber,
          message: second.result.message,
          retried: true,
        });
        await ackReaction('confused', second.token);
        return;
      }
      log('error', 'webhook_comment_retry_failed', {
        deliveryId,
        repo: req.repoFullName,
        pr: req.prNumber,
        code: second.result.code,
      });
      // The retry's mint failing doesn't invalidate a first-attempt token —
      // installation tokens live an hour, this one is seconds old. Retryable
      // codes imply the first mint succeeded, so the null check is type
      // narrowing, not a reachable branch.
      const feedbackToken = second.token ?? first.token;
      if (!feedbackToken) return;
      await ackReaction('confused', feedbackToken);
      await postFailureNotice(second.result.code, true, feedbackToken);
    })().catch((err) => {
      // The retry runs past the response; an escaped rejection here would be an
      // unhandled rejection in waitUntil, invisible to ops.
      log('error', 'webhook_comment_retry_failed', {
        deliveryId,
        repo: req.repoFullName,
        pr: req.prNumber,
        code: 'RETRY_TASK_THREW',
        error: err instanceof Error ? err.message : String(err),
      });
    });
    if (ctx) ctx.waitUntil(retryTask);
    else await retryTask;
    return json({ ok: true, status: 'retry_scheduled', code: first.result.code }, 202);
  }

  // Deterministic terminal failure (NOT_CONFIGURED, ENQUEUE_FAILED) — surface
  // it on the PR; a token exists on every code that can reach this branch.
  log('error', 'webhook_comment_enqueue_failed', {
    deliveryId,
    repo: req.repoFullName,
    pr: req.prNumber,
    code: first.result.code,
  });
  if (first.token) {
    await ackReaction('confused', first.token);
    await postFailureNotice(first.result.code, false, first.token);
  }
  return json({ error: first.result.code }, first.result.httpStatus);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
