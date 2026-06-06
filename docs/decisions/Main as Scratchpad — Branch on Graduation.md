# Main as Scratchpad — Branch on Graduation

Date: 2026-06-03 (refocused 2026-06-03; amended 2026-06-05 — model-named, deterministically-gated refinement, see below)
Status: **ROADMAP-tracked (first priority, promoted 2026-06-03); implementation pending.** Design is committed; sequenced *after* the [Coder Delegation Collapse](Coder%20Delegation%20Collapse%20—%20Component%20Audit.md) track (step 2 of the combined roadmap item). Flip to `Current` when `auto-branch-on-commit` ships.
Owner: Push
Related: `app/src/hooks/useWorkspaceSandboxController.ts` (branch→sandbox teardown gate),
`app/src/hooks/useSandbox.ts` + `app/src/lib/sandbox-session.ts` (sandbox keyed by `repo:branch`; `RESTORE_FAILED_MESSAGE`),
`app/src/worker/snapshot-index.ts`, `app/src/worker/worker-cf-sandbox.ts` (per-branch snapshot index + reclaim),
`app/src/lib/sandbox-tools.ts` (`create_branch` / `switch_branch` typed tools),
`docs/decisions/Modal Sandbox Snapshots Design.md`, `docs/decisions/Cloudflare Native Backup Migration.md` (the snapshot impl this leans on),
`docs/decisions/Scratchpad Durable Storage — Remote vs Phone-Local.md` (the where-does-the-delta-live fork, split out of this doc),
[`Coder Delegation Collapse — Component Audit.md`](Coder%20Delegation%20Collapse%20—%20Component%20Audit.md) (**pairs with this** — collapses the Orchestrator→Coder wrapper so the lead agent drives the engine directly; that single-agent loop is what *commits*, and auto-branch is its durability story),
`CLAUDE.md` (repo/session/branch model)

## TL;DR

Push's differentiator over every other mobile coding agent is that it lets you
**start talking on `main` without branching first**. This doc pins the model
that keeps that differentiator coherent under load, in one line:

> **We take the mandatory branch every cloud agent forces, and move it from the
> front of the interaction to the first commit — automatically.** You talk on
> `main` immediately; nothing is branched while you explore. The moment a
> *commit* happens, Push **auto-creates a branch** and the commit lands there —
> no prompt, no choice, no commit ever lands on `main`. You never branch to
> *start*; the branch materializes when you persist.

This is **not** the other agents' model — they branch *before your first word*,
so you're on a branch the whole time. Auto-branch-on-commit keeps the entire
pre-commit conversation branch-free and defers the (automatic) branch to the
first commit. That single choice **dissolves** the three problems an interactive
"branch this?" prompt created — see "Why auto-branch dissolves the hard
questions" below.

**The decomposition (the load-bearing decision of this doc):** split behavior
along two independent seams, and do **not** fork the first one by platform:

- **Commit-flow → `auto-branch-on-commit`, universal** (PWA + APK + cloud).
  Simple, no prompt, keeps the differentiator. Same everywhere.
- **Durable-storage substrate → platform-flagged.** *Where* the work durably
  lives differs by surface because the storage reality does: APK can use
  local git / SAF (real filesystem), PWA leans on the remote snapshot
  (evictable local storage). This is the only thing the platform flag governs —
  see `Scratchpad Durable Storage — Remote vs Phone-Local.md`.

