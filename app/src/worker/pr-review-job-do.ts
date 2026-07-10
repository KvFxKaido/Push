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
  ReviewVerification,
} from '@push/lib/provider-contract';
import { PROJECT_INSTRUCTION_FILENAMES } from '@push/lib/project-instructions-source';
import { parseAgentsMdHints } from '@push/lib/repo-commands';
import { resolveReviewGuidance } from '@push/lib/review-guidance';
import { buildReviewerContextBlock, type PriorReviewContext } from '@push/lib/role-context';
import { runDeepReviewer, type DeepReviewerResumeState } from '@push/lib/deep-reviewer-agent';
import {
  createInProgressReviewCheckRun,
  createReviewCheckRun,
  executePostPRReview,
  executeReadOnlyGitHubToolWithToken,
  fetchRepoFileContent,
  fetchPullRequestDiff,
  fetchPullRequestHeadSha,
  fetchReviewGuidance,
  finalizeReviewCheckRun,
  type ReviewCheckConclusion,
} from '@/lib/github-tools';
import type { Env } from './worker-middleware';
import {
  DEFAULT_PR_REVIEW_MODEL,
  DEFAULT_PR_REVIEW_PROVIDER,
  coerceKnownPrReviewer,
  getDefaultPrReviewModel,
  getPrReviewEffectiveConfig,
  getPrReviewRuntimeConfig,
  isValidPrReviewRuntimeConfig,
} from './pr-review-config';
import { exchangeForInstallationToken, generateGitHubAppJWT } from './worker-infra';
import { recordInflightReview } from './pr-review-inflight-index';
import { createWebStreamAdapter } from './coder-job-stream-adapter';
import { createWebDetectorAdapter, type AnyToolCall } from './coder-job-detector-adapter';
import {
  cleanupReviewSandbox,
  executeReviewSandboxTool,
  provisionReviewSandbox,
  REVIEW_DEFAULT_SETUP_COMMAND,
  reviewSandboxToolNames,
  runReviewSetup,
  type ReviewSandbox,
  type ReviewSetupResult,
  type ReviewVerifierCommands,
} from './review-sandbox-tools';
import type { ReviewablePullRequest } from './github-webhook';

const DEFAULT_PROVIDER: AIProviderType = DEFAULT_PR_REVIEW_PROVIDER;
const DEFAULT_MODEL = DEFAULT_PR_REVIEW_MODEL;

// Orphan-sweep tuning. A review whose DO is evicted mid-run leaves its row
// `running` and its check-run hanging "Reviewing…" forever (the in-process
// finalize paths never get to execute). The sweep fails such rows and closes
// their check-run. GRACE keeps the sweep from racing a just-started delivery
// whose runReview hasn't registered its abort controller yet.
// REVIEW_TIMEOUT_MS is the max time WITHOUT PROGRESS (last checkpoint, else
// start) before a live review is force-failed as stalled; total model work is
// bounded separately by MAX_DEEP_REVIEW_ROUNDS, so a review that keeps
// completing rounds may legitimately run longer than this end to end.
const ORPHAN_GRACE_MS = 2 * 60_000;
const REVIEW_TIMEOUT_MS = 15 * 60_000;
// The runtime reclaims a DO instance ~1–3 min after its triggering event
// settles, taking the in-memory runReview promise with it — diagnosed live on
// PR #887 (2026-06-11): the original died <4 min in with no deploy, the retry
// made exactly 2 provider rounds after the alarm then evaporated. Unwatched
// reviews therefore CANNOT finish in one attempt; the fix is the
// CoderJob/RunHost discipline — per-round checkpoints + a short-cadence
// watchdog + relaunch-from-checkpoint, so progress is monotone and repeated
// evictions converge. WATCHDOG is the detection cadence while any review is
// live; MAX_REVIEW_RELAUNCHES
// bounds total relaunches per delivery (persisted in `relaunch_count`, so the
// cap survives the very evictions it counts). Each relaunch banks at least
// the rounds its checkpoint captured; MAX_DEEP_REVIEW_ROUNDS bounds total
// model work, so the cap is a runaway backstop, not a progress budget.
const REVIEW_WATCHDOG_MS = 90_000;
const MAX_REVIEW_RELAUNCHES = 10;
// A review attempt that dies without a result (DO evicted by a deploy, or a
// stalled provider stream hitting the wall-clock) is re-enqueued ONCE with this
// suffix on its delivery id. The suffix doubles as the attempt counter: a dead
// retry is final. Derived ids stay unique (webhook delivery ids are UUIDs and
// never end with this suffix) and ride the existing dedupe/supersede logic
// unchanged. Charset constraint: the suffix must stay within the cancel
// route's deliveryId pattern (`[A-Za-z0-9._-]` in worker-pr-review.ts) or
// running retries become uncancellable from the UI.
const AUTO_RETRY_SUFFIX = '.auto-retry';
// Origin for retries of rows persisted before the `origin` column existed. The
// stream adapter only uses it to construct an in-process synthetic Request URL,
// so any parseable origin works.
const RETRY_FALLBACK_ORIGIN = 'https://push.internal';
// What a dead review's check-run should tell a human. New commits do NOT
// trigger reviews (`synchronize` is deliberately not a reviewable action in
// github-webhook.ts), so the old "push a new commit" advice was a dead end.
const TERMINAL_RETRY_ADVICE =
  'New commits do not trigger reviews — close and reopen the PR to run a fresh review.';
const DEFAULT_REVIEW_TYPECHECK_COMMAND = 'npx tsc --noEmit';

/** Start payload the webhook receiver POSTs to the DO. */
export interface PrReviewStartInput extends ReviewablePullRequest {
  deliveryId: string;
  /** Worker origin, threaded to the provider-stream adapter. */
  origin: string;
  /**
   * Provider/model PINNED for this delivery's lifetime. Resolved once when
   * the first attempt starts and persisted on the review row; relaunches and
   * auto-retries reuse it instead of re-reading live config. Without the pin,
   * a mid-flight settings swap retroactively applied to a running review —
   * observed killing #909's own review when its relaunch re-resolved a model
   * the deployed catalog didn't have yet. Optional for rows that predate the
   * columns; the executor falls back to live resolution for those.
   */
  pinnedProvider?: string;
  pinnedModel?: string;
  /**
   * Widen coalescing to supersede an in-flight review on the *same* head SHA,
   * not just older ones. Set by an explicit on-demand `@push-agent review`
   * comment so a re-request cancels the running pass and the latest request
   * wins. Transient (not persisted) — a later relaunch/retry of the winning
   * review has no competitor left to supersede.
   */
  supersedeSameHead?: boolean;
  /**
   * Cross-review memory: the most recent review already POSTED to this PR,
   * fed to the executor so a re-review verifies prior findings against the
   * new head ("3 of 5 addressed") instead of starting from scratch. Computed
   * by the DO in runReview per attempt — start, relaunch, and auto-retry all
   * pass through there — from rows this DO already holds. Never sent by the
   * webhook receiver and never persisted; absent on a PR's first review.
   */
  priorReview?: PriorReviewContext;
}

