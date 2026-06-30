# Checkpoint Recovery on Sandbox Loss (Increment 2)

Date: 2026-06-24
Status: **Current** — PR1 (the cloud-snapshot gate + cold-start-on-loss spine)
is implemented (#1136) and **device-validated on the Moto G** (2026-06-24). The
core decision — native shell recovers from the on-device checkpoint, never the
cloud — is shipped and proven. The consistency/ordering items below are tracked
as follow-up hardening (PR2+), not blockers for this decision.

## Device validation (2026-06-24, Moto G)

The container was killed server-side mid-session (cleanup endpoint, in the app's
own auth context) to force a real definitive loss. Captured live in logcat:

- **Loss detected** as definitive — `Refresh: container gone … NOT_FOUND` (the
  health-check probe classified it correctly, not transient).
- **Retire fired, not cloud restore** — `{"event":"sandbox_retired_dead_id_native"}`
  with **zero** `Attempting restore from snapshot` lines; the saved session had
  `snapshotId: null` (nothing ever shipped to Modal).
- **Unstranded → cold-start** — dropped to idle, and the next message cold-started
  a fresh sandbox; the agent turn then ran clean on it (`inline_turn_completed
  outcome:ok`) — "Cloudflare sees it and continues as normal" for the fresh-clone
  path.
- **Checkpoint survived the loss** — `CheckpointHistory` still listed the latest
  on-device commit (keyed by repo+branch, not sandbox).
- **UI confirmed** — the on-device restore banner appeared on the fresh sandbox,
  and the hub's Hibernate strip was hidden on the native shell.

The one path *not* exercised here is restoring the checkpoint *onto* a fresh
sandbox and the derived-cache coherence that follows — see the cache-invalidation
follow-up below (PR2).

## Implementation status

**PR1 — landed + validated (cloud snapshots off on native, local is the only recovery):**
the `nativeCheckpointsActive()` predicate (native shell + flag, the same switch
`selectCheckpointStore` uses) gates every cloud-snapshot path in `useSandbox`:
idle keep-warm hibernation (activity bookkeeping preserved, only the snapshot
skipped), manual `hibernate()`, and `attemptSnapshotRestore` on reconnect. The
liveness probe stays. Loss no longer strands on a dead id: `refresh`'s
definitively-gone branch and the tool-path `markUnreachable` (via a silent probe)
retire the id → idle so the next `ensureSandbox` cold-starts and the on-device
checkpoint offer fires against the fresh sandbox (which it reaches by construction
— `restoredFromSnapshotSandboxId` stays null on native). The hub's
hibernate/restore/forget affordances are hidden on native.

**PR2 — landed (post-restore cache invalidation):** both stores' `restore()` now
call `invalidateWorkspaceSnapshots(sandboxId)` on success, so a whole-tree restore
clears the file-version cache, prefetched-edit cache, and symbol + file ledgers
(not just the mutation listeners) — the load-bearing "continues as normal" item.
The gap was *shared* with the increment-1 manual restore (and the remote/web
store), so the fix covers both stores. See Post-restore consistency below.

**Deferred to follow-up PRs:** native-restore-before workspace-patch-replay
ordering; resume "re-apply" suppression in `useChatCheckpoint`; detection↔capture
race ordering; auto-restore-vs-banner UX; and eager auto-cold-start-without-user-
action on mid-session loss (PR1 unstrands, so recovery fires on the next
sandbox-requiring action).

Increment 2 of the native checkpoint arc. Increment 1 (the manual
capture↔restore loop + diff transport) is shipped and device-validated — see
[`Native Checkpoint Store.md`](<Native Checkpoint Store.md>), which deferred
"automated recovery on sandbox loss + UI surfacing" to here. This doc decides how
recovery behaves on the **native APK shell** when the cloud sandbox is lost.

## The problem (verified in code, 2026-06-24)

On the APK today the **cloud snapshot system preempts the on-device checkpoint** —
the opposite of what the native store is for. Three facts, all in
`app/src/hooks/useSandbox.ts` (which has **no `isNativePlatform` gate anywhere**):

1. **Idle hibernation leaks WIP to the cloud.** Every 45 min idle
   (`IDLE_HIBERNATE_MS`) it calls `hibernateSandbox(id, { keepWarm: true })`
   (line ~473), snapshotting the working tree — WIP included — into **Modal**.
   That is exactly the "no WIP leaves the device" guarantee the native store
   exists to provide, violated.
2. **Recovery comes from the cloud.** On sandbox loss the reconnect effect calls
   `restoreFromSnapshot(saved.snapshotId, …)` (line ~250) — restoring from the
   Modal snapshot, not the device checkpoint.
3. **It then silently gates off the local offer.** The native checkpoint restore
   (`useWorkspaceSandboxRestore`) is `enabled` only when
   `restoredFromSnapshotSandboxId !== sandbox.sandboxId`
   (`WorkspaceSessionScreen.tsx` line ~118). So once a cloud snapshot restores,
   the local checkpoint banner **never shows**.

Net on the APK: cloud wins, WIP travels to Modal, and the recovery the user
actually wants is suppressed. "Interfering at worst, visually confusing at best"
— confirmed.

## Decision: on the native shell, local is the only recovery

When native checkpoints are active (`isNativePlatform() && VITE_NATIVE_CHECKPOINTS`),
the **cloud snapshot system is off** and the on-device checkpoint is the single
recovery path. So **local always wins** — there is no second reservoir to lose to.

- **No hibernation to Modal — idle AND manual.** Gate off the idle-timer
  hibernation *and* the manual `useSandbox.hibernate()` (the hub's **Hibernate**
  button + the snapshot **Restore** affordance, `WorkspaceHubSheet.tsx` ~1474 /
  ~1525, `WorkspaceChatRoute.tsx` ~784). Idle alone isn't enough — a hand-tapped
  hibernate still ships WIP to Modal. Hide those affordances on the native shell.
- **Loss → retire the dead id, then cold-start.** Gating off `restoreFromSnapshot`
  is **not sufficient** — a lost sandbox today leaves the dead `sandboxId` in
  place (`refresh`/`markUnreachable` keep it, `ensureSandbox` returns it without a
  status check, `useWorkspaceSandboxController.ts` ~118). So native loss handling
  must explicitly **clear/retire the dead id and create a fresh sandbox** (normal
  clone from origin), then restore the native checkpoint into it (the existing
  `.git`-preserving, delete-faithful sync). Without the retire step, gating the
  snapshot path **strands** the session on a dead id instead of cold-starting.
- **Keep the liveness probe.** The warm-reconnect *probe* (`execInSandbox(id,
  'true')` — "is my container still alive?") stays; it reattaches to a live
  container with no restore. Only the *snapshot* halves are gated off.
- **One switch, not a new flag.** Gate the cloud snapshot paths on
  `!(isNativePlatform() && isNativeCheckpointsEnabled())` — the same condition
  that already selects the native store (`selectCheckpointStore`). "If you're on
  native checkpoints, you're not on cloud snapshots." (A dedicated kill-switch
  flag is trivial to add later if an override is ever wanted; not needed now.)
