# Main as Scratchpad — Branch on Graduation

Date: 2026-06-03
Status: **Draft** — design-in-motion; needs a `ROADMAP.md` entry to graduate to an implementation commitment
Owner: Push
Related: `app/src/hooks/useWorkspaceSandboxController.ts` (branch→sandbox teardown gate),
`app/src/hooks/useSandbox.ts` + `app/src/lib/sandbox-session.ts` (sandbox keyed by `repo:branch`),
`app/src/worker/snapshot-index.ts`, `app/src/worker/worker-cf-sandbox.ts` (per-branch snapshot index + reclaim),
`app/src/lib/sandbox-tools.ts` (`create_branch` / `switch_branch` typed tools),
`docs/decisions/Modal Sandbox Snapshots Design.md`, `docs/decisions/Cloudflare Native Backup Migration.md` (the snapshot impl this leans on),
`CLAUDE.md` (repo/session/branch model)

## TL;DR

Push's differentiator over every other mobile coding agent is that it lets you
**start talking on `main` without branching first** — the main guard is optional
and routinely off. Every other agent (Claude Code on web included) forces a
branch before you can speak, because they conflate two separable things:

- **the persistence boundary** — where diffs durably live, and
- **the workflow ceremony** — naming a stream before you can work.

This doc records the model we want Push to commit to, which keeps the
differentiator and makes it *coherent* under load:

> **`main` is a short-lived, snapshot-backed scratchpad. Chats and models are
> interchangeable lenses on one shared workspace. Branching is a deliberate
> *graduation* — the single cheap motion that carries your accumulated diffs
> onto a named branch, where they become a commit and a PR. You never branch to
> start; you branch to diverge.**

