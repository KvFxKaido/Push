# Pre-Order PRs — Detached Sandbox Jobs

Status: **Draft**
Reviewed: 2026-06-07

Design-in-motion. Not yet roadmap-promoted; nothing built. This note exists to
be lived with and poked at before any code. When promoted, the operating
contract folds into [`Platform, Sessions, and Sandbox Decisions.md`](<Platform, Sessions, and Sandbox Decisions.md>)
(it owns background execution + sandbox providers) and this file moves to
`../archive/decisions/` as provenance.

> Placement caveat: the folder README says the two live docs are the only
> default residents here and that design-in-motion belongs under
> `docs/runbooks/` (impl plan) or folded into a live doc. Parked here by
> explicit request for review; relocate on promotion.

## The scenario

You open Push with two things to tackle in one sitting:

1. A **repo-wide doc update** — broad, mostly-mechanical, independent edits.
2. A **longer refactor** you don't trust to leave sitting in a hot (ephemeral)
   sandbox — long-running, and you want it to survive the container going cold.

Today both would compete for the one session sandbox and the one active branch,
serialized, foreground, sharing fate. You want to **place each as an order and
walk away**, get the work back **on its own branch**, and then choose whether
to open a PR.

## The decision

A **pre-order** is a detached, durably-executed unit of work that runs in its
**own isolated sandbox** and terminates by **pushing its branch and surfacing
it for your review**. Opening the PR is an **opt-in graduation step you take**,
not automatic. One pre-order = one sandbox = one branch = one durable
`CoderJob` = (optionally) one PR. The units stay aligned, so the delegation
unit is the branch unit is — when you say so — the review/merge unit.

- **You supply the decomposition.** A pre-order is one intent you already know
  is separate. No machine decomposition into PR-coherent units, no dependency
  DAG, no stacked-PR reconciliation. Two intents → two branches → (your call)
  two PRs.
- **User-initiated only (MVP).** You place the order; the lead does not yet
  offer to detach work on its own. *Future shape:* a "work on feature on
  branch X" setup-and-send flow — configure it, dispatch it, continue in the
  normal app while it runs. The chat verb is the seed of that.
- **No PR by default.** Terminal state is a pushed branch behind the
  secret-scan + Auditor gates, surfaced as "ready — open a PR?" You decide.
  Merge, when you choose it, stays on GitHub's PR flow (Push never local-merges).
- **Cap 1 for the MVP.** At most one outstanding pre-order at a time while we
  work out the kinks. The cap removes all multi-job coordination surface.
- **Intake: a chat verb.** Place the order from the transcript (e.g. a
  `pre-order`/`detach` verb). Launcher/setup UI is the future-shape direction,
  not the MVP.

### Separate sandboxes, not worktrees

A git worktree is multiple working dirs inside *one* container — that is what
would poke the one-active-branch invariant and the `git checkout`/`switch`
blocks (two HEADs sharing a repo). **Separate sandboxes sidestep that
entirely:** each is its own container doing an ordinary single clone + checkout,
one HEAD apiece. The "one active branch per repo session" invariant holds
unchanged — it becomes "one active branch *per sandbox*," and each still has
exactly one.

Worktrees-in-one-container return *only* as a later cost optimization, if/when
many cheap pre-orders sharing a container beats paying for N containers. The
cap-1 MVP does not need them.

## What already exists (verified 2026-06-07)

The CF Sandbox backend is **id-addressed**: `getSandbox(env.Sandbox, id)` is a
handle to the container with that id; a new id is a new container.

| Primitive | Status | Anchor |
|---|---|---|
| Mint a fresh container by id | ✅ | `getSandbox(env.Sandbox, <new id>)` — `worker-cf-sandbox.ts` |
| Clone a branch in, warm `node_modules` | ✅ | `sandbox.gitCheckout(...)` + cache hardlink — `worker-cf-sandbox.ts:418-435` |
| Durable agent loop under `waitUntil` | ✅ | `CoderJob` DO — `coder-job-do.ts` |
| Snapshot every N rounds | ✅ | checkpoint cadence (5) — `coder-job-do.ts` |
| Restore into a fresh container on death | ✅ | `restoreWorkspaceSnapshot` — `worker-cf-sandbox.ts:1626` |
| Auto-branch + secret-scan + push | ✅ | secret-scan gate + auto-branch-on-commit plumbing |
| Per-PR autonomous review | ✅ | `PrReviewJob` (webhook-triggered) |
| Watch several in-flight at once | ✅ | cross-PR in-flight review view (#819) |
| Sandbox teardown | ✅ (implicit) | provider idle-timeout — `worker-cf-sandbox.ts:~1005` |

**The current gap:** the background `CoderJob` reuses the caller's session
sandbox (`useBackgroundCoderJob.ts:522` → `sandboxId: input.sandboxId`), so it
shares the foreground container's fate. Isolation is the thing to add.

## What's new (the slice)

1. **Pre-order provisioning entry.** A start path that mints its *own*
   `sandboxId` and clones the target branch into it (reuse the session
   clone primitive), instead of inheriting the session sandbox.
2. **DO accepts provision-your-own.** `CoderJobStartInput` today takes
   `sandboxId` as given; the pre-order path supplies a freshly-provisioned id
   (or has the DO provision internally).
3. **Terminal = pushed branch, awaiting your call.** Chain the existing engines
   on completion: Auditor SAFE/UNSAFE gate → auto-branch + secret-scan + push →
   mark the job complete and surface "ready — open a PR?". **No auto-PR.**
   Opening the PR (which then triggers `PrReviewJob` via webhook) is a separate
   user action via the existing branch/PR UI.
4. **Teardown on terminal.** Tear down the pre-order sandbox on completion or
   failure; emit symmetric structured logs on both branches
   (`preorder_torn_down` ↔ `preorder_teardown_failed`). Idle-timeout is the
   backstop, explicit teardown is the intent. (Note: the branch is already
   pushed, so teardown loses nothing the user wanted to keep.)
5. **Chat verb + cap-1 guard.** A transcript verb to place the order, and a
   guard that refuses/queues a second while one is live, with a structured log
   on the refusal path.

## Decided (2026-06-07)

- **Who places it:** user only for the MVP. Future: a configure-and-send
  "work on feature on branch X" flow that runs while you keep using the app.
- **PR open:** user choice, **no PR by default** — terminal is a pushed branch
  surfaced for review.
- **Intake:** a chat verb to start.

## Protected (must not regress)

Event-shape compatibility (`subagent.*` / `task_graph.*` + drift pins),
capability gating, the Auditor commit gate, the secret-scan pre-push gate,
Protect Main, the `git checkout`/`switch` blocks, and progress/liveness.

## Effort

Closer to a **weekend than a fortnight** for cap-1: the expensive primitives
(mint container, clone-with-warm-deps, snapshot/restore for durability) are
already built and proven. New work is a provisioning entry, a lifecycle
terminal + teardown, and intake — composition over invention.

## Source

- Conversation 2026-06-07 (delegation → "lean into DO jobs" → delegated
  worktrees → pre-order PRs → separate sandboxes, cap 1).
- Related: [`Agent Runtime Decisions.md`](<Agent Runtime Decisions.md>) §2 (the
  Orchestrator is the capable lead; delegation is a durable engine path),
  ROADMAP "Single-Agent Loop + Branch-at-Commit Persistence".
