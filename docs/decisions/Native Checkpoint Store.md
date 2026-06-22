# Native Checkpoint Store

Date: 2026-06-22
Status: **Capture device-validated end-to-end** (2026-06-22, Moto G) — PR1–PR3b
landed; a capture now flows inline edit → trigger → coordinator → archive →
download → on-device JGit commit, confirmed by an orphan checkpoint ref on disk.
Getting there took fixing **three stacked bugs** the device test surfaced (below).
Feature stays dormant (behind `VITE_NATIVE_CHECKPOINTS`) pending the remaining
work: **restore** device-validation, the **7 MB-per-capture** efficiency fix, and
the restore large-upload endpoint. Not roadmap-promoted. Owner: Push mobile/git.

## Device validation: the three stacked bugs (2026-06-22)

The original finding ("capture never fires in the inline lane") was the *first* of
three failures, each invisible until the one before it was fixed:

1. **No trigger.** The capture coordinator listens for the client-side
   `notifyWorkspaceMutation` signal, but the inline lane's edits dispatch detached
   / run-host, so it never fired. Fix: `chat-send-inline.ts` emits the signal at
   run completion when the workspace changed.
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

**Known design point (next):** because the agent commits the whole tree, the
git-aware archive is the *entire repo* (~7 MB for Push), re-downloaded every
debounced capture. The on-device JGit dedups identical trees (no new commit), but
the 7 MB download still happens each time. Capture should skip the download when
the tree is unchanged (cheap tree-hash probe first), or move to diff transport.

## Historical device finding (2026-06-22, Moto G) — fixed by PR3c

A flag-on local-bundle build was driven on-device. Result:

- **Verified working:** `listCheckpoints` is called on the correct lane dir and
  returns its result; the UI → `useCheckpointHistory` → store → `NativeGit` plugin
  → list path is sound, and the JGit engine itself passes its JVM tests. Nothing
  below the trigger is wrong.
- **Original failure: capture never fired.** After a real multi-file change, there were **zero**
  `native_checkpoint_*` AND zero `auto_back_*` log events, and `files/checkpoints/`
  was never created on the device (the native repo is `git init`-ed on first
  capture). The capture *coordinator* (`useWorkspaceSandboxAutoBack`) didn't run at
  all — neither the native store nor the remote draft-ref path.

**Root cause (high confidence):** the capture coordinator triggers off the
client-side `notifyWorkspaceMutation` signal (emitted by `sandbox-client.ts`
writes / `markWorkspaceMutated` execs). On-device the user is in the **inline
lane**, whose edits dispatch through a **detached / run-host path**
(`sandbox_exec_detached_dispatch`, `run_host_client_*`) — and that signal isn't
reaching the client coordinator. No signal → no debounced capture → nothing
written. The same gap explains the hub **diff view** not picking up changes (it
keys off the same mutation signal / workspace revision).

**Scope: this is a pre-existing, lane-wide gap, not native-specific.** It is the
*same* coordinator and signal the remote B2 auto-back uses, so remote auto-back
almost certainly has the same blind spot in the inline lane. The native
checkpoint store inherited it; it did not introduce it. The inline lane is "the
collapsed lead" (CLAUDE.md §10) and was converged onto after auto-back was built
for the delegated web round-loop.

**Fix (landed and capture device-validated):** `chat-send-inline.ts` now emits
`notifyWorkspaceMutation(sandboxId)` at inline-run completion when the run changed
the workspace (`workspaceChanged`), paired with an `inline_workspace_mutation_signaled`
log. This is the deterministic trigger — the per-tool signals fire *during* the
run (coordinator possibly gated, WebView possibly backgrounded with throttled
timers), so re-firing at completion (run done, sandbox ready) reliably arms the
capture debounce and invalidates the diff cache. It fixes BOTH symptoms (capture
+ hub diff) since both consume the one signal. A symmetric `auto_back_skipped_unready`
log was added to the coordinator's silent early-return. Done in the inline lane,
not the checkpoint store — the store was always correct.

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
   data, but needs the device base kept in sync) is **deferred**.
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
   - Remaining: restore device-validation, the capture efficiency fix (avoid the
     ~7 MB full-tree download when unchanged), restore large-upload endpoint, and
     broader capture/restore failure telemetry.

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
- **Restore upload is ~5 MB-capped.** Restore uploads the archive through
  `writeToSandbox` (the only `/workspace`-writable path), which is ~5 MB-capped,
  while capture's download path is uncapped (64 MB). Large checkpoints capture but
  can't restore until a dedicated large-upload endpoint lands with the restore
  wiring.

## Out of scope (deferred, not rejected)

- Diff-based transport (revisit when full-tree mobile-data cost bites).
- Clone-based device repo with origin ancestry.
- Native-as-live-push-path and its pushed-diff source (the Deferred sibling doc).
- A local secret scanner for checkpoints (first version relies on app-private +
  retention + clear + sensitivity marking; revisit if the blast radius warrants).

## Status flip plan

Note PR1/2/3 inline as they land; promote to **Current** when the remaining
restore device-validation and transport-efficiency fixes land. Fold durable parts into
[`Platform, Sessions, and Sandbox Decisions.md`](<Platform, Sessions, and Sandbox Decisions.md>)
when the arc stabilizes.

---

*Design synthesized from a three-way exchange (Shawn + Claude + a ChatGPT review).
ChatGPT contributed the `CheckpointStore`-with-backends framing and the
local-storage blast-radius pushback; the thin-adapter constraint, the
debuggable-APK caveat, and the delete-aware restore note were added in review.*