**Load-bearing condition:** auto-branch only buys durability if the branch
**auto-pushes to origin**. A branch that lives only in the ephemeral sandbox is
no more durable than a `main` checkpoint — durability would just relocate to the
snapshot under a different ref name. So the real chain is *auto-branch →
auto-push the branch → deterministic pre-push secret scan* (the Auditor-unbundle
from open-Q #2, now firing at auto-push). The branch-carry plumbing
(`create_branch`) and the honest-failure surface (`RESTORE_FAILED_MESSAGE`)
already exist; the net-new is auto-branch + auto-push + the scan + auto-naming.

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
  `skipBranchTeardownRef` (`useWorkspaceSandboxController.ts`). **The branch-carry
  mechanics already exist** — the gap is firing them automatically at commit
  (plus auto-push + a name), not the carry plumbing itself.

So Push *already is* a branch-as-container system that has simply assumed one
stream per branch. "Work from `main`" today means "one active workspace that you
happened to name `main`."

## The model we're committing to

### `main` = a scratchpad you start on (cloud-default)
- You talk immediately; the main guard stays optional. (Differentiator.)
- Continuity across chats/models lives here, on the shared workspace. (Anchor #1.)
- While you explore, work stays as the **uncommitted working tree** on `main`,
  held best-effort by the snapshot. No commit ever lands on `main`.

### Commit → `auto-branch-on-commit` (universal, no prompt)
- The instant a commit happens, Push **auto-creates a branch** and the commit
  lands *there*, not on `main`. No prompt, no "branch this?", no choice — and
  therefore no "No" path. The differentiator survives because the *pre-commit*
  conversation was branch-free; the branch is simply deferred to (and automated
  at) the first commit.
- **Auto-push is part of the gesture, or it's not durable.** Auto-branch alone
  leaves the branch in the ephemeral sandbox — same durability as a `main`
  checkpoint. So the commit auto-pushes the new branch to origin behind a
  **deterministic pre-push secret scan** (the unbundled Auditor — open-Q #2).
  That push, not the local commit, is what makes the work durable.
- **Net-new to build:** auto-branch wiring at commit, auto-push, the secret
  scan, and **branch auto-naming** (model-proposed topic name, or a deterministic
  fallback). Branch-carry (`create_branch`) is reused.

### Why auto-branch dissolves the hard questions
The interactive "branch this?" prompt we first sketched created three problems;
auto-branch makes all three *not exist* rather than answering them:
- **Who triggers / answers the prompt** (esp. agent-mid-run and headless
  background coder jobs) → there is no prompt; the branch is automatic, so the
  agent-initiated and human-initiated paths are identical.
- **Does "No" produce a commit on ephemeral `main`** → there is no "No"; `main`
  never carries a commit, so the awkward checkpoint-on-`main` concept is gone.
- **`Protect Main` vs committing to `main`** → nothing commits to `main`, so the
  collision can't occur. (`Protect Main` keeps governing *pushes to origin/main*,
  untouched.)

This is also *why every other cloud agent forces branch-first* — they couldn't
answer "who decides, and when," so they removed the decision. Auto-branch removes
it too, but keeps the start-on-`main` differentiator the upfront version throws away.

**Pairs with the [Coder Delegation Collapse](Coder%20Delegation%20Collapse%20—%20Component%20Audit.md) track:** that collapse makes *headless detached engine runs* (lead drives the durable job DO directly, no Orchestrator handoff) more central — and a headless run literally *cannot* answer a "branch this?" prompt. So the delegation collapse is independent evidence that auto-branch, not a prompt, is the right call; and auto-branch supplies the durability story for that collapsed single-agent loop. Pair the visions, but sequence the rollout (collapse delegation first — it has a test suite and a clean cut — then layer auto-branch, whose "who commits" answer is cleanest once the single-agent loop exists).

## Refinement (2026-06-05): model-named, deterministically-gated

The mechanism above implies the *runtime* both decides to branch and names it.
This refinement splits those: keep the **guarantee** in code, hand the
**judgment** to the model. It is strictly better — it gets good branch names for
free — and it resolves open-Q #1 while leaving open-Q #2's scan placement intact.

The motivating instinct: rather than runtime-intercept the commit verb, let a
hook simply *tell the model to branch first, then keep working*. That instinct is
right about the **trigger** and about **who names the branch**, and wrong only if
the hook *asks* without being able to *enforce* — at which point it is just the
rejected "branch this?" prompt pointed at the model instead of the user. The fix
is to decompose "branch" into three parts and put each where it belongs:

- **Gate (deterministic, in code) — the guarantee.** A boundary check that
  *cannot pass while unpersisted work sits on `main`*: HEAD-is-`main` with a dirty
  tree, or a commit-to-`main` attempt, is a hard stop. Unbreakable, and it lives
  at the git-policy enforcement seam (`lib/git/policy.ts`-adjacent), not in a
  prompt. This is the part a non-cooperating model cannot route around.
- **Name (the model's judgment) — the one sub-task that genuinely wants a model.**
  On a gate trip the runtime *nudges*: "branch before you persist — name it for
  the work." The model supplies a real topic name (`fix/streamdown-purge`, not
  `wip-2026-06-05-1432`) via the `create_branch` tool it already has. This is the
  answer to **open-Q #1** — *both* model-proposed and deterministic, layered:
  model-proposed is the happy path because the model knows what the work *is*;
  naming is intent, not mechanics, so it is the right thing to delegate.
- **Fallback (deterministic slug) — the non-cooperating / headless case.** If the
  model doesn't branch within N attempts, `create_branch` errors, or the run is
  headless with no model turn to nudge, the runtime auto-branches with the
  timestamp slug and proceeds. This is what keeps the refinement honest against
  `CLAUDE.md`'s *behavior-lives-in-code* test: the gate never opens and the
  fallback eventually fires, so a confused or hostile model still cannot strand
  work on `main`.

**Why this isn't the rejected prompt.** "Branch this?" asked a human *whether* to
branch — a breakable decision with a "No" path. This nudges the model about *what
to name* a branch the system is creating **either way**. The decision ("you will
branch") is the gate's; only the label is the model's.

**The trigger is a hook — the [anchoring counterexample](#the-counterexample-that-anchors-this),
inverted.** That env's stop-hook fired on uncommitted changes as a *confession*
("I can't hold this — commit or lose it"). Push's reads as the opposite posture —
a graduation gate ("persist this properly before you go") — and it lands as
housekeeping rather than panic *only because the snapshot floor already held the
work during the run*. Same hook point, opposite meaning, earned by the floor
underneath. Trigger placement is a durability-granularity knob, not a naming
question:

- **Stop-gate** (won't let a run finish with unpersisted `main` work): simplest —
  no commit-verb interception, a pure run-end post-check — but batches the branch
  to run-end, widening the window where committed-but-unpushed work leans on the
  snapshot (open-Q #4's reliability bar).
- **Commit-attempt gate**: keeps per-commit durability, at the cost of the
  interception the hook framing was trying to avoid.

Either works with the gate/name/fallback split; pick by how much mid-run loss the
snapshot floor can absorb.

**Consistency with the Auditor unbundle (open-Q #2).** The unbundle's logic is
"mechanical jobs (secret recall) belong in deterministic code, not a model." This
refinement honors it exactly: the *mechanical* parts of branching — the guarantee
a branch exists, the push, the secret scan, the slug fallback — are all
deterministic; the model is used *only* for naming. The earlier worry that
"telling the model to branch" re-mechanizes a model dissolves once "branch" is
decomposed into deterministic-guarantee + model-named-label. We are not handing
the model a mechanical job; we are handing it the one judgment call in the flow.

**Net change to the build list.** The gate seam + fallback are net-new
deterministic code; the nudge is a hook message; `create_branch` is reused.
**Open-Q #1 (auto-naming) is resolved** — model-proposed, deterministic-slug
fallback. Open-Q #2's scan stays at auto-push. What's genuinely new to decide is
only the stop-gate-vs-commit-attempt trigger (the durability knob above).

## The decomposition: flag the *storage substrate*, not the commit-flow

The one thing the platform flag governs is **where durable state lives** — because
that's the only thing that genuinely differs by surface. Commit-flow is the same
everywhere; storage is not:

- **Commit-flow → `auto-branch-on-commit`, universal** (PWA + APK + cloud). No
  per-platform fork. Avoids a two-mental-models coherence tax and the "what does
  commit do here?" ambiguity.
- **Durable-storage substrate → platform-flagged:**
  - **APK** can use **local git / SAF** (real durable filesystem) — the
    owner-held, stateless-container bet.
  - **PWA** leans on the **remote snapshot** (its local storage is evictable
    OPFS/IndexedDB; not safe to own the only durable copy).
  - Detail lives in `Scratchpad Durable Storage — Remote vs Phone-Local.md`.

**Two conscious tradeoffs this flag carries — recorded, NOT yet decided:**
1. **APK-local = re-adopting phone-local = it severs cross-surface continuity.**
   The delta on the phone isn't visible on the WSL surface. This only holds
   together if we accept *"the `main` scratchpad is per-device; anything you want
   cross-surface, you graduate to a branch"* (branches ARE cross-surface via
   GitHub). Coherent, but a real narrowing of the continuity headline — decide
   with eyes open, don't let the flag smuggle it in.
2. **Identity:** if PWA auto-branches and the richest scratchpad (local git)
   lives only on the experimental/debug-only APK, the headline differentiator's
   best form lives where almost nobody is. Pick deliberately: is the scratchpad
   *the reason to install the APK* (power-user hook), or a niche perk while the
   PWA is "a solid mobile agent like the others"? Don't land in the fuzzy middle.

## The snapshot's contract: best-effort warm-reattach (not a guarantee)

This is the key reframe versus the original draft. Treating the snapshot as a
*durability guarantee* forces a hard SLO — never drop work, hold the line at
every stall — which is the "marathon" that made this design feel expensive.

In the auto-branch model the snapshot's job *shrinks further*: durable work lives
on pushed branches (git), so the snapshot only holds the **uncommitted `main`
exploration** between sessions. The owner's stance ("I'd like it there when I get
back, but I won't expect it") fits exactly — **best-effort warm-reattach**:
usually your in-flight `main` work is still there; sometimes it isn't; either way
the system *tells you which*. No SLO to defend.

"Best-effort + honest" is **not** "permission to be flaky." The bar moves from
*never lose work* to **fail loudly, never silently** — clear at reconnect when a
restore failed (the `RESTORE_FAILED_MESSAGE` surface already does this). And the
blast radius is bounded by design: anything committed has already auto-branched
and auto-pushed to durable git, so only *uncommitted* exploration is ever at
best-effort risk.

## Explicitly out of scope / rejected

- **Per-chat sandbox isolation** — would break the cross-chat continuity that is
  Anchor #1. Same-branch chats *should* share a workspace.
- **Under-the-hood branch routed to `main`** — pays the branch ceremony *and*
  the routing complexity to end up pretending it's `main`. Two pairs of shoes.
- **Committing WIP durably to `main`** — nothing commits to `main` at all now;
  the first commit auto-branches off it.
- **An interactive "branch this?" prompt** — the model we first sketched.
  Replaced by `auto-branch-on-commit` because the prompt re-created branch-first
  ceremony and had no good answer for agent-initiated / headless commits.
- **Forking the commit-flow by platform** — PWA and APK both `auto-branch-on-commit`;
  only the *storage substrate* is platform-flagged. Avoids two mental models.
- **Daemon/remote-session as the *durable* home (for now)** — the right someday,
  but cross-network reachability is unsolved; cloud-default sidesteps it. (Anchor #3.)
- **Making the snapshot a durability guarantee** — replaced by the best-effort
  contract above.

## Known sharp edge this reframes (not yet fixed)

The per-branch snapshot key (`snapshot:<repo>:<branch>`, one slot, prior
reclaimed) means two parallel `main` *explorations* contend for the single
`:main` slot. **This is live for this owner** — uncommitted `main` work moves
across an Android surface *and* a local WSL surface, which is exactly two streams
at `:main`. (Note: only the *uncommitted exploration* contends now — committed
work has already auto-branched to its own `:<branch>` slot, so the blast radius
is just in-flight scratch.) Candidate fixes (deferred): a **per-device** `main`
slot on the remote rather than per-branch, so two surfaces don't stomp each
other; or last-writer-wins with a loud "a newer `main` snapshot from another
device replaced this." A real concurrency question, and it interacts with the
APK-local-storage tradeoff (#1 in the decomposition) — phone-local sidesteps the
remote collision entirely but at the cost of cross-surface visibility.

## Open questions before this graduates

1. **Branch auto-naming + auto-push policy.** *Naming half **resolved** by the
   [2026-06-05 refinement](#refinement-2026-06-05-model-named-deterministically-gated):
   model-proposed name on the happy path, deterministic timestamp/slug as the
   non-cooperating/headless fallback — both, layered.* Still open is the auto-push
   policy: does the first commit *always*
   auto-push to origin, or is there a "stay local until I say" case (which would
   re-introduce snapshot-dependence for that branch)? Note the scope: auto-branch
   fires on the *first* commit while on `main`; once you're on the named branch,
   subsequent commits are ordinary. *(This replaces the old "branch this?" prompt
   + silence-policy question — auto-branch dissolved it.)*
2. **Does the commit auto-push behind a scan, and does the Auditor survive this
   model at all?** Leaning toward **unbundle and mostly retire the
   model-Auditor.** It was the v1 answer when commit-to-`main` was the primary
   path and a model-judge was the only available gate; the branch-at-commit shift
   plus the tooling that now exists relocates each of its three jobs to a
   better-fitted home:
   - *Secrets / footguns (mechanical, a recall problem)* → a **deterministic
     pre-push scan** (gitleaks/trufflehog-style; seed already in
     `app/src/lib/sensitive-data-guard.ts`'s token regex). Models are the wrong
     tool for recall — they miss and hallucinate. **Shipped (2026-06-06):** the
     scanner kernel is `lib/secret-scan.ts` (high-precision rules:
     private-key/GitHub/OpenAI/Google/AWS-id/AWS-secret/Slack/Stripe-live/GCP-SA;
     precision-over-recall since there's no human at auto-push, so broad shapes
     like a bare `Bearer` are redacted-for-display but not blocked). The
     deterministic match **fails closed** (blocks) while infra trouble (no diff
     resolvable / read error) **fails open** with a loud structured log
     (`secret_scan_clean`↔`blocked`↔`skipped`↔`no_diff`↔`error`) — deliberately
     *not* the model-Auditor's "flaky backend blocks the op" liability. It runs
     through a new **`PrePushGate` seam** on `PushGit.push()`
     (`lib/git/push-git.ts`), built by `lib/git/secret-scan-gate.ts` over a
     caller-supplied diff source. It scans the **uncapped about-to-be-pushed
     commits** — `lib/git/pushed-diff.ts`'s `computePushedDiff` resolves
     `base..HEAD` (upstream → `origin/<branch>` → merge-base with `origin/HEAD`)
     — *not* a working-tree preview, so a truncated diff or a secret already
     sitting in an unpushed commit can't slip past (PR #802 review). `computePushedDiff`
     also falls back to the **empty tree** when the remote has no baseline (a
     fresh/empty repo), so a first publish scans its whole tree rather than
     skipping. **Wired into every push path** via
     `createSandboxPushGit(..., { secretScan: true })`: the web commit/push flow
     (`useCommitPush`), the model-invokable `push` tool (`handleSandboxPush`),
     `promote_to_github`, the chat-card commit/push action, and `sandbox_save_draft`
     (the one release path that skips the Auditor, so the deterministic scan is
     its only gate) — closing the surface asymmetry (PR #803). Opt-out: `PUSH_SECRET_SCAN=0` (Node) /
     `VITE_PUSH_SECRET_SCAN=0` (web client), `resolveSecretScanEnabled` (mirrors
     `resolveAuditorGateEnabled`). **Remaining:** confirm
     the "semantically-dangerous AND must-be-caught-pre-push, beyond secrets"
     band is empty before retiring the model-Auditor.
   - *"Is this change dangerous" (semantic judgment)* → the **PR reviewers we
     already have** (Copilot trusted-gate, Kilo, the glm-5.1 autonomous
     reviewer) — independent model judgment *with full diff context*, which a
     commit-time gate lacks.
   - *"Don't land unreviewed on the live branch"* → already `Protect Main`.

   Independent cost argument for getting it off the per-commit path regardless:
   the Auditor **defaults to UNSAFE on error**, so a flaky audit backend *blocks
   your commit* — a latency/reliability liability on the hot path. The only
   territory a slimmed model-judge-at-graduation would own is "semantically
   dangerous AND must-be-caught **pre-push**, beyond secrets" — a band that looks
   empty (the deterministic scan covers catastrophic-once-pushed; the PR catches
   the rest pre-*merge*). Keep a model-Auditor here **only if that band turns out
   non-empty.** Open: confirm the band is empty; pick the deterministic scanner;
   decide whether the scan runs inline on auto-push and blocks on a hit (and how
   that failure surfaces, since there's no human in the loop at auto-push).
3. **`:main` multi-surface contention.** Per-device slot, last-writer-wins-loud,
   or other? (See sharp edge above.)
4. **Snapshot best-effort target.** Not an SLO, but a *felt* reliability bar —
   how often must uncommitted `main` exploration survive a reclaim to feel
   trustworthy? Needs instrumentation from the CF/Modal snapshot work for numbers.
5. **Abandon path.** Discarding a `main` exploration before any commit — explicit
   "forget," or just snapshot TTL expiry? What's the UX?
6. **Storage substrate per platform + its two conscious tradeoffs.** The
   decomposition *decides to platform-flag the substrate* (APK local-git/SAF vs
   PWA remote-snapshot); still open are (a) accepting that APK-local **narrows
   cross-surface continuity** to "graduate-to-a-branch," and (b) the **identity**
   pick (scratchpad = APK power-user hook vs niche perk). Detail + the
   remote-vs-local bet live in
   `docs/decisions/Scratchpad Durable Storage — Remote vs Phone-Local.md`.

## Next step

Needs a `ROADMAP.md` entry to become work. The cheapest first slice that proves
the model is **`auto-branch-on-commit` + auto-push + auto-naming** (universal,
no platform flag yet) — the branch-carry plumbing (`create_branch`) and the
honest-failure surface (`RESTORE_FAILED_MESSAGE`) already exist, so the net-new
is firing the branch automatically at the first commit, auto-pushing it behind
the secret scan, and the naming scheme. The platform-flagged storage substrate
(APK-local vs PWA-remote) and snapshot best-effort hardening proceed in parallel
via the storage + CF/Modal snapshot docs — the latter as warm-reattach quality,
no longer as a durability guarantee.
