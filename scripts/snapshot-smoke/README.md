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
| **3** | Coder-job **mid-run resume**: kill a sandbox while a job runs → DO restores the latest checkpoint into a fresh sandbox and continues | ❌ manual (needs a live model-driven job) — see below | #649/#650 |

Layer 3 can't be scripted without driving a real Coder job (model calls, the
`CoderJob` Durable Object, SSE). It's a runbook, not a script.

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

**Procedure**

1. Start a Coder job long enough to checkpoint — a multi-round refactor task, on
   the Cloudflare backend. Note the `sandboxId` and `jobId`.
2. Wait for at least one checkpoint. Confirm via the job's SSE stream
   (`/api/coder-job/events?jobId=…`) or by grepping Worker logs
   (`npx wrangler tail`) for a checkpoint write before proceeding.
3. **Kill the sandbox mid-run.** Either:
   - `POST /api/sandbox-cf/cleanup` with that `sandbox_id` + its `owner_token`, or
   - destroy the container from the Cloudflare dashboard.
4. **Confirm resume.** In `wrangler tail`, expect:
   - `coder_job_resumed` — restored from checkpoint, continuing (success).
   - `coder_resume_restore_failed` — restore returned an error (this is the
     #651 path; after `MAX_JOB_RESUMES` or a hard failure the job fails and the
     **client surfaces the restore-failure toast**).
5. **Verify the #651 toast (UI).** Force the failure path: kill the sandbox
   *and* delete its checkpoint snapshot from R2 (or hit it with an unrestorable
   snapshot) so `resumeFromCheckpoint` returns null → the original failure
   stands → the web app shows the restore-failure toast. Layer 2 above already
   asserts the backend returns the error that triggers it.

**Pass criteria:** the job continues from the checkpointed round (not from
scratch) after the kill, with the same `jobId` and a *new* `sandboxId` in
`coder_job_resumed`; and the toast appears when resume is genuinely unrecoverable.
