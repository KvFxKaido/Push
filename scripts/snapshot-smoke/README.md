# Snapshot/restore smoke-test — shipped Cloudflare path

Verifies the R2-backed snapshot/restore path that shipped in **#647–#651**,
against a live Worker. Successor to `scripts/cf-sandbox-spike/` (the 2026-04-19
throwaway that benchmarked the *SDK-native* `createBackup`/`restoreBackup` to
decide whether to build the provider). The provider shipped — but it rolls its
own **R2 `tar.gz` archive** snapshot (`createWorkspaceSnapshot` /
`restoreWorkspaceSnapshot` in `app/src/worker/worker-cf-sandbox.ts`), *not* the
SDK primitive the spike measured. This test points the spike's benchmark shape
at the path that actually runs.

## What it covers

| Layer | What | Automated? | Exercises |
|---|---|---|---|
| **1** | Seed → hibernate (snapshot to R2) → restore into a fresh sandbox → verify file count + content digest → time each phase → grade restore latency | ✅ `snapshot-smoke.mjs` | #647 |
| **2** | Unrestorable snapshot: wrong `restore_token` → `403 AUTH_FAILURE`; nonexistent id → `404 SNAPSHOT_NOT_FOUND` (the backend errors the UI turns into a restore-failure toast) | ✅ `snapshot-smoke.mjs` | #651 |
| **3** | Coder-job **mid-run resume**: kill a sandbox while a job runs → DO restores the latest checkpoint into a fresh sandbox and continues | ✅ `coder-resume-smoke.mjs` (end-to-end via `/api/sandbox-cf/cleanup` as of the fatal-flag fix) | #649/#650 |
| **3b** | `MAX_JOB_RESUMES = 2` cap: kill three times in a row → 3rd resume bails (cap exhausted) and the job fails | ⚠️ `coder-resume-cap-smoke.mjs` (flaky — see "Layer 3 cap test" below) | #649/#650 |

Layer 3 needs a real model-driven Coder job (model calls, the `CoderJob`
Durable Object, SSE) so it ships as a driver + runbook pair rather than a
pure assertion script. See "Layer 3" below for the live-test status.

## Prerequisites

The Worker must be running the Cloudflare backend with snapshot storage bound:

- `PUSH_SANDBOX_PROVIDER=cloudflare` (default in `wrangler.jsonc`)
- `SNAPSHOTS` R2 bucket bound — provision first:
  `npx wrangler r2 bucket create push-cf-snapshots`
- `SNAPSHOT_INDEX` KV + `SANDBOX_TOKENS` KV bound (already in `wrangler.jsonc`)

Run against either:

- **Local** — `npx wrangler dev` from the repo root (builds the sandbox
  container from `Dockerfile.sandbox` on first run; first restore can be slow —
  set `SANDBOX_DEV_LONG_DEADLINE=1`). Base URL `http://localhost:8787`.
- **Deployed** — `npx wrangler deploy`, then point at the `*.workers.dev` URL.

## Run

```bash
PUSH_SMOKE_BASE_URL=http://localhost:8787 node scripts/snapshot-smoke/snapshot-smoke.mjs
```