- **Split "touch activity" from "take snapshot."** The idle effect persists
  `lastActivityAt` *before* the snapshot decision (`useSandbox.ts` ~418), and
  reconnect recoverability reads it (`~203`, `sandbox-session.ts` ~155). Gate only
  the snapshot call, not the whole effect — keep the activity bookkeeping so warm
  reattach doesn't regress.
- **Drop the snapshot-suppression of the local offer on the APK.** With cloud
  snapshot restore gone, `restoredFromSnapshotSandboxId` never matches on the
  native shell, so the native restore is reached. Make the intent explicit so a
  future change can't silently re-suppress it.

## Precedence (decided)

"Local always wins" means **over a cold/fresh sandbox**, not over live work:

- Fresh / lost / cold-cloned sandbox (no uncommitted work) → local checkpoint is
  the newer truth → restore it (auto or one-tap default-yes; UX in §UI).
- Sandbox already has its **own uncommitted work** → the existing **dirty-tree
  refusal** in `restore()` (`native-jgit-store.ts` ~531) holds → never silently
  clobber; ask. (Unchanged.)

**Caveat — the dirty-tree refusal does NOT cover cold-loss.** A freshly cloned
sandbox is *clean*, so the refusal only guards live/manual restore. On cold-loss
recovery the restore proceeds against a clean clone, which means it restores the
**last checkpoint** — and the dead sandbox may have had up to one debounce-window
(~45 s) of un-checkpointed work past it. That tail is lost. Accepted: the bounded
window is the cost of the debounce, and it's strictly better than losing the whole
sandbox. Flush-on-background already shrinks it; state it plainly, don't pretend
the dirty-check saves it.