export interface PrReviewStatusSnapshot {
  deliveryId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'superseded' | 'duplicate' | 'cancelled';
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
   * Whether an advisory review was actually POSTed. `false` on the
   * head-advanced skip path (the review ran but a newer push superseded the
   * SHA before posting) and on the degraded path (`result.degraded` — the
   * fallback result is deliberately not posted). Consumers distinguishing
   * the two must check `result.degraded` first. `true` for a normal
   * completion.
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

/**
 * Check-run conclusion for a POSTED zero-findings review, decided by the
 * runtime verification record — never by what the model claims. `success` is
 * reserved for "reviewed AND verified": at least one verifier ran and passed,
 * and none failed. Everything else is `neutral` with the reason in the title:
 *
 * - verifier failed        → the reviewer saw a red verifier and still posted
 *                            no findings; surface the contradiction.
 * - nothing ran, available → unverified (the model declined the nudge).
 * - nothing available      → cross-fork / sandbox off; honestly unverifiable.
 * - record absent          → pre-verification rows / unknown; treat as
 *                            unverified rather than assuming.
 */
export function cleanPassCheckStatus(verification: ReviewVerification | undefined): {
  conclusion: ReviewCheckConclusion;
  title: string;
  summary: string;
} {
  const v = verification;
  const anyFail = v?.typecheck === 'fail' || v?.tests === 'fail';
  const anyPass = v?.typecheck === 'pass' || v?.tests === 'pass';
  const anyAvailable = v != null && (v.typecheck !== 'unavailable' || v.tests !== 'unavailable');

  if (anyFail) {
    const failed = [
      v?.typecheck === 'fail' ? 'typecheck' : null,
      v?.tests === 'fail' ? 'tests' : null,
    ]
      .filter(Boolean)
      .join(' + ');
    return {
      conclusion: 'neutral',
      title: 'No blocking findings — verification failed',
      summary: `The reviewer posted no findings, but ${failed} failed on the PR head. Check the verifier output before trusting the clean pass.`,
    };
  }
  if (anyPass) {
    const passed = [
      v?.typecheck === 'pass' ? 'typecheck' : null,
      v?.tests === 'pass' ? 'tests' : null,
    ]
      .filter(Boolean)
      .join(' + ');
    return {
      conclusion: 'success',
      title: `No blocking findings — verified (${passed})`,
      summary: `No blocking issues. Verified against the PR head: ${passed} passed.`,
    };
  }
  if (!anyAvailable) {
    return {
      conclusion: 'neutral',
      title: 'No blocking findings (verification unavailable)',
      summary:
        'No blocking issues found from the diff and code reading. No sandbox verifier was available for this PR (cross-fork or sandbox disabled), so the clean pass is unverified.',
    };
  }
  return {
    conclusion: 'neutral',
    title: 'No blocking findings (unverified)',
    summary:
      'No blocking issues found, but the reviewer did not run typecheck/tests despite an available sandbox. The clean pass is unverified.',
  };
}

/** Checkpoint/resume hooks the DO threads into the executor. Optional fourth
 *  parameter so test overrides (and any 3-arg executor) stay assignable. */
export interface PrReviewExecutorHooks {
  /** Seed the deep-reviewer loop from a persisted checkpoint (relaunch path). */
  resumeState?: DeepReviewerResumeState;
  /** Per-round state snapshot — the DO persists it synchronously. */
  onRoundState?: (state: DeepReviewerResumeState) => void;
  /**
   * Seed the executor's verification record on relaunch. Verifier runs
   * (typecheck/tests) live in executor memory; without this, a review that
   * verified in rounds the checkpoint already banked would forget it after an
   * eviction and finish "unverified" (or get nudged to re-run an 8-minute
   * suite). Persisted next to the round checkpoint by the DO.
   */
  resumeVerification?: ReviewVerification;
  /** Fired whenever a verifier records an outcome — the DO keeps the latest
   *  snapshot and persists it with the next round checkpoint. */
  onVerification?: (verification: ReviewVerification) => void;
  /**
   * Fired when a sandbox tool starts executing — and again after the verifier
   * setup gate settles. The DO touches the round checkpoint's `updated_at` so
   * long tool runs count as PROGRESS for `failTimedOutReviews`: model round
   * wall-clock + setup (600s) + a verifier (480s) legitimately exceeds the
   * 15-min no-progress budget measured from any single mark (Codex P2,
   * PR #1387).
   */
  onToolProgress?: () => void;
}

/** Injectable model/network leaf — see `__setPrReviewExecutorOverride`. */
export type PrReviewExecutor = (
  input: PrReviewStartInput,
  env: Env,
  signal: AbortSignal,
  hooks?: PrReviewExecutorHooks,
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
  origin TEXT,
  status TEXT NOT NULL,
  comments_posted INTEGER,
  posted INTEGER,
  result_json TEXT,
  error_text TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  check_run_id INTEGER,
  pinned_provider TEXT,
  pinned_model TEXT
);
CREATE INDEX IF NOT EXISTS review_status_idx ON review (status);

CREATE TABLE IF NOT EXISTS event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_checkpoint (
  delivery_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  round INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  verification_json TEXT
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
  origin: string | null;
  status: PrReviewStatusSnapshot['status'];
  comments_posted: number | null;
  posted: number | null;
  result_json: string | null;
  error_text: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  check_run_id: number | null;
  relaunch_count: number;
  pinned_provider: string | null;
  pinned_model: string | null;
}

export class PrReviewJob {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private readonly abortControllers = new Map<string, AbortController>();
  // Latest verifier record per live delivery (fed by the executor's
  // onVerification hook); persisted alongside each round checkpoint so it
  // survives evictions with the rounds it belongs to.
  private readonly verificationState = new Map<string, ReviewVerification>();
  // Reset on every cold start; the orphan sweep runs once per DO instance on
  // first fetch (a fresh instance has an empty abortControllers map, so any
  // `running` row it finds belonged to a prior, now-dead instance).
  private orphanSweepKicked = false;

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
    if (!have.has('check_run_id')) {
      this.ctx.storage.sql.exec('ALTER TABLE review ADD COLUMN check_run_id INTEGER');
    }
    if (!have.has('origin')) {
      this.ctx.storage.sql.exec('ALTER TABLE review ADD COLUMN origin TEXT');
    }
    if (!have.has('pinned_provider')) {
      this.ctx.storage.sql.exec('ALTER TABLE review ADD COLUMN pinned_provider TEXT');
    }
    if (!have.has('pinned_model')) {
      this.ctx.storage.sql.exec('ALTER TABLE review ADD COLUMN pinned_model TEXT');
    }
    if (!have.has('relaunch_count')) {
      this.ctx.storage.sql.exec(
        'ALTER TABLE review ADD COLUMN relaunch_count INTEGER NOT NULL DEFAULT 0',
      );
    }
    const checkpointCols = this.ctx.storage.sql
      .exec('PRAGMA table_info(review_checkpoint)')
      .toArray() as Array<{ name: string }>;
    const haveCheckpoint = new Set(checkpointCols.map((c) => c.name));
    if (!haveCheckpoint.has('verification_json')) {
      this.ctx.storage.sql.exec('ALTER TABLE review_checkpoint ADD COLUMN verification_json TEXT');
    }
  }

  // -------------------------------------------------------------------------
  // Per-round checkpoints — the relaunch substrate. All sync (sql.exec), so
  // callers inside sweep loops stay race-free within an event-loop turn.
  // -------------------------------------------------------------------------

  private writeCheckpoint(deliveryId: string, state: DeepReviewerResumeState): void {
    const json = JSON.stringify(state);
    const verification = this.verificationState.get(deliveryId) ?? null;
    this.ctx.storage.sql.exec(
      'INSERT INTO review_checkpoint (delivery_id, state_json, round, updated_at, verification_json) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(delivery_id) DO UPDATE SET state_json = excluded.state_json, round = excluded.round, updated_at = excluded.updated_at, verification_json = excluded.verification_json',
      deliveryId,
      json,
      state.nextRound,
      Date.now(),
      verification ? JSON.stringify(verification) : null,
    );
    log('info', 'pr_review_checkpoint_captured', {
      deliveryId,
      round: state.nextRound,
      bytes: json.length,
    });
  }

  private readCheckpoint(deliveryId: string): {
    state: DeepReviewerResumeState;
    round: number;
    updatedAt: number;
    verification: ReviewVerification | null;
  } | null {
    const rows = this.ctx.storage.sql
      .exec(
        'SELECT state_json, round, updated_at, verification_json FROM review_checkpoint WHERE delivery_id = ?',
        deliveryId,
      )
      .toArray() as Array<{
      state_json: string;
      round: number;
      updated_at: number;
      verification_json: string | null;
    }>;
    if (!rows.length) return null;
    try {
      // A corrupt verification blob degrades to null (the attempt restarts
      // its record) without dropping the round checkpoint with it.
      let verification: ReviewVerification | null = null;
      if (rows[0].verification_json) {
        try {
          verification = JSON.parse(rows[0].verification_json) as ReviewVerification;
        } catch {
          verification = null;
        }
      }
      return {
        state: JSON.parse(rows[0].state_json) as DeepReviewerResumeState,
        round: rows[0].round,
        updatedAt: rows[0].updated_at,
        verification,
      };
    } catch (err) {
      // A corrupt checkpoint must not wedge the sweep — drop it loudly so the
      // row falls back to the from-scratch retry path.
      log('error', 'pr_review_checkpoint_parse_failed', {
        deliveryId,
        message: err instanceof Error ? err.message : String(err),
      });
      this.clearCheckpoint(deliveryId);
      return null;
    }
  }

  /**
   * Mark progress on a live delivery's checkpoint without changing its state:
   * bumps `updated_at` so the progress-anchored timeout in
   * `failTimedOutReviews` covers long in-round tool runs (setup + verifier).
   * No-op when no checkpoint row exists yet (the round-top write creates it
   * before any tool can run).
   */
  private touchCheckpoint(deliveryId: string): void {
    this.ctx.storage.sql.exec(
      'UPDATE review_checkpoint SET updated_at = ? WHERE delivery_id = ?',
      Date.now(),
      deliveryId,
    );
  }

  private clearCheckpoint(deliveryId: string): void {
    this.ctx.storage.sql.exec('DELETE FROM review_checkpoint WHERE delivery_id = ?', deliveryId);
  }

  /** Pull the next alarm to ≤ now + REVIEW_WATCHDOG_MS without pushing out a
   *  sooner one (single-alarm discipline, same merge rule as runReview). */
  private async armWatchdogMergeSooner(): Promise<void> {
    const target = Date.now() + REVIEW_WATCHDOG_MS;
    const pending = await this.ctx.storage.getAlarm();
    await this.ctx.storage.setAlarm(
      pending != null && pending > Date.now() && pending < target ? pending : target,
    );
  }

