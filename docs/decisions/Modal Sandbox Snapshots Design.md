# Modal Sandbox Snapshots Design

Date: 2026-04-14
Status: **Draft** — Phase 0 spike required before commitment
Owner: Push
Related: `docs/decisions/Resumable Sessions Design.md` (client-side checkpoint companion), `docs/decisions/Vercel Open Agents Review.md` (origin of this work item), `sandbox/app.py`

## Problem

Push's resume-after-suspend story has two layers today and they don't compose well:

1. **Client-side run journal** (`app/src/lib/run-journal.ts`, `app/src/lib/snapshot-manager.ts`) — survives tab suspension and reconstructs loop state from the persisted conversation + a delta checkpoint. Already shipped via `Resumable Sessions Design.md`.
2. **Modal sandbox container** — created in `sandbox/app.py:1023` with `timeout=3600`. After ~1 hour the container is gone. The current recovery path on a dead container is "create a fresh sandbox, re-clone, re-warm node_modules, lose all uncommitted state outside git."

The journal can tell us *what the agent was about to do*. The git tree on a fresh sandbox can tell us *what landed in the index*. Neither tells us:

- The state of `node_modules` after a 90-second `npm install`.
- Build artifacts the agent generated for verification (`dist/`, `.next/`, `__pycache__`).
- Untracked scratch files (`tmp/`, debug logs, the half-edited file the agent was about to commit).
- The sandbox's git config, owner token, workspace-revision counter, environment probe results.

So "reopen the chat 2 hours later" pays the full clone-and-warm cost every time. On mobile, where sessions are bursty and the user constantly backgrounds the app, this is the dominant resume latency and the biggest reliability cliff. It's also the headline gap surfaced in the Vercel Open Agents review (see `Vercel Open Agents Review.md` §5.1).

## Goal

When the user returns to a previously-active sandbox session — minutes, hours, or a day later — Push restores the working tree, dependencies, and untracked state into a fresh sandbox in seconds, without losing anything that wasn't garbage to begin with.

## Non-goals

- **Resuming running processes** (dev servers, watchers, REPLs). Filesystem snapshots cannot capture process memory. Long-running processes are the domain of the sandbox port-exposure work in `Vercel Open Agents Review.md` §5.2 and need their own design.
- **Cross-branch snapshot sharing.** Snapshots are keyed per `(repo, branch)` and never reused across branches.
- **Snapshot-as-source-of-truth.** Git remains canonical. Snapshots are an optimization on top of it, not a replacement for it.
- **CLI parity.** The local CLI's "sandbox" is the user's own filesystem; there is nothing to snapshot. This is a web-only feature.
- **Replacing the run journal.** The client-side checkpoint flow continues to handle in-flight loop interruption. Snapshots handle the longer-horizon "container is dead, but the workspace shouldn't have to be" case.

## Background — current sandbox lifecycle

| Stage | Code path | What it does |
|---|---|---|
| Create | `sandbox/app.py:1023` `create()` | `modal.Sandbox.create("sleep", "infinity", image=sandbox_image, timeout=3600)` then `git clone --depth=50 --branch <branch>`. Issues an owner token to `/tmp/push-owner-token` (`OWNER_TOKEN_FILE`). Initializes the workspace revision counter at `/tmp/push-workspace-revision` (`WORKSPACE_REVISION_FILE`). Runs an environment probe. |
| Resume (current) | `sandbox/app.py:656` `_load_sandbox()` → `modal.Sandbox.from_id()` | Looks up the existing container by ID. Works only while the container is still alive (≤1h). Returns "not found / expired" once it dies. |
| Per-call validation | `_validate_owner_token()` | Re-reads the token file from inside the sandbox and HMAC-compares. |
| Cleanup | `sandbox/app.py:1648` `cleanup()` | `sb.terminate()`. Called explicitly on branch switch (`docs/architecture.md:67`). |
| Client-side persistence | `app/src/lib/sandbox-session.ts` | Stores `{sandboxId, ownerToken, repoFullName, branch, createdAt}` in localStorage, keyed `sandbox_session:repo:<full>:<branch>`. **Already keyed per repo + branch** — this is exactly the snapshot key we need. |

Two facts from this matter for the design:

1. The sandbox session is already `(repo, branch)`-scoped client-side. Snapshot keying drops in cleanly.
2. Owner token and workspace revision live as files in the sandbox FS, not in Modal-side state. They will survive a filesystem snapshot for free, which avoids re-issuing tokens on resume.

## Phase 0 — Modal API verification (must complete before Phase 1)

