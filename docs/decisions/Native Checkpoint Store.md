# Native Checkpoint Store

Date: 2026-06-22
Status: **Proposed** — design agreed (three-way: Shawn + Claude + ChatGPT review).
PR1 (the `CheckpointStore` abstraction + adapters + capture-coordinator wiring,
`app/src/lib/checkpoint/`) has **landed**; native capture (PR2) and restore wiring
(PR3) remain proposed. Not roadmap-promoted. Owner: Push mobile/git.

## Context

Push already has a checkpoint/backup primitive: **B2 auto-back**
(`app/src/lib/sandbox-auto-back.ts`, shipped 2026-06). It captures the cloud
sandbox's working tree into an off-HEAD commit and **force-pushes it to a remote
draft ref** (`origin/draft/auto/<branch>`). The durable home for in-progress work
is GitHub. That model is web/cloud-sandbox scoped and depends on network + push
auth, and it puts WIP on a shared remote (which is why it is secret-scanned).

On the Android shell two things are true that aren't on web: there is **durable
on-device storage**, and there is a **validated on-device git engine** (JGit, via
`capacitor-native-git` — clone/commit proven on-device 2026-06). That makes the
device a *better* durable home for mobile checkpoints than a remote draft ref:

- survives sandbox loss **and** offline (no network dependency),
- no WIP leaves the device (nothing reaches origin),
- no push auth for the backup itself.

This doc decides how to use that without spawning a second, drifting backup system.

## Decision

Introduce a **`CheckpointStore`** abstraction and keep the existing checkpoint
*coordinator* (when to capture) and *restore UX* (offer-to-restore) as the single
pipe. Only the storage *reservoir* is pluggable:

- **`RemoteDraftRefCheckpointStore`** (web/cloud) — a **thin adapter over the
  existing auto-back functions**. Not a rewrite of auto-back internals; it
  delegates, so freshly-shipped B2 code is not restructured to fit a retrofitted
  interface.
- **`NativeJGitCheckpointStore`** (APK/native) — an **app-private `git init`
  repo** on the device. Each checkpoint is a full-tree commit into that local
  repo. Selected behind an APK build flag.

Three roles, one source of truth each — matching Push's seam style (the
`git-session.ts` selection seam, `SandboxProvider`):

- **CheckpointCoordinator** — decides *when* to capture (existing debounce cadence).
- **CheckpointStore** — decides *where* it lives (this abstraction).
- **RestoreUX** — decides *how* recovery is offered (existing offer-to-restore).

This is **not** "native git backend takes over." The native checkpoint repo is a
**separate backup dir**, never the session's active working copy. The increment-1
selection seam stays dormant; checkpointing is a parallel consumer of the native
git engine — "native git holds the parachute," not flies the plane.

### Why this over native-as-live-push-path

Local checkpoints never push, so they never touch the pre-push gates — which
removes the entire pushed-diff-source / gate-unification increment (see
[`Native Git Runtime Integration.md`](<Native Git Runtime Integration.md>), now
Deferred). It reaches the mobile work-loss goal sooner, reuses the coordinator +
restore UX (minimal new UI), and is flag-gated and native-only (web untouched).

## First-increment forks (decided)

1. **`git init` + full-tree snapshots, NOT clone-based.** The job is "do not lose
   my sandbox work," not "maintain a faithful project DAG." `git init` needs zero
   auth, makes no claim to origin's history, and has no "checkpoint base no longer
   matches origin" failure mode. History is just `checkpoint 1, 2, 3…` — enough to
   restore a filesystem moment. Clone-based ancestry (real base, cheap diffs) is
   **deferred** until there's real pain, not architectural prophecy.
2. **Full-tree transport, NOT diff.** Capture streams the sandbox working tree to
   the device repo dir and commits it. Diff-based transport (lighter on mobile
   data, but needs the device base kept in sync) is **deferred**.

## The `CheckpointStore` interface (sketch)

```ts
interface CheckpointStore {
  capture(input: CheckpointCaptureInput): Promise<CheckpointRecord>;
  list(scope: CheckpointScope): Promise<CheckpointRecord[]>;
  restore(checkpointId: string, target: RestoreTarget): Promise<RestoreResult>;
  prune(policy: RetentionPolicy): Promise<void>;
}
```