  /**
   * Alarm backstop: fires (even after an eviction — the alarm is persistent) at
   * a review's deadline and finalizes anything left orphaned or live-but-stuck.
   * A live AbortController means the current isolate still owns the review; it
   * does not prove the provider/model stream is making progress. Once the wall
   * clock budget expires, abort and fail it so the UI/check-run cannot hang
   * forever.
   *
   * Merges the grace-recheck alarm from sweepOrphans with live-review deadlines
   * so the earliest alarm always wins — preventing the grace alarm from being
   * silently overwritten (Durable Objects support only a single alarm).
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    await this.failTimedOutReviews(now);
    const graceAlarm = await this.sweepOrphans(false);

    const pending = this.ctx.storage.sql
      .exec("SELECT * FROM review WHERE status IN ('queued','running')")
      .toArray() as unknown as ReviewRow[];
    let nextAlarm = graceAlarm;
    for (const row of pending) {
      if (row.status !== 'running' || row.started_at == null) continue;
      if (!this.abortControllers.has(row.delivery_id)) continue;
      // While any review is live (including one just relaunched by the sweep
      // above), the next alarm is the WATCHDOG cadence — instance death must
      // be noticed in ~90s so the relaunch chain outruns the eviction cycle.
      // The 15-min progress deadline is enforced by failTimedOutReviews on
      // each firing; it never needs to be the armed target since the watchdog
      // fires far more often.
      const candidate = now + REVIEW_WATCHDOG_MS;
      nextAlarm = nextAlarm == null ? candidate : Math.min(nextAlarm, candidate);
    }
    if (nextAlarm != null) {
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, nextAlarm));
    }
  }

  /** Force-fail live reviews that exceeded the wall-clock budget. */
  private async failTimedOutReviews(now: number): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec("SELECT * FROM review WHERE status IN ('queued','running')")
      .toArray() as unknown as ReviewRow[];
    for (const row of rows) {
      if (row.status !== 'running' || row.started_at == null) continue;
      const controller = this.abortControllers.get(row.delivery_id);
      if (!controller) continue;
      // Progress-anchored deadline: a review that keeps checkpointing rounds
      // is working, not stalled — the budget measures time since the LAST
      // progress, not since the (possibly much earlier, relaunch-spanning)
      // start. Total model work stays bounded by MAX_DEEP_REVIEW_ROUNDS.
      const progressAnchor = Math.max(
        row.started_at,
        this.readCheckpoint(row.delivery_id)?.updatedAt ?? 0,
      );
      if (now - progressAnchor < REVIEW_TIMEOUT_MS) continue;

      if (!controller.signal.aborted) controller.abort();
      this.abortControllers.delete(row.delivery_id);

      const message =
        'Review exceeded its wall-clock budget; the provider stream appears stalled and was forcibly terminated.';
      this.ctx.storage.sql.exec(
        "UPDATE review SET status = 'failed', error_text = ?, finished_at = ? WHERE delivery_id = ?",
        message,
        now,
        row.delivery_id,
      );
      this.emit(row.delivery_id, 'review.failed', { errorType: 'timeout', message });
      log('warn', 'pr_review_timeout_swept', {
        deliveryId: row.delivery_id,
        repo: row.repo,
        pr: row.pr_number,
      });

      const retried = this.maybeRetryDeadReview(row, 'timeout');

      // Best-effort check-run finalization per row: a single network hiccup
      // must not skip abort+DB-update for other timed-out rows.
      try {
        const token = await this.mintInstallationToken(row.installation_id);
        if (token) {
          await this.finalizeCheckRun(
            row.repo,
            row.head_sha,
            token,
            row.check_run_id ?? null,
            'neutral',
            retried
              ? {
                  title: 'Review retrying',
                  summary:
                    'The first attempt exceeded its wall-clock budget (stalled provider stream) and was terminated. A second attempt is running and will report on its own check-run.',
                }
              : {
                  title: 'Review timed out',
                  summary: `The review exceeded its wall-clock budget and its automatic retry was already used. ${TERMINAL_RETRY_ADVICE}`,
                },
          );
        }
      } catch (err) {
        log('warn', 'pr_review_timeout_check_close_failed', {
          deliveryId: row.delivery_id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    // First fetch after a DO wake: a prior instance may have died mid-review,
    // leaving rows `running` and their check-runs hanging. Sweep them before
    // handling the request (waitUntil keeps the DO alive until it settles).
    if (!this.orphanSweepKicked) {
      this.orphanSweepKicked = true;
      this.ctx.waitUntil(this.sweepOrphans());
    }
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
        case 'cancel':
          return this.handleCancel((await request.json()) as { deliveryId?: string });
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

  private async handleStart(input: PrReviewStartInput): Promise<Response> {
    const missing = (
      ['deliveryId', 'repoFullName', 'prNumber', 'headSha', 'baseRef', 'installationId'] as const
    ).filter((k) => !input[k]);
    if (missing.length) {
      return json({ error: 'MISSING_FIELDS', fields: missing }, 400);
    }

    // ⚠️ INVARIANT: the dedupe → supersede → insert sequence below MUST stay
    // synchronous — do NOT introduce an `await` until after insertQueuedReview().
    // The reservation is what makes a concurrent redelivery dedupe and a newer
    // head SHA coalesce instead of double-queueing; an external await parked
    // mid-block let a redelivery race the unique insert (Codex P1, PR #910 — see
    // the pin-await note further down, which is deliberately the FIRST yield).
    // `supersedeSameHead` widens the coalescing scope to the whole PR, which
    // makes this atomicity matter even more. Anything async (config/KV/network)
    // belongs after the insert.

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
    // dedupes above; this only fires for genuinely newer pushes. An explicit
    // comment re-request (`supersedeSameHead`) widens this to the same head too,
    // so "review again now" cancels the in-flight pass and the latest wins. The
    // current delivery's own row isn't inserted yet, so it can't supersede
    // itself.
    const stale = (
      input.supersedeSameHead
        ? this.ctx.storage.sql.exec(
            "SELECT delivery_id FROM review WHERE pr_number = ? AND status IN ('queued','running')",
            input.prNumber,
          )
        : this.ctx.storage.sql.exec(
            "SELECT delivery_id FROM review WHERE pr_number = ? AND head_sha != ? AND status IN ('queued','running')",
            input.prNumber,
            input.headSha,
          )
    ).toArray() as Array<{ delivery_id: string }>;
    for (const row of stale) {
      this.ctx.storage.sql.exec(
        "UPDATE review SET status = 'superseded', finished_at = ? WHERE delivery_id = ?",
        Date.now(),
        row.delivery_id,
      );
      this.abortControllers.get(row.delivery_id)?.abort();
      // Terminal: a superseded row must never be relaunched from its stale
      // checkpoint by a later sweep (an orphaned superseded row has no
      // in-process finally to clear it).
      this.clearCheckpoint(row.delivery_id);
      this.emit(row.delivery_id, 'review.superseded', { byHeadSha: input.headSha });
      log('info', 'pr_review_superseded', {
        deliveryId: row.delivery_id,
        byDeliveryId: input.deliveryId,
        pr: input.prNumber,
      });
      // The superseded delivery's own runReview closes its check-run on its
      // abort/superseded exit (it always registered the controller and holds
      // the check-run id by then) — so we deliberately do NOT touch the
      // check-run here. Doing so raced startCheckRun and could both
      // double-post and leave the late in-progress run hanging "Reviewing…".
    }

    this.insertQueuedReview(input);
    this.emit(input.deliveryId, 'review.queued', { headSha: input.headSha });

    // Register in the cross-PR discovery index so this review is reachable from
    // the global "active reviews" surface regardless of which branch the UI is
    // on. Best-effort/waitUntil — the index is observability, not correctness,
    // and must not block the 202 ack the webhook receiver needs within ~10s.
    this.ctx.waitUntil(
      recordInflightReview(this.env, {
        repo: input.repoFullName,
        prNumber: input.prNumber,
        deliveryId: input.deliveryId,
        headSha: input.headSha,
        createdAt: Date.now(),
      }),
    );

    // Pin provider/model for the delivery's lifetime — AFTER the
    // synchronous dedupe→supersede→insert block above. The row reservation
    // must not be separated from its duplicate/coalescing checks by an
    // external await: a settings/KV read parked there let a concurrent
    // redelivery race the unique insert, and let two head SHAs both queue
    // because neither saw the other (Codex P1, PR #910). Relaunches and
    // auto-retries rebuild their input from the row, so persisting the pin
    // here covers every later attempt. Best-effort: a failed read logs
    // loudly and leaves the delivery unpinned (executor resolves live per
    // attempt — the pre-pin behavior). One fast KV/doc read; the webhook
    // 202 budget (~10s) is unaffected.
    try {
      const effective = await getPrReviewEffectiveConfig(this.env);
      input.pinnedProvider = effective.provider;
      input.pinnedModel = effective.model;
      this.ctx.storage.sql.exec(
        'UPDATE review SET pinned_provider = ?, pinned_model = ? WHERE delivery_id = ?',
        effective.provider,
        effective.model,
        input.deliveryId,
      );
      log('info', 'pr_review_config_pinned', {
        deliveryId: input.deliveryId,
        provider: effective.provider,
        model: effective.model,
      });
    } catch (err) {
      log('warn', 'pr_review_config_pin_failed', {
        deliveryId: input.deliveryId,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // The pin await above is the one yield between reservation and launch: a
    // newer head SHA can supersede this row inside it. Kicking runReview for
    // a superseded row would resurrect it to 'running' — re-check and stand
    // down instead (the superseding delivery owns the PR now).
    const postPinStatus = this.reviewRow(input.deliveryId)?.status;
    if (postPinStatus !== 'queued') {
      log('info', 'pr_review_start_stood_down', {
        deliveryId: input.deliveryId,
        status: postPinStatus ?? null,
      });
      return json({ status: postPinStatus ?? 'unknown' }, 200);
    }

    // Run in the background; keep the DO alive until it settles.
    this.ctx.waitUntil(this.runReview(input));
    return json({ status: 'queued' }, 202);
  }

  private insertQueuedReview(input: PrReviewStartInput): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO review (delivery_id, repo, pr_number, head_sha, base_ref, head_ref, installation_id, is_cross_fork, origin, status, created_at, pinned_provider, pinned_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      input.deliveryId,
      input.repoFullName,
      input.prNumber,
      input.headSha,
      input.baseRef,
      input.headRef,
      input.installationId,
      input.isCrossFork ? 1 : 0,
      input.origin,
      Date.now(),
      input.pinnedProvider ?? null,
      input.pinnedModel ?? null,
    );
  }

  /**
   * Re-enqueue a review attempt that died without producing a result — the DO
   * was evicted mid-run (every production deploy does this to any in-flight
   * review) or the provider stream stalled past the wall-clock budget. Exactly
   * one retry per original delivery: the retry id carries AUTO_RETRY_SUFFIX,
   * and a dead retry is final. Returns true when a retry was kicked (callers
   * pick the check-run wording off this).
   */
  private maybeRetryDeadReview(row: ReviewRow, cause: 'orphaned' | 'timeout'): boolean {
    try {
      return this.retryDeadReview(row, cause);
    } catch (err) {
      // A storage hiccup enqueuing the retry must not throw into the sweep or
      // the alarm handler — the original row is already finalized; losing the
      // retry degrades to the pre-retry behavior, loudly.
      log('error', 'pr_review_retry_enqueue_failed', {
        deliveryId: row.delivery_id,
        cause,
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private retryDeadReview(row: ReviewRow, cause: 'orphaned' | 'timeout'): boolean {
    if (row.delivery_id.endsWith(AUTO_RETRY_SUFFIX)) return false;
    const retryId = row.delivery_id + AUTO_RETRY_SUFFIX;
    // Idempotence across alarm re-fires / first-fetch sweeps: if the retry row
    // already exists (whatever its state), never enqueue a third attempt.
    const existing = this.ctx.storage.sql
      .exec('SELECT status FROM review WHERE delivery_id = ?', retryId)
      .toArray();
    if (existing.length) return false;

    const input: PrReviewStartInput = {
      deliveryId: retryId,
      repoFullName: row.repo,
      prNumber: row.pr_number,
      headSha: row.head_sha,
      baseRef: row.base_ref,
      headRef: row.head_ref,
      installationId: row.installation_id,
      isCrossFork: row.is_cross_fork === 1,
      origin: row.origin ?? RETRY_FALLBACK_ORIGIN,
      // The retry is the same review intent; it keeps the original pin.
      pinnedProvider: row.pinned_provider ?? undefined,
      pinnedModel: row.pinned_model ?? undefined,
    };
    this.insertQueuedReview(input);
    this.emit(retryId, 'review.queued', {
      headSha: row.head_sha,
      retryOf: row.delivery_id,
      cause,
    });
    log('info', 'pr_review_auto_retry', {
      deliveryId: row.delivery_id,
      retryId,
      cause,
      repo: row.repo,
      pr: row.pr_number,
    });
    this.ctx.waitUntil(
      recordInflightReview(this.env, {
        repo: row.repo,
        prNumber: row.pr_number,
        deliveryId: retryId,
        headSha: row.head_sha,
        createdAt: Date.now(),
      }),
    );
    this.ctx.waitUntil(this.runReview(input));
    return true;
  }

  private async runReview(
    input: PrReviewStartInput,
    resume?: { state: DeepReviewerResumeState; verification?: ReviewVerification | null },
  ): Promise<void> {
    const controller = new AbortController();
    // Registration is SYNCHRONOUS (before the first await) — the sweep's
    // "running row without a controller ⇒ owning instance is dead" inference
    // and the relaunch path's race-freedom both depend on it.
    this.abortControllers.set(input.deliveryId, controller);
    this.ctx.storage.sql.exec(
      "UPDATE review SET status = 'running', started_at = ? WHERE delivery_id = ?",
      Date.now(),
      input.deliveryId,
    );
    this.emit(input.deliveryId, resume ? 'review.relaunched' : 'review.started', {
      ...(resume ? { fromRound: resume.state.nextRound } : {}),
    });

    // Arm the watchdog: while a review is live the alarm fires at a short
    // cadence so an instance death is noticed in ~REVIEW_WATCHDOG_MS, not at
    // the 15-min backstop. Merge with any earlier pending alarm (DOs hold a
    // single alarm) — a relaunch/retry kicked from inside the alarm/sweep path
    // must not push out a sooner grace-recheck by blindly overwriting it.
    const backstop = Date.now() + REVIEW_WATCHDOG_MS;
    const pendingAlarm = await this.ctx.storage.getAlarm();
    await this.ctx.storage.setAlarm(
      pendingAlarm != null && pendingAlarm > Date.now() && pendingAlarm < backstop
        ? pendingAlarm
        : backstop,
    );

    // Open the visible "Reviewing…" check-run (best-effort; null without
    // creds). A relaunch reuses the original attempt's check-run instead of
    // stacking a new one per resume.
    const existingCheckRunId = this.reviewRow(input.deliveryId)?.check_run_id ?? null;
    const checkToken = await this.mintInstallationToken(input.installationId);
    const checkRunId =
      existingCheckRunId ?? (checkToken ? await this.startCheckRun(input, checkToken) : null);

    // Attach cross-review memory for this attempt. Computed here (not in
    // handleStart) so relaunches and auto-retries — which rebuild their input
    // from the row — pick it up uniformly. The prior set cannot change while
    // this delivery is live: a newer completed review would have superseded it.
    const prior = this.latestPostedReview(input.deliveryId);
    if (prior) {
      input.priorReview = prior.context;
      log('info', 'pr_review_prior_context_attached', {
        deliveryId: input.deliveryId,
        priorDeliveryId: prior.deliveryId,
        priorHeadSha: prior.context.headSha,
        priorFindings: prior.context.comments.length,
      });
    } else {
      log('info', 'pr_review_prior_context_none', { deliveryId: input.deliveryId });
    }

    const executor = EXECUTOR_OVERRIDES.get(input.deliveryId) ?? defaultPrReviewExecutor;
    // Seed the in-memory verifier record from the relaunch checkpoint so the
    // next writeCheckpoint doesn't wipe what a prior attempt banked.
    if (resume?.verification) {
      this.verificationState.set(input.deliveryId, resume.verification);
    }
    try {
      const outcome = await executor(input, this.env, controller.signal, {
        resumeState: resume?.state,
        resumeVerification: resume?.verification ?? undefined,
        onVerification: (verification) => {
          this.verificationState.set(input.deliveryId, verification);
        },
        onToolProgress: () => {
          try {
            this.touchCheckpoint(input.deliveryId);
          } catch (err) {
            // Losing one progress mark only narrows the timeout window back
            // to the round top — never worth failing the tool call over.
            log('warn', 'pr_review_checkpoint_touch_failed', {
              deliveryId: input.deliveryId,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        },
        onRoundState: (state) => {
          // Synchronous persist (the lib hands us its live array — serialize
          // now). Re-arming the watchdog is async; fire-and-forget under
          // waitUntil so a slow storage op never blocks the round loop.
          try {
            this.writeCheckpoint(input.deliveryId, state);
          } catch (err) {
            log('error', 'pr_review_checkpoint_write_failed', {
              deliveryId: input.deliveryId,
              round: state.nextRound,
              message: err instanceof Error ? err.message : String(err),
            });
          }
          this.ctx.waitUntil(
            this.armWatchdogMergeSooner().catch((err) => {
              // Non-fatal: the alarm armed at runReview start (≤ WATCHDOG away)
              // still fires; losing the re-arm only delays death detection.
              log('warn', 'pr_review_watchdog_rearm_failed', {
                deliveryId: input.deliveryId,
                message: err instanceof Error ? err.message : String(err),
              });
            }),
          );
        },
      });
      // A late alarm/supersede may have flipped status while we ran; don't clobber it.
      const current = this.reviewRow(input.deliveryId);
      if (current?.status !== 'running') {
        log('info', 'pr_review_completed_after_terminal', {
          deliveryId: input.deliveryId,
          status: current?.status ?? null,
        });
        if (checkToken) {
          if (current?.status === 'superseded') {
            await this.closeCheckSuperseded(input, checkToken, checkRunId);
          } else if (current?.status === 'cancelled') {
            await this.closeCheckCancelled(input, checkToken, checkRunId);
          }
        }
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
        verification: outcome.result.verification ?? null,
      });
      log('info', 'pr_review_completed', {
        deliveryId: input.deliveryId,
        repo: input.repoFullName,
        pr: input.prNumber,
        commentsPosted: outcome.commentsPosted,
        posted: outcome.posted,
        degraded: outcome.result.degraded ?? false,
        findings: outcome.result.comments.length,
        // Surface token usage in ops logs when the provider reported it; null
        // keeps the field present (and greppable) when it didn't.
        totalTokens: outcome.result.usage?.totalTokens ?? null,
        verification: outcome.result.verification ?? null,
      });
      if (checkToken) {
        const findings = outcome.result.comments.length;
        // degraded = the run never produced structured output (fallback
        // result, nothing posted) → neutral, NOT success: a review that
        // didn't happen must not read as "no blocking findings" (PRs
        // #905/#906). !posted = head advanced before posting (skipped).
        // gated = blocking finding on a gating repo → failure. Otherwise
        // success, with the finding count in the title so it's legible
        // without opening the PR.
        const status = outcome.result.degraded
          ? {
              conclusion: 'neutral' as ReviewCheckConclusion,
              title: 'Review incomplete',
              summary:
                'The reviewer did not produce structured findings (round limit or dead ' +
                'forced-output turn). Nothing was posted. Close and reopen the PR to re-run.',
            }
          : !outcome.posted
            ? {
                conclusion: 'neutral' as ReviewCheckConclusion,
                title: 'Skipped — newer commit',
                summary: 'A newer commit arrived before this review could post.',
              }
            : outcome.gated
              ? {
                  conclusion: 'failure' as ReviewCheckConclusion,
                  title: 'Critical findings',
                  summary: outcome.result.summary || 'Critical issues found.',
                }
              : findings === 0
                ? // Clean pass: `success` is reserved for reviews that actually
                  // VERIFIED (a sandbox verifier ran and passed). A zero-findings
                  // review that never executed anything — or whose verifier
                  // failed — concludes `neutral` with the reason in the title,
                  // so "didn't check" can't launder into a green check (the
                  // same didn't-happen ≠ clean-pass rule as the degraded path).
                  cleanPassCheckStatus(outcome.result.verification)
                : {
                    conclusion: 'success' as ReviewCheckConclusion,
                    title: `${findings} finding${findings === 1 ? '' : 's'}`,
                    summary: outcome.result.summary || `${findings} finding(s) posted.`,
                  };
        await this.finalizeCheckRun(
          input.repoFullName,
          input.headSha,
          checkToken,
          checkRunId,
          status.conclusion,
          { title: status.title, summary: status.summary },
        );
      }
    } catch (err) {
      if (controller.signal.aborted) {
        const current = this.reviewRow(input.deliveryId);
        // The timeout sweep (failTimedOutReviews) already closed the check-run
        // when it drove the row to `failed`; re-closing would race its finalize.
        if (current?.status === 'failed') {
          log('info', 'pr_review_aborted_after_terminal', {
            deliveryId: input.deliveryId,
            status: current.status,
          });
          return;
        }
        log('info', 'pr_review_aborted', {
          deliveryId: input.deliveryId,
          status: current?.status ?? null,
        });
        // We own this check-run (created at start, id held locally), and by now
        // startCheckRun has resolved — so `checkRunId` is the real in-progress id
        // even when the abort landed mid-create. Close it here so it can't hang
        // "Reviewing…", for both a user cancel and a supersede. handleCancel
        // deliberately does NOT close when a controller is live (this path); it
        // only closes orphaned rows, so closing the *late-created* run with the
        // real id is owned here rather than racing a stale (null-id) close.
        if (checkToken) {
          if (current?.status === 'cancelled') {
            await this.closeCheckCancelled(input, checkToken, checkRunId);
          } else {
            await this.closeCheckSuperseded(input, checkToken, checkRunId);
          }
        }
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
      if (checkToken) {
        // Neutral, not failure: a reviewer hiccup shouldn't red-X the PR's
        // checks — but it must be visible rather than vanish.
        await this.finalizeCheckRun(
          input.repoFullName,
          input.headSha,
          checkToken,
          checkRunId,
          'neutral',
          {
            title: 'Review failed',
            summary: `Push could not complete the review: ${message.slice(0, 300)}`,
          },
        );
      }
    } finally {
      this.abortControllers.delete(input.deliveryId);
      this.verificationState.delete(input.deliveryId);
      // Every in-process exit is terminal for this attempt (completed, failed,
      // cancelled, superseded) — the checkpoint has served its purpose. The
      // relaunch path never reaches here: it exists precisely for promises
      // that died WITH the instance, where no finally runs and the persisted
      // checkpoint is the survivor.
      this.clearCheckpoint(input.deliveryId);
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

  /**
   * User-initiated cancel of an in-flight (`queued`/`running`) review. Drives the
   * row to `cancelled`, aborts the live executor if this instance owns one, and
   * closes the check-run — mirroring the timeout sweep's ownership model: the
   * cancel path is the single owner of the terminal transition + check-run close,
   * so runReview's abort catch early-returns on `cancelled` (see runReview).
   *
   * Already-terminal reviews return 409 (NOT_CANCELLABLE) so a stale tab racing a
   * just-completed/superseded review gets a clear signal instead of a silent
   * no-op. The check-run close runs via waitUntil so the client isn't blocked on
   * GitHub; it's token-gated (no-op without App creds) and covers the orphaned
   * case too (a `running` row whose DO died has no controller to abort, but the
   * check-run still needs closing — nothing else will).
   */
  private handleCancel(input: { deliveryId?: string }): Response {
    const deliveryId = typeof input.deliveryId === 'string' ? input.deliveryId : '';
    if (!deliveryId) return json({ error: 'MISSING_FIELDS', fields: ['deliveryId'] }, 400);
    const row = this.reviewRow(deliveryId);
    if (!row) return json({ error: 'NOT_FOUND', deliveryId }, 404);

    const cancelledTarget = this.cancelReviewRow(row);

    // Cascade to the auto-retry child. The first-fetch orphan sweep can race a
    // cancel aimed at a dead original: by the time the cancel lands, the sweep
    // has already failed the original AND enqueued its retry — so honoring the
    // user's intent means killing the retry too, whichever ordering won.
    let cancelledRetry = false;
    if (!deliveryId.endsWith(AUTO_RETRY_SUFFIX)) {
      const retryRow = this.reviewRow(deliveryId + AUTO_RETRY_SUFFIX);
      if (retryRow) cancelledRetry = this.cancelReviewRow(retryRow);
    }

    if (!cancelledTarget && !cancelledRetry) {
      return json(
        {
          error: 'NOT_CANCELLABLE',
          status: row.status,
          message: 'Review is already in a terminal state.',
        },
        409,
      );
    }
    return json({ status: 'cancelled' }, 200);
  }

  /** Cancel one non-terminal row; returns false when it was already terminal. */
  private cancelReviewRow(row: ReviewRow): boolean {
    if (row.status !== 'queued' && row.status !== 'running') return false;

    this.ctx.storage.sql.exec(
      "UPDATE review SET status = 'cancelled', finished_at = ? WHERE delivery_id = ?",
      Date.now(),
      row.delivery_id,
    );
    const controller = this.abortControllers.get(row.delivery_id);
    if (controller && !controller.signal.aborted) controller.abort();
    this.abortControllers.delete(row.delivery_id);
    // Terminal for orphaned cancels too (no in-process finally will run).
    this.clearCheckpoint(row.delivery_id);
    this.emit(row.delivery_id, 'review.cancelled', {});
    log('info', 'pr_review_cancelled', {
      deliveryId: row.delivery_id,
      repo: row.repo,
      pr: row.pr_number,
      priorStatus: row.status,
      hadController: controller != null,
    });

    // Check-run close ownership: when a live controller exists, the aborted
    // runReview closes the in-progress run with the *real* check-run id — which
    // covers the race where this cancel landed while startCheckRun was still
    // creating it (the row's check_run_id is still null here, so closing from it
    // would orphan the real run and post a duplicate). Only close from the row
    // for a true orphan (no controller: the running row's instance died), since
    // nothing else will. Best-effort/token-gated; waitUntil keeps the DO alive.
    if (!controller) {
      this.ctx.waitUntil(this.closeCheckCancelledFromRow(row));
    }
    return true;
  }

  /**
   * Cross-review memory source: the most recent review actually POSTED to this
   * PR (completed, `posted = 1`, with a persisted result), excluding the given
   * delivery. Unposted rows (head-advanced skips, degraded runs) never reached
   * the PR, so their findings are not "prior review" in the sense the re-review
   * instructions promise ("addressed vs remaining" refers to posted comments).
   */
  private latestPostedReview(
    excludeDeliveryId: string,
  ): { deliveryId: string; context: PriorReviewContext } | null {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT delivery_id, head_sha, finished_at, result_json FROM review WHERE status = 'completed' AND posted = 1 AND result_json IS NOT NULL AND delivery_id != ? ORDER BY finished_at DESC LIMIT 1",
        excludeDeliveryId,
      )
      .toArray() as Array<{
      delivery_id: string;
      head_sha: string;
      finished_at: number | null;
      result_json: string;
    }>;
    if (!rows.length) return null;
    try {
      const result = JSON.parse(rows[0].result_json) as ReviewResult;
      return {
        deliveryId: rows[0].delivery_id,
        context: {
          headSha: rows[0].head_sha,
          reviewedAt: rows[0].finished_at,
          summary: result.summary,
          comments: result.comments,
        },
      };
    } catch (err) {
      // A corrupt result blob degrades to a from-scratch review, loudly.
      log('warn', 'pr_review_prior_context_parse_failed', {
        priorDeliveryId: rows[0].delivery_id,
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
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

  // ── Check-run status surface ──────────────────────────────────────────────
  // Every delivery gets a single "Push review" check-run that progresses
  // in-place: in_progress on start → terminal at every outcome (posted /
  // skipped / superseded / failed). This is the visibility surface — it lives
  // on the PR, survives merge in the checks list, and turns the formerly-silent
  // superseded/failed/head-advanced paths into something you can see. All ops
  // are best-effort and token-gated: with no GitHub App creds they no-op, so a
  // check-run hiccup never affects the review (or the credential-free tests).

  private async mintInstallationToken(installationId: string): Promise<string | null> {
    if (!this.env.GITHUB_APP_ID || !this.env.GITHUB_APP_PRIVATE_KEY) return null;
    try {
      const jwt = await generateGitHubAppJWT(
        this.env.GITHUB_APP_ID,
        this.env.GITHUB_APP_PRIVATE_KEY,
      );
      const { token } = await exchangeForInstallationToken(jwt, installationId);
      return token;
    } catch (err) {
      log('warn', 'pr_review_check_token_failed', {
        installationId,
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Best-effort: open the in-progress check-run and return its id. The id is
   * also persisted on the review row as a correlation handle (DO record ↔ the
   * GitHub check-run) for debugging/observability; finalization itself uses the
   * in-scope id returned here, not a DB read-back.
   */
  private async startCheckRun(input: PrReviewStartInput, token: string): Promise<number | null> {
    try {
      const id = await createInProgressReviewCheckRun(
        input.repoFullName,
        input.headSha,
        { title: 'Reviewing…', summary: 'Push is reviewing this pull request.' },
        { token },
      );
      this.ctx.storage.sql.exec(
        'UPDATE review SET check_run_id = ? WHERE delivery_id = ?',
        id,
        input.deliveryId,
      );
      return id;
    } catch (err) {
      log('warn', 'pr_review_check_create_failed', {
        deliveryId: input.deliveryId,
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Best-effort terminal update of a delivery's check-run. Patches the existing
   * in-progress run if we have its id; otherwise posts a fresh completed run
   * (covers a delivery superseded before its in-progress run was created).
   */
  private async finalizeCheckRun(
    repo: string,
    headSha: string,
    token: string,
    checkRunId: number | null,
    conclusion: ReviewCheckConclusion,
    output: { title: string; summary: string },
  ): Promise<void> {
    try {
      if (checkRunId != null) {
        await finalizeReviewCheckRun(repo, checkRunId, conclusion, output, { token });
      } else {
        await createReviewCheckRun(repo, headSha, conclusion, output, { token });
      }
    } catch (err) {
      log('warn', 'pr_review_check_finalize_failed', {
        repo,
        conclusion,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Close this delivery's own check-run as superseded. Called from runReview's
   * abort/superseded exits (not from handleStart) so the run that opened the
   * check is the one that closes it — avoiding the race where a not-yet-
   * persisted id from an in-flight startCheckRun leaves a hanging "Reviewing…".
   */
  private async closeCheckSuperseded(
    input: PrReviewStartInput,
    token: string,
    checkRunId: number | null,
  ): Promise<void> {
    await this.finalizeCheckRun(input.repoFullName, input.headSha, token, checkRunId, 'neutral', {
      title: 'Superseded',
      summary: 'A newer commit arrived; this review was superseded.',
    });
  }

  /**
   * Close a cancelled review's check-run as neutral, using the in-scope real
   * check-run id from runReview (mirrors closeCheckSuperseded). Called from
   * runReview's abort / after-terminal exits — the path that owns the close
   * whenever a live controller existed, so the late-created in-progress run is
   * patched with its real id rather than left hanging "Reviewing…".
   */
  private async closeCheckCancelled(
    input: PrReviewStartInput,
    token: string,
    checkRunId: number | null,
  ): Promise<void> {
    await this.finalizeCheckRun(input.repoFullName, input.headSha, token, checkRunId, 'neutral', {
      title: 'Review cancelled',
      summary: 'This review was cancelled.',
    });
  }

  /**
   * Close a cancelled *orphan's* check-run from its persisted row — used only
   * when the cancel found no live controller (the running row's instance had
   * died), so runReview won't run to close it. Mints its own token; token-gated
   * and best-effort throughout.
   */
  private async closeCheckCancelledFromRow(row: ReviewRow): Promise<void> {
    const token = await this.mintInstallationToken(row.installation_id);
    if (!token) return;
    await this.finalizeCheckRun(
      row.repo,
      row.head_sha,
      token,
      row.check_run_id ?? null,
      'neutral',
      {
        title: 'Review cancelled',
        summary: 'This review was cancelled.',
      },
    );
  }

  /**
   * Fail any `queued`/`running` review that no live execution owns and close its
   * hung check-run. A row with no entry in `abortControllers` is not being run
   * by this instance — and since there's exactly one DO per PR, that means the
   * instance that started it died (eviction/crash) before it could finalize.
   * The GRACE window skips rows young enough that a just-started delivery may
   * not have registered its controller yet, avoiding a race that would fail a
   * live review. Best-effort throughout — never throws into the caller.
   */
  private async sweepOrphans(armGrace = true): Promise<number | null> {
    let graceAlarm: number | null = null;
    try {
      const cutoff = Date.now() - ORPHAN_GRACE_MS;
      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM review WHERE status IN ('queued','running')")
        .toArray() as unknown as ReviewRow[];
      let graceSkipped = false;
      for (const row of rows) {
        if (this.abortControllers.has(row.delivery_id)) continue; // live in this instance

        // Relaunch-from-checkpoint, the primary recovery path: a running row
        // with a checkpoint and no live controller means the owning instance
        // died mid-review (registration is synchronous, so there is no
        // startup race a checkpointed row could be in — the grace window is
        // for rows that died before round 1). Resume the SAME delivery from
        // its last round instead of failing it: progress is monotone, so
        // repeated evictions converge where from-scratch retries cannot
        // (the death interval is shorter than a full review). The entire
        // decide+increment+launch sequence below is synchronous, so a
        // concurrent sweep in the same instance sees the controller
        // registered and skips.
        if (row.status === 'running') {
          const checkpoint = this.readCheckpoint(row.delivery_id);
          if (checkpoint && row.relaunch_count < MAX_REVIEW_RELAUNCHES) {
            this.ctx.storage.sql.exec(
              'UPDATE review SET relaunch_count = relaunch_count + 1 WHERE delivery_id = ?',
              row.delivery_id,
            );
            log('warn', 'pr_review_relaunched', {
              deliveryId: row.delivery_id,
              repo: row.repo,
              pr: row.pr_number,
              attempt: row.relaunch_count + 1,
              fromRound: checkpoint.round,
            });
            this.ctx.waitUntil(
              this.runReview(
                {
                  deliveryId: row.delivery_id,
                  repoFullName: row.repo,
                  prNumber: row.pr_number,
                  headSha: row.head_sha,
                  baseRef: row.base_ref,
                  headRef: row.head_ref,
                  installationId: row.installation_id,
                  isCrossFork: row.is_cross_fork === 1,
                  origin: row.origin ?? RETRY_FALLBACK_ORIGIN,
                  pinnedProvider: row.pinned_provider ?? undefined,
                  pinnedModel: row.pinned_model ?? undefined,
                },
                { state: checkpoint.state, verification: checkpoint.verification },
              ),
            );
            continue;
          }
          if (checkpoint && row.relaunch_count >= MAX_REVIEW_RELAUNCHES) {
            log('error', 'pr_review_relaunch_cap_exhausted', {
              deliveryId: row.delivery_id,
              repo: row.repo,
              pr: row.pr_number,
              relaunches: row.relaunch_count,
              lastRound: checkpoint.round,
            });
            // Fall through to the terminal orphan path below.
          }
        }

        if ((row.started_at ?? row.created_at) > cutoff) {
          graceSkipped = true; // too fresh — recheck after the grace window
          continue;
        }
        const message =
          'Review did not finish (the worker restarted or it exceeded its time budget).';
        this.ctx.storage.sql.exec(
          "UPDATE review SET status = 'failed', error_text = ?, finished_at = ? WHERE delivery_id = ?",
          message,
          Date.now(),
          row.delivery_id,
        );
        this.emit(row.delivery_id, 'review.failed', { errorType: 'orphaned', message });
        this.clearCheckpoint(row.delivery_id);
        log('warn', 'pr_review_orphan_swept', {
          deliveryId: row.delivery_id,
          repo: row.repo,
          pr: row.pr_number,
          priorStatus: row.status,
        });
        const retried = this.maybeRetryDeadReview(row, 'orphaned');
        const token = await this.mintInstallationToken(row.installation_id);
        if (token) {
          await this.finalizeCheckRun(
            row.repo,
            row.head_sha,
            token,
            row.check_run_id ?? null,
            'neutral',
            retried
              ? {
                  title: 'Review retrying',
                  summary:
                    'The first attempt did not finish (the worker restarted mid-run — production deploys evict in-flight reviews). A second attempt is running and will report on its own check-run.',
                }
              : {
                  title: 'Review incomplete',
                  summary: `The review did not finish (the worker restarted or it exceeded its time budget) and its automatic retry was already used. ${TERMINAL_RETRY_ADVICE}`,
                },
          );
        }
      }
      // A grace-skipped row may be a genuine orphan whose start-time alarm never
      // armed (DO died in the window before setAlarm) — without a recheck it
      // would hang forever once the grace window passes and the once-per-instance
      // first-fetch sweep is spent. Ensure a recheck just past the grace window.
      // (A row that turned out live re-arms the long alarm in alarm() instead.)
      if (graceSkipped) {
        graceAlarm = Date.now() + ORPHAN_GRACE_MS + 1_000;
        if (armGrace) await this.ctx.storage.setAlarm(graceAlarm);
      }
    } catch (err) {
      // Best-effort: a storage hiccup mid-sweep must not throw into the alarm
      // handler (which the runtime would retry) or a waitUntil. The first-fetch
      // sweep / alarm will retry on the next wake.
      log('error', 'pr_review_orphan_sweep_failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return graceAlarm;
  }
}

// ---------------------------------------------------------------------------
// Default executor — the model + GitHub leaf
// ---------------------------------------------------------------------------

/**
 * Resolve the reviewer's verifier commands from the repo's instruction files
 * at the BASE ref (trusted — never the head), in the canonical loader order
 * (`PROJECT_INSTRUCTION_FILENAMES`: PUSH.md → AGENTS.md → CLAUDE.md →
 * GEMINI.md) so a PUSH.md hint outranks an AGENTS.md one the way every other
 * instruction consumer resolves (Codex P2, PR #1385 — the old loop hardcoded
 * AGENTS.md/CLAUDE.md). Typecheck falls back to the universal
 * `npx tsc --noEmit`; tests have no safe default, so a repo without a
 * `# test:` hint gets `tests: null` and the test tool is not advertised.
 * Setup (`# setup:` hint, hint-only kind) falls back to the conditional
 * root-install default — it runs once before the first verifier so the
 * sandbox has dependencies (the PR #1386 signal: a bare checkout fails any
 * repo-level typecheck regardless of the diff).
 * Independent per kind: the first file that declares a kind wins for it.
 */
async function resolveReviewCommands(
  repoFullName: string,
  baseRef: string,
  auth: { token: string },
): Promise<ReviewVerifierCommands> {
  let typecheck: string | null = null;
  let tests: string | null = null;
  let setup: string | null = null;
  for (const filename of PROJECT_INSTRUCTION_FILENAMES) {
    if (typecheck && tests && setup) break;
    try {
      const content = await fetchRepoFileContent(repoFullName, filename, baseRef, auth);
      if (!content) continue;
      const hints = parseAgentsMdHints(content);
      if (!typecheck) {
        const hit = hints.find((hint) => hint.kind === 'typecheck');
        if (hit?.command.trim()) {
          typecheck = hit.command.trim();
          log('debug', 'pr_review_typecheck_command_resolved', {
            source: filename,
            command: typecheck,
          });
        }
      }
      if (!tests) {
        const hit = hints.find((hint) => hint.kind === 'test');
        if (hit?.command.trim()) {
          tests = hit.command.trim();
          log('debug', 'pr_review_test_command_resolved', {
            source: filename,
            command: tests,
          });
        }
      }
      if (!setup) {
        const hit = hints.find((hint) => hint.kind === 'setup');
        if (hit?.command.trim()) {
          setup = hit.command.trim();
          log('debug', 'pr_review_setup_command_resolved', {
            source: filename,
            command: setup,
          });
        }
      }
    } catch (err) {
      log('warn', 'pr_review_verifier_command_fetch_failed', {
        source: filename,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!typecheck) {
    log('debug', 'pr_review_typecheck_command_defaulted', {
      command: DEFAULT_REVIEW_TYPECHECK_COMMAND,
    });
  }
  if (!tests) {
    log('debug', 'pr_review_test_command_absent', { repo: repoFullName });
  }
  if (!setup) {
    log('debug', 'pr_review_setup_command_defaulted', {
      command: REVIEW_DEFAULT_SETUP_COMMAND,
    });
  }
  return {
    typecheck: typecheck ?? DEFAULT_REVIEW_TYPECHECK_COMMAND,
    tests,
    setup: setup ?? REVIEW_DEFAULT_SETUP_COMMAND,
  };
}

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
export const defaultPrReviewExecutor: PrReviewExecutor = async (input, env, signal, hooks) => {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error('GitHub App credentials are not configured (GITHUB_APP_ID / PRIVATE_KEY).');
  }
  const jwt = await generateGitHubAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const { token } = await exchangeForInstallationToken(jwt, input.installationId);
  const auth = { token };

  const diff = await fetchPullRequestDiff(input.repoFullName, input.prNumber, auth);

  // Flag-gated reachability spike for the sandbox-backed reviewer (see
  // review-sandbox-spike.ts). Inert unless PUSH_REVIEW_SANDBOX_SPIKE=1; never
  // throws into the review. Confirms the DO can provision + grep + tear down a
  // sandbox on a real PR before the full lazy-provision integration is built.
  if (env.PUSH_REVIEW_SANDBOX_SPIKE === '1') {
    // Dynamic import: the spike pulls in worker-cf-sandbox (and the CF Sandbox
    // SDK's `cloudflare:`-scheme imports). Loading that statically would drag the
    // SDK into every importer of this module — including pr-review-job-do.test.ts
    // under the node/vitest loader, which can't resolve `cloudflare:`. Deferring
    // it behind the flag keeps the SDK off both the test graph and the normal
    // (flag-off) review path.
    const { runReviewSandboxReachabilitySpike } = await import('./review-sandbox-spike');
    await runReviewSandboxReachabilitySpike({
      env,
      repoFullName: input.repoFullName,
      headRef: input.headRef,
      githubToken: token,
      isCrossFork: Boolean(input.isCrossFork),
    });
  }

  // REVIEW.md from the BASE ref, never the head — a fork's head is
  // attacker-controlled (design doc Security checklist). For same-repo PRs the
  // base ref is the authoritative guidance anyway.
  const reviewGuidance = await resolveReviewGuidance({
    fetchCommitted: () =>
      input.isCrossFork
        ? Promise.resolve(null)
        : fetchReviewGuidance(input.repoFullName, input.baseRef, auth),
  });

  // Prefer the per-delivery pin (resolved once at first start, threaded by
  // the DO through every relaunch/retry); fall back to live resolution only
  // for unpinned rows (pre-pin deploys, or a pin step that failed loudly).
  let provider: AIProviderType;
  let modelId: string;
  if (input.pinnedProvider && input.pinnedModel) {
    provider = input.pinnedProvider as AIProviderType;
    modelId = input.pinnedModel;
  } else {
    const runtimeConfig = await getPrReviewRuntimeConfig(env);
    provider = runtimeConfig.provider ?? DEFAULT_PROVIDER;
    modelId = runtimeConfig.model ?? getDefaultPrReviewModel(provider) ?? DEFAULT_MODEL;
  }

  // A configured/pinned provider that's no longer in the catalog (e.g. the
  // retired `blackbox`) falls back to the built-in default reviewer rather than
  // hard-failing every review; its now-stale model is dropped with it.
  const coerced = coerceKnownPrReviewer(provider, modelId);
  provider = coerced.provider;
  modelId = coerced.model;

  // Hard-fail policy: a model that's invalid for a *known* provider still
  // surfaces loudly (a genuine misconfiguration, not a removed provider).
  if (!isValidPrReviewRuntimeConfig(provider, modelId)) {
    throw new Error(`Configured review model is unavailable for ${provider}: ${modelId}`);
  }

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

  // Sandbox tools for the reviewer: provisioned eagerly at review start (see
  // the warm-up kick below) so the environment install overlaps model rounds —
  // the completion gate expects verifiers to run on every clean pass, so the
  // old pay-nothing-if-unused laziness optimized for a case that no longer
  // exists. Gated to same-repo PRs with a CF sandbox configured; killable via
  // PUSH_REVIEWER_SANDBOX=0. Fail-safe — any provisioning/exec problem degrades
  // to a diff-only review.
  const sandboxToolsEnabled =
    Boolean(env.Sandbox && env.SANDBOX_TOKENS) &&
    !input.isCrossFork &&
    env.PUSH_REVIEWER_SANDBOX !== '0';
  const reviewCommands: ReviewVerifierCommands = sandboxToolsEnabled
    ? await resolveReviewCommands(input.repoFullName, input.baseRef, auth)
    : {
        typecheck: DEFAULT_REVIEW_TYPECHECK_COMMAND,
        tests: null,
        setup: REVIEW_DEFAULT_SETUP_COMMAND,
      };

  // Verification record for this attempt — runtime-tracked, never inferred
  // from model claims. Seeded from the checkpoint on relaunch so verifier runs
  // banked by earlier attempts survive DO evictions.
  const verification: ReviewVerification = hooks?.resumeVerification
    ? { ...hooks.resumeVerification }
    : sandboxToolsEnabled
      ? { typecheck: 'not_run', tests: reviewCommands.tests ? 'not_run' : 'unavailable' }
      : { typecheck: 'unavailable', tests: 'unavailable' };
  let sandboxProvisionPromise: Promise<ReviewSandbox | null> | null = null;
  // Memoize the in-flight provision so concurrent (Promise.all) tool calls in a
  // single round share ONE sandbox instead of racing to create duplicates.
  const getReviewSandbox = (): Promise<ReviewSandbox | null> => {
    if (!sandboxProvisionPromise) {
      sandboxProvisionPromise = provisionReviewSandbox(
        env,
        input.repoFullName,
        input.headRef,
        input.headSha,
        token,
      );
    }
    return sandboxProvisionPromise;
  };

  // One environment-setup run per review, memoized like the provision above —
  // concurrent verifier calls share it, and only verifier calls trigger it
  // (inspection tools don't need dependencies). Failure is remembered too: a
  // setup that can't succeed shouldn't re-run 300s installs per verifier call.
  let setupPromise: Promise<ReviewSetupResult> | null = null;
  const ensureSetup = (sb: ReviewSandbox): Promise<ReviewSetupResult> => {
    if (!setupPromise) {
      setupPromise = runReviewSetup(env, sb, reviewCommands.setup).then((setup) => {
        log(
          setup.ok ? 'info' : 'warn',
          setup.ok ? 'pr_review_setup_succeeded' : 'pr_review_setup_failed',
          {
            deliveryId: input.deliveryId,
            ...(setup.ok ? {} : { detail: setup.text.slice(0, 300) }),
          },
        );
        return setup;
      });
    }
    return setupPromise;
  };

  // Eager warm-up: provision the sandbox and start the one-time environment
  // setup as soon as the review starts, so the multi-minute install overlaps
  // model rounds instead of running serially inside the first verifier tool
  // call. Observed 2026-07-09: models typically touch the sandbox only when
  // the completion gate nudges them to verify, so the first verifier call was
  // paying provision + cold install + verifier back-to-back under the 15-min
  // budget — and no setup ever completed. Both functions never throw (they
  // resolve null/failed); the catch is a defensive backstop so an unexpected
  // rejection can't surface as an unhandled rejection in the DO.
  // `reviewEnded` (set first thing in the .finally below) gates the setup
  // kick: this subscriber is registered BEFORE the teardown's detached chase,
  // so without the gate a provision that lands after a fast-ending review
  // would launch a 600s setup against a sandbox the very next microtask
  // destroys (local Codex P2, PR #1391).
  let reviewEnded = false;
  if (sandboxToolsEnabled) {
    void getReviewSandbox()
      .then((sb) => (sb && !reviewEnded ? ensureSetup(sb) : null))
      .catch(() => {});
  }

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
        priorReview: input.priorReview ?? null,
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
        if (toolCall.source === 'github') {
          const r = await executeReadOnlyGitHubToolWithToken(
            toolCall.call,
            input.repoFullName,
            token,
          );
          return { resultText: r.text };
        }
        // Sandbox inspection + base-command typecheck over the checked-out PR
        // head (same-repo only, lazily provisioned). Degrades to diff-only on
        // any provisioning/tool failure.
        if (sandboxToolsEnabled && toolCall.source === 'sandbox') {
          try {
            // Mark progress before potentially long work (provision, setup,
            // verifier) so the 15-min no-progress budget measures from here,
            // not from the round top the model already spent streaming.
            hooks?.onToolProgress?.();
            const sb = await getReviewSandbox();
            if (!sb) {
              return {
                resultText:
                  '[Tool Result] Sandbox unavailable — investigate via GitHub tools and the diff instead.',
              };
            }
            const r = await executeReviewSandboxTool(
              env,
              sb,
              toolCall.call,
              reviewCommands,
              () => ensureSetup(sb),
              // Re-mark progress after the setup gate settles: a verifier that
              // waited on the install needs its own deadline measured from the
              // install's end, or setup (600s) + verifier (480s) overruns the
              // 15-min no-progress budget with no mark in between.
              hooks?.onToolProgress,
            );
            if (r.verification) {
              verification[r.verification.kind] = r.verification.pass ? 'pass' : 'fail';
              log('info', 'pr_review_verification_recorded', {
                deliveryId: input.deliveryId,
                verifier: r.verification.kind,
                pass: r.verification.pass,
              });
              hooks?.onVerification?.({ ...verification });
            }
            return { resultText: r.text };
          } catch {
            // toolExec must NEVER throw into the reviewer loop (it awaits this
            // directly). Degrade to diff-only on any sandbox-tool failure.
            return {
              resultText:
                '[Tool Result] Sandbox tool failed — investigate via GitHub tools and the diff instead.',
            };
          }
        }
        return {
          resultText: `[Tool Error] ${toolCall.call.tool} is unavailable in automated PR review (GitHub read tools only).`,
        };
      },
      detectAllToolCalls: detectors.detectAllToolCalls,
      detectAnyToolCall: detectors.detectAnyToolCall,
      // No web-search backend in the webhook DO — omit the Web tool from the
      // prompt entirely so the model never attempts an unavailable tool.
      webSearchToolProtocol: '',
      webSearchAvailable: false,
      sandboxAvailable: sandboxToolsEnabled,
      sandboxToolNames: reviewSandboxToolNames(Boolean(reviewCommands.tests)),
      resumeState: hooks?.resumeState,
      // Verify-before-clean-pass gate: a zero-findings review with an
      // available sandbox and no verifier run gets one bounded nudge to run
      // typecheck/tests (or stand by its conclusion — the second completion
      // is accepted and the check-run labels it unverified). Runtime-tracked
      // via `verification`, so a cooperative-sounding claim without a real
      // tool run cannot satisfy it.
      completionGate: (result) => {
        if (!sandboxToolsEnabled) return null;
        if (result.comments.length > 0) return null;
        const ran =
          verification.typecheck !== 'not_run' ||
          verification.tests === 'pass' ||
          verification.tests === 'fail';
        if (ran) return null;
        log('info', 'pr_review_verification_nudged', { deliveryId: input.deliveryId });
        return (
          'You are reporting zero findings without having run any verification tool. ' +
          `Run the typecheck${reviewCommands.tests ? ' and test' : ''} tool${reviewCommands.tests ? 's' : ''} against the checked-out PR head, review the output, then emit ${'[REVIEW_COMPLETE]'} again — with any findings the verifier surfaces, or the same clean result if it passes. ` +
          'If you have a concrete reason verification cannot run, state it and re-emit; the review will be marked unverified.'
        );
      },
    },
    { onStatus: () => {}, signal, onRoundState: hooks?.onRoundState },
  ).finally(async () => {
    // Best-effort teardown on success, error, AND abort. Considers the
    // provision promise, not a snapshot var — with the eager warm-up a
    // provision can still be in flight when a fast-failing review ends. But
    // an in-flight provision must NOT hold the already-computed result: its
    // create/verify route awaits are unbounded, so a wedged sandbox create
    // would turn a finished diff-only review into a stalled one (Codex P2,
    // PR #1391). A settled provision keeps the awaited cleanup (the
    // pre-warm-up critical path); a pending one is chased detached —
    // cleanup never throws, and the 1h idle reaper is the backstop if the
    // DO retires before the chase lands.
    reviewEnded = true;
    if (!sandboxProvisionPromise) return;
    const provisionPromise = sandboxProvisionPromise;
    const PENDING = Symbol('pending');
    // Race subscription order makes this deterministic: a settled provision
    // resolves the race with its sandbox; only a still-pending one yields
    // the sentinel.
    const settled = await Promise.race([provisionPromise, Promise.resolve(PENDING)]);
    if (settled === PENDING) {
      void provisionPromise.then((sb) => (sb ? cleanupReviewSandbox(env, sb) : undefined));
      return;
    }
    if (settled) await cleanupReviewSandbox(env, settled);
  });
  if (signal.aborted) throw new Error('aborted');

  // Attach the runtime verification record before ANY return path — the
  // check-run policy labels clean passes off it, and the head-advanced /
  // degraded exits still persist the result for cross-review memory.
  result.verification = { ...verification };

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

  // A degraded result (fallback path — no structured [REVIEW_COMPLETE]
  // output; zero findings by construction) is not a review. Posting it put
  // mid-investigation narration on PRs #905/#906 as the review body; even
  // the neutral fallback line is noise on the PR. Don't post — the check-run
  // lifecycle reports it as `neutral`/"Review incomplete" instead of a
  // clean pass, which is where the signal belongs.
  if (result.degraded) {
    log('warn', 'pr_review_degraded_not_posted', {
      deliveryId: input.deliveryId,
      repo: input.repoFullName,
      pr: input.prNumber,
      summaryPreview: result.summary.slice(0, 140),
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

  // Opt-in gating verdict: a blocking (critical) finding on a gating repo. The
  // single "Push review" check-run is now created and finalized by the DO
  // lifecycle (which turns this into a `failure` conclusion); the executor only
  // reports whether the verdict gates, so the recorded outcome + event reflect
  // it. No separate check-run POST here — that produced a duplicate check.
  const gated =
    repoGatingEnabled(input.repoFullName, env.PR_REVIEW_GATING_REPOS) &&
    result.comments.some((c) => c.severity === 'critical');

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