The design assumes Modal supports filesystem snapshots that can be turned into a new sandbox quickly. We need to confirm specifics before committing:

1. **Is `Sandbox.snapshot_filesystem()` (or equivalent) available on our Modal plan?** What does it return — an `Image`, an opaque snapshot handle, or something else?
2. **What's the actual snapshot/restore latency** on a workspace shaped like ours (200–500 MB working tree, big `node_modules`, deep `.git`)?
3. **Snapshot size and pricing** — are snapshots billed per GB-month? What's the cap on snapshots per workspace / per account?
4. **Snapshot lifetime** — TTL, eviction policy, what happens when an Image is unused for N days.
5. **Does the snapshot include `/tmp`?** This determines whether the owner token and workspace revision survive without extra work, or if we have to relocate them outside `/tmp`.
6. **Cold-create from snapshot vs. warm-resume from existing sandbox** — relative latencies. If cold-create-from-snapshot is within ~3× of warm `from_id`, the design simplifies dramatically (we just always cold-create from snapshot and stop trying to keep containers warm).
7. **Memory snapshots for sandboxes** — only relevant if Modal exposes them for `Sandbox` (not just `Function`). If yes, that's a follow-up doc. For now, assume FS-only.

Phase 0 deliverable: a one-page report in `docs/research/` with measurements and answers. **No production code changes in Phase 0.** If Modal's snapshot story turns out to be unsuitable, this whole design is parked and we revisit on the next platform iteration.

## Design

### 1. Sandbox lifecycle states

Today the sandbox is either **active** or **gone**. The new model adds two states between them:

```
active ──idle timeout──▶ snapshotting ──▶ snapshotted ──resume request──▶ restoring ──▶ active
   │                                            │
   └──explicit cleanup / branch switch──▶ dead  └──TTL eviction──▶ dead
```

| State | Meaning | Visible to the agent? |
|---|---|---|
| `active` | Container is running, accepting calls. | Yes (existing). |
| `snapshotting` | A snapshot is being taken; container still serves reads but blocks mutations. | Yes — surfaced in the session capability block (`docs/architecture.md:32`) so the agent knows not to dispatch more tools. |
| `snapshotted` | Container has been terminated; a snapshot exists for `(repo, branch)`. No live container. | No — the agent sees "no sandbox" until it's restored. |
| `restoring` | A new container is being created from the snapshot. | Yes — surfaced as a capability-block phase, similar to today's "creating sandbox" state. |
| `dead` | No container, no usable snapshot. Must clone fresh. | No. |

The transitions:

