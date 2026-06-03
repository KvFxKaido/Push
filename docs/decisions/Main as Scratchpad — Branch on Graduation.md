# Main as Scratchpad — Branch on Graduation

Date: 2026-06-03 (refocused 2026-06-03)
Status: **Draft** — design-in-motion; needs a `ROADMAP.md` entry to graduate to an implementation commitment
Owner: Push
Related: `app/src/hooks/useWorkspaceSandboxController.ts` (branch→sandbox teardown gate),
`app/src/hooks/useSandbox.ts` + `app/src/lib/sandbox-session.ts` (sandbox keyed by `repo:branch`; `RESTORE_FAILED_MESSAGE`),
`app/src/worker/snapshot-index.ts`, `app/src/worker/worker-cf-sandbox.ts` (per-branch snapshot index + reclaim),
`app/src/lib/sandbox-tools.ts` (`create_branch` / `switch_branch` typed tools),
`docs/decisions/Modal Sandbox Snapshots Design.md`, `docs/decisions/Cloudflare Native Backup Migration.md` (the snapshot impl this leans on),
`docs/decisions/Scratchpad Durable Storage — Remote vs Phone-Local.md` (the parked where-does-the-delta-live fork, split out of this doc),
`CLAUDE.md` (repo/session/branch model)

## TL;DR

Push's differentiator over every other mobile coding agent is that it lets you
**start talking on `main` without branching first**. This doc pins the model
that keeps that differentiator coherent under load, in one line:

> **We take the mandatory branch every cloud agent forces, and move it from the
> front of the interaction to the point of intent.** You talk on `main`
> immediately. When you *commit* — the moment you've decided some work is worth
> keeping — Push asks once: *branch this?* "Yes" makes it durable, named, and
> PR-bound. "No" keeps it as a best-effort checkpoint on `main`, with the
> tradeoff stated plainly. You never branch to *start*; you branch to *persist*.

The only things this asks us to engineer are small: a **commit-time branch
prompt** (and the discipline to keep it quiet after the first ask), and an
honest contract for the snapshot — **best-effort warm-reattach, not a
durability guarantee**. The branch-carry plumbing and the honest-failure
surface already exist.

## The counterexample that anchors this

The realization that drove this doc: in another agent's cloud environment, a
Claude Code instance hit a **stop-hook because it had uncommitted changes** —
and that env had already **created a branch before responding to the first
prompt**. Those two behaviors aren't UX quirks; they're forced by an
architecture, and naming the architecture is what makes Push's choice legible.

That agent's cloud persistence layer **is git, full stop.** There is no
scratchpad underneath it. So:

- **Branch-before-first-response** is mandatory because a branch is the *only*
  durable home for work — nothing can be held until one exists.
- **Stop-hook-on-uncommitted** treats uncommitted work as *unsafe to leave*,
  because in a git-only model uncommitted = not persisted = gone on the next
  sandbox reclaim. The hook is the system honestly admitting "I can't hold this
  for you."

They conflate the **persistence boundary** (where diffs durably live) with the
**workflow ceremony** (naming a stream before you can work) — not out of
carelessness, but because git is the only floor they have, so the two collapse
into one act that has to happen up front.

**Push's inversion:** the snapshot is a durability floor *below* git. Because
work survives without a commit, the branch stops being the only way to persist —
so it stops being mandatory up front. The branch decision is freed to move to
where it's actually meaningful: the moment you commit. Same git-centric
durability instinct as the stop-hook, but the branch is *pulled from the front
to the point of intent*, and the floor underneath makes "talk on `main` first"
a consequence of the architecture rather than a hack we're rationalizing.

## What anchors this (how the owner actually uses Push)

1. **Continuity is the headline feature, and the workspace is its unit.**
   Switching chats/models to "pick up where I left off" after a stall means
   chats are *lenses on one body of work*, not isolated streams. The shared
   `main` container is therefore **correct**, not a footgun — it is the
   mechanism that makes reattachment possible.
2. **"Work from `main`" was never anti-branch on principle.** It started as a
   workaround for PRs-feel-like-ceremony before the setup made them useful. With
   PRs now wanted, `main`-first becomes *pro-low-friction-start* and survives
   contact with branches instead of fighting them.