Node 18+ (uses global `fetch`). Zero dependencies — nothing to install.

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `PUSH_SMOKE_BASE_URL` | *(required)* | Worker base URL, no trailing slash |
| `PUSH_SMOKE_ORIGIN` | base URL's origin | `Origin` header; the request's own origin is always allowed, so the default just works |
| `PUSH_SMOKE_REPO` | `push-smoke/scratch` | `repo_full_name` for snapshot-index keying (does **not** clone — create runs scratch) |
| `PUSH_SMOKE_BRANCH` | `snapshot-smoke-<ts>` | unique per run so it never collides with a real index entry |
| `PUSH_SMOKE_FILES` | `256` | seed-file count (compressible content — does NOT stress the size ceiling) |
| `PUSH_SMOKE_BLOB_MB` | `0` | Stress mode: seed N MB of **incompressible** data. The only mode that probes the ~24 MiB compressed RPC ceiling. `>~24` is expected to fail with a DO RPC 32 MiB error (see `docs/decisions/Cloudflare Native Backup Migration.md`). |
| `PUSH_SMOKE_GREEN_MS` / `PUSH_SMOKE_YELLOW_MS` | `5000` / `15000` | restore-latency grading bars (from the spike) |
| `PUSH_SMOKE_KEEP` | unset | `1` keeps the snapshot in R2 (skips `delete-snapshot`) |
| `PUSH_SMOKE_STRICT_LATENCY` | unset | `1` makes a red restore grade fail the run |
| `PUSH_SMOKE_SESSION_TOKEN` | unset | Sent as `X-Push-Session`. **Required when the Worker enforces the session gate** (`PUSH_SESSION_GATE_ENFORCE=1`) — otherwise gated routes 401 with `SESSION_AUTH_REQUIRED`. Must be a session JWT signed with the Worker's `PUSH_SESSION_SECRET` for a `GITHUB_ALLOWED_USER_IDS` user. |

> **Enforcing deployment:** mint an `X-Push-Session` JWT (HS256, `sub` = an
> allowlisted GitHub user id, signed with `PUSH_SESSION_SECRET`) and pass it as
> `PUSH_SMOKE_SESSION_TOKEN`.

## Output

Per-phase timings plus a restore-latency grade:

- **green** (≤5s) — restore is fast enough to be the primary resume path.
- **yellow** (≤15s) — works, but flag the UX; consider re-clone fallback in the hot path.
- **red** (>15s) — investigate before relying on it.