- `active → snapshotting`: triggered by **idle policy** (see §3) or by a **client-driven `visibilitychange` hibernation request** when the user backgrounds the app for more than N seconds.
- `snapshotting → snapshotted`: snapshot persisted, sandbox terminated, snapshot key written to client + server-side cache.
- `snapshotted → restoring`: triggered by the next call from the client that needs the sandbox (lazy restore — we don't restore on app open, only when the agent or the user actually needs the workspace).
- `restoring → active`: new sandbox is up, owner token re-validated, capability block flips back to live.
- `snapshotted → dead`: TTL eviction (see §6) or explicit branch deletion.

### 2. Snapshot key and storage

```
snapshot_key = sha256(f"{repo_full_name}|{branch}|{user_id}")[:16]
```

Why include `user_id`: snapshots can contain in-progress dirty edits and `.env` files the user pasted in. They are **not** shareable across users, even on the same branch.

Two pieces of state need to be kept in sync:

1. **Modal-side**: the snapshot itself (whatever Modal returns from `snapshot_filesystem()`). We store the snapshot handle in a small KV (Cloudflare KV is the obvious fit — already in the stack via the Worker proxy). Schema: `{ snapshotKey → { modalRef, createdAt, sizeBytes, sourceSandboxId, workspaceRevision } }`.
2. **Client-side**: extend `PersistedSandboxSession` in `app/src/lib/sandbox-session.ts` with an optional `snapshotKey` field. When the client tries to load a sandbox, it asks the Worker for the live container by ID (existing path); if that fails, it asks "is there a snapshot for this `(repo, branch)`?" before falling back to a fresh clone.

The client storage key (`sandbox_session:repo:<full>:<branch>`) is already correctly scoped — no migration needed beyond adding the optional field.

### 3. When to snapshot

Three triggers, in priority order:

**A. Pre-eviction snapshot (mandatory).** Modal's `timeout=3600` will kill the container at ~1 hour. We schedule a snapshot at `T - 5 minutes`. This is the safety net: nobody loses state to the timer.

**B. Idle hibernation (the main optimization).** Track time-since-last-tool-call on the client. After N minutes of idle (proposed default: **8 minutes**), the client asks the Worker to snapshot and terminate the sandbox. This is the "user closed the app, not coming back for a while" case.

The "since last tool call" signal is already available — the run journal tracks it. The hibernation request is a new endpoint on the Worker that calls a new `snapshot_and_terminate()` Modal function (parallel to `cleanup()` at `sandbox/app.py:1648`).

**C. Explicit user hibernate (optional UI affordance).** Workspace Hub gets a "Hibernate sandbox" action that triggers an immediate snapshot. Useful for "I'm done for today, see you tomorrow." Not required for the first ship.

**Crucially: branch switch does NOT snapshot.** Branch switch already has explicit teardown semantics (`docs/architecture.md:67`); switching branches snapshots the *outgoing* branch and creates fresh on the incoming one. This means switching back resumes instantly, which is a real UX win independent of session-resume.

### 4. When to resume

Lazy. The next time the client makes a sandbox call after seeing "no live container":

1. Check the local `PersistedSandboxSession` for a `snapshotKey`.
2. Call a new `restore()` endpoint on the Worker → Modal `restore_from_snapshot(snapshot_key)`.
3. Modal creates a new sandbox using the snapshot as its image base.
4. Owner token already lives in the snapshot at `OWNER_TOKEN_FILE` (assuming Phase 0 confirms `/tmp` is captured) — no re-issue needed.
5. New sandbox ID returned to the client; persist it via `saveSandboxSession()`.

Resume is silent if it succeeds. The capability block flips through `restoring → active` and the run journal recovery flow (already shipped, `Resumable Sessions Design.md` §3) can then do its sandbox-state reconciliation against the resumed workspace exactly as it does today against a fresh one.

### 5. Owner token + workspace revision survival

Both `OWNER_TOKEN_FILE` (`/tmp/push-owner-token`) and `WORKSPACE_REVISION_FILE` (`/tmp/push-workspace-revision`) live in `/tmp`. Phase 0 must confirm whether Modal snapshots include `/tmp`. Two paths:

- **If yes:** zero work. Token survives the snapshot, restore is transparent, the existing `_validate_owner_token()` (`sandbox/app.py:620`) just works.
- **If no:** relocate both files to `/workspace/.push/` (gitignored at the workspace level via a sandbox-managed `.git/info/exclude` entry — never write to `.gitignore` in the user's repo). Update `OWNER_TOKEN_FILE` and `WORKSPACE_REVISION_FILE` constants accordingly. This is a small, contained change but it's load-bearing for security, so it gets its own review.

### 6. Snapshot TTL and eviction

Snapshots are not free storage. Policy:

- **Default TTL: 7 days** since last access. Touched on every restore. Configurable per environment.
- **Per-user cap:** 10 active snapshots. Beyond that, evict the oldest (LRU on last-access timestamp).
- **Per-repo cap:** 1 snapshot per `(repo, branch, user)`. New snapshot of the same key replaces the old one atomically.
- **Manual clear:** "Forget sandbox state" action in Workspace Hub clears the snapshot and the local session entry. Useful when the workspace is irreparably broken and the user wants a clean clone.
- **On branch deletion (via UI):** drop the corresponding snapshot.

A daily Worker cron walks the snapshot index and evicts expired entries.

### 7. Capability block update

Today the session capability block already exposes "container lifetime, creation/download events, and recent workspace lifecycle state" (`docs/architecture.md:32`). Add three things:

- `sandbox.phase` extended with `snapshotting | snapshotted | restoring`.
- `sandbox.snapshotAge` (seconds since the snapshot was taken; null if active).
- `sandbox.snapshotSizeMB` for observability.

This lets the agent reason about whether to wait, whether the workspace is "warm" or about to be restored, and surfaces hibernation state in transcripts so reviewers and resume flows can see what happened.

### 8. Interaction with the run journal

The run journal (`Resumable Sessions Design.md`) and snapshots solve adjacent problems:

| Layer | Solves | Lifetime |
|---|---|---|
| Run journal | Loop state lost to client suspend | Seconds–minutes |
| Snapshots | Workspace state lost to container timeout | Minutes–days |

They compose without coupling. The journal's `detectInterruptedRun()` already validates `sandboxSessionId` to make sure the sandbox identity matches; with snapshots, a restored sandbox has a *new* sandbox ID, so the journal's identity check would fail. Two options:

**A. Journal stores `snapshotKey` instead of (or in addition to) `sandboxSessionId`.** Then identity is "same `(repo, branch, snapshotKey)`" rather than "same container ID." This is the cleaner fix. It's a small additive change to `RunCheckpoint` in `Resumable Sessions Design.md` §1.

**B. After restore, propagate the new sandbox ID back into the latest journal entry.** Hackier, more error-prone.

Picking **A**. This is a small ripple in the journal type definition — call it out in the Phase 1 PR description so the journal author signs off.

### 9. Edge cases

**Snapshot is taken while a tool is mid-flight.** Don't. The `snapshotting` phase blocks new tool dispatches client-side, and the snapshot trigger waits for the current tool batch to drain (or aborts after a timeout, surfacing an error rather than capturing a partial-mutation state).

**User has two tabs open on the same chat.** The existing multi-tab lock from `Resumable Sessions Design.md` §6 (`run_active_${chatId}` localStorage lock) ensures only one tab drives the loop. The hibernation trigger respects the same lock — only the active tab can hibernate. If the active tab dies without releasing the lock, the next tab's idle-policy fires after the lock goes stale.

**Snapshot fails mid-creation.** Atomic: don't terminate the source container until the snapshot is confirmed persisted by Modal. If snapshotting fails, log it, leave the container alive, and let the natural 1-hour timeout handle eviction.

**Restore fails.** Fall back to a fresh `git clone`. The user sees a "starting from scratch" notice. The journal recovery flow already handles this case correctly because it reconciles against whatever the sandbox actually contains.

**Snapshot includes a leaked secret the user pasted.** Snapshots are user-scoped, but a user might paste an API key into a file expecting it to be ephemeral. We document that hibernated workspaces persist *exactly* what's on disk, mirror that in the "Hibernate sandbox" UI copy, and provide the "Forget sandbox state" escape hatch.

**Branch protection kicks in between hibernation and resume.** Doesn't matter — protection is checked at commit/push time, not at sandbox restore. The restored workspace looks identical; the agent finds out about new protection rules the next time it tries to push.

**Modal raises a snapshot quota error.** Treat the same as "snapshot failed." Surface a one-time toast asking the user to clear old hibernated sandboxes from settings.

**Repo got force-pushed while we were hibernated.** The restored snapshot still points at the old SHA. On restore, run `git fetch && git status -uno` once and surface a banner if `HEAD` is no longer reachable from the remote branch tip. Don't auto-rebase. The agent can decide what to do, same as today's "branch drifted" handling.

## Open questions

1. **Idle threshold.** 8 minutes is a guess. Need to instrument and tune against real session telemetry.
2. **Eager vs lazy restore on app open.** Lazy is simpler (no wasted restores) but adds latency to the first tool call after wake. Could prefetch the restore in parallel with the first user message stream. Defer to Phase 3.
3. **Snapshot compression / dedup.** If Modal stores raw images, two snapshots for the same `(repo, branch)` taken minutes apart will mostly overlap. Worth asking Modal about content-addressed storage during Phase 0.
4. **Server-side snapshot index storage.** Cloudflare KV is the easy answer; D1 is more queryable but adds a binding. KV unless we hit the size cap.
5. **Telemetry.** Capture `(snapshot_size_bytes, snapshot_duration_ms, restore_duration_ms, idle_at_snapshot_seconds, age_at_restore_seconds, restore_outcome)` per event into the existing telemetry sink. Need this from day 1 to validate the design lives up to its promises.
6. **Interaction with sandbox port exposure** (`Vercel Open Agents Review.md` §5.2). When that ships, we'll want hibernation to also persist the dev-server config, even though we can't restart the process for free. Out of scope here, flagged for the port-exposure design.

## Implementation plan

### Phase 0: Modal API spike (no production changes)

Files touched: `docs/research/Modal Snapshot Spike.md` (new).

Scope:
- Manual experiments against a real Modal account on the deployed sandbox image.
- Measure snapshot/restore times on representative workspaces (small Python repo, mid-size Next.js app, large monorepo).
- Confirm `/tmp` capture behavior, snapshot lifetime, pricing, quotas.
- Decide GO / NO-GO on the rest of the plan.

Exit criteria: spike doc filed; team agrees the numbers justify Phase 1.

### Phase 1: Backend snapshot primitives

Files touched:
- `sandbox/app.py` — new `snapshot_and_terminate()` and `restore_from_snapshot()` Modal functions; possibly relocate `OWNER_TOKEN_FILE` and `WORKSPACE_REVISION_FILE` out of `/tmp` if Phase 0 says so.
- Worker proxy (Cloudflare) — new routes for hibernate/restore.
- KV binding for the snapshot index.

Scope:
- `snapshot_and_terminate(sandbox_id, owner_token)` validates the owner, calls `sb.snapshot_filesystem()` (or whatever Phase 0 settles on), writes the snapshot ref to KV under `snapshot_key`, then `sb.terminate()`.
- `restore_from_snapshot(snapshot_key, owner_token_check)` looks up the snapshot, creates a new sandbox from it, returns the new sandbox ID.
- Both endpoints reuse the existing owner-token plumbing.

Exit criteria: hibernate-then-restore round-trip works end-to-end against a manual repro. No client wiring yet.

### Phase 2: Client wiring + idle policy

Files touched:
- `app/src/lib/sandbox-session.ts` — add `snapshotKey` to `PersistedSandboxSession`.
- `app/src/lib/sandbox-client.ts` — fallback path: on "container not found," look up the snapshot and call restore before giving up.
- `app/src/hooks/useChat.ts` (or wherever idle tracking lives — probably the run journal owner) — idle timer that fires `hibernate()` after N minutes of no tool calls.
- `app/src/lib/run-journal.ts` — extend `RunCheckpoint` with `snapshotKey`; update `detectInterruptedRun()` identity check accordingly.

Scope:
- Background idle hibernation.
- Lazy restore on next call.
- Capability-block phase additions.
- Telemetry events.

Exit criteria: a user can leave a session for an hour, return, and have the agent pick up with the working tree intact in <5s.

### Phase 3: UX polish

Files touched:
- Workspace Hub — "Hibernate sandbox" action, "Forget sandbox state" action.
- Resume banners — surface `snapshotAge` so the user knows how stale the workspace is on resume.
- Settings — "Hibernated sandboxes" list with manual-evict controls.

Scope: explicit user controls + visibility. Not load-bearing for the resume win; ship after Phase 2 has bedded in.

### Phase 4: Eviction + cron

Files touched:
- Worker cron job — daily walk of the snapshot index; evict expired entries; report metrics.
- KV index — schema additions for `lastAccessedAt`.

Scope: keep the snapshot store from growing unbounded.

## Design decisions

**Why filesystem snapshots, not memory snapshots?**
Modal's memory snapshot story is geared at Function cold-starts, not Sandboxes, and even where it exists it captures process state — which is actively *not* what we want, because we'd be capturing the `sleep infinity` shim that holds the sandbox open. Filesystem snapshots are the right primitive for "warm working tree, cold processes."

**Why lazy restore?**
Eager restore on app open burns money on sessions the user is just glancing at. Lazy restore pays the latency exactly when it matters and not before. We can revisit if Phase 2 telemetry shows first-tool-call latency is noticeable.

**Why per-`(repo, branch, user)` keying?**
Branches diverge in untracked state. Users diverge in secrets. Sharing snapshots across either dimension trades a small storage win for a large security and correctness loss.

**Why not store snapshots in our own object storage instead of Modal?**
We'd be reinventing Modal's image system and paying egress to ship gigabytes around. Modal already has the right primitive; we should use it and treat our KV index as a thin pointer layer.

**Why does the journal own identity, not the snapshot system?**
The journal already validates `sandboxSessionId`. Threading `snapshotKey` through is one field. Building a parallel identity system in the snapshot layer would duplicate validation and create two places to forget to update.

**Relationship to the Background Coder Tasks deferral.**
Background Coder Tasks would let the agent keep working while the user is gone. Snapshots let the workspace keep existing. They are independent and complementary — if Background Coder Tasks ships later, the snapshot system continues to work unchanged, and the two together get us to "true persistent agent."

## Alternatives considered

**Always keep containers warm via heartbeat.**
We could ping Modal every minute to keep `timeout` reset. This costs idle-container time-money for sessions the user has abandoned, doesn't survive any Modal-side eviction, and doesn't help with planned maintenance restarts. Snapshots are strictly cheaper at the cost of a few seconds of restore latency.

**Mirror the workspace to S3/R2 between mutations.**
We'd own the persistence layer outright but pay egress on every mutation, lose per-file dedup that Modal might be doing under the hood, and double the trust boundary the owner token has to defend. Rejected.

**Server-side run loop with no client-side journal.**
That's the deferred Background Coder Tasks plan from `Resumable Sessions Design.md`. It solves a different problem (keep working in the background). It doesn't help the "I'm back, please pick up where I left off" case any better than snapshots do, and it's a much larger re-architecture.

**Snapshot-on-every-mutation.**
Too expensive in both Modal billing and snapshot-ceremony latency. Idle-triggered snapshots are sufficient because the run journal already covers the "fresh interruption" case.