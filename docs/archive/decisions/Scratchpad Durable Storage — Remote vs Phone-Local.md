# Scratchpad Durable Storage — Remote vs Phone-Local

Date: 2026-06-03 (rescoped 2026-06-03)
Status: **Draft — ROADMAP-tracked as step 4 (gated) of the "Single-Agent Loop + Branch-at-Commit Persistence" item; not yet decided.** Split out of `Main as Scratchpad — Branch on Graduation.md`. That doc's **decomposition decided** the *commit-flow* is `auto-branch-on-commit`, universal (no platform fork) — and that the **one thing the platform flag governs is the durable-storage substrate**, which is what THIS doc owns. So this is no longer just a parked fork: it's the open half of a settled split. Still open here: which substrate per platform, and the two conscious tradeoffs (continuity narrowing + identity) below.
Owner: Push
Related: `docs/archive/decisions/Main as Scratchpad — Branch on Graduation.md` (parent — the persistence posture this serves),
`docs/archive/decisions/Repo Mirror Design.md` (the phone-side `MirrorTarget` storage layer a phone-local variant would build on),
`docs/archive/decisions/Cloudflare Native Backup Migration.md`, `docs/archive/decisions/Modal Sandbox Snapshots Design.md` (the remote-snapshot impl)

## What this owns (post-decomposition)

The parent doc settled two things that scope this one:

1. **Commit-flow is `auto-branch-on-commit`, universal.** Durable work lives on
   auto-pushed branches (git), the same on every surface. So this doc is *not*
   about how commits behave.
2. **The platform flag governs only the storage substrate** — i.e. where the
   *uncommitted `main` exploration* (the snapshot's now-shrunken job) durably
   lives. That's this doc's question, and it's genuinely platform-dependent
   because the storage reality is (APK-strong / PWA-weak, below).

And the parent demotes the snapshot to **best-effort warm-reattach**, which lowers
the stakes: any option here satisfies a best-effort bar, so this is a substrate
*preference* per platform, not a correctness blocker. It only escalates if we ever
want the delta to be more than best-effort, or if remote-session reachability gets
solved well enough to make a device-owned store primary.

## The trichotomy

Each store should hold what it's *supposed* to:

| Store | Holds | Property |
|---|---|---|
| **GitHub** | named, shared work (branches / PRs) | durable, collaborative |
| **Phone (or other owned device)** | the personal, unnamed `main` scratchpad delta | durable, private, owner-held |
| **Container** | nothing | **stateless** — disposable compute, hydrated from GitHub + the device per session |

The prize is the last row: the container becomes pure compute. No snapshot index,
no TTL, no reclaim, and the `:main` single-slot collision *cannot occur* — there's
no shared remote scratchpad slot to contend for; each device holds its own delta.

**What's stored is the *delta*, not the tree:** working-tree patch + untracked
blobs + index state against branch HEAD. Small, composes onto a fresh `git clone`
at session start.

**Substrate half-exists.** `Repo Mirror Design.md` supplies the storage half — the
`MirrorTarget` abstraction (SAF on the Android APK, OPFS/IndexedDB on PWA) and a
"sandbox-as-export-proxy" transport. **But** that doc explicitly scopes out
*bidirectional* and *working-tree* sync (it's `read + share` only), so phone-local
`main` is net-new scope built *on* the mirror's storage layer, not a free rider.

## The three caveats any device-owned bet must stare at

1. **Single-device continuity.** A remote snapshot is device-agnostic — reattach
   from any device on the same repo+branch. Device-local means the delta lives on
   *that device*; switch surfaces and it isn't there. **This is the binding
   constraint for this owner specifically** — the real workflow is genuinely
   bi-surface (Android + local WSL), so a phone-local delta would sever the
   cross-surface continuity that is the headline feature. A remote store is the
   device-agnostic fit; the cost it carries is the `:main` contention (see parent
   doc's sharp edge), which a *per-device remote slot* could resolve without
   giving up device-agnosticism.
2. **The owned device becomes the loss surface.** If it's the *only* durable copy
   of uncommitted work, a wiped/lost device = lost work — worse than a server
   snapshot with backups. Pairs with cheap+frequent graduation: graduate often and
   the device only ever holds a sprint's worth, bounding the blast radius.
3. **APK-strong, PWA-weak.** SAF on the Android shell is real durable filesystem; a
   mobile browser is on evictable OPFS/IndexedDB. So a device-owned store is
   fundamentally an *APK-shell* feature — and that shell is still
   experimental/debug-only. The foundation would be more reliable than R2 *only* on
   the surface that is least mature.

## If this un-parks: the bets, ranked for *this* owner

- **Remote-snapshot-primary, with a per-device slot** — keeps device-agnostic
  continuity (the binding constraint), and the per-device slot fixes `:main`
  contention without going device-local. **Most likely the right answer here.**
- **Phone-primary / remote-snapshot-backup** — owner-held durability + stateless
  container; was the original draft's recommendation. Rejected as primary for this
  owner because caveat #1 (single-device) breaks the bi-surface workflow; viable
  only under a phone-first single-user posture, which isn't the current reality.
- **Hybrid by surface** — phone-local on APK where SAF is durable, remote-snapshot
  on PWA where storage is evictable. Most complex; only worth it if both surfaces
  matter equally *and* reachability is solved.

The pick is a graduation-time decision, made when (and if) best-effort stops being
good enough — not assumed now.