The only thing this model asks us to *engineer* is the pair that makes it
trustworthy: **snapshot durability** (so the scratchpad survives stalls) and
**cheap graduation** (so the scratchpad's job stays short). It explicitly asks
us to *remove* a tempting mechanism — under-the-hood-branch-routed-to-`main` —
rather than add one.

## What anchors this

Two facts about how the owner actually uses Push pin the design:

1. **Continuity is the headline feature, and the workspace is its unit.**
   Switching chats/models to "pick up where I left off" after a stall or hiccup
   means chats are *lenses on one body of work*, not isolated streams. The
   shared `main` container is therefore **correct**, not a footgun — it is the
   mechanism that makes reattachment possible.
2. **"Work from `main`" was never anti-branch on principle.** It started as a
   workaround for PRs-feel-like-ceremony before the setup made them useful. With
   PRs now wanted, `main`-first becomes *pro-low-friction-start*, and it
   survives contact with branches instead of fighting them.

## Current state (what the code does today)

These are the load-bearing facts the design rests on, with refs:

- **Sandbox is keyed by `(repoFullName, branch)` only — no `chatId`.**
  `buildSandboxSessionStorageKey` (`app/src/lib/sandbox-session.ts:59-66`) and
  the `useSandbox` memo (`app/src/hooks/useSandbox.ts:105-108`) derive identity
  from repo + branch. Switching chats only sets `activeChatId`
  (`app/src/hooks/chat-management.ts:139`) — it never touches the sandbox.
  **Consequence:** two chats on the same branch *share one container's
  `/workspace` and all uncommitted diffs.* This is the continuity feature, by
  construction.
- **The working tree persists via a per-branch snapshot.** On idle-hibernate the
  `/workspace` is archived to R2/Modal and restored on reconnect. The snapshot
  index is keyed `snapshot:<repoFullName>:<branch>` —
  *one snapshot per branch* — and each new hibernate reclaims the prior one
  (`app/src/worker/worker-cf-sandbox.ts:1361-1367`, `app/src/worker/snapshot-index.ts`),
  TTL ~7 days.
- **Typed branch tools already preserve the workspace on fork.**
  `create_branch` (forked) returns `branchSwitch: { kind: 'forked' }`
  (`app/src/lib/sandbox-tools.ts:859`) and the controller suppresses teardown via
  `skipBranchTeardownRef` (`app/src/hooks/useWorkspaceSandboxController.ts`), so a
  fork carries the dirty working tree onto the new branch. **The graduation
  motion's mechanics already exist** — the gap is ergonomics and intent, not
  plumbing.

So Push *already is* a branch-as-container system under the hood — it has simply
assumed one stream of work per branch. "Work from `main`" today means "one active
workspace that you happened to name `main`."

## The model we're committing to

### `main` = ephemeral, snapshot-backed scratchpad
- You talk immediately; the guard stays optional. (Differentiator preserved.)
- Continuity across chats/models lives here, on the shared workspace. (Anchor #1.)
- **You do not commit to `main`, route to `main`, or try to make `main`
  durable.** Work accumulates as *uncommitted diffs* held by the snapshot.

### Chats / models = lenses
- A stalled chat, a model swap, a hiccup → reattach to the same diffs from a new
  lens. No per-chat isolation, because isolation would *break* reattachment.

### Branch = the deliberate commit-and-diverge moment
- Graduation is **one cheap motion** that: (a) carries the working tree onto a
  named branch (mechanics already in `create_branch`), (b) becomes the commit,
  (c) opens the PR on-ramp. (Anchor #2.)
- This is the *only* place "durable" and "named" enter — and they enter
  **together**, which is the whole point (next section).

## Why this dissolves the durability problem (instead of solving it)

The instinct to give `main` real git-commit durability leads straight to
"branch under the hood but route pushes to `main`" — which is the *worst* of
both worlds: you pay the branch ceremony **and** the routing complexity to end
up pretending it's `main`. Two pairs of shoes for more traction. **Rejected.**

It's unnecessary because the moment you'd actually *want* committed durability
for some work is the exact moment that work is worth **naming** — i.e. the
moment you'd graduate it anyway. **The durability need and the naming moment
coincide.** There is no real window where you need "permanent committed
durability on still-anonymous `main`." That window is imaginary, which is why
solving for it feels like extra shoes.

So we don't make `main` durable. We **stop asking it to be.** In this model the
uncommitted work sitting on `main` at any instant is small and short-lived — just
the current in-flight exploration. The snapshot isn't running a marathon
(hold months, never fail); it's holding a **sprint** — from now until the next
graduation or abandon. That's a reliability bar, not an architecture.

## What this asks us to engineer

Only the pair that makes the sprint trustworthy. They reinforce each other:
cheap graduation keeps the snapshot's job short; a reliable snapshot makes
deferring the commit safe.

1. **Snapshot durability is first-class, because it is load-bearing for "work
   from `main`."** Stalls / reloads / container reclaims are *precisely* when the
   snapshot is tested. A flaky snapshot makes the differentiator a lie. (This is
   why `Cloudflare Native Backup Migration.md` and the Modal snapshot work matter
   here — they're the foundation, not a side quest.)
2. **Graduation is one frictionless tap that brings your work with it.** The
   `create_branch` working-tree-carry already exists; what's missing is surfacing
   it as *the* obvious motion at "this is worth a PR," and folding the commit into
   the same gesture.

## Explicitly out of scope / rejected

- **Per-chat sandbox isolation** — would break the cross-chat continuity that is
  Anchor #1. Same-branch chats *should* share a workspace.
- **Under-the-hood branch routed to `main`** — the two-pairs-of-shoes pattern.
- **Committing WIP to `main`** — clutters history, needs the guard off, and is
  redundant once graduation is cheap.

## Known sharp edge this reframes (not yet fixed)

The per-branch snapshot key (`snapshot:<repo>:<branch>`, one slot, prior
reclaimed) means *if* two genuinely parallel workspaces ever root at `main`, they
contend for the single `:main` slot. In this model that's not a bug to patch on
`main` — it's the signal that the second stream **wanted a name all along**, i.e.
should have graduated to a branch. The fix is making graduation obvious, not
making `:main` hold N streams.

## Open questions before this graduates

1. **What's the graduation trigger surface?** Model-proposed (a tool suggestion
   when work looks PR-shaped), user-tap, or both? Where does it live in the chat
   UI?
2. **Does graduation auto-commit, or stage-and-confirm?** The commit goes through
   the **Auditor** SAFE/UNSAFE gate per repo delivery rules — how does that fold
   into "one motion" without becoming ceremony again?
3. **Snapshot reliability target.** What failure rate / restore-success SLO makes
   deferring the commit *feel* safe enough to live on the scratchpad? Needs the
   instrumentation from the CF/Modal snapshot work to answer with numbers.
4. **Abandon path.** Discarding a scratchpad exploration without graduating —
   explicit "forget", or just snapshot TTL expiry? What's the UX?

## Next step

Needs a `ROADMAP.md` entry to become work. The cheapest first slice that proves
the model is **(2) graduation ergonomics** — the plumbing already exists in
`create_branch`; surfacing it as the one obvious motion is mostly UX + the commit
fold. Snapshot durability (1) is already in motion via the CF/Modal snapshot
docs and can harden in parallel.
