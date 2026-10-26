# Cloudflare Sandbox SDK 1.0 Migration

**Status:** Current (partially implemented). **Production has run 1.0 since 2026-10-25**
(`@cloudflare/sandbox` 1.0.3, `app/src/worker/sandbox-do.ts`, a self-owned
`Dockerfile.sandbox`). Phases 1-5 shipped; the switch was forced early by a
branch build and deployed by hand (see "Production cutover"). Phase 6 cleanup
is open, and part of it is live-infra work this repo cannot verify - including
a leftover 0.12 container application that **keeps billing**. Drop the
qualifier when Phase 6 closes.

**Date:** 2026-10-24

**Related:**
- `app/src/worker/worker-cf-sandbox.ts` (the Cloudflare sandbox handler)
- `app/src/worker/snapshot-index.ts`
- `app/src/worker/coder-job-do.ts` (checkpoint and resume)
- `scripts/snapshot-smoke/` (the rehearsal harness)
- `docs/archive/decisions/Cloudflare Sandbox Provider Design.md`
- Cloudflare: [Migrate from Sandbox SDK 0.x](https://developers.cloudflare.com/sandbox/sdk/migrate/)

## Why this is a project, not a bump

Sandbox SDK 1.0 (Dependabot #1652) removes the `Sandbox` class and
`getSandbox()`. In 1.0 the app writes its own Durable Object, and that object
drives the container directly through `this.ctx.container`. Commands, files,
background processes, git checkout and directory backups all move into code
Push owns. The 0.12 container server is gone, and the image no longer derives
from `cloudflare/sandbox`.

Three facts shape the plan:

1. **The switch can't be undone.** The deploy that sets the class to
   `scheduling_policy: "durable_object"` is permanent. Cloudflare's docs say
   "a `wrangler rollback` to 0.12 either fails or deploys code that cannot
   start containers." Wrangler also refuses a multi-version deploy that mixes
   the two, so there's no gradual rollout.
2. **Merges deploy production.** Workers Builds deploys `main`, so merging the
   1.0 branch *is* the one-way switch, unless the deploy is taken off
   auto-deploy for that one change.
3. **There's time.** 0.x gets bug and security fixes until **2026-12-31**.
   Push is pinned to 0.12.14 for SDK and image together (#1673), which is the
   docs' required starting point.

## What Push uses (inventory, main @ 0.12.14)

| 0.12 surface | Push usage | 1.0 replacement |
|---|---|---|
| `getSandbox(env.Sandbox, id, { sleepAfter: '1h', transport: 'rpc', enableDefaultSession: false })` | One accessor, `sandboxFor()` | `env.Sandbox.getByName(id)`. `sleepAfter` becomes `setInactivityTimeout()`; `transport` and `enableDefaultSession` go away. |
| `sandbox.exec(cmdString, opts)` | 44 call sites, shell strings | `container.exec(argv)` runs **without a shell**: wrap in `["bash","-c",cmd]`. cwd defaults to `/`; env is not inherited (only `PATH`); a timeout kills the command. |
| `writeFile` (8), `readFile` (2), `listFiles` (1), `deleteFile` (1) | read/write/upload/batch-write/list/delete routes | `Files` class, which needs `sandbox-shim` in the image. `writeFile` no longer creates parent directories, `readDirectory` returns dotfiles, `remove` needs `recursive` for directories. |
| `gitCheckout` (4) | clone with an `x-access-token` URL | A DO method that runs `git clone` through `exec` |
| `startProcess`, `getProcess`, `getProcessLogs`, `killProcess` | `exec-start`, `exec-status`, `exec-logs`, `exec-kill` | Per-ID process directories in the container, plus a `process:<id>` key in DO storage and an alarm (the docs' pattern) |
| `createBackup` / `restoreBackup` | hibernate, restore-snapshot, CoderJob checkpoint and resume | `DirectoryBackup` + the `DirectoryBackupGateway` export, on the same `BACKUP_BUCKET` |
| `destroy` | cleanup | `container.destroy()` |

**Not used, so no work needed:** preview URLs (`exposePort`/`proxyToSandbox`),
tunnels, terminals, bucket mounts, the code interpreter, `schedule()`, outbound
rules, and default sessions (already disabled).

## Design: a compatibility facade

Rewriting 22 routes in a 3,600-line handler against a new API is where bugs
come from. Instead, the new Durable Object exposes **the same small method set
Push already calls**, with 0.12-shaped inputs and results. The handler then
changes in a few places only: `sandboxFor()`, the backup record type, and the
deadline helper.

- **New file `app/src/worker/sandbox-do.ts`:**
  - It exports `class Sandbox extends DurableObject`. The class name stays the
    same, so no DO migration is needed and existing DO storage and names carry
    over.
  - **`ensureRunning()` / `startContainer()`:** start with `env`,
    `enableInternet: true` (the 0.12 default) and `setInactivityTimeout(1h)`.
    The constructor re-applies the timeout, because it doesn't survive a DO
    restart.
  - **`exec(cmd, { cwd = '/workspace', env, timeout })`:** runs
    `bash -c cmd`. It decodes stdout and stderr and returns
    `{ success, exitCode, stdout, stderr }`. Timeouts use GNU `timeout`, where
    exit 124 or 137 means it timed out. This one adapter absorbs the shell,
    cwd and env differences for all 44 call sites.
  - **`writeFile`:** runs `mkdir -p` on the parent first, then writes to a temp
    path and renames it, so a reader never sees a partial file.
  - **`listFiles`:** filters dotfiles unless asked, to keep 0.12's output.
  - **`readFile` / `deleteFile`:** keep 0.12 semantics.
  - **Processes:** `startProcess` / `getProcess` / `getProcessLogs` /
    `killProcess` follow the docs' pattern, with 0.12 status names mapped back
    to what the routes expect.
  - **`createBackup` / `restoreBackup`:** wrap `DirectoryBackup` and keep the
    `ttl` sidecar (`.meta.json`). `restoreBackup` converts a 0.12 SquashFS
    record on first sight (see "Snapshots" below).
  - **`gitCheckout`:** `git clone` through `exec`, same token-in-URL as today.
    Credential injection at the outbound layer is a later improvement, not
    part of this migration.
- **`app/worker.ts`:**
  - It exports the new class instead of re-exporting the package's.
  - It also exports `DirectoryBackupGateway`.
- **`wrangler.jsonc`:**
  - **Containers entry:** gets a new `name` and
    `scheduling_policy: "durable_object"`, with `images.sandbox.dockerfile`
    pointing at `./Dockerfile.sandbox`.
  - **Removed:** `image`, `instance_type` and `max_instances`, which the policy
    rejects. The instance size moves to `start()` (`standard-1`; today's
    "standard" is 4 GiB / ½ vCPU, so verify the 1.0 equivalent).
  - **Unchanged:** `compatibility_date` is 2026-04-20, already past the
    2025-11-17 that `ctx.exports` needs.
- **`Dockerfile.sandbox`:**
  - **New base:** drop `FROM cloudflare/sandbox:*-python`. Pick a base that
    reproduces today's toolchain: Node (decide 22 vs the repo's 24 floor), Bun,
    Python 3.11 with pip and venv, git, curl, jq, zip, and the data libraries.
  - **Additions:** `COPY --from=docker.io/cloudflare/sandbox:<1.x>
    /usr/local/bin/sandbox-shim`, `WORKDIR /workspace` and
    `CMD ["sleep","infinity"]`. (Conversion would also have needed
    `squashfs-tools`; snapshots lapse instead, below.)
  - **Removed:** `EXPOSE`. `ENV` lines no longer reach commands, so those
    values move into the facade's `env`.

## Snapshots: convert, or let them lapse

**Decided 2026-10-24: let them lapse.** The facade refuses a 0.12 handle as
`BACKUP_EXPIRED` (logged as `cf_legacy_backup_refused`), which the handler
already maps to `SNAPSHOT_NOT_FOUND`, the same path an aged-out snapshot
takes. That removes the SquashFS reader, `squashfs-tools` and the R2 API
keypair from the migration. The cost: any work that exists only in a
snapshot taken in the last seven days before cutover is lost, so cut over
when no long CoderJob is mid-run. The options as first weighed:

Hibernate snapshots are SDK `createBackup` archives in SquashFS format, with
a **7-day TTL** (`snapshot-index.ts`). CoderJob checkpoint and resume depends
on restoring them. 1.0 writes a different format.

1. **Convert on first restore (recommended).** The docs give the code: unpack
   the SquashFS into `<dir>.convert`, swap it in, re-back it up with
   `DirectoryBackup`, then delete the old objects. Needs `squashfs-tools` and
   enough disk for the archive, the extracted copy and the existing directory
   at once.
2. **Let them lapse.** Restoring a pre-switch snapshot fails clearly, falls
   back to a fresh clone, and the UI says so. This is simpler, but any work
   that existed only in a snapshot is lost, which matters for long CoderJobs.

Either way, the switch must not leave a restore that fails silently. The
fallback path needs a structured log and a user-visible message.

## Phase 0: staging Worker (first)

A separate Worker that mirrors production. The rehearsal deploys 1.0 onto a
staging Worker that *already runs 0.12.14 with live sandboxes and snapshots*,
then checks it. That's the only way to test the one-way switch before it's
real.

**Setup**
- **Config:** `wrangler.staging.jsonc`, copied from `wrangler.jsonc`:
  - `name: "push-staging"`. Containers need their own `name` too; the docs warn
    that `wrangler deploy --name` doesn't rename container applications.
  - **Its own storage:** new KV namespaces for `SNAPSHOT_INDEX`,
    `SANDBOX_TOKENS`, `ARTIFACTS` and `CHAT_LIBRARY`, and a new R2 bucket
    (`push-staging-snapshots`) bound as both `SNAPSHOTS` and `BACKUP_BUCKET`.
    Staging must never touch production snapshots.
  - **Removed for staging:** `triggers` (no duplicate cron jobs) and
    `logpush`. Staging serves on `*.workers.dev`; production's config has no
    `routes` to strip.
  - **Renamed or re-pointed:** the `analytics_engine_datasets` dataset gets a
    staging name. Give `ratelimits` their own `namespace_id`s, so staging
    traffic doesn't spend production's limits.
  - **Kept:** Durable Objects and migrations (they're per-Worker
    automatically) and `PUSH_SANDBOX_PROVIDER: "cloudflare"`.
- **Secrets:** decide whether staging reads the same Secrets Store entries
  (simplest; Push is single-user) or gets its own (cleaner). Set Worker
  secrets with `wrangler versions secret put … -c wrangler.staging.jsonc`.
- **Deploys:** by hand from a local checkout (`wrangler deploy -c
  wrangler.staging.jsonc`), never Workers Builds. Docker is available
  locally to build the image. Confirm Workers Builds ignores the staging
  config.
- **Ignore files:** add `.wrangler/` state and any staging-only outputs.

**Baseline on 0.12.14 (before any 1.0 code exists)**
1. Deploy staging from `main`.
2. Run `scripts/snapshot-smoke/snapshot-smoke.mjs` against the staging URL.
   Layers 1 and 2 must pass. That proves staging is a faithful copy.
3. Run `coder-resume-smoke.mjs` (Layer 3), which needs model keys.
4. Check the Modal fallback (below) on staging.

Phase 0 is **done** when staging passes the smoke tests on 0.12.14. That's
useful on its own: Push gains a staging Worker it can rehearse any risky
change on.

### Phase 0 progress (2026-10-24)

**Stood up**
- **Worker:** `push-staging` is live at `https://push-staging.ishawnd.workers.dev`,
  first deployed as version `0e239a98-d8f1-4742-b88e-384e51a86ca0`.
- **Code and config:** it was deployed from the #1673 branch, so it runs SDK and
  image 0.12.14. The config is `wrangler.staging.jsonc`, generated from
  `wrangler.jsonc` with the differences listed in its header.
- **Container application:** `push-staging-sandbox`, with `max_instances` 3.
- **Storage:** its own KV namespaces (`push-staging-SNAPSHOT_INDEX`,
  `-SANDBOX_TOKENS`, `-ARTIFACTS`, `-CHAT_LIBRARY`) and its own R2 bucket,
  `push-staging-snapshots`. The bucket has a 7-day expire rule and the
  default multipart-abort rule.
- **Secrets set:** `BACKUP_BUCKET_NAME` and `CLOUDFLARE_ACCOUNT_ID`.

**First smoke run: blocked on R2 credentials, as expected**
- Create works. This is the first live run of the 0.12.14 image.
- Seeding 256 files works.
- Hibernate fails with "Missing: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY".
  The 0.12 SDK uploads backups through presigned R2 URLs, so the bucket
  binding alone isn't enough.

**Baseline on 0.12.14: PASS (2026-10-24, after the owner set the R2 keys)**

`snapshot-smoke.mjs` against staging passed both layers:

| Step | Result |
|---|---|
| Create sandbox (warm) | 5,124 ms. The first, cold run took 128 s. |
| Seed 256 files | 532 ms |
| Hibernate to R2 | 2,827 ms |
| Wrong restore_token / nonexistent id | 403 `AUTH_FAILURE` / 404 `SNAPSHOT_NOT_FOUND` |
| Restore into a fresh sandbox | 14,495 ms, graded YELLOW (green ≤ 5 s, yellow ≤ 15 s) |
| Integrity | 256 files, content digest matches |

These are the numbers 1.0 must match or beat on the same harness. There's no
production figure to compare the restore time against yet. Running the smoke
on production would create and delete production sandboxes, so that waits for
the owner's go-ahead.

**Still open in Phase 0**
- **Layer 3 (`coder-resume-smoke.mjs`):** it drives a real model through
  CoderJob, and staging has no AI provider secrets. It needs owner-set
  credentials, or can be deferred to the 1.0 rehearsal.
- **Modal fallback:** see "Found along the way" below.

**Owner step to unblock (done)**
1. Create an R2 API token scoped to `push-staging-snapshots` with Object
   Read & Write (Cloudflare dashboard → R2 → Manage API tokens).
2. Set its two values from a checkout that has `wrangler.staging.jsonc`:
   `npx wrangler secret put R2_ACCESS_KEY_ID -c wrangler.staging.jsonc` and
   `npx wrangler secret put R2_SECRET_ACCESS_KEY -c wrangler.staging.jsonc`.

**Found along the way**
- **Instance type renamed.** Wrangler 4.152 warns that the `"standard"`
  instance type is now `"standard-1"`, so today's size has a 1.0 name. That
  answers the instance-size open question.
- **Production's bucket had no expiry rule (fixed 2026-10-24).**
  `push-cf-snapshots` had only the default multipart-abort rule, although the
  `wrangler.jsonc` comment says the 7-day rule "is what physically reclaims"
  SDK archives.
  - **Before the fix,** the bucket held 29 objects, all older than 7 days and
    the oldest 96 days: 24 objects under `backups/` (135.7 MB) and 5
    descriptors under `cf-backups/`. Every one was past the 7-day handle TTL,
    so none was restorable. The storage cost was negligible.
  - **The fix:** an `expire-7d` rule (whole bucket, 7 days) was added through
    the API alongside the existing multipart-abort rule, at the owner's
    request. `npm run r2:snapshots:lifecycle` is the scripted equivalent, but
    on Windows wrangler 4.152's `r2 bucket lifecycle add` crashed (libuv
    assertion), on staging too.
- **Cold start.** The first sandbox create on staging took 128 s, most likely
  the first pull of a new container application's image. Re-measure when
  warm.
- **Modal fallback unverified.** Production has `MODAL_SANDBOX_BASE_URL` set,
  but whether the Modal app behind it is still deployed is unverified. The
  Modal CLI isn't installed on the dev machine. Testing the fallback on
  staging needs that URL copied in by the owner, because it may embed a
  credential.

### Phases 1–3 progress (2026-10-24, branch `feat/sandbox-sdk-1.0`)

Built on a branch and, *at the time of writing*, **not deployed anywhere**.
Layer 3 and the Modal check are deferred to the rehearsal, at the owner's call.
(Superseded the next day: this branch became production on 2026-10-25 - see
"Production cutover" below.)

**Image (Phase 1)**
- **Base and pins:** `Dockerfile.sandbox` now builds on
  `python:3.11.14-slim-bookworm` with Node 22.23.4 copied from the official
  image, Bun 1.4.4, and `sandbox-shim` from `cloudflare/sandbox:1.0.3`.
- **Parity, checked against the 0.12 base:** a local build reports Node
  22.23.4 / npm 10.9.9 / Bun 1.4.4 / Python 3.11.14, the data libraries, and
  every tool the old base had. (It briefly added `squashfs-tools` for the
  legacy restore path, since removed.)
- **The one deliberate difference:** Debian 12 replaces Ubuntu 22.04.
- **EXPOSE dropped.** The image-contract test now pins its absence.

**Facade (Phase 2):** `app/src/worker/sandbox-do.ts` implements a
`SandboxFacade` interface that the handler types its stub with.
- **Commands:** `bash -c`, cwd `/workspace`, `HOME`/`LANG` passed explicitly,
  and timeouts through an `AbortSignal`, reported as exit 124.
- **Files:** `writeFile` creates parent directories and writes through a temp
  file; `listFiles` hides dotfiles.
- **Git:** `gitCheckout` throws git's own message with any token redacted.
- **Processes:** run detached, in their own process group.
- **Backups:** `DirectoryBackup` plus an expiry sidecar. 0.12 SquashFS handles
  are refused as `BACKUP_EXPIRED` without starting the container; a break test
  confirms the refusal test fails when the check is removed. 1.0 backups need
  only the `BACKUP_BUCKET` binding, not the 0.12 R2 API keypair.
- **Error codes:** errors lead their message with the code, because custom
  error properties aren't guaranteed to survive Workers RPC.
- **Tests:** 21 facade tests. Break tests confirmed the `HOME`, dotfile and
  error-code guards each fail when removed.

**Handler and config (Phase 3)**
- **Handler:** `sandboxFor()` is now `env.Sandbox.getByName(id)`, with the same
  id as before (no normalization), so Durable Object identities carry over.
  The backup handle type moved to the facade's, `localBucket` was dropped, and
  `backupErrorCode` also parses the message prefix.
- **Wrangler config:** both containers entries use
  `scheduling_policy: "durable_object"` with a named image and new application
  names (`push-sandbox-do`, `push-staging-sandbox-do`).
- **Checks:** both configs dry-run cleanly, and app vitest passes 7,553.

### Rehearsal on push-staging (2026-10-24, branch at `691e9d57`)

**Sequence:** a real 0.12 snapshot was made on the 0.12.14 Worker first,
then `wrangler deploy -c wrangler.staging.jsonc` shipped the 1.0 branch as
version `f28f86e0-0641-4932-8e87-eaa86dbaea12`, with the container now
`Sandbox (durable_object)`. Staging can't go back to 0.12 now; that was the
point.

**Layers 1–2 (`snapshot-smoke.mjs`): PASS, twice.**

| Step | 0.12.14 baseline | 1.0, first run | 1.0, second run |
|---|---|---|---|
| Create sandbox | 5,124 ms warm (128 s cold) | 23,024 ms (first start of the new image) | 2,737 ms |
| Seed 256 files | 532 ms | 357 ms | 386 ms |
| Hibernate | 2,827 ms | 2,029 ms | 1,808 ms |
| Wrong token / missing id | 403 / 404 | 403 / 404 | 403 / 404 |
| Restore | 14,495 ms, YELLOW | 3,561 ms, GREEN | 3,686 ms, GREEN |
| Integrity | 256 files, digest match | 256 files, digest match | 256 files, digest match |

Restore is about 4× faster on 1.0. The smoke prints "0KB compressed" for
the snapshot because the backup path doesn't report a size; that predates
1.0 and isn't a regression.

**Layer 3 (`coder-resume-smoke.mjs`): PASS.** Workers AI (`kimi-k2.6`)
through the staging `AI` binding, so no provider secrets were needed. The
sandbox was killed mid-run and the job still completed (114 s total). The
tail showed 4 `coder_checkpoint_captured`, 1 `coder_job_resumed`, and the
checkpoint restored into a fresh sandbox (`cf_backup_materialized`,
`cf_backup_restored`).

**A real 0.12 snapshot after the switch: refused as designed.** Three
restores of the snapshot made before the deploy each returned
`404 SNAPSHOT_NOT_FOUND` in about 1.3 s. The tail showed
`cf_legacy_backup_refused` and `BACKUP_EXPIRED: backup … was made by Sandbox
SDK 0.12 and is not restorable after the 1.0 upgrade` each time, so it was
the refusal, not some other miss.

**Modal fallback: alive.** With `MODAL_SANDBOX_BASE_URL` copied to staging
by the owner, staging was redeployed with `--var PUSH_SANDBOX_PROVIDER:modal`
(version `88edc5a4`) and driven through `/api/sandbox/*`: create 200 in 51 s
(cold), exec 200 (exit 0), write and read-back 200, cleanup 200. It's a
working escape hatch if 1.0 has to be abandoned. One parity gap: Modal's
image runs Python 3.12.10, against 3.11.14 on the Cloudflare image. Staging
was then redeployed on `cloudflare` (version `6eb92269`), and
`snapshot-smoke.mjs` passed again (restore 3.7 s, GREEN).

**Background processes: two bugs found and fixed on staging.** No smoke
layer started a background process, so a probe drove `exec-start`,
`exec-status`, `exec-logs` and `exec-kill` through the real stub.
1. **Every `exec-start` failed (500).** The launcher joined its steps with
   ` && `, and the backgrounding step ends in `&`, giving `& &&`, a bash
   syntax error. The unit tests only compared strings. Fixed: one step per
   line under `set -e`, plus a test that parses every generated script with
   a real `bash -n` (confirmed red against the old join).
2. **A finished process could report `running` forever.** The command ran
   inline in the wrapper shell, so `exit 3` skipped writing the exit code.
   And PID 1 (`sleep infinity`) never reaps, so the dead wrapper lingered as
   a zombie that `kill -0` still found. Fixed: the command runs in its own
   `bash -c`, and only a non-zombie (`ps -o stat=`) counts as alive.

After the fixes (staging version `fde3fbe3`): a command ending in `exit 3`
reports `failed`, exit 3, with a 4,010 ms run for a 4 s sleep. Logs come back
on the right streams. `exec-kill` reports `killed`. A wrapper SIGKILLed
behind the facade's back (`ps` shows `Zs`) reports `failed`. An unknown id
is 404.

**`Date` values over RPC: fine.** `started_at` and `ended_at` come back as
valid ISO strings through the real stub. The Worker and container clocks
agree within a second. (The dev machine's clock runs about 5 minutes slow,
which first looked like skew.)

**Keep-alive past the idle window: none, matching 0.12 (decided
2026-10-24).** In 0.12.4 (`@cloudflare/containers` 0.3.7), the idle timer is
renewed only by in-flight requests (`isActivityExpired`,
`renewActivityTimeout`), and Push set `sleepAfter: '1h'` without
`keepAlive`. So a background process with no requests for an hour was
stopped on 0.12 too. 1.0's `setInactivityTimeout` behaves the same: the
lifetime docs say code running in the container is not activity. The 0.12
code already rejected `keepAlive` for its orphaned-container cost. A process
someone is watching gets polled, which counts as activity. If a real need
appears, the 1.0 pattern is an alarm that runs while any process is alive,
with a cap.

**Noted for the production cutover:** per the 1.0 migration guide, a pending
0.12 alarm calls the new class's `alarm()` once after the switch. The facade
has no `alarm()`, so each sandbox that was active logs one internal error,
which then clears. That's harmless, but expect it in the logs.

### Production cutover (2026-10-25, forced; deployed by hand)

**How it happened:**
- A Workers Builds non-production branch build of this branch ran `wrangler versions upload` against the **production** `push` Worker (00:56 UTC).
- That created the `push-sandbox-do` (`durable_object`) application and attached it to production's Sandbox namespace, alongside the old `push-sandbox` app.
- The next main deploy (01:43, still 0.12 code) could not start any container: "Image or container snapshot must be set for the new runtime". Sandboxes hung on "starting".
- The docs line "versions upload does not publish a new image or roll out container instances" is true. It says nothing about container *applications* or namespace links.

**The fix forward:**
1. Workers Builds disabled on `push`.
2. This branch (`e86ff4e0`) deployed by hand with `wrangler deploy` as version `028cf905` (02:05 UTC).
3. Verified: health OK, and a real sandbox create went end to end in 23 s (git identity 18.8 s, which absorbed the first image start; clone 2.3 s; cache populate 82 ms), then exec and read returned 200.

**Still to do:**
- Merge #1674 and this PR into main so main matches production. Builds stay disabled until then.
- Set up Worker Previews: per-branch DO namespaces and container apps, tested on staging. Until then, branch builds are not isolated from production.
- Delete the leftover 0.12 `push-sandbox` container application.
- Delete the 0.12-only R2 secrets.

### Reconciliation (2026-10-25, main @ `3fef835c`)

The cutover section's "Still to do" list, checked against main rather than
against memory.

**Landed since the cutover was written:**
- *Merge #1674 and this PR into main.* Done - `6cac3376` and `2b392fe5` are on
  main, so main matches what was hand-deployed.
- *Set up Worker Previews.* Done - #1683 wires per-branch previews in both
  `wrangler.jsonc` and `wrangler.staging.jsonc`, pinned by
  `app/src/worker/wrangler-previews-config.test.ts` and documented in the
  deployment runbook; #1684 adds logs and traces. #1694 also added
  `scripts/deploy-worker.mjs`, which retries the sandbox image-push timeout, so
  the hand-deploy step is a command now rather than a procedure.

**Phases 1-5, confirmed present on main:**
- **Image:** `Dockerfile.sandbox` is multi-stage on
  `python:3.11.14-slim-bookworm`, Node 22.23.4 copied from the official image,
  and `COPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim`.
- **Facade:** `app/src/worker/sandbox-do.ts` (485 lines) with
  `sandbox-do.test.ts` (371).
- **Handler:** `sandboxFor()` is `env.Sandbox!.getByName(sandboxId)`; the
  "every backup goes through the R2 binding" note survives at the backup site.
- `setInactivityTimeout()` is called **both** in the constructor and after
  `start()`, which is what the migration guide requires.
- `@cloudflare/workers-types` is now `^5.20261024.1`, which types
  `signal?: AbortSignal` on `ContainerExecOptions` - the mechanism the open
  timeouts question needs. Whether it covers every `withExecDeadline` case is
  still unanswered.

**Closed here, from Phase 6:**
- `scripts/snapshot-smoke/README.md` described the snapshot path as a
  home-rolled "R2 `tar.gz` archive", *not* the SDK primitive. That was inverted:
  `createWorkspaceSnapshot` / `restoreWorkspaceSnapshot` wrap `DirectoryBackup`
  through the facade, with `SNAPSHOTS` holding the descriptor index and
  `BACKUP_BUCKET` the objects. Corrected, with a note that the `tar.gz` still in
  the handler belongs to the unrelated `/download` route.

**Still open, and visible in the repo:**
- Remove the remaining 0.12-only code.
- This doc's `(partially implemented)` qualifier, gated on the rest of Phase 6.

**Still open, and NOT verifiable from the repo - needs the owner:**
- **Delete the leftover 0.12 `push-sandbox` container application.** It keeps
  running and billing, which makes it the one cleanup item with a meter on it.
- Delete the 0.12-only R2 secrets.
- Delete 0.12 DO storage keys by name - never `deleteAll()`, which would also
  take unconverted backup handles.
- **Whether Workers Builds was re-enabled on `push`** after the incident
  disabled it. Isolated previews now exist (#1683/#1684), so the reason it was
  switched off may be gone; leaving it off indefinitely means every deploy is a
  hand deploy.
- Confirm the Modal fallback (`PUSH_SANDBOX_PROVIDER=modal` plus
  `MODAL_SANDBOX_BASE_URL`), which the escape-hatch section itself records as
  having "drifted unchecked". With 0.12 unreachable by rollback, this is the
  only route around a bad 1.0 deploy.

## Phases after staging

1. **Image:** a new `Dockerfile.sandbox` on its own base. Build it locally and
   confirm the toolchain versions match today's, or record the deliberate
   changes.
2. **Facade:** `sandbox-do.ts` with the methods above, and unit tests against
   a mocked `ctx.container` for each semantic difference (shell, cwd, env,
   parent directories, dotfiles, timeouts, process states, backup round trip,
   SquashFS conversion).
3. **Handler:** switch `sandboxFor()` to `getByName()`, and the record type
   from `DirectoryBackup` to `DirectoryBackupRecord` (`localBucket` is gone;
   `size`, `name`, `sha256` and `format` are added). Update the test mocks
   that stub `getSandbox`.
4. **Rehearse on staging** (the docs' in-place path):
   - Seed staging on 0.12.14 with a hibernated snapshot, a running sandbox
     with a connected client, and a CoderJob mid-run.
   - Upload the 1.0 version with `wrangler versions upload -c …` and note the
     version ID, then deploy it with `wrangler versions deploy <id>@100% -y`.
   - Wait a few minutes; requests can briefly reach the old container.
   - Pass criteria:
     - smoke Layers 1–3 are green;
     - a pre-switch snapshot restores, converted if option 1 is chosen;
     - the running sandbox's commands fail cleanly and recover on the next
       request, instead of hanging;
     - `wrangler containers list` shows the new application.
5. **Production switch:**
   - Pick a quiet window with no running CoderJobs.
   - Hibernate any workspace worth keeping.
   - Confirm the Modal fallback works.
   - Deploy with `versions upload` + `versions deploy`, not by merging into
     auto-deploy.
   - Run the smoke tests against production, then watch logs for a day.
6. **Cleanup:**
   - Delete the old container application (`wrangler containers delete`),
     which otherwise keeps running and billing.
   - Delete 0.12 DO storage keys by name, never with `deleteAll()`, which
     would also delete unconverted backup handles.
   - Remove 0.12-only code and fix `scripts/snapshot-smoke/README.md`, which
     still says snapshots are tar.gz although they're SDK backups.
   - Drop this doc's `(partially implemented)` qualifier.

## Escape hatch: Modal

The class can't go back to 0.12, but **Push can route around it**.
`PUSH_SANDBOX_PROVIDER=modal` sends `/api/sandbox/*` to the Modal backend
(`sandbox/app.py`). That needs the Modal app deployed and
`MODAL_SANDBOX_BASE_URL` set, both of which have drifted unchecked. Phase 0
should verify the fallback works on staging, so a broken 1.0 deploy has a
same-day workaround: flip the var and fix forward.

## Decisions for the owner

1. **In place or side by side.** Recommended: in place. Push sandboxes are
   short-lived (1-hour idle sleep) and their durable state lives in snapshots
   and GitHub, which suits the in-place path. Side by side runs both classes
   and copies `/workspace` per sandbox, which is more code for state Push
   doesn't keep in containers.
2. **Snapshots: convert or lapse.** **Decided: lapse** (2026-10-24, see
   "Snapshots" above). First recommended convert; the reader it needed cost
   more than seven days of snapshots are worth, and the refusal is not silent.
3. **Staging secrets: shared or separate.** Still open; not answerable from the
   repo.
4. **Base image Node version: 22, as today, or the repo's 24 floor.**
   **Decided: 22** (2026-10-24). `Dockerfile.sandbox` copies Node 22.23.4 from
   `node:22.23.4-bookworm-slim`, and its NOTE ON NODE header states the grounds:
   the sandbox runs the *user's* repo commands, and `sandbox/app.py` (Modal)
   mirrors the pin via `setup_22.x`, so the two backends must agree. The
   `engines: node >=24` warning this produces when Push installs itself inside
   the sandbox is warn-only and explicitly not a reason to move.
   (An earlier revision of this line read the sub-floor pin as drift left over
   from inheriting the 0.12 base. It is not: the header was rewritten with the
   1.0 image and re-states the decision on its own grounds.)
   Dependabot #1687 proposed Node 26 and was **closed** 2026-10-26: v26 is
   `lts: false` while v22/v24 are Jod/Krypton, the image ships no compiler so
   native modules depend on prebuilts that are thinnest on the newest major,
   nothing in CI builds this image (`Validate sandbox` only syntax-checks the
   Modal app, so the first real build is a deploy), and it touched only the
   Cloudflare half of a documented two-backend pin. `.github/dependabot.yml`
   now holds both base pins so the decision stops being re-proposed weekly:
   `library/node` ignores majors (the major *is* the Node release line, so 22.x
   minors still arrive), and `library/python` ignores majors **and minors**,
   because Dependabot reads a Docker tag as `major.minor.patch` — 3.11 to 3.15
   is a semver-minor update, so a major-only rule would have stopped nothing
   but Python 4. Both reviewers caught that on #1698. `sandbox/app.py`'s Node
   comment, which still carried the superseded 0.12-base rationale, now points
   at `Dockerfile.sandbox`'s NOTE ON NODE as the single source of the pin.
5. **Production switch timing**, set by when 0.x support ends on 2026-12-31.
   Recommended: aim for early December, leaving room to fix forward.

## Follow-up: Cloudflare Artifacts for checkpoints

Not part of this migration. [Artifacts](https://developers.cloudflare.com/artifacts/)
(Git-compatible storage, open beta since 2026-10-01) could replace
`DirectoryBackup` for checkpoints: `createBackup` already honours
`.gitignore`, so a commit captures nearly the same tree. The win is
capability, not simplicity: checkpoint history, forking a session from a
checkpoint, and reading a checkpoint's files from the Worker without waking a
container. Unknowns to spike on staging first:

- **Shallow clones.** Sandboxes clone at `depth: 1`. Pushing a HEAD-parented
  commit into an empty Artifacts repo may be refused; a parentless commit
  works but flattens unpushed local commits into working-tree changes.
- **Private repos.** `import` takes only public HTTPS remotes, so the first
  push carries the whole history, against a 1 GB per-repo cap.
- **Cleanup.** Repos have no TTL; Push would own deletion (today the R2
  bucket's 7-day rule does it).
- **Beta on beta**, the objection in the archived `artifact-fs` doc.

## Open questions to settle in staging

- ~~**Instance size:**~~ **Settled.** `sandbox-do.ts` pins
  `INSTANCE_TYPE = 'standard-1'`, commented as the 0.12 `"standard"` type
  renamed upstream, and passes it to `start({ instance })`.
- **Timeouts:** check whether the facade's `exec` timeout (GNU `timeout`)
  covers every `withExecDeadline` case, or whether some calls need an
  `AbortSignal`.
- **Output size:** check whether exec output above 0.12's size limits behaves
  the same way. The 1.0 docs don't say.
- **Cost:** check the cost of the staging Worker's idle containers, and whether
  `max_instances` (removed in 1.0) has a replacement Push should set.