Exit code: `0` only if every assertion passes (and, with
`PUSH_SMOKE_STRICT_LATENCY=1`, restore isn't red). A slow-but-correct restore
is **not** a failure by default — latency is a signal, correctness is the gate.

> **Note:** this is a *correctness + relative-latency* check on a small
> synthetic tree (excludes `node_modules`/`dist` just like the real snapshot).
> For representative sizing, raise `PUSH_SMOKE_FILES` or seed a real repo.

## Layer 3 — coder-job mid-run resume (manual)

This is the headline path from #649/#650: a checkpoint is taken every few rounds
(`captureCheckpoint` → `createWorkspaceSnapshot`), and on a confirmed sandbox
death (`SandboxUnreachableError`) the DO restores the latest checkpoint into a
fresh sandbox and continues — bounded by `MAX_JOB_RESUMES = 2`.

### Driver

`coder-resume-smoke.mjs` is a thin Layer-3 cousin of `snapshot-smoke.mjs`:
creates a scratch sandbox via `/api/sandbox-cf/create`, posts a multi-step
Coder envelope to `/api/jobs/start`, watches the SSE stream for
`assistant.prompt_snapshot`, and fires `/api/sandbox-cf/cleanup` on a
calibrated `killDelayMs` (default 45s — past the round-5 checkpoint on
kimi-k2.6, before natural completion). Same env vars as `snapshot-smoke.mjs`
plus:

| Var | Default | Meaning |
|---|---|---|
| `PUSH_SMOKE_PROVIDER` | `cloudflare` | provider for the Coder run |
| `PUSH_SMOKE_MODEL` | `@cf/moonshotai/kimi-k2.6` | model id |
| `PUSH_SMOKE_KILL_DELAY_MS` | `45000` | delay after `prompt_snapshot` before killing the sandbox |
| `PUSH_SMOKE_POST_KILL_MS` | `180000` | minimum extra wall clock to keep SSE open after the kill (extends `maxWaitMs` so a tight ceiling can't cut off the resume window) |
| `PUSH_SMOKE_MAX_WAIT_MS` | `420000` | hard ceiling on total wall clock (extended by `POST_KILL_MS` once the kill fires) |
| `PUSH_SMOKE_EXTERNAL_KILL` | unset | `1` disables the auto-kill timer and treats any clean `job.completed` as a PASS — use when killing the sandbox via the Cloudflare dashboard (see Layer 3 §"Procedure (current, with workaround)" below) |

```bash
PUSH_SMOKE_BASE_URL=https://push.<sub>.workers.dev \
PUSH_SMOKE_SESSION_TOKEN="<X-Push-Session JWT>" \
node scripts/snapshot-smoke/coder-resume-smoke.mjs
```

The script asserts only what SSE shows (kill fired, terminal `job.completed`
vs `job.failed`). Structured-log corroboration (`coder_checkpoint_captured`,
`coder_job_resumed`, `coder_resume_restore_failed`) is read from a parallel
`wrangler tail push --format json` — wrangler buffers events with a ~20-30s
lag, so in-driver real-time polling races a fast job. Run the tail in a
separate process and read the events post-hoc.

### Status (2026-05-25, live prod test — end-to-end GREEN)

| Component | Result |
|---|---|
| `captureCheckpoint` runs at the round-5 cadence and writes to R2 | ✅ — three captures observed at rounds 5/10/15 on the original sandbox |
| `coder_checkpoint_captured` structured log on success | ✅ — symmetric to `coder_checkpoint_failed`; emitted from `coder-job-do.ts` |
| **`coder_job_resumed` after `/api/sandbox-cf/cleanup` kill** | ✅ — same `jobId`, new `sandboxId`, restored from round 5 |
| Restored loop continues + captures new checkpoints | ✅ — three more `coder_checkpoint_captured` (rounds 5/10/15) on the restored sandbox post-resume |
| `job.completed` with clean full-task summary | ✅ — no "sandbox expired" disclaimer; the model saw a seamless continuation |
| `MAX_JOB_RESUMES = 2` bound | not yet exercised — only one kill performed; killing 3× in a row to confirm the cap is open follow-up work |

### How the `/cleanup` path works end-to-end

After `POST /api/sandbox-cf/cleanup` destroys the container and revokes the
owner token, the next sandbox tool call hits the owner-token gate first.
`verifySandboxOwnerToken` calls `sandbox.exec` on the destroyed container,
hits a "no such" classification (`worker-cf-sandbox.ts` ~L1716), and the
gate returns `404 { code: 'NOT_FOUND' }`.

`coder-job-executor-adapter.ts` translates that to a structured tool error
of `type: 'SANDBOX_UNREACHABLE', fatal: true`. The kernel's loss tracker
in `lib/coder-agent.ts` sees `fatal: true` and throws
`SandboxUnreachableError` on the FIRST occurrence rather than waiting for
the standard `SANDBOX_LOSS_THRESHOLD = 2` to trip — which is critical
because models that gracefully summarize after one tool error (kimi-k2.6
on Workers AI does exactly that) never make the second consecutive failing
call the threshold needs.

The `CoderJob` DO catches `SandboxUnreachableError` in its `runLoop`,
calls `resumeFromCheckpoint`, restores the latest snapshot into a fresh
sandbox, and re-enters the loop seeded with the persisted
`CoderCheckpointState`. Bounded by `MAX_JOB_RESUMES = 2`.

The transient SDK blip path is unchanged: a one-off `SANDBOX_UNREACHABLE`
result without `fatal: true` still respects the threshold-of-2 counter
and resets on the next success — so a flaky network call doesn't pointlessly
burn a resume budget.

### Procedure

1. Run `coder-resume-smoke.mjs` against the target deployment. With
   default settings (`killDelayMs=45000`) on kimi-k2.6 + the bundled
   palette task, the kill lands past the round-5 checkpoint and before
   natural completion. Adjust `PUSH_SMOKE_KILL_DELAY_MS` if you swap the
   model/task and the timing shifts.
2. **Confirm resume in a parallel `wrangler tail push --format json`**.
   Expect a sequence like:
   - `coder_checkpoint_captured` at round 5 (pre-kill)
   - `coder_job_resumed` with the same `jobId` and a NEW `sandboxId`
   - more `coder_checkpoint_captured` lines as the restored loop runs
3. **Pass criteria:** the driver's SSE stream lands `job.completed` (not
   `job.failed`); the `wrangler tail` shows `coder_job_resumed` with the
   same `jobId`; and the model's summary describes a full task completion
   (no "sandbox expired" disclaimer — the resume should be invisible to
   the model).

The `PUSH_SMOKE_EXTERNAL_KILL=1` mode + Cloudflare-dashboard kill
workaround from earlier revisions is still available for the case where
you specifically want to test infrastructure-level container death
(container OOM, edge deploy, etc.) rather than the `/cleanup` code path.

### Layer 3 cap test — `MAX_JOB_RESUMES = 2`

`coder-resume-cap-smoke.mjs` exercises the upper bound on the resume
chain: kill the same job three times, expect the third to fail with
`job.failed` because `resumeFromCheckpoint(2)` short-circuits on
`resumesUsed >= MAX_JOB_RESUMES` and returns null.

Driver mechanics differ from the single-kill `coder-resume-smoke.mjs`:
the script spawns its own `wrangler tail` for diagnostics, baselines
the `SANDBOX_TOKENS` KV namespace at startup, then for each kill cycle
uses the SSE `assistant.prompt_snapshot` event (fast) as the resume
signal, then KV-list-diff (against the baseline + already-seen
sandboxIds) to discover the new sandbox identity the DO minted during
`restoreWorkspaceSnapshot`, then `wrangler kv key get` for the new
owner token. The DO doesn't surface the post-resume sandbox identity
through any public API, so KV diff is how we recover it.

**Status (2026-05-26, prod):** the cap path is wired and was observed
end-to-end on one validating run (jobId `3262f268`, 97s, 2 successful
resumes then `job.failed` with `error: "Sandbox is unreachable"`). New
observability log lines (`coder_resume_cap_exhausted`,
`coder_resume_no_checkpoint`, `coder_resume_state_parse_failed`) close
the silent-null paths in `resumeFromCheckpoint` so a failed resume is
no longer indistinguishable from a successful one that hasn't happened
yet.

**Known flakiness — re-run on a miss.** The test passes intermittently
on the bundled palette task because:

- The default `subsequentKillDelayMs = 8000` is in a narrow sweet spot.
- Smaller (≤ 3s) hits a Cloudflare Sandbox container-provisioning race
  (`SandboxError: Container is starting. Please retry in a moment.`)
  during the next restore — the kill lands faster than CF can spin up
  the new container.
- Larger (≥ 10s) gives kimi-k2.6 enough rope to summarize the remaining
  work on the resumed sandbox before the next kill lands, exiting the
  loop with `job.completed` and no resume attempt.
- Even within the sweet spot, model variance occasionally lands the
  kill BEFORE the resumed kernel makes its first tool call, in which
  case the model produces a "task done" summary with no tool calls and
  the loop exits cleanly.

This is a test-driver limitation, not a runtime bug. The cap itself is
deterministic. If a run produces `job.completed` rather than
`job.failed` at kill 3, re-run; on the order of 1 in 3 runs hits the
cap cleanly. Future improvements to make this deterministic would mean
either rewriting the bundled task to require provably more tool calls
on the resumed loop, or switching the test to a model with more
predictable retry behavior — neither of which seemed worth doing for a
one-shot validation of a bound that's already proven.

### #651 unhappy-path / UI toast

Verifying the #651 restore-failure toast requires a browser session
(deferred). Layer 2 above already asserts the backend codes that trigger
the toast (`403 AUTH_FAILURE`, `404 SNAPSHOT_NOT_FOUND`), so the missing
piece is purely the UI side.