### Precedence vs the *other* fresh-sandbox restore paths

Native restore is not the only thing that touches a fresh sandbox — two others
race it, and the native checkpoint must win (it's the authoritative WIP backup):

- **Workspace-patch replay.** `WorkspaceSessionScreen` replays pending
  `workspace-patch` cards on `creating → ready` (`~248`, via
  `replayWorkspacePatch`), mutating the tree in parallel with native restore.
  Unsequenced, whoever lands first breaks the other (replay first → native
  dirty-refuses; native first → replay double-applies / mis-marks). **Decision:**
  on the native shell, **native restore precedes patch replay** — defer/suppress
  replay until restore resolves, and treat the restored tree as authoritative (the
  checkpoint already contains the WIP those cards represent). Exact mechanism
  (skip vs defer vs reconcile-against-result) to be nailed in implementation.
- **Chat/session resume "re-apply".** `useChatCheckpoint` recreates a sandbox on
  resume and builds a model message that says *"re-apply these changes"* with a
  saved diff (`~512` / `~644`, `checkpoint-manager.ts` ~308). After a device
  restore that instruction is **stale and dangerous** (double-apply). **Decision:**
  when native restore is the recovery path, the resume reconciliation must **not**
  instruct re-apply — the checkpoint already restored the work; the message should
  be suppressed or reduced to a "restored from on-device checkpoint" note.

## Post-restore consistency — "Cloudflare sees it and continues as normal"

The sandbox is still the execution environment (the device doesn't run code), so
after a device→sandbox restore the sandbox's *derived* state must be coherent or
the agent can't just keep going. Checklist to audit/wire:

- ✅ **Mutation signal alone is not enough — DONE (PR2).** Restore passed only
  `markWorkspaceMutated: true`, which wakes mutation *listeners* (the auto-back
  coordinator via `sandbox-mutation-signal.ts`) but clears nothing. A **whole-tree**
  restore also has to invalidate the derived caches a single edit doesn't:
  file-version cache, prefetched-edit cache, the symbol ledger, the file ledger.
  Both stores' `restore()` now call `invalidateWorkspaceSnapshots(sandboxId)`
  (`sandbox-edit-ops.ts`) on success — placed inside `restore()` so it covers
  every caller (the offer banner *and* the hub `CheckpointHistory`) without
  asymmetry. Was the load-bearing "continues as normal" item; device validation
  (the agent turn ran clean post-recovery) plus the new unit assertions cover it.
- **Workspace revision** — left untouched: it's `0` on the Cloudflare backend, so
  it's not the "where we are" signal; the provider-agnostic mutation signal is.
  `invalidateWorkspaceSnapshots` only writes a revision when one is passed, and PR2
  passes none. (Revisit only if a revision-keyed consumer appears.)
- **Next-checkpoint base** — after restore the device tree and sandbox tree match
  (we just pushed device→sandbox), so the next delta capture's base is correct by
  construction. ✔ (state it, don't re-derive.)
- **Auto-back re-clobber** — not a loop: after a restore the working tree equals
  the restored checkpoint's tree, so the `markWorkspaceMutated` wake-up's debounced
  capture hits the tree-hash dedup (`unchanged`) and commits nothing. One benign
  no-op probe, not a re-capture cycle. ✔ (handled by the existing dedup.)
- **Lifecycle flags** — `freshSandboxId` / `restoredFromSnapshotSandboxId` are the
  hooks the restore enabling keys on; the cold-start→native-restore path must set
  them so the offer fires **exactly once** per lane and isn't itself suppressed.
- **Detection ↔ capture race** — `useWorkspaceSandboxRestore` marks a lane probed
  *before* async detection resolves (`~140`), while auto-back capture is
  independently debounced/in-flight (`useWorkspaceSandboxAutoBack.ts` ~108). If
  detection runs before a just-finishing device capture is visible, the fresh
  sandbox won't re-probe and the offer is missed. Order detection after any
  in-flight capture settles, or make detection re-runnable for the lane.

## Tradeoffs (accepted)

- **Slower reconnect on the APK.** Container-dead reconnect is *cold clone +
  native restore* instead of *warm Modal snapshot*. Accepted: the native restore
  is now KB-cheap (diff transport, increment 1), and the gain is
  local-authoritative recovery with nothing in the cloud.
- **Device loss = WIP-checkpoint loss.** Local-only checkpoints survive sandbox
  loss and offline, but **not** a lost/wiped phone. Committed-and-pushed work is
  still safe via normal git — checkpoints are the *uncommitted-WIP* safety net.
  Accepted as the data-locality / privacy bargain (the whole point of the native
  store). The "local primary, cloud secondary" alternative buys device-loss
  durability at the cost of WIP-leaves-the-device, which defeats the purpose.

## Known limitation (decided): origin drift

The checkpoint repo is `git init` with **no origin ancestry** (Native Checkpoint
Store first-increment fork 1), and restore is a **full-tree replacement**, not an
overlay: the sync `find`s and `rm -rf`s every non-`.git` top-level entry, then
extracts the checkpoint (`native-jgit-store.ts` ~114 / the `.git`-preserving sync).
So the restored working tree **is the checkpoint's entire tree**, sitting on top of
the fresh clone's `.git`/HEAD. If origin moved while the sandbox was gone, every
file where the checkpoint differs from the new HEAD shows as a working change — the
checkpoint is effectively "the whole tree as of last capture" diffed against
current origin, which can be a large diff, not a tidy WIP overlay. For work-loss
recovery that's the right content; the framing just has to be honest about it. v1
accepts full-tree-replace against current HEAD. The **clone-based device repo with
origin ancestry** (which would let the sandbox continue against the *right* base)
stays **deferred** — revisit if the full-tree-vs-moved-HEAD diff causes real
confusion in use.

## Cold-start when the branch isn't on origin (recreate net, 2026-06-28)

Every cold-clone recovery path above assumes `git clone --branch <branch>`
succeeds. It doesn't when the session's branch isn't on origin — the common case
being a **branch-on-first-prompt** branch that only ever lived locally in a
since-gone sandbox (gate-at-push keeps it local until the first commit). The
`--branch <missing>` clone hard-failed, so the sandbox create aborted and the
session was stranded ("can't start a sandbox on this branch").

`routeCreate` (`worker-cf-sandbox.ts`) now recovers: on a `--branch` clone failure
it wipes `/workspace`, clones the remote's **default HEAD**, then **confirms the
branch is genuinely absent on origin** before recreating it — `git ls-remote
--heads origin <branch>` via the configured remote (token read from `.git/config`,
never on the command line). Only on confirmed absence does it recreate the branch
locally (`git checkout -b <branch>`, skipped only when `symbolic-ref HEAD` shows the
default checkout already *is* that branch — `rev-parse` would also resolve a
same-named **tag** and wrongly skip the create). If the branch **does** exist on
origin, the `--branch` clone failed transiently/for real, so the original failure
is surfaced rather than recreating the branch at the wrong base. Every throw on this
path **fail-closes** (destroys the container) because the fallback clone used the
tokenized URL — an unstripped origin must not linger in an orphaned sandbox (#987).
Emits `cf_sandbox_branch_recreated`.

**Recovering unpushed work, not just the branch name (2026-06-28).** Once a branch
is confirmed absent on origin, `routeCreate` first tries to restore the
**repo/branch-indexed R2 snapshot** (`restoreSnapshotIntoSandbox`) before falling
back to an empty `checkout -b`: it reads the snapshot bytes by the index `imageId`
and hydrates `/workspace` (tree **and** `.git`, so unpushed local commits come
back). This closes the tokenless-cold-start gap the client's localStorage-keyed
restore couldn't — a fresh app load that lost the saved `snapshotId`/`restoreToken`
now finds the snapshot by repo+branch. No restore-token check: the worker is
reading its own R2 object for its own freshly-created container, and the snapshot's
origin is already the public URL (stripped before capture), so no credential rides
in. Restore is **naturally scoped to absent branches** — the default branch is
always on origin, so a stale default snapshot can never shadow a fresh clone — and
**best-effort**: a missing object (`cf_sandbox_cold_restore_miss`), a failed
hydrate (`cf_sandbox_cold_restore_failed`, which re-clones a clean base), or no
snapshot at all all fall through to the empty-branch recreate. Emits
`cf_sandbox_branch_restored_from_snapshot` on success vs `cf_sandbox_branch_recreated`
on the empty fallback.

Lossless for a never-pushed branch either way.

**On-origin branches with unpushed work — the divergence guard (2026-06-29).** The
absent-branch path above misses a branch that *is* on origin but carries unpushed
local commits: its `--branch` clone succeeds, so it never enters that path. After a
successful `--branch` clone, `routeCreate` now also tries
`restoreUnpushedWorkOverClone` — restore the repo/branch snapshot *over* the fresh
clone to recover that work. The hard part is doing it without shadowing origin (the
absent-branch case had no origin to shadow; this one does — you may have pushed from
another device, or a merge landed). The guard: the fresh clone gives origin's current
tip for free (`git rev-parse HEAD`); after hydrating the snapshot we verify that tip
is **reachable from the restored HEAD** — an ancestor of it — via `git merge-base
--is-ancestor <originTip> HEAD`. Reachability, not mere object existence: a
`cat-file -e` check would pass for a snapshot whose sandbox had `git fetch`ed the
advanced origin (new tip present as a loose object) without merging it, silently
hiding that commit. If origin's tip is reachable, the snapshot is "origin's tip +
your unpushed work" and restoring loses nothing
(`cf_sandbox_unpushed_work_restored`). If it isn't, origin advanced past the
snapshot, so we **discard the restore and re-clone** the fresh tip
(`cf_sandbox_cold_restore_diverged`) rather than silently drop real commits.

Default-branch sessions **skip this over-clone restore path** and cold-start from
origin. The guard is still required for feature branches, but it is too expensive
to use as the default-branch filter: a stale or large default-branch snapshot can
make every ordinary startup hydrate, guard, and often re-clone before the sandbox
is usable. For compatibility with older clients that do not send `default_branch`,
the worker treats `main`/`master` as default-looking and also honors an explicit
`default_branch` hint when present. Best-effort throughout — no snapshot / too
large / object reaped keeps the clean clone; a wipe or hydrate failure re-clones.
**Still deferred:** the true-divergence case where you have unpushed commits *and*
origin advanced — the guard correctly drops the unpushed work (a fresh origin clone
is the safe choice; an auto-rebase/merge would be the only way to keep both, and
that's out of scope).

## UI surfacing (to design in implementation)

- On the APK, recovery should feel like one system, not two. The cloud
  snapshot/reconnect spinner path is gone; the native checkpoint offer is the only
  affordance. Decide: silent auto-restore on a fresh sandbox vs a default-yes
  one-tap banner (`AutoBackRestoreBanner`). Lean: auto-restore when the sandbox is
  unambiguously fresh/empty; banner only when there's anything to weigh.
- The hub's manual **CheckpointHistory** browse/Restore is user-triggered and
  already native-gated (`CheckpointHistory.tsx` ~32) — not an auto-collision, but
  it calls the **same `restore()`**, so it inherits the same consistency
  requirements (cache invalidation above) and the same full-tree-replace semantics.
  It stays; the snapshot **Restore** affordance is what goes.

## Out of scope

- The **web** surface keeps the cloud snapshot system unchanged (it's the right
  tool there — no device, network-dependent, ephemeral sandbox).
- Restore-direction diff transport (still deferred in the parent doc).
- Clone-based device repo / origin ancestry (above).

## Status flip plan

✅ **Done (2026-06-24).** The native shell ships local-only recovery
(cloud-snapshot gated off + cold-start-on-loss, #1136) and it's device-validated
on the Moto G (see Device validation above) — Status flipped to **Current**. The
parent doc (`Native Checkpoint Store.md`) carries no separate "increment 2"
pointer to update; it's scoped to capture/restore + diff transport.
