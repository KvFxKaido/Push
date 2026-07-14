import type { ReviewCheckRunSummary, ReviewVerification } from '../../../lib/provider-contract';
import { type CheckRunForSha, fetchCheckRunsForSha } from '../lib/github-tools';

/**
 * The reviewer's verification, sourced from the check runs GitHub already produced
 * for the head SHA (decision doc §9a) instead of re-run inside the reviewer's own
 * sandbox.
 *
 * CI ran those exact commands, on that exact commit, on real hardware, with a warm
 * cache, in ~90s. The sandbox path re-ran them on a half-vCPU container that
 * `Dockerfile.sandbox` already documents as getting OOM-killed by repo test suites,
 * and we were reading the corpse as flakiness. This reads the verdict the change
 * actually merges on.
 */

/**
 * Conclusions that mean the check FAILED. A conservative list on purpose: anything
 * not named here is treated as "no failure", so a conclusion GitHub adds later
 * cannot silently start failing every review.
 */
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required']);

/** One source of truth for aggregation and human-facing failed-check names. */
export function isFailingReviewCheckConclusion(conclusion: string | null): boolean {
  return conclusion != null && FAILING_CONCLUSIONS.has(conclusion);
}

/**
 * Conclusions that are terminal but carry NO verdict. A skipped or cancelled check
 * neither passes nor fails — counting it as a pass would let a repo that cancels CI
 * launder a green verification.
 */
const NO_VERDICT_CONCLUSIONS = new Set(['neutral', 'skipped', 'cancelled', 'stale']);

/** How long to wait for in-flight CI before recording `blocked`. */
export const REVIEW_CI_DEADLINE_MS = 300_000;
/** Gap between polls while CI is still in flight. */
export const REVIEW_CI_POLL_INTERVAL_MS = 15_000;

function log(level: 'info' | 'warn', event: string, ctx: Record<string, unknown>): void {
  // Worker surface: stdout IS the logging pipeline here (CLAUDE.md, "Stream choice
  // is surface-dependent").
  console.log(JSON.stringify({ level, event, ...ctx }));
}

const toSummary = (r: CheckRunForSha): ReviewCheckRunSummary => ({
  name: r.name,
  conclusion: r.conclusion,
  ...(r.detailsUrl ? { detailsUrl: r.detailsUrl } : {}),
});

