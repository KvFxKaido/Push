# Checkpoint Recovery on Sandbox Loss (Increment 2)

Date: 2026-06-24
Status: **Draft** — design approved (premise + forks decided with Shawn
2026-06-24), not yet implemented.

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

- **Mutation signal alone is not enough.** Restore passes `markWorkspaceMutated:
  true` (`native-jgit-store.ts` ~558), which wakes mutation listeners
  (`sandbox-client.ts` ~1303) — but a **whole-tree** restore also has to invalidate
  the derived caches a single edit doesn't: file-version cache, prefetched-edit
  cache, the symbol ledger, the file ledger. There's already a broad invalidator
  for this (`sandbox-edit-ops.ts` ~109) — the restore must run the equivalent, or
  editor saves and symbol/file awareness go stale against the new tree. **This is
  the load-bearing "continues as normal" item.**
- **Workspace revision** — confirm the restore bumps/refreshes the sandbox
  workspace revision so the UI's "where we are" settles (it's `0` on Cloudflare —
  verify nothing keys off a stale value).
- **Next-checkpoint base** — after restore the device tree and sandbox tree match
  (we just pushed device→sandbox), so the next delta capture's base is correct by
  construction. ✔ (state it, don't re-derive.)
- **Auto-back re-clobber** — ensure the capture coordinator doesn't immediately
  re-capture/treat the just-restored tree as a fresh mutation in a way that loops.
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

Promote to **Current** when the native shell ships local-only recovery
(cloud-snapshot gated off + cold-start→native-restore on loss) and it's
device-validated on the Moto G. Flip the parent doc's "increment 2 is separate"
pointer to reference this doc.
