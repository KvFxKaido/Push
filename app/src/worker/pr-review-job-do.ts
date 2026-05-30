/**
 * PrReviewJob — Durable Object that runs an advisory PR review off a GitHub
 * webhook delivery and posts the result back to the PR.
 *
 * Design: docs/decisions/Webhook-Triggered PR Review.md
 *
 * One instance per PR (named `repo#prNumber` by the webhook receiver), so all
 * deliveries for a PR serialize through one place. That gives us two guards for
 * free:
 *   - **Replay dedupe** — a redelivered `X-GitHub-Delivery` is recognized and
 *     dropped (GitHub retries on non-2xx / timeout).
 *   - **Coalescing** — a newer `synchronize` (new head SHA) supersedes an
 *     in-flight review for an older SHA instead of racing it.
 *
 * v1 posture is **advisory only**: the posted review uses `event: 'COMMENT'`,
 * never REQUEST_CHANGES/APPROVE. Severity → gating is a deferred per-repo
 * opt-in (see design doc).
 *
 * The model/network leaf is behind an injectable executor seam
 * (`__setPrReviewExecutorOverride`) so the lifecycle (dedupe, coalesce, status,
 * events) is unit-testable without live GitHub or a provider call.
 */

import type { DurableObjectState } from '@cloudflare/workers-types';
import type {
  AIProviderType,
  LlmMessage,
  PushStream,
  ReviewResult,
} from '@push/lib/provider-contract';
import { resolveReviewGuidance } from '@push/lib/review-guidance';
import { buildReviewerContextBlock } from '@push/lib/role-context';
import { runDeepReviewer } from '@push/lib/deep-reviewer-agent';
import {
  createReviewCheckRun,
  executePostPRReview,
  executeReadOnlyGitHubToolWithToken,
  fetchPullRequestDiff,
  fetchPullRequestHeadSha,
  fetchReviewGuidance,
  type ReviewCheckConclusion,
} from '@/lib/github-tools';
import type { Env } from './worker-middleware';
import { exchangeForInstallationToken, generateGitHubAppJWT } from './worker-infra';
import { createWebStreamAdapter } from './coder-job-stream-adapter';
import { createWebDetectorAdapter, type AnyToolCall } from './coder-job-detector-adapter';
import type { ReviewablePullRequest } from './github-webhook';

const DEFAULT_PROVIDER: AIProviderType = 'anthropic';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Start payload the webhook receiver POSTs to the DO. */
export interface PrReviewStartInput extends ReviewablePullRequest {
  deliveryId: string;
  /** Worker origin, threaded to the provider-stream adapter. */
  origin: string;
}

export interface PrReviewStatusSnapshot {
  deliveryId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'superseded' | 'duplicate';
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  commentsPosted: number | null;
  /**
   * Whether an advisory review was actually POSTed to the PR. Distinguishes a
   * genuine completion (`true` — a review landed, even a "looks clean" summary
   * with zero inline anchors) from a head-advanced skip (`false` — a newer push
   * arrived mid-review, so this run posted nothing and a fresh delivery covers
   * the new head). `null` until the run reaches a terminal state. Without this,
   * the UI can't tell "posted a body-only review" from "skipped" — both show
   * `commentsPosted: 0` (which counts inline anchors only).
   */
  posted: boolean | null;
  error: string | null;
}

/**
 * A review with its persisted findings, returned by the `list` action that the
 * PWA review-history surface polls. Extends the status snapshot with the full
 * `ReviewResult` (null until a review completes / for failed/superseded runs).
 */
export interface PrReviewListItem extends PrReviewStatusSnapshot {
  result: ReviewResult | null;
}

/** Outcome the executor returns to the lifecycle. */
export interface PrReviewOutcome {
  result: ReviewResult;
  commentsPosted: number;
  /**
   * Whether an advisory review was actually POSTed. `false` only on the
   * head-advanced skip path (the review ran but a newer push superseded the
   * SHA before posting). Defaults to `true` for a normal completion.
   */
  posted: boolean;
  /** True when a failing gating check was posted (critical finding on a gated repo). */
  gated?: boolean;
}

/**
 * Whether a repo opted into review gating via `PR_REVIEW_GATING_REPOS`
 * (comma/space-separated `owner/name`, case-insensitive). Default off.
 */
