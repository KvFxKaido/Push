# Native Checkpoint Store

Date: 2026-06-22
Status: **Current** — capture↔restore device-validated end-to-end (2026-06-23,
Moto G). The full loop runs: inline edit → trigger → coordinator → git-aware
archive → download → on-device JGit commit, and **history Restore** → on-device
`archiveCommit` → large-upload route → `.git`-preserving sandbox sync, confirmed
with zero errors on-device. The three named remaining items all landed: **restore
device-validation** (this session), the **capture-efficiency tree-hash probe**
(skip the ~7 MB download on an unchanged tree, #1097), and the **restore
large-upload endpoint** (the dedicated 12 MB `upload` route, #1097 + Modal parity
here). Feature stays **flag-gated** (`VITE_NATIVE_CHECKPOINTS`), native-only; web
untouched — Current means the design is active, not that it's GA. Getting capture
working took fixing **three stacked bugs** the device test surfaced (below).
Owner: Push mobile/git.

## Device validation: the three stacked bugs (2026-06-22)

The original finding ("capture never fires in the inline lane") was the *first* of
three failures, each invisible until the one before it was fixed:

1. **No trigger.** The capture coordinator listens for the client-side
   `notifyWorkspaceMutation` signal (emitted by `sandbox-client.ts` writes /
   `markWorkspaceMutated` execs), but on-device the user is in the **inline lane**,
   whose edits dispatch through a detached / run-host path
   (`sandbox_exec_detached_dispatch`, `run_host_client_*`) that never reaches the
   client coordinator — so capture *and* the hub diff view (same signal /
   workspace revision) both went silent. **Scope: pre-existing and lane-wide, not
   native-specific** — it's the same coordinator/signal the remote B2 auto-back
   uses, so auto-back shares the blind spot; the native store inherited it. (The
   inline lane is "the collapsed lead", CLAUDE.md §10, converged onto after
   auto-back was built for the delegated web round-loop.) Fix: `chat-send-inline.ts`
   emits the signal at run completion when the workspace changed.
2. **Over-eager readiness gate.** `onMutation`/`schedule` hard-rejected on
   `enabled` (`sandbox.status === 'ready'`), which can be transiently false at
   mutation time. Fix: move readiness to the single `runBackup` gate (fires after
   the 45s debounce, when status has settled); keep only the sandbox-identity
   guard eager.
3. **Archive written to `/tmp`.** The capture built a 7 MB git-aware zip in `/tmp`
   and tried to fetch it — but the Cloudflare download endpoint rejects
   non-`/workspace` paths ("Path must be within /workspace"), and exec stdout is
   500 KB-capped so streaming the base64 wasn't an option. Fix: write the archive
   under `/workspace` (`.push-checkpoint.zip`), kept invisible to git via
   `.git/info/exclude` + an archive pathspec so it never pollutes status / diff /
   `add -A` / remote auto-back, and never lands in a checkpoint.

Each fix added the symmetric structured logs that were missing on the silent path
(per-stage `native_checkpoint_capture_failed`, `auto_back_skipped_unready`,
`auto_back_mutation_ignored`) — which is what turned "silently does nothing" into
"here is the exact failing line."

**Known design point (addressed):** because the agent commits the whole tree, the
git-aware archive is the *entire repo* (~7 MB for Push), re-downloaded every
debounced capture. The on-device JGit dedups identical trees (no new commit), but
the 7 MB download still happened each time. **Fixed (#1097):** capture now runs a
cheap tree-hash probe first (temp-index `git add -A` + `git write-tree` in the
sandbox, no mobile data) and short-circuits to `unchanged` before the download
when the working tree matches the last capture for that scope. Diff-based
transport is the **designed next step** for the changed-capture case — see
[Diff transport (capture): manifest-rsync](#diff-transport-capture-manifest-rsync).

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
   matches origin" failure mode. Clone-based **origin ancestry** (checkpoints
   related to the real project DAG) is **deferred** — but note this does NOT defer
   **checkpoint-to-checkpoint file diffs**, which fall out of Model 3 below for
   free (git diffs commit N against N-1 regardless of origin ancestry).
2. **Full-tree transport, NOT diff.** Capture streams the sandbox working tree to
   the device repo dir and commits it. Diff-based transport (lighter on mobile
   data, but needs the device base kept in sync) was **deferred** at this
   increment — since designed for the capture direction via manifest-rsync (the
   base-sync concern is resolved by having the device supply its own base each
   capture; see [Diff transport (capture)](#diff-transport-capture-manifest-rsync)).
3. **Tree-in-JGit (Model 3), NOT archive-blob.** The on-device archive is
   **extracted into the repo worktree** and committed as real files, so git tracks
   a true tree — not stored as an opaque archive blob. This is the product vision
   (browsable history + per-checkpoint diffs) and it is also the most
   storage-efficient across many checkpoints (git delta-packs similar trees; N
   blob archives would each be full). It stays consistent with forks 1–2: still
   `git init` (no clone), still full-tree transport — the only addition is
   extracting the tree so git sees files.

## Capture / restore data flow (Model 3)

The sandbox↔archive transport already exists (the snapshot system:
`downloadFromSandbox` ↔ `hydrateSnapshotInSandbox`, both HTTP to the Worker, both
work on native). Model 3 uses it as follows:

**Capture** (sandbox WIP → on-device commit):
1. A **git-aware** archive of the sandbox working tree, via `execInSandbox` —
   `git ls-files -z --cached --others --exclude-standard | tar --null -czf - -T -`
   (tracked + untracked, `.gitignore`-respecting, WIP included; `git archive HEAD`
   would miss untracked WIP), plus the hard-exclude list + size cap. NOT the raw
   `downloadFromSandbox` endpoint, which is not git-aware and would tar
   `node_modules`.
2. The base64 archive → `NativeGit.commitWorkingTree(dir, archive, message)`:
   clear the worktree (**keeping `.git`**), extract, `git add -A` (so deletions
   stage → delete-faithful), commit. Returns the commit id.

**Restore** (on-device commit → fresh sandbox that already has a clone):
1. `NativeGit.archiveCommit(dir, commitId)` → the checkpoint tree as a base64
   ZIP.
2. Apply into the sandbox via `execInSandbox` with a **`.git`-preserving,
   delete-faithful** sync (see finding below) — leaving the recovered work as
   unstaged changes on the existing clone (matching auto-back restore semantics).

### Finding: the hydrate endpoint can't be reused verbatim for restore

`hydrateSnapshotInSandbox` (`sandbox/app.py` restore handler) is clear-then-extract
— it runs `find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf` which **deletes
`.git` too**, then extracts. That's correct for a *full snapshot* (the archive
carries `.git`), but **wrong for a checkpoint restore**: the git-aware capture
excludes `.git`, and restore lands on a fresh sandbox whose clone `.git` (origin,
branch) must be preserved. So checkpoint restore uses a **`.git`-preserving**
variant via `execInSandbox`:

```
cd /workspace && find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
unzip -o -q /tmp/push-checkpoint-restore.zip -d /workspace
```

Delete-faithful (clears all working files except `.git`) and repo-preserving. No
new Worker endpoint needed (the sandbox has `git`/`tar`/`base64`, no `rsync`).
Restore refuses on a dirty working tree (don't clobber live work), mirroring
auto-back restore.

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
2. **Native capture + restore (Model 3).** Built as two slices landed together:
   - **2a (JS, device-free):** grow the interface with `list()`; add the four
     plugin TS definitions (`commitWorkingTree` / `archiveCommit` /
     `listCheckpoints` / `pruneCheckpoints`) + web stub; implement
     `NativeJgitCheckpointStore` over them — capture via the git-aware ZIP exec,
     restore via the `.git`-preserving sync exec, list via the plugin; unit-test
     the orchestration with a fake plugin.
   - **2b (Kotlin + device):** the four `JGitEngine`/plugin methods (extract +
     `add -A` + commit; tree → ZIP; `git log`; prune) and end-to-end device
     validation of the capture→commit→restore round-trip on the Moto G.
3. **Restore-coordinator wiring + UX.**
   - **3a (shipped):** routed `useWorkspaceSandboxRestore` through the store
     (both coordinators now backend-agnostic), keyed on the full lane scope.
   - **3b (UX, shipped):** the checkpoint-history browse/restore surface — `useCheckpointHistory`
     + a presentational `CheckpointHistoryList` + a self-gating `CheckpointHistory`
     container (renders nothing off the native shell / flag), mounted in the
     workspace hub sheet next to hibernate/snapshot. Web-safe; on-device visual +
     list/restore e2e is the device-session follow-up.
   - **3c (shipped):** inline-lane mutation trigger + capture telemetry fixes;
     capture now flows end-to-end on-device.
   - **3d (shipped, #1097 + this PR):** the restore large-upload endpoint (the
     dedicated 12 MB `upload` route; CF in #1097, Modal `file-ops`/`write` parity
     here) and the capture-efficiency tree-hash probe. Restore round-trip
     device-validated on the Moto G (2026-06-23) — capture → history Restore →
     `.git`-preserving sync, zero errors. This is the flip-to-**Current** PR.
   - Remaining (non-blocking, deferred): diff-based transport, and the
     known-limitation follow-ups below (exec-bit/symlink preservation,
     empty-tree-deletion checkpoints).

## Known limitations

- **Exec bit / symlinks not preserved.** ZIP extraction via `java.util.zip` writes
  every entry as a plain file, so a tracked executable or symlink round-trips as a
  non-executable regular file — a mode/semantics diff on restore even when content
  matches. (tar would preserve these; the ZIP choice was to avoid an Android tar
  dependency. Reconsider tar + Apache Commons Compress in PR3 if this bites.)
- **Empty-tree deletion not checkpointed.** When the working tree has no files,
  `zip -@` produces no archive and capture reports `clean`, so deleting the last
  file isn't recorded — a later restore could resurrect it. Needs an explicit
  empty-checkpoint path.
- **Same-second checkpoint ordering is ambiguous.** "Newest" is resolved by
  git `commitTime`, which is second-resolution, and checkpoints are orphan refs
  with no parent chain — so two checkpoints committed in the same second have an
  undefined relative order. The 45 s capture debounce makes this rare, and diff
  transport's **verify-before-publish** prevents the dangerous case (a *wrong* ref
  can't land; a stale same-second base just makes the delta verify fail and fall
  back). The residual is low-severity: a restore could pick the older of two valid
  near-simultaneous checkpoints. A monotonic `refs/checkpoint-latest` pointer
  updated on every commit would make it deterministic — deferred follow-up.
- ~~**Restore upload is ~5 MB-capped.**~~ **Resolved (#1097 + this PR).** Restore
  no longer uploads through the ~5 MB `write` route; it uses a dedicated `upload`
  route in the 12 MB body tier. On **Cloudflare** it writes via the uncapped
  sandbox SDK path with `realpath -m`-based `/workspace` confinement (blocks `..`
  *and* symlinked-dir escape). On **Modal** it forwards to `file-ops`/`write` (no
  dedicated function) — the same path, and the same `normpath`/prefix-based
  confinement, the pre-route restore already used, so this is parity, not a new
  guarantee. (The two backends' confinement strength differs; that asymmetry
  predates this change.) A ~7 MB whole-tree checkpoint (~9 MB base64) now
  restores; the device-validated round-trip exercised exactly this path.

## Diff transport (capture): manifest-rsync

**Status: shipped + device-validated (2026-06-24, Moto G).** The production
checkpoint path captured a real delta on-device — `native_checkpoint_captured_delta`
with **`deltaBytes: 208`** (vs the ~7 MB full tree). An isolated transport run
confirmed correctness: base manifest **1696** files → new **1697** (one added) →
**193-byte** delta archive → `commitDelta committed: true`, with **no verify
mismatch, no `valDiff`, no file-count gap, no lock noise**. That `1696` is the
receipt for the on-device fixes — the broken run was `actual=1665 expected=1696`
(31 em-dash files dropped by `core.quotePath`); now the full set is present and the
raw-bytes hashing agrees end-to-end. Capture-direction only; restore stays on the
full-tree upload path (rare, user-initiated, already in the 12 MB tier — its diff
variant is still deferred, see Out of scope).

**Known timing behavior (benign):** if the model `git commit`s locally before the
debounced snapshot fires, the working tree is clean by capture time, the diff is
`empty_delta`, and capture **falls back to a full** — the work is still
checkpointed, just not via the delta. A timing miss, not a verify failure; not
worth chasing (rare, self-healing).

### Problem

Even with the tree-hash probe short-circuiting *no-change* debounces, a capture
that *does* change still ships the **entire** git-aware tree (~7 MB for Push) over
mobile data — on every 45 s debounce after edits. A one-line edit costs 7 MB. The
goal: transmit only what changed since the last checkpoint.

### Constraint that shapes it

The sandbox's git repo is the **origin clone**; the device's checkpoint repo is a
separate `git init`. They **share no object store**, so the sandbox cannot
`git diff` against a device checkpoint commit. Any design that bridges the two
object stores re-introduces exactly the "keep the device base in sync" coupling
this doc deferred (first-increment fork 2).

### Decision: device-supplied manifest, stateless sandbox diff (manifest-rsync)

The device supplies its own base each capture; the sandbox holds **no checkpoint
state**:

1. **device → sandbox:** the base manifest — `path → blobhash` for the **newest
   checkpoint** (gzipped; ~tens of KB for Push, vs the 7 MB that flows the other
   way). Blob hashes are **content-only, over raw file bytes** — load-bearing, see
   Correctness constraints below.
2. **sandbox:** stage the working tree into the **throwaway index** (the probe
   already does this — `git add -A` into `GIT_INDEX_FILE=/tmp/…`), then read the
   *current* manifest from that index (`git ls-files -s`, content hashes). Diff it
   against the supplied base:
   - changed/new paths → the delta archive;
   - paths in base but not current → a **deletion list** (delete-faithful).
   Build the delta **from the staged index's object IDs**, not a re-read of the
   worktree — so the manifest, the delta bytes, and the returned tree hash are one
   atomic snapshot; a worktree write mid-capture can't desync them.
3. **sandbox → device:** the delta archive (small) + deletion list + the new tree
   hash. This is the only payload that crosses mobile data.
4. **device:** apply the delta **onto the existing worktree** (do *not* clear):
   write the changed files, remove the deleted paths (handling dir↔file
   transitions — see plugin surface), `git add -A`, commit a new orphan
   checkpoint. Then **verify the resulting tree matches the returned tree hash**;
   on mismatch, discard and fall back to a full capture. Same result tree as a
   full capture, a fraction of the bytes.

The sandbox needs **zero persisted state** — it survives restarts because the
device re-supplies the base every capture. That is what defuses the base-sync
objection: the base lives where it is authoritative (the device) and travels up
cheaply (hashes, not contents).

### Base = newest-checkpoint tree, and the fallback

Checkpoints are **orphan commits under `refs/checkpoints/<sha>`** — there is no
branch and **HEAD never moves** (`JGitEngine.commitWorkingTree`). The base is the
**newest checkpoint ref's tree**, *not* HEAD. The device worktree happens to track
it because each full capture extracts that tree (`replaceWorktree`) and each delta
applies onto it — so after any successful commit the worktree equals the newest
checkpoint's tree. The device guards this: before applying a delta it confirms its
current worktree manifest matches the base it sent (cheap — the same hash set). On
**any** mismatch — first capture, no prior checkpoint, an app-restart cache miss,
or worktree drift — it **falls back to the existing full-tree capture**, and the
post-apply tree-hash verification (step 4) catches a delta that applied wrong. Diff
transport is an optimization layered over the proven full path, never a replacement
that can strand a capture.

### New plugin surface

- `listManifest(dir)` → `path → blobhash` of the **newest checkpoint ref's** tree
  (cheap JGit `TreeWalk`; **not** HEAD — checkpoints are orphan refs and HEAD
  doesn't track them). The authority for the base manifest (a JS-side cache can
  prime it, with this as the fallback on cache miss).
- `commitDelta(dir, deltaArchiveBase64, deletedPaths, message)` → apply onto the
  worktree without clearing — write changed files, remove deleted paths, and
  **handle dir↔file transitions** (delete a directory before writing a file at its
  path, and vice versa; there's no clear-first to lean on) — then `add -A`, commit
  an orphan checkpoint, and **return the resulting tree hash** for the caller to
  verify against the sandbox's. Sibling to `commitWorkingTree`, which stays for the
  full-tree fallback.

### Correctness constraints (from design review)

Load-bearing, not polish — a content-hash diff across *two* git implementations is
only sound if a hash means the same thing on both sides:

- **Raw-bytes hashing, no filters.** The base manifest is JGit-computed (device),
  the current manifest C-git-computed (sandbox). So **both sides must hash raw file
  bytes with EOL/clean filters and `core.autocrlf` disabled.** The unsafe failure
  is specifically `autocrlf`: it can canonicalize CRLF and LF content to the *same*
  blob, making a line-ending-only change hash as **unchanged** → silently dropped
  (a false *unchanged*, the only dangerous direction). The reverse (same content,
  different hash) only yields a false *changed* — a bigger delta, still correct.
  Repos with `.gitattributes` clean filters / LFS are the live risk; disabling
  filters for manifest+delta hashing closes it, and the drift-check + full-tree
  fallback contains anything missed.
- **Mode / symlinks out of scope.** Manifest hashes are content-only and the ZIP
  transport already writes regular files (the existing exec-bit/symlink
  limitation). A chmod-only change therefore yields an *empty* content delta; the
  device no-ops it (the on-device tree already dedups identical trees). Consistent
  with today's behavior, not a regression — but it means the sandbox's mode-aware
  `git write-tree` hash must **not** be the delta-emptiness signal; the manifest
  diff is the sole authority on what changed.

These two surfaced during on-device validation (2026-06-23) — both made every
delta verify fail, and the second is also a latent bug in the *full*-capture path:

- **`.gitattributes` EOL normalization (device side).** The captured tree carries
  the project's `.gitattributes` (Push's is `* text=auto eol=lf`, `*.cmd/*.bat
  eol=crlf`), and JGit's `add()` honored it — normalizing content the sandbox
  hashed raw (`--no-filters`), so blob ids diverged. Fix: write `* -text` into the
  checkpoint repo's `.git/info/attributes` (highest attribute precedence), forcing
  raw-bytes blobs that match the sandbox. (#1108 separately builds the index by
  hand via `DirCacheEntry`/`FileMode`, which bypasses `add()`'s filtering at the
  source — so the two are now belt-and-suspenders; either alone suffices, and one
  could be dropped in a cleanup.)
- **`core.quotePath` drops non-ASCII paths.** `git ls-files` C-quotes non-ASCII
  paths by default (em-dash → `"…\342\200\224…"`); `zip -@` then can't find the
  file and **silently omits it**. So every non-ASCII-named file was missing from
  checkpoints (full capture *and* delta). Fix: `git -c core.quotePath=false
  ls-files` everywhere paths feed `zip`/`hash-object`.

### Rejected alternative: git-bundle bridge

Make the sandbox aware of the device checkpoint commit (export device objects into
the sandbox, or keep a parallel checkpoint branch there) and ship a real packfile
delta. More git-native, but it forces the two repos to share object state — the
exact coupling manifest-rsync avoids — and adds a new failure surface (a drifted or
absent bridge ref) for no payload-size win over content-hash diffing.

### Caveats (unchanged by this)

- The manifest is a small **upload** each capture — the inverse trade (KB up to
  save MB down). Net win is large, but it is not free; gzip the manifest.
- **Exec-bit / symlinks** are still ZIP-bound (a separate known limitation); the
  delta archive inherits it. Orthogonal to transport size.

## Out of scope (deferred, not rejected)

- Diff-based transport **for restore** (the capture direction is now designed —
  see [Diff transport (capture): manifest-rsync](#diff-transport-capture-manifest-rsync);
  restore stays full-tree for now, since it's user-initiated and rare).
- Clone-based device repo with origin ancestry.
- Native-as-live-push-path and its pushed-diff source (the Deferred sibling doc).
- A local secret scanner for checkpoints (first version relies on app-private +
  retention + clear + sensitivity marking; revisit if the blast radius warrants).

## Status flip plan

Flipped to **Current** (2026-06-23): the restore device-validation and
transport-efficiency fixes that gated the promotion have all landed (see the PR
sequencing above). Remaining work is deferred/non-blocking, not a barrier to
Current. Next: fold the durable parts into
[`Platform, Sessions, and Sandbox Decisions.md`](<Platform, Sessions, and Sandbox Decisions.md>)
when the arc stabilizes.

---

*Design synthesized from a three-way exchange (Shawn + Claude + a ChatGPT review).
ChatGPT contributed the `CheckpointStore`-with-backends framing and the
local-storage blast-radius pushback; the thin-adapter constraint, the
debuggable-APK caveat, and the delete-aware restore note were added in review.*