3. **Cloud is the default, and stays the default.** It's the most durable way to
   code on every platform *today*. The daemon/remote-session path (drive a local
   pushd from mobile) would put durability on a substrate we own — but
   cross-network reachability is an unsolved, industry-wide problem, so making it
   the durable home is premature. Cloud-default routes around that.

## Current state (load-bearing facts, with refs)

- **Sandbox is keyed by `(repoFullName, branch)` only — no `chatId`.**
  `buildSandboxSessionStorageKey` (`app/src/lib/sandbox-session.ts:59-66`) and
  the `useSandbox` memo (`app/src/hooks/useSandbox.ts:105-108`) derive identity
  from repo + branch; switching chats only sets `activeChatId`
  (`app/src/hooks/chat-management.ts:139`), never the sandbox. **Consequence:**
  same-branch chats *share one container's `/workspace` and all uncommitted
  diffs.* That's the continuity feature, by construction.
- **The working tree persists via a per-branch snapshot** (R2/Modal on
  idle-hibernate, restored on reconnect). The index is keyed
  `snapshot:<repo>:<branch>` — one slot per branch, each hibernate reclaims the
  prior (`app/src/worker/worker-cf-sandbox.ts:1361-1367`,
  `app/src/worker/snapshot-index.ts`), TTL ~7 days.
- **Restore failure is already surfaced, not silent.** `RESTORE_FAILED_MESSAGE`
  in `useSandbox` ("Could not restore your saved workspace — starting a fresh
  sandbox") exists specifically so a lost snapshot doesn't masquerade as a
  normal cold start. The honest-failure half of this design is already shipped.
- **Typed branch tools already carry the working tree on fork.** `create_branch`
  (forked) returns `branchSwitch: { kind: 'forked' }`
  (`app/src/lib/sandbox-tools.ts:859`) and the controller suppresses teardown via
  `skipBranchTeardownRef` (`useWorkspaceSandboxController.ts`). **The graduation
  motion's mechanics already exist** — the gap is the commit-time prompt and
  intent, not plumbing.

So Push *already is* a branch-as-container system that has simply assumed one
stream per branch. "Work from `main`" today means "one active workspace that you
happened to name `main`."

## The model we're committing to

### `main` = a scratchpad you start on (cloud-default)
- You talk immediately; the main guard stays optional. (Differentiator.)
- Continuity across chats/models lives here, on the shared workspace. (Anchor #1.)
- You do not route to `main` or try to make `main` *guaranteed*-durable. Work
  accumulates as uncommitted diffs and best-effort checkpoints.

### Commit on `main` → "branch this?" (the graduation prompt)
- The branch decision fires at **commit time** — the moment you've signaled this
  work is worth keeping. This is the mandatory-branch-moved-to-intent.
- **Intercept-before, not graduate-after.** The prompt fires at the commit
  gesture; "Yes" branches *then* commits there, so `main` never carries the
  commit and there's no reset-`main` cleanup. (Keeps `main` pristine, matches
  "`main` is where you start, not where commits land.")
- **Design the silence as deliberately as the prompt.** Firing on *every*
  main-commit re-creates branch-first by a thousand cuts. The value is the
  *first* graduation moment — after that, a "not now / stop asking this stretch"
  affordance, or quiet until intent changes. Get this wrong and the prompt
  becomes the new ceremony.

### "Yes" = the durable path
- Carries the work onto a named branch (mechanics in `create_branch`), becomes
  the commit, opens the PR on-ramp. The commit goes through the **Auditor**
  SAFE/UNSAFE gate per delivery rules (see open question on folding that in).

### "No" = an explicit, best-effort checkpoint on `main`
- The commit stays on the sandbox's local `main`. We *try* to keep it via the
  snapshot, but it is **not guaranteed** — and the prompt says so. Declining is a
  visible, informed choice to treat the work as ephemeral, not a silent default.
- Copy should call it a **checkpoint**, not a "save," so the word "commit"
  doesn't quietly over-promise: *"committed as a checkpoint on `main`
  (best-effort — branch to make it durable)."*

## The snapshot's contract: best-effort warm-reattach (not a guarantee)

This is the key reframe versus the original draft. Treating the snapshot as a
*durability guarantee* forces a hard SLO — never drop work, hold the line at
every stall — which is the "marathon" that made this design feel expensive.

The owner's stance ("I'd like it there when I get back, but I won't expect it")
demotes the snapshot to **best-effort warm-reattach**: usually your declined-but-
committed `main` work is still there; sometimes it isn't; either way the system
*tells you which*. No SLO to defend, no marathon — because we stopped promising
something we couldn't guarantee.

"Best-effort + honest" is **not** "permission to be flaky." The bar just moves
from *never lose work* to **fail loudly, never silently** — good enough that
"No" usually works, and clear at reconnect when it didn't (the
`RESTORE_FAILED_MESSAGE` surface already does this). The tradeoff-statement at
the prompt and the honest-failure at reconnect are two halves of one honesty,
and one half already ships.