export interface ReviewCiVerificationOptions {
  repoFullName: string;
  headSha: string;
  token: string;
  /**
   * The reviewer's OWN check run, which MUST be excluded or it waits on itself.
   *
   * `runReview` opens an `in_progress` "Push review" check on the head SHA before the
   * executor starts, so the reviewer is itself one of this SHA's check runs for the
   * entire review. A verifier that waited for "all check runs on this SHA" would
   * block to the deadline and report `blocked` on EVERY review that publishes a
   * visible check — i.e. the normal case — and the failure would look exactly like
   * the sandbox failure §9a exists to fix. (Codex, PR #1469, caught in the design.)
   */
  selfCheckRunId: number | null;
  /**
   * Our owning GitHub App id, excluded defensively: a rerun or a superseded attempt
   * can leave a SECOND `push-agent` check on the same SHA that `selfCheckRunId` does
   * not name. Never filter by check-run NAME — `REVIEW_CHECK_NAME` is user-visible
   * text and a repo can mint a check that collides with it.
   */
  selfAppId: number | null;
  deliveryId: string;
  signal?: AbortSignal;
  /** Test seams. */
  deadlineMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchCheckRuns?: typeof fetchCheckRunsForSha;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read the head SHA's check runs and reduce them to one verdict.
 *
 * Polls while CI is still in flight, and stops for a terminal condition on EVERY
 * arm — deadline, abort, unreadable API — never only on the happy path (CLAUDE.md,
 * "`await` in a loop"). Never throws: an unreadable API records `blocked`, because
 * "we could not see CI" is a fact about us, not a verdict on the code.
 */
export async function fetchReviewCiVerification(
  opts: ReviewCiVerificationOptions,
): Promise<ReviewVerification> {
  const {
    repoFullName,
    headSha,
    token,
    selfCheckRunId,
    selfAppId,
    deliveryId,
    signal,
    deadlineMs = REVIEW_CI_DEADLINE_MS,
    pollIntervalMs = REVIEW_CI_POLL_INTERVAL_MS,
    now = Date.now,
    sleep = defaultSleep,
    fetchCheckRuns = fetchCheckRunsForSha,
  } = opts;

  const deadline = now() + deadlineMs;
  const auth = { token };
  let lastPending: ReviewCheckRunSummary[] = [];
  let emptyObservations = 0;

  for (;;) {
    if (signal?.aborted) {
      return blocked('The review was aborted before CI completed.', lastPending, {
        deliveryId,
        repo: repoFullName,
        sha: headSha,
        reason: 'aborted',
      });
    }

    let all: CheckRunForSha[] | null;
    try {
      all = await fetchCheckRuns(repoFullName, headSha, auth);
    } catch {
      // Keep the injected seam honest too: the production helper returns null,
      // but an unexpected implementation/rejection must not fail the whole review.
      all = null;
    }
    // Abort may have landed while the GitHub request was in flight.
    if (signal?.aborted) continue;
    if (all === null) {
      return blocked("Push could not read this commit's check runs from GitHub.", lastPending, {
        deliveryId,
        repo: repoFullName,
        sha: headSha,
        reason: 'check_runs_unreadable',
      });
    }

    // Exclude ourselves BEFORE anything else — by id (exact) and by owning app id
    // (defensive). See `selfCheckRunId` / `selfAppId`.
    const runs = all.filter(
      (r) =>
        !(selfCheckRunId != null && r.id === selfCheckRunId) &&
        !(selfAppId != null && r.appId === selfAppId),
    );

    if (runs.length === 0) {
      if (lastPending.length > 0) {
        return blocked(
          'CI check runs disappeared while Push was waiting for them to complete.',
          lastPending,
          {
            deliveryId,
            repo: repoFullName,
            sha: headSha,
            reason: 'checks_disappeared',
          },
        );
      }
      // Check suites are registered asynchronously from the PR webhook. Give an
      // initially empty set one poll interval to appear before deciding the repo has
      // no CI; otherwise a fast review can race Actions startup into `unavailable`.
      const remaining = deadline - now();
      if (emptyObservations === 0 && remaining > 0) {
        emptyObservations += 1;
        await sleep(Math.min(pollIntervalMs, remaining));
        continue;
      }
      // Still empty after the discovery poll (or no time remained). Nothing produced
      // a verdict — that is `unavailable`, not `blocked`.
      log('info', 'pr_review_ci_verification_unavailable', {
        deliveryId,
        repo: repoFullName,
        sha: headSha,
        totalChecks: all.length,
      });
      return { ci: 'unavailable', checks: [] };
    }

    const failed = runs.filter((r) => isFailingReviewCheckConclusion(r.conclusion));
    // Short-circuit: a failure is terminal regardless of what is still running.
    // Waiting out the remaining checks could not change the verdict, and the
    // reviewer would burn its deadline to arrive at the same `fail`.
    if (failed.length > 0) {
      log('warn', 'pr_review_ci_verification_failed', {
        deliveryId,
        repo: repoFullName,
        sha: headSha,
        failedChecks: failed.map((r) => r.name),
      });
      return { ci: 'fail', checks: runs.map(toSummary) };
    }

    const pending = runs.filter((r) => r.status !== 'completed');
    if (pending.length === 0) {
      // Everything completed and nothing failed. A check that ended without a real
      // conclusion (skipped/cancelled/neutral) is not a pass — if that is ALL there
      // is, nothing verified anything and saying `pass` would be a lie.
      const decisive = runs.filter(
        (r) => r.conclusion != null && !NO_VERDICT_CONCLUSIONS.has(r.conclusion),
      );
      if (decisive.length === 0) {
        return blocked(
          'Every check run on this commit ended without a decisive conclusion.',
          runs.map(toSummary),
          { deliveryId, repo: repoFullName, sha: headSha, reason: 'no_decisive_checks' },
        );
      }
      log('info', 'pr_review_ci_verification_passed', {
        deliveryId,
        repo: repoFullName,
        sha: headSha,
        passedChecks: decisive.map((r) => r.name),
      });
      return { ci: 'pass', checks: runs.map(toSummary) };
    }

    lastPending = runs.map(toSummary);

    // Still in flight. Stop at the deadline rather than at "CI eventually finishes" —
    // CI can queue behind a busy runner pool for longer than a review lives.
    const remaining = deadline - now();
    if (remaining <= 0) {
      return blocked(
        `CI had not completed for this commit within ${Math.round(deadlineMs / 1000)}s (still running: ${pending
          .map((r) => r.name)
          .join(', ')}).`,
        lastPending,
        {
          deliveryId,
          repo: repoFullName,
          sha: headSha,
          reason: 'deadline',
          pendingChecks: pending.map((r) => r.name),
        },
      );
    }
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}

function blocked(
  reason: string,
  checks: ReviewCheckRunSummary[],
  ctx: Record<string, unknown>,
): ReviewVerification {
  log('warn', 'pr_review_ci_verification_blocked', ctx);
  return { ci: 'blocked', blockedReason: reason, checks };
}
