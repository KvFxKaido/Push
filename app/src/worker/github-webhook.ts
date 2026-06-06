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

/** Actions on a `pull_request` event that warrant a fresh review. */
const REVIEWABLE_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

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

/** Stable DO name so all events for one PR land on the same instance. */
export function prReviewJobName(repoFullName: string, prNumber: number): string {
  return `${repoFullName}#${prNumber}`;
}

/**
 * `/api/github/webhook` handler. Gates the delivery (signature → parse →
 * event-select → allowlist), then enqueues to the `PrReviewJob` DO and acks 202.
 */
export async function handleGitHubWebhook(request: Request, env: Env): Promise<Response> {
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