The interface must be shaped by **both** concretions before it is locked: auto-back
capture is push-shaped (`commit-tree` + force-push to a ref), native capture is
filesystem-shaped (stream tree → JGit commit). Validate the shape with the native
*skeleton* in the same PR that introduces the interface, so it isn't a Procrustean
bed built around auto-back's current form.

## Capture: exclusions and size

Capture must be **`.gitignore`-respecting** (auto-back already is) **plus** a hard
exclusion list and a size cap, so the first mobile experience isn't "checkpoint
captured 1.7 GB of webpack moss":

- always exclude: `.git/`, `node_modules/`, `dist/`, `build/`, `.next/`, `.cache/`,
  `coverage/`, `target/` (and per-project large-binary patterns over a size cap);
- **do NOT exclude `.env` / credential files by default.** The point is faithful
  recovery — a restore that silently drops the file needed to *run* the project is
  a worse lie than no restore. Instead, treat the whole store as sensitive (below).

## Restore semantics

Restore is **"sync the working tree *to* the checkpoint tree"** — add/update **and
delete** — not "unzip on top." A checkpoint taken after a file was deleted must,
on restore, remove that file from the target sandbox; a plain extract would leave a
stale file and produce an unfaithful restore. Successful restore leaves recovered
changes **unstaged** in the target working tree (matching auto-back restore today).

## Security / blast radius

Persistent local storage is a **larger blast radius than the ephemeral sandbox**: a
secret in sandbox temp dies with the sandbox; a secret committed into a durable
hidden checkpoint repo persists. "Local" is not "harmless." Mitigations are
load-bearing, not polish:

- **App-private internal storage only** — never Android external/shared storage.
  The JGit plugin already resolves relative dirs under `getContext().filesDir`
  (app-private), which is the correct target.
- **Caveat — the experimental APK is `debuggable`.** On a debug build, `adb backup`
  / `run-as` can read app-private storage over USB, so app-private is *not* a hard
  boundary against a USB-connected attacker. This is acceptable for an experimental
  flag, but it is *why* the retention cap + manual-clear matter — they are the real
  mitigation, since the storage boundary itself is soft on debug builds.
- **Retention cap** — bound checkpoint count/age (also bounds storage growth).
- **Manual "clear checkpoints" action** (can land after the first increment).
- Mark checkpoint storage **sensitive** in any surfacing.

## PR sequencing

1. **Interface + adapters (no transport yet).** ✅ *Landed.* Defined
   `CheckpointStore` (`app/src/lib/checkpoint/`); `RemoteDraftRefCheckpointStore`
   as a thin delegating adapter over existing auto-back (untouched);
   `NativeJGitCheckpointStore` skeleton (clean `unsupported`/`unavailable` returns
   + structured logs, behind `VITE_NATIVE_CHECKPOINTS`); the capture coordinator
   (`useWorkspaceSandboxAutoBack`) routes through `resolveCheckpointStore()` with
   an opaque dedup token (replacing the git `tree:head` pin — the remote store
   encodes/decodes it); contract test for both backends + the selector. The
   restore *coordinator* keeps calling auto-back directly until PR3; the store's
   restore methods are contract-tested but not yet live-wired. `list`/`prune`
   (retention) deferred to PR2 with native capture.
2. **Native capture.** Sandbox tree download with exclusions + size cap → write to
   the app-private checkpoint repo → JGit commit → retention cap. Symmetric
   structured logs per branch.
3. **Native restore.** Restore a selected checkpoint into a sandbox (sync,
   incl. deletions) → reuse offer-to-restore UX → capture/restore failure telemetry.

## Out of scope (deferred, not rejected)

- Diff-based transport (revisit when full-tree mobile-data cost bites).
- Clone-based device repo with origin ancestry.
- Native-as-live-push-path and its pushed-diff source (the Deferred sibling doc).
- A local secret scanner for checkpoints (first version relies on app-private +
  retention + clear + sensitivity marking; revisit if the blast radius warrants).

## Status flip plan

Note PR1/2/3 inline as they land; promote **Proposed → Current** when the native
capture+restore path is device-validated end-to-end. Fold durable parts into
[`Platform, Sessions, and Sandbox Decisions.md`](<Platform, Sessions, and Sandbox Decisions.md>)
when the arc stabilizes.

---

*Design synthesized from a three-way exchange (Shawn + Claude + a ChatGPT review).
ChatGPT contributed the `CheckpointStore`-with-backends framing and the
local-storage blast-radius pushback; the thin-adapter constraint, the
debuggable-APK caveat, and the delete-aware restore note were added in review.*
