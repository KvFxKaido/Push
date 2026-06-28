/**
 * Reachability spike (flag-gated) for giving the autonomous PR reviewer
 * repo-wide read-only grep via a sandbox.
 *
 * The review Durable Object reviews from the GitHub-API diff only today
 * (`pr-review-job-do.ts` `toolExec` is GitHub-read-only). The intended follow-up
 * provisions a sandbox with the PR head checked out and wires
 * `sandbox_search`/`sandbox_read_file` into the reviewer's tool loop so it can
 * trace a symbol across files (the gap that let the #1219 normalizer strip slip
 * through review). Before building that, three DO-runtime unknowns need
 * confirming on a real PR — none are exercisable offline:
 *
 *   1. Reachability. `sandboxFetch` builds RELATIVE URLs (`resolveApiUrl`), which
 *      a Worker cannot fetch — so the DO must hit an ABSOLUTE origin. This probe
 *      fetches `${origin}/api/sandbox-cf/*` directly to confirm the DO can reach
 *      the sandbox routes at all.
 *   2. Checkout + cold start. Whether `gitCheckout` of the PR head succeeds with
 *      the installation token, and how long cold start actually takes.
 *   3. Cross-fork coverage. A fork PR's head ref lives in the fork, not the base
 *      repo, so a base-repo checkout of `headRef` is expected to FAIL — recorded
 *      via `isCrossFork`, not hidden.
 *
 * It runs create -> one read-only grep (`exec`) -> cleanup, emits one structured
 * log per leg (so the first real run says exactly which leg works), and NEVER
 * throws into the review path. Gated by `PUSH_REVIEW_SANDBOX_SPIKE` so it is
 * inert in normal operation. Delete once the full integration lands.
 */

export interface ReviewSandboxSpikeInput {
  /** Absolute origin the DO can reach (e.g. the public Worker URL). */
  origin: string;
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

async function postJson(
  url: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let json: Record<string, unknown> | null = null;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON body (e.g. an HTML error page from a misrouted origin) — the
      // status code alone still tells us whether the route was reachable.
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

const okStatus = (s: number): boolean => s >= 200 && s < 300;

export async function runReviewSandboxReachabilitySpike(
  input: ReviewSandboxSpikeInput,
): Promise<void> {
  const base = `${input.origin.replace(/\/+$/, '')}/api/sandbox-cf`;
  const startedAt = Date.now();
  let sandboxId = '';
  let ownerToken = '';
  let createOk = false;
  let searchOk = false;
  let cleanupOk = false;

  // Leg 1 — create + checkout (the cold-start path: clone depth=1 + token mint).
  try {
    const t0 = Date.now();
    const { status, json } = await postJson(
      `${base}/create`,
      { repo: input.repoFullName, branch: input.headRef, github_token: input.githubToken },
      180_000,
    );
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

  // Leg 2 — one read-only grep over the checked-out tree. `|| true` keeps grep's
  // exit-1-on-no-match from reading as a failure; `import` reliably matches any
  // populated TS checkout, so a non-empty stdout confirms the clone landed.
  if (createOk) {
    try {
      const t0 = Date.now();
      const { status, json } = await postJson(
        `${base}/exec`,
        {
          sandbox_id: sandboxId,
          owner_token: ownerToken,
          command: 'grep -rIl "import" /workspace --include="*.ts" | head -3 || true',
          timeout_ms: 30_000,
        },
        45_000,
      );
      const exitCode = typeof json?.exit_code === 'number' ? json.exit_code : undefined;
      searchOk = okStatus(status) && exitCode === 0;
      log('review_sandbox_spike_search', {
        ok: searchOk,
        httpStatus: status,
        ms: Date.now() - t0,
        exitCode,
        matchedSomething: typeof json?.stdout === 'string' && json.stdout.trim().length > 0,
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
      const { status } = await postJson(
        `${base}/cleanup`,
        { sandbox_id: sandboxId, owner_token: ownerToken },
        30_000,
      );
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

  log('review_sandbox_spike_done', {
    reachable: createOk,
    createOk,
    searchOk,
    cleanupOk,
    totalMs: Date.now() - startedAt,
    isCrossFork: input.isCrossFork,
  });
}
