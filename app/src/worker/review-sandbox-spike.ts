import type { Env } from './worker-middleware';
import { dispatchSandboxRouteInternal } from './worker-cf-sandbox';

/**
 * Reachability spike (flag-gated) for giving the autonomous PR reviewer
 * repo-wide read-only grep via a sandbox.
 *
 * The review Durable Object reviews from the GitHub-API diff only today
 * (`pr-review-job-do.ts` `toolExec` is GitHub-read-only). The intended follow-up
 * provisions a sandbox with the PR head checked out and wires
 * `sandbox_search`/`sandbox_read_file` into the reviewer's tool loop so it can
 * trace a symbol across files (the gap that let the #1219 normalizer strip slip
 * through review). Before building that, the DO-runtime unknowns need confirming
 * on a real PR — none are exercisable offline:
 *
 *   1. Provisioning path. The DO must NOT use the public `/api/sandbox-cf/*` HTTP
 *      surface — it's gated for browser sessions (session auth + Origin/Referer +
 *      rate-limit) and would reject a DO outright. This probe calls the internal
 *      `dispatchSandboxRouteInternal` entry directly with the DO's `env`.
 *   2. Checkout landed. `routeCreate` returns HTTP 200 + a `sandbox_id` once the
 *      sandbox exists; on its own that does NOT prove the clone populated the
 *      workspace (whether the SDK's `gitCheckout` throws on a missing ref is
 *      itself unverified). So the authoritative signal is the grep leg actually
 *      finding files (`checkoutLanded`), not the create status.
 *   3. Cross-fork. A fork PR's head ref lives in the fork, not the base repo, so
 *      a base-repo checkout is expected to leave an empty workspace —
 *      `checkoutLanded: false` with `isCrossFork: true` is the recorded outcome.
 *
 * Runs create -> one read-only grep (`exec`) -> cleanup, emits one structured
 * log per leg (so the first real run says exactly which leg works), and NEVER
 * throws into the review path. Gated by `PUSH_REVIEW_SANDBOX_SPIKE` so it is
 * inert in normal operation. Delete once the full integration lands.
 */

export interface ReviewSandboxSpikeInput {
  env: Env;
  repoFullName: string;
  headRef: string;
  /** GitHub installation token (read-only; stripped from .git/config on clone). */
  githubToken: string;
  isCrossFork: boolean;
}

function log(event: string, ctx: Record<string, unknown>): void {
  // Worker surface → console.log per the structured-log convention.
  console.log(JSON.stringify({ level: 'info', event, ...ctx }));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

const okStatus = (s: number): boolean => s >= 200 && s < 300;

async function callRoute(
  env: Env,
  route: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await dispatchSandboxRouteInternal(env, route, body);
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON body — the status alone still tells us the route ran.
  }
  return { status: res.status, json };
}

export async function runReviewSandboxReachabilitySpike(
  input: ReviewSandboxSpikeInput,
): Promise<void> {
  const { env } = input;
  const startedAt = Date.now();
  let sandboxId = '';
  let ownerToken = '';
  let createOk = false;
  let searchOk = false;
  let checkoutLanded = false;
  let cleanupOk = false;

  // Leg 1 — provision via the internal entry (clone depth=1 + token mint).
  try {
    const t0 = Date.now();
    const { status, json } = await callRoute(env, 'create', {
      repo: input.repoFullName,
      branch: input.headRef,
      github_token: input.githubToken,
    });
    sandboxId = typeof json?.sandbox_id === 'string' ? json.sandbox_id : '';
    ownerToken = typeof json?.owner_token === 'string' ? json.owner_token : '';
    createOk = okStatus(status) && sandboxId.length > 0;
    log('review_sandbox_spike_create', {
      ok: createOk,
      httpStatus: status,
      ms: Date.now() - t0,
      hasSandboxId: sandboxId.length > 0,
      isCrossFork: input.isCrossFork,
      error: createOk ? undefined : typeof json?.error === 'string' ? json.error : 'no_sandbox_id',
    });
  } catch (err) {
    log('review_sandbox_spike_create', {
      ok: false,
      error: errMsg(err),
      isCrossFork: input.isCrossFork,
    });
  }

  // Leg 2 — one read-only grep. This is the authoritative "checkout landed"
  // probe: `routeExec` runs `cd /workspace && …`, and `import` matches any
  // populated TS checkout, so a non-empty stdout proves the clone actually
  // populated the tree (create returning 200 does not). `|| true` keeps grep's
  // exit-1-on-no-match from reading as a transport failure.
  if (createOk) {
    try {
      const t0 = Date.now();
      const { status, json } = await callRoute(env, 'exec', {
        sandbox_id: sandboxId,
        owner_token: ownerToken,
        command: 'grep -rIl "import" /workspace --include="*.ts" | head -3 || true',
        timeout_ms: 30_000,
      });
      const exitCode = typeof json?.exit_code === 'number' ? json.exit_code : undefined;
      checkoutLanded = typeof json?.stdout === 'string' && json.stdout.trim().length > 0;
      searchOk = okStatus(status) && exitCode === 0;
      log('review_sandbox_spike_search', {
        ok: searchOk,
        httpStatus: status,
        ms: Date.now() - t0,
        exitCode,
        checkoutLanded,
        error: searchOk ? undefined : typeof json?.error === 'string' ? json.error : undefined,
      });
    } catch (err) {
      log('review_sandbox_spike_search', { ok: false, error: errMsg(err) });
    }
  }

  // Leg 3 — always tear down what we created so a failed spike doesn't leak a
  // sandbox that lingers until the 1h idle reclaim.
  if (sandboxId) {
    try {
      const t0 = Date.now();
      const { status } = await callRoute(env, 'cleanup', {
        sandbox_id: sandboxId,
        owner_token: ownerToken,
      });
      cleanupOk = okStatus(status);
      log('review_sandbox_spike_cleanup', {
        ok: cleanupOk,
        httpStatus: status,
        ms: Date.now() - t0,
      });
    } catch (err) {
      log('review_sandbox_spike_cleanup', { ok: false, error: errMsg(err) });
    }
  }

  // `checkoutLanded` is the headline result — it answers unknowns #2 and #3.
  // `reachable` (create succeeded) only confirms the internal provisioning path.
  log('review_sandbox_spike_done', {
    reachable: createOk,
    createOk,
    searchOk,
    checkoutLanded,
    cleanupOk,
    totalMs: Date.now() - startedAt,
    isCrossFork: input.isCrossFork,
  });
}
