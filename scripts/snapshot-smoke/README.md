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
| **3** | Coder-job **mid-run resume**: kill a sandbox while a job runs → DO restores the latest checkpoint into a fresh sandbox and continues | partial — `coder-resume-smoke.mjs` drives the seed sandbox + job + SSE; the kill step still depends on the runbook below | #649/#650 |

Layer 3 needs a real model-driven Coder job (model calls, the `CoderJob`
Durable Object, SSE) so it ships as a driver + runbook pair rather than a
pure assertion script. See "Layer 3" below for the live-test status, the
known runtime gap, and the workaround procedure.

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
| `PUSH_SMOKE_DEPLOYMENT_TOKEN` | unset | Sent as `X-Push-Deployment-Token`. **Required for a private deployment** (Worker has `PUSH_DEPLOYMENT_TOKEN` set) — otherwise every route 401s with `DEPLOYMENT_AUTH_REQUIRED`. |

> **Private deployment:** if the Worker sets `PUSH_DEPLOYMENT_TOKEN`, source it without
> echoing the value, e.g. `export PUSH_SMOKE_DEPLOYMENT_TOKEN="$(grep '^PUSH_DEPLOYMENT_TOKEN=' .dev.vars | cut -d= -f2- | tr -d '"\r')"`.

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
PUSH_SMOKE_DEPLOYMENT_TOKEN="$(grep ^PUSH_DEPLOYMENT_TOKEN= .dev.vars | cut -d= -f2- | tr -d '"\r')" \
node scripts/snapshot-smoke/coder-resume-smoke.mjs
```

The script asserts only what SSE shows (kill fired, terminal `job.completed`
vs `job.failed`). Structured-log corroboration (`coder_checkpoint_captured`,
`coder_job_resumed`, `coder_resume_restore_failed`) is read from a parallel
`wrangler tail push --format json` — wrangler buffers events with a ~20-30s
lag, so in-driver real-time polling races a fast job. Run the tail in a
separate process and read the events post-hoc.

### Status (2026-05-25, live prod test)

| Component | Result |
|---|---|
| `captureCheckpoint` runs at the round-5 cadence and writes to R2 | ✅ — three captures observed for one 67s/15-round run, at rounds 5/10/15 |
| `coder_checkpoint_captured` structured log on success | ✅ — added in this revision (symmetric to `coder_checkpoint_failed`); deployed |
| `MAX_JOB_RESUMES = 2` bound | not yet exercised — needs a kill method that triggers resume |
| **`coder_job_resumed` after `/api/sandbox-cf/cleanup` kill** | ❌ — **runbook's documented kill method does NOT trigger resume on the deployed runtime** (see below) |

### Known gap — `/cleanup` doesn't surface as `SANDBOX_UNREACHABLE`

`lib/coder-agent.ts` raises `SandboxUnreachableError` only after
`SANDBOX_LOSS_THRESHOLD = 2` consecutive tool calls return
`structuredError.type === 'SANDBOX_UNREACHABLE'`. The DO's `runLoop` catches
that exception and drives resume.

After `POST /api/sandbox-cf/cleanup` succeeds, the next sandbox tool call
hits the owner-token gate before reaching the route handler. The gate's
`verifySandboxOwnerToken` calls `sandbox.exec(...)` on the (now-destroyed)
container, hits a "no such" classification, and returns `404 NOT_FOUND`
(`worker-cf-sandbox.ts` line ~1716). `coder-job-executor-adapter.ts` passes
that code straight through:

```ts
structuredError: { type: err.code ?? 'SANDBOX_UNREACHABLE', ... }
```

So the executed-tool result carries `errorType: 'NOT_FOUND'`, not
`'SANDBOX_UNREACHABLE'`. The coder-agent's loss counter never increments,
`SandboxUnreachableError` never throws, and the DO never enters the resume
path. The model just sees repeated "[Tool Error] NOT_FOUND" results, gives
up after a few rounds, and produces a partial-completion summary like
*"I encountered a sandbox failure during the task."*

The resume path is wired correctly for INFRASTRUCTURE-LEVEL sandbox death
(container OOM, edge deploy, RPC throw without an error code) — which is
also the realistic production scenario. But the runbook-documented
`/api/sandbox-cf/cleanup` kill method tests only the failure-tolerance of
the model, not the resume code.

**Proposed fix (single PR, narrow):** in
`app/src/worker/coder-job-executor-adapter.ts`, map `NOT_FOUND` returned
from the auth gate (and the equivalent classifier in the `catch` arm) to
`SANDBOX_UNREACHABLE` for the kernel's `structuredError.type`. The
semantics are identical from the loop's perspective ("the sandbox is gone
from my point of view"), and the auth gate is the ONLY public path that
returns `NOT_FOUND` for a destroyed sandbox — so the blast radius is small.

Until that ships, Layer 3 happy-path live verification needs the second
kill method from the original runbook: **destroy the container from the
Cloudflare dashboard** (or wait for natural infra death). The
`coder-resume-smoke.mjs` driver above still produces the seed sandbox +
job; the kill step just has to come from outside the public API.

### Procedure (current, with workaround)

1. Run `coder-resume-smoke.mjs` with `PUSH_SMOKE_EXTERNAL_KILL=1`. The script
   skips the auto-kill timer, prints the `sandboxId` + `jobId`, and waits on
   the SSE stream for the terminal event. The pass criterion in this mode
   relaxes to "any clean `job.completed`" — since you control the kill, the
   script can't distinguish kill-then-resume from natural-completion-no-kill,
   so corroboration shifts to the parallel `wrangler tail` (step 4).
2. Wait for `coder_checkpoint_captured` in a parallel
   `wrangler tail push --format json` stream before proceeding (round 5 is
   the first cadence boundary; on kimi-k2.6 + the bundled palette task
   that's ~25-40s into the run).
3. **Kill the sandbox at the infrastructure level.** In the Cloudflare
   dashboard: Workers → push → Sandbox container → Destroy. This produces
   the RPC-throw failure mode that maps to `SANDBOX_UNREACHABLE`.
4. **Confirm resume.** In the parallel `wrangler tail`, expect:
   - `coder_job_resumed` — restored from checkpoint, continuing (success).
   - `coder_resume_restore_failed` — restore returned an error.
5. **Pass criteria:** same `jobId`, new `sandboxId` in the `coder_job_resumed`
   log line, and `job.completed` (not `job.failed`) lands on the SSE stream.

### Procedure (post-fix, when `NOT_FOUND`→`SANDBOX_UNREACHABLE` mapping ships)

The `coder-resume-smoke.mjs` driver's default `killDelayMs=45000` /
`/api/sandbox-cf/cleanup` kill path becomes the end-to-end signal:
`job.completed` after the kill ⇒ the DO restored from checkpoint and the
loop continued.

### #651 unhappy-path / UI toast

Verifying the #651 restore-failure toast requires a browser session
(deferred). Layer 2 above already asserts the backend codes that trigger
the toast (`403 AUTH_FAILURE`, `404 SNAPSHOT_NOT_FOUND`), so the missing
piece is purely the UI side.