export function repoGatingEnabled(repo: string, gatingReposEnv: string | undefined): boolean {
  const allowed = new Set(
    (gatingReposEnv ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return allowed.has(repo.toLowerCase());
}

/** Injectable model/network leaf — see `__setPrReviewExecutorOverride`. */
export type PrReviewExecutor = (
  input: PrReviewStartInput,
  env: Env,
  signal: AbortSignal,
) => Promise<PrReviewOutcome>;

const EXECUTOR_OVERRIDES = new Map<string, PrReviewExecutor>();

/** Test-only: inject a fake executor for the next review with this deliveryId. */
export function __setPrReviewExecutorOverride(
  deliveryId: string,
  executor: PrReviewExecutor,
): void {
  EXECUTOR_OVERRIDES.set(deliveryId, executor);
}

function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  ctx: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ level, event, ...ctx }));
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS review (
  delivery_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  is_cross_fork INTEGER NOT NULL,
  status TEXT NOT NULL,
  comments_posted INTEGER,
  posted INTEGER,
  result_json TEXT,
  error_text TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS review_status_idx ON review (status);

CREATE TABLE IF NOT EXISTS event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
`;

interface ReviewRow {
  delivery_id: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  base_ref: string;
  head_ref: string;
  installation_id: string;
  is_cross_fork: number;
  status: PrReviewStatusSnapshot['status'];
  comments_posted: number | null;
  posted: number | null;
  result_json: string | null;
  error_text: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export class PrReviewJob {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.ctx.storage.sql.exec(SCHEMA_SQL);
    this.ensureColumns();
  }

  /**
   * Add columns to a `review` table created before they existed. SQLite has no
   * ADD COLUMN IF NOT EXISTS, so probe via PRAGMA and ALTER only the missing
   * ones — mirrors CoderJob's `do_resume_count` migration. Probing avoids
   * swallowing real storage errors in a try/catch.
   */
  private ensureColumns(): void {
    const cols = this.ctx.storage.sql.exec('PRAGMA table_info(review)').toArray() as Array<{
      name: string;
    }>;
    const have = new Set(cols.map((c) => c.name));
    if (!have.has('result_json')) {
      this.ctx.storage.sql.exec('ALTER TABLE review ADD COLUMN result_json TEXT');
    }
    if (!have.has('posted')) {
      this.ctx.storage.sql.exec('ALTER TABLE review ADD COLUMN posted INTEGER');
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split('/').filter(Boolean).pop();
    try {
      switch (action) {
        case 'start':
          return await this.handleStart((await request.json()) as PrReviewStartInput);
        case 'status':
          return this.handleStatus(url.searchParams.get('deliveryId') ?? '');
        case 'list':
          return this.handleList();
        default:
          return json({ error: 'UNKNOWN_ACTION', action }, 404);
      }
    } catch (err) {
      return json(
        { error: 'DO_FETCH_FAILED', message: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  }

  private handleStart(input: PrReviewStartInput): Response {
    const missing = (
      ['deliveryId', 'repoFullName', 'prNumber', 'headSha', 'baseRef', 'installationId'] as const
    ).filter((k) => !input[k]);
    if (missing.length) {
      return json({ error: 'MISSING_FIELDS', fields: missing }, 400);
    }

    // Replay dedupe: same delivery already seen → no-op.
    const existing = this.ctx.storage.sql
      .exec('SELECT status FROM review WHERE delivery_id = ?', input.deliveryId)
      .toArray() as Array<{ status: string }>;
    if (existing.length) {
      log('debug', 'pr_review_duplicate_delivery', {
        deliveryId: input.deliveryId,
        repo: input.repoFullName,
        pr: input.prNumber,
      });
      return json({ status: 'duplicate' }, 200);
    }

    // Coalesce: supersede any non-terminal review for this PR on an older head
    // SHA, and abort it if in-flight. A redelivery of the *same* head SHA still
    // dedupes above; this only fires for genuinely newer pushes.
    const stale = this.ctx.storage.sql
      .exec(
        "SELECT delivery_id FROM review WHERE pr_number = ? AND head_sha != ? AND status IN ('queued','running')",
        input.prNumber,
        input.headSha,
      )
      .toArray() as Array<{ delivery_id: string }>;
    for (const row of stale) {
      this.ctx.storage.sql.exec(
        "UPDATE review SET status = 'superseded', finished_at = ? WHERE delivery_id = ?",
        Date.now(),
        row.delivery_id,
      );
      this.abortControllers.get(row.delivery_id)?.abort();
      this.emit(row.delivery_id, 'review.superseded', { byHeadSha: input.headSha });
      log('info', 'pr_review_superseded', {
        deliveryId: row.delivery_id,
        byDeliveryId: input.deliveryId,
        pr: input.prNumber,
      });
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO review (delivery_id, repo, pr_number, head_sha, base_ref, head_ref, installation_id, is_cross_fork, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      input.deliveryId,
      input.repoFullName,
      input.prNumber,
      input.headSha,
      input.baseRef,
      input.headRef,
      input.installationId,
      input.isCrossFork ? 1 : 0,
      Date.now(),
    );
    this.emit(input.deliveryId, 'review.queued', { headSha: input.headSha });

    // Run in the background; keep the DO alive until it settles.
    this.ctx.waitUntil(this.runReview(input));
    return json({ status: 'queued' }, 202);
  }

  private async runReview(input: PrReviewStartInput): Promise<void> {
    const controller = new AbortController();
    this.abortControllers.set(input.deliveryId, controller);
    this.ctx.storage.sql.exec(
      "UPDATE review SET status = 'running', started_at = ? WHERE delivery_id = ?",
      Date.now(),
      input.deliveryId,
    );
    this.emit(input.deliveryId, 'review.started', {});

    const executor = EXECUTOR_OVERRIDES.get(input.deliveryId) ?? defaultPrReviewExecutor;
    try {
      const outcome = await executor(input, this.env, controller.signal);
      // A late supersede may have flipped status while we ran; don't clobber it.
      const current = this.reviewRow(input.deliveryId);
      if (current?.status === 'superseded') {
        log('info', 'pr_review_completed_after_supersede', { deliveryId: input.deliveryId });
        return;
      }
      this.ctx.storage.sql.exec(
        "UPDATE review SET status = 'completed', comments_posted = ?, posted = ?, result_json = ?, finished_at = ? WHERE delivery_id = ?",
        outcome.commentsPosted,
        outcome.posted ? 1 : 0,
        JSON.stringify(outcome.result),
        Date.now(),
        input.deliveryId,
      );
      this.emit(input.deliveryId, 'review.completed', {
        commentsPosted: outcome.commentsPosted,
        posted: outcome.posted,
        findings: outcome.result.comments.length,
        filesReviewed: outcome.result.filesReviewed,
        truncated: outcome.result.truncated,
        usage: outcome.result.usage ?? null,
        gated: outcome.gated ?? false,
      });
      log('info', 'pr_review_completed', {
        deliveryId: input.deliveryId,
        repo: input.repoFullName,
        pr: input.prNumber,
        commentsPosted: outcome.commentsPosted,
        posted: outcome.posted,
        findings: outcome.result.comments.length,
        // Surface token usage in ops logs when the provider reported it; null
        // keeps the field present (and greppable) when it didn't.
        totalTokens: outcome.result.usage?.totalTokens ?? null,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        log('info', 'pr_review_aborted', { deliveryId: input.deliveryId });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.ctx.storage.sql.exec(
        "UPDATE review SET status = 'failed', error_text = ?, finished_at = ? WHERE delivery_id = ?",
        message,
        Date.now(),
        input.deliveryId,
      );
      this.emit(input.deliveryId, 'review.failed', { errorType: classifyError(message), message });
      log('error', 'pr_review_failed', {
        deliveryId: input.deliveryId,
        repo: input.repoFullName,
        pr: input.prNumber,
        errorType: classifyError(message),
        message,
      });
    } finally {
      this.abortControllers.delete(input.deliveryId);
    }
  }

  private handleStatus(deliveryId: string): Response {
    const row = this.reviewRow(deliveryId);
    if (!row) return json({ error: 'NOT_FOUND', deliveryId }, 404);
    return json(rowToListItem(row), 200);
  }

  /**
   * All reviews this DO has handled for its PR, newest first. The DO is named
   * `repo#prNumber`, so its rows *are* the PR's review history. Powers the PWA
   * review-history surface (polled while a review is non-terminal).
   */
  private handleList(): Response {
    const rows = this.ctx.storage.sql
      .exec('SELECT * FROM review ORDER BY created_at DESC')
      .toArray() as unknown as ReviewRow[];
    return json({ reviews: rows.map(rowToListItem) }, 200);
  }

  private reviewRow(deliveryId: string): ReviewRow | null {
    const rows = this.ctx.storage.sql
      .exec('SELECT * FROM review WHERE delivery_id = ?', deliveryId)
      .toArray() as unknown as ReviewRow[];
    return rows[0] ?? null;
  }

  private emit(deliveryId: string, type: string, payload: Record<string, unknown>): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO event (delivery_id, ts, type, payload_json) VALUES (?, ?, ?, ?)',
      deliveryId,
      Date.now(),
      type,
      JSON.stringify(payload),
    );
  }
}