## Explicitly out of scope / rejected

- **Per-chat sandbox isolation** — would break the cross-chat continuity that is
  Anchor #1. Same-branch chats *should* share a workspace.
- **Under-the-hood branch routed to `main`** — pays the branch ceremony *and*
  the routing complexity to end up pretending it's `main`. Two pairs of shoes.
- **Committing WIP durably to `main`** — clutters history, needs the guard off,
  and is redundant once the branch prompt is cheap.
- **Daemon/remote-session as the *durable* home (for now)** — the right someday,
  but cross-network reachability is unsolved; cloud-default sidesteps it. (Anchor #3.)
- **Making the snapshot a durability guarantee** — replaced by the best-effort
  contract above.

## Known sharp edge this reframes (not yet fixed)

The per-branch snapshot key (`snapshot:<repo>:<branch>`, one slot, prior
reclaimed) means two genuinely parallel workspaces rooted at `main` contend for
the single `:main` slot. **This is live for this owner** — work moves on `main`
across an Android surface *and* a local WSL surface, which is exactly two streams
at `:main`. The original draft called this "a signal the stream wanted a name";
that's too neat when the owner's real workflow provokes it routinely. Candidate
fixes to weigh (deferred): a **per-device** scratchpad slot on the remote rather
than per-branch, so two surfaces don't stomp each other; or accept last-writer-
wins with a loud "a newer checkpoint from another device replaced this." Either
way it's a real concurrency question, not just a graduation nudge.

## Open questions before this graduates

1. **Graduation prompt surface + silence policy.** Where does the commit-time
   "branch this?" live in the chat UI, and what's the *don't-nag* rule (once per
   session / stretch / until intent changes)? The silence is half the design.
2. **Does "Yes" auto-commit, or stage-and-confirm?** The commit goes through the
   Auditor SAFE/UNSAFE gate — how does that fold into "one motion" without
   becoming the ceremony we just removed? (What happens on UNSAFE mid-graduation?)
3. **`:main` multi-surface contention.** Per-device slot, last-writer-wins-loud,
   or other? (See sharp edge above.)
4. **Snapshot best-effort target.** Not an SLO, but a *felt* reliability bar —
   how often must "No" survive for the checkpoint to feel trustworthy? Needs
   instrumentation from the CF/Modal snapshot work to answer with numbers.
5. **Abandon path.** Discarding a `main` exploration without graduating — explicit
   "forget," or just snapshot TTL expiry? What's the UX?
6. **Where the durable delta physically lives** — remote snapshot vs phone-local
   vs hybrid — is split into
   `docs/decisions/Scratchpad Durable Storage — Remote vs Phone-Local.md` and
   **parked**; the best-effort contract here makes that question less urgent.

## Next step

Needs a `ROADMAP.md` entry to become work. The cheapest first slice that proves
the model is the **commit-time branch prompt + its silence logic** — the
branch-carry plumbing (`create_branch`) and the honest-failure surface
(`RESTORE_FAILED_MESSAGE`) already exist, so the net-new is the prompt, the
intercept-before wiring, and the don't-nag rule. Snapshot best-effort hardening
proceeds in parallel via the CF/Modal snapshot docs — but as warm-reattach
quality, no longer as a durability guarantee.
