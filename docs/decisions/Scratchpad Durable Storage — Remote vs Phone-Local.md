# Scratchpad Durable Storage — Remote vs Phone-Local

Date: 2026-06-03
Status: **Draft — Parked.** Split out of `Main as Scratchpad — Branch on Graduation.md` to keep that doc about the *principle*. Parked because the best-effort snapshot contract (below) makes "where the delta physically lives" less urgent, and because the device-owned bets depend on cross-network reachability that is currently unsolved.
Owner: Push
Related: `docs/decisions/Main as Scratchpad — Branch on Graduation.md` (parent — the persistence posture this serves),
`docs/decisions/Repo Mirror Design.md` (the phone-side `MirrorTarget` storage layer a phone-local variant would build on),
`docs/decisions/Cloudflare Native Backup Migration.md`, `docs/decisions/Modal Sandbox Snapshots Design.md` (the remote-snapshot impl)

## Why this is parked, not decided

The parent doc demotes the snapshot from a *durability guarantee* to **best-effort
warm-reattach**. Once "your declined-but-committed `main` work might not survive,
and we say so" is the contract, the question of *which durable store holds the
delta* stops being load-bearing — any of the options below satisfies a best-effort
bar. So this is a fork in the road worth recording, not a blocker to resolve now.
It becomes live again only if/when we want the scratchpad delta to be more than
best-effort, or when remote-session reachability is solved well enough to make a
device-owned store primary.

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