// ---------------------------------------------------------------------------
// Default executor — the model + GitHub leaf
// ---------------------------------------------------------------------------

/**
 * Mint an installation token, fetch the PR diff, resolve REVIEW.md at the **base**
 * ref, run the agentic **deep reviewer** (reads beyond the diff via GitHub tools),
 * and post an advisory review.
 *
 * Uses the shared `github-tools` client with an injected installation token, so
 * the webhook path and the browser reviewer post through one code path (same
 * review body format, same 422→body-only degradation). The DO can't use the
 * browser default token (localStorage), hence the explicit `{ token }` auth.
 *
 * Cancellation: the deep reviewer composes `callbacks.signal` into its model
 * stream and tool loop, so the DO's `signal` (aborted on supersede) stops an
 * in-flight review mid-round rather than running to the per-round timeout.
 */
export const defaultPrReviewExecutor: PrReviewExecutor = async (input, env, signal) => {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error('GitHub App credentials are not configured (GITHUB_APP_ID / PRIVATE_KEY).');
  }
  const jwt = await generateGitHubAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const { token } = await exchangeForInstallationToken(jwt, input.installationId);
  const auth = { token };

  const diff = await fetchPullRequestDiff(input.repoFullName, input.prNumber, auth);

  // REVIEW.md from the BASE ref, never the head — a fork's head is
  // attacker-controlled (design doc Security checklist). For same-repo PRs the
  // base ref is the authoritative guidance anyway.
  const reviewGuidance = await resolveReviewGuidance({
    fetchCommitted: () =>
      input.isCrossFork
        ? Promise.resolve(null)
        : fetchReviewGuidance(input.repoFullName, input.baseRef, auth),
  });

  const provider = (env.PR_REVIEW_PROVIDER as AIProviderType | undefined) ?? DEFAULT_PROVIDER;
  const modelId = env.PR_REVIEW_MODEL ?? DEFAULT_MODEL;
  const zenGo =
    provider === 'zen' && ['1', 'true', 'yes'].includes((env.PR_REVIEW_ZEN_GO ?? '').toLowerCase());
  const stream = createWebStreamAdapter({
    env,
    origin: input.origin,
    provider,
    modelId,
    jobId: input.deliveryId,
    zenGo,
  });

  const detectors = createWebDetectorAdapter();
  const result = await runDeepReviewer<AnyToolCall, unknown>(
    diff,
    {
      provider,
      stream: stream as unknown as PushStream<LlmMessage>,
      modelId,
      context: {
        repoFullName: input.repoFullName,
        activeBranch: input.headRef,
        defaultBranch: input.baseRef,
        source: 'pr-diff',
        reviewGuidance,
      },
      allowedRepo: input.repoFullName,
      branchContext: {
        activeBranch: input.headRef,
        defaultBranch: input.baseRef,
        protectMain: false,
      },
      userProfile: null,
      resolveRuntimeContext: async (_diff, context) => buildReviewerContextBlock(context) || '',
      // Read-only GitHub tools only, gated to this repo with the installation
      // token. The deep reviewer never emits mutations (it only executes the
      // detected read-only set); web search has no backend here, so reject it
      // with a model-readable note rather than failing the run.
      toolExec: async (toolCall) => {
        if (toolCall.source !== 'github') {
          return {
            resultText: `[Tool Error] ${toolCall.call.tool} is unavailable in automated PR review (GitHub read tools only).`,
          };
        }
        const r = await executeReadOnlyGitHubToolWithToken(
          toolCall.call,
          input.repoFullName,
          token,
        );
        return { resultText: r.text };
      },
      detectAllToolCalls: detectors.detectAllToolCalls,
      detectAnyToolCall: detectors.detectAnyToolCall,
      // No web-search backend in the webhook DO — omit the Web tool from the
      // prompt entirely so the model never attempts an unavailable tool.
      webSearchToolProtocol: '',
      webSearchAvailable: false,
    },
    { onStatus: () => {}, signal },
  );
  if (signal.aborted) throw new Error('aborted');

  // Pin the post to the SHA we reviewed. `fetchPullRequestDiff` returns the PR's
  // *current* diff; if the head advanced between the webhook delivery and now
  // (a push whose own delivery hasn't reached this DO yet), posting against the
  // stale `input.headSha` would attach the review to the wrong commit and risk
  // 422s on anchors that no longer match. Skip — the newer push has its own
  // delivery that will review the new head and coalesce this one out.
  const currentHead = await fetchPullRequestHeadSha(input.repoFullName, input.prNumber, auth);
  if (currentHead && currentHead !== input.headSha) {
    log('info', 'pr_review_head_advanced', {
      deliveryId: input.deliveryId,
      reviewedSha: input.headSha,
      currentSha: currentHead,
    });
    return { result, commentsPosted: 0, posted: false };
  }

  const commentsPosted = await executePostPRReview(
    input.repoFullName,
    input.prNumber,
    input.headSha,
    result,
    auth,
    // The reviewed diff — lets a 422 salvage the valid inline anchors instead
    // of dropping all of them to the body. Safe to pass: the head-advanced
    // guard above ensures this diff matches `input.headSha`.
    diff,
  );

  // Opt-in gating: post a Checks API run reflecting the verdict (critical →
  // failure, else success) on the reviewed commit, alongside the advisory
  // comment. A check-run failure (e.g. missing `checks: write`) is logged but
  // never aborts the already-posted review.
  let gated = false;
  if (repoGatingEnabled(input.repoFullName, env.PR_REVIEW_GATING_REPOS)) {
    const hasCritical = result.comments.some((c) => c.severity === 'critical');
    const conclusion: ReviewCheckConclusion = hasCritical ? 'failure' : 'success';
    try {
      await createReviewCheckRun(
        input.repoFullName,
        input.headSha,
        conclusion,
        {
          title: hasCritical ? 'Critical findings' : 'No blocking findings',
          summary:
            result.summary || (hasCritical ? 'Critical issues found.' : 'No blocking issues.'),
        },
        auth,
      );
      // Only true once a failing check actually posted — so the recorded
      // outcome matches reality if the POST throws (e.g. missing checks:write).
      gated = hasCritical;
      log('info', 'pr_review_check_run_posted', {
        deliveryId: input.deliveryId,
        repo: input.repoFullName,
        conclusion,
      });
    } catch (err) {
      log('warn', 'pr_review_check_run_failed', {
        deliveryId: input.deliveryId,
        repo: input.repoFullName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { result, commentsPosted, posted: true, gated };
};

/**
 * Map a thrown GitHub error to a coarse type for the `review.failed` event. The
 * shared `github-tools` errors embed the status either parenthesized
 * (`(429)`, `(403)`) or as a "Not found" phrase (404), so match both.
 */
function classifyError(message: string): string {
  if (/not found/i.test(message)) return 'not_found';
  const status = message.match(/\b(\d{3})\b/)?.[1];
  if (!status) return 'unknown';
  if (status === '401' || status === '403') return 'auth';
  if (status === '404') return 'not_found';
  if (status === '422') return 'validation';
  if (status === '429') return 'rate_limit';
  if (status.startsWith('5')) return 'upstream';
  return 'unknown';
}

function rowToListItem(row: ReviewRow): PrReviewListItem {
  let result: ReviewResult | null = null;
  if (row.result_json) {
    try {
      result = JSON.parse(row.result_json) as ReviewResult;
    } catch {
      // A corrupt result blob shouldn't drop the row from history — surface the
      // review with its status/error and a null result.
      result = null;
    }
  }
  return {
    deliveryId: row.delivery_id,
    repo: row.repo,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    commentsPosted: row.comments_posted,
    posted: row.posted === null ? null : row.posted === 1,
    error: row.error_text,
    result,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
