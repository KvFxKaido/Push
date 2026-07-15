# Pushed Branch as Source of Truth — Gate at Push, Sandbox as Disposable Compute

Date: 2026-06-18
Status: **Current (partially implemented)** — the shipped parts (Move A
gate-at-push + Move B2 auto-back) are the live web/cloud delivery model; B1
(push-to-start) and OQ2/OQ3 remain open. Poses the model and the owner calls it
needs; OQ1 is now settled (Auditor moves to push — 2026-06-18), the rest remain
open. On
implementation, the Current parts fold into
[`Platform, Sessions, and Sandbox Decisions.md`](<Platform, Sessions, and Sandbox Decisions.md>)
(which owns the commit/push/sandbox seams) and this file becomes provenance.
Owner: Push

**Implemented so far (2026-06-18):** Move B / **B2 (auto-back)** has shipped —
the working tree is continuously mirrored to a pushed `draft/auto/<branch>` ref
with an offer-to-restore on a fresh sandbox (#980 primitive, #981 coordinator,
#983 restore; follow-ups #982). The durability decision now lives in
[`Platform, Sessions, and Sandbox Decisions.md`](<Platform, Sessions, and Sandbox Decisions.md>) §5.
**Move A (gate-at-push) has shipped (2026-06-18):** OQ1 is settled (the Auditor
**moves to push** — see [Move A](#move-a--commit-freely-move-the-gate-to-push))
and implemented. The agent commits silently via `sandbox_commit` (pre-commit
hook + auto-branch-off-main, no Auditor); `prepare_push` audits the cumulative
push diff and returns the review card; approval ships through the deterministic
gates (the push-time Auditor gate defaults on for direct pushes). The retired
`sandbox_prepare_commit` is replaced by that pair. **Still open:** B1
(push-to-start) remains the destination beyond B2; OQ2 (B1-vs-B2 trigger) and
OQ3 (WIP-push cadence). Once B1 lands, the Current parts fold into
[`Platform, Sessions, and Sandbox Decisions.md`](<Platform, Sessions, and Sandbox Decisions.md>)
and [`Auto-Branch on Commit`](<Auto-Branch on Commit — Nothing Lands on Main.md>)
is marked `Superseded by` this doc (the gate it kept at commit has now moved).
**Destination pin follow-up (2026-06-19):** `prepare_push` review cards now pin
the audited branch/upstream/remote-URL alongside `auditedHeadSha`; approval
re-reads all four and fails closed if the sandbox destination changed before
push. The remote-URL pin (`auditedRemoteUrl`) closes a deeper variant of the
same vector: the upstream *ref* (`origin/foo`) survives a remote repoint, and
`git push origin HEAD` can use `remote.origin.pushurl`, so the pin reads the
resolved push URL (`git remote get-url --push origin`). Defense-in-depth:
remote identity mutations via `git remote` (`set-url` / `add` / `rename` /
`remove` / `set-head` / `set-branches`) and equivalent `git config remote.*` /
`git config url.*InsteadOf` repoints are also blocked outright in the sandbox git
policy (`lib/git/policy.ts`, `remote-mutation`), with no `allowDirectGit`
escape — same treatment as a local merge, since the session's remote is fixed.

**Force-with-lease + ref-only plan follow-up (2026-06-21):** the destination
pins above all read *local* state (HEAD, branch, the local remote-tracking
mirror for the pushed branch, the configured remote URL); none caught origin's
branch tip *advancing* between review and push. `lib/git/push-plan.ts`
(`computePushPlan`) adds a side-effect-free, ref-only preview — modeled on
`entireio/git-sync`'s `plan` step — that reads origin's **live** tip via
`ls-remote` (not the possibly-stale local mirror `computePushedDiff` bases its
diff on) and classifies the move
(`create` / `fast-forward` / `force` / `skip` / `unknown`). Two uses: (1)
`prepare_push` blocks a **proven-diverged** push up front — Push never
force-pushes and local merge/rebase are policy-blocked, so a diverged remote is
a reconcile-via-PR situation, not git's opaque non-fast-forward rejection to
retry into; (2) the live tip is pinned on the card (`auditedRemoteTipSha`,
`ZERO_OID` encoding a create) as a **force-with-lease** value, and approval
re-reads it — if origin moved, the audited diff no longer describes what ships,
so the push is refused with a refresh prompt. The lease is read over the network
(unlike the other, local pins), so it's only enforced when origin was reachable
at audit time; an unreadable origin leaves git's own non-fast-forward rejection
as the backstop rather than bricking the push. A `PushPlanSummary` (`fast-forward`
/ `create` + ahead/behind) surfaces on the review card for the user.

## Thesis

**The pushed branch is the durable source of truth; the cloud sandbox is
disposable compute attached to it.**

Three things that have been decided or drifted toward separately are actually
one model:

1. **Reads come from GitHub.** Exploration/search/read default to the GitHub
   tier; the sandbox is the on-demand exception for the working tree (shipped:
   [`Agent Runtime Decisions §11`](<Agent Runtime Decisions.md>)).
2. **The push is the durable boundary.** A branch left in the ephemeral sandbox
   is no more durable than a `main` checkpoint — only the push to origin makes
   work survive (settled in
   [`Auto-Branch on Commit`](<Auto-Branch on Commit — Nothing Lands on Main.md>):
   "auto-branch only buys durability if it auto-pushes").
3. **The sandbox is unreliable and ephemeral** (30-min token, reclaimed) — which
   is *why* §11 exists and why reads were pulled off it.

Put together: if reads don't need the sandbox, and the push is the only durable
boundary, then the sandbox is not the workspace — it is **transient compute that
exists in service of a branch already on the remote.** This doc proposes
completing that model in two moves the prior decisions set up but stopped short
of: **gate at push (not commit)** and **gate the sandbox behind a pushed
branch.**

## Already true (do not re-litigate)

- **Reads default to GitHub** (§11) — committed state is read without the
  sandbox; the code-enforced fallback degrades sandbox reads to GitHub.
- **Push-time gating exists and is built to compose.** `PushGit.push()`
  (`lib/git/push-git.ts`) takes a `PrePushGate`, and `composePrePushGates`
  combines several. Two already ride it: the deterministic secret scan
  (`makeSecretScanPrePushGate`, `lib/git/secret-scan-gate.ts`, over the scanner
  in `lib/secret-scan.ts`) and Protect Main (`makeProtectMainPrePushGate`, #976).
  The Auditor is today a `PreCommitGate` on `PushGit.commit()` — so Move A is
  adding/moving it as one more composed `PrePushGate`. The seam exists; this
  joins infrastructure rather than inventing it.
- **Protect Main is now enforced at the push boundary** (#976) — the gate that
  used to guard the commit already migrated to the push via that exact
  `PrePushGate` seam. The push boundary is accreting the gates on its own; this
  doc names the pattern and finishes it.
- **Auto-branch-on-commit + auto-push** ship on web/cloud: a commit on `main`
  auto-creates a branch and auto-pushes through the gated `PushGit` path, so
  nothing lands on `main` and the work is durable the moment it's pushed.
- **Runs already survive sandbox loss** via `RunHost` checkpoint/adopt
  ([`Durable Runs — Adopt-on-Silence`](<Durable Runs — Adopt-on-Silence.md>)) —
  session continuity is already decoupled from sandbox lifetime.
- **The CLI/daemon has a real local filesystem** — its reliable substrate is
  local, not a pushed branch. This model is **web/cloud-sandbox scoped** (same
  scoping as §11).

## The two moves

### Move A — Commit freely; move the gate to push

**Today**, the interactive flow doesn't really commit-then-gate. `prepare_commit`
audits the *uncommitted working-tree diff*, and the commit happens **at
approval, coupled with the push**. There is effectively no local-commit step:
it's "hold edits → audited commit+push as one atomic action." That coupling is
the thing to break.

**Proposed:** the agent commits freely and locally as it works (real history,
cheap, no per-commit ceremony). The SAFE/UNSAFE gate + delivery approval fire at
**push**, over the cumulative diff of the commits being pushed — the unit that
actually ships.

Why this is the right boundary:

- The push is already the durable *and* trust boundary (secret scan lives
  there). Gating the commit puts ceremony on an action that ships nothing.
- The Auditor reviews the same net diff, just at the delivery unit instead of
  intermediate states that may be amended/squashed away. (PRs squash-merge, so
  messy local history is already collapsed downstream.)
- One Auditor run per push instead of per commit — cheaper, faster.
- Free local commits give us the write-side durability lever: a WIP push to a
  `draft/` branch (`sandbox_save_draft`, already unaudited by design) checkpoints
  work without invoking the delivery gate.

**Decided (2026-06-18): the Auditor moves to push.** This re-opens the
2026-06-08 call that kept the model-Auditor per-commit ("the verdict's reader is
the agent loop, not a human"), and the resolution corrects that call's framing:

- **What ships is identical either way.** The push gate runs the *same* Auditor
  rubric over the cumulative diff before anything reaches origin, so the
  "dangerous-beyond-secrets" band (injection, disabled auth/CORS, novel external
  network calls — none of which the deterministic secret scan catches) is gated
  equally. Moving the gate changes *when the loop learns*, not *what escapes*.
  This is a **feedback-latency tradeoff, not a safety-boundary one** — which is
  the axis the 2026-06-08 decision conflated.
- **Per-commit auditing buys earlier feedback, not more safety**, and in a
  commit-freely model it audits non-delivery checkpoints that may be amended or
  squashed away before they ship. The cost it imposes — a full LLM audit on
  every throwaway commit — is real; the safety it adds over the push gate is not.
- **Do not lean on `[DIAGNOSTICS]` as the continuous safety signal.** An earlier
  draft of this section did, and it was wrong: `[DIAGNOSTICS]` is a single-file
  syntax transpile (`ts.transpileModule` / `python3 -m py_compile`, in
  `app/src/lib/sandbox-edit-ops.ts`) — it catches syntax errors, not even type
  errors, and carries *none* of the Auditor's security rubric. If the coarser
  per-push feedback proves painful, the answer is a *real* lightweight continuous
  security lint, built deliberately — not the syntax check relabeled. Move A is
  **not** blocked on that lint existing.
- **The "UI-only" middle is not a stable resting place.** Decoupling commit/push
  in the UI while keeping the per-commit Auditor makes commits cheap to *create*
  and expensive to *make* (an audit per checkpoint), which defeats the point of
  free local commits. If we adopt commit-freely at all, the Auditor has to move.

The old "the loop reads the verdict" premise was itself only partly
load-bearing: today only the Coder/`sandbox_prepare_commit` path consumes the
verdict programmatically (it withholds the commit-review card on UNSAFE); the
file-browser path hard-blocks for a human, and the inline lead surfaces the
verdict to the approval queue with no programmatic block
(`app/src/hooks/chat-send-inline.ts`).

**Coarser feedback is the accepted cost**, mitigated two ways: the Auditor
already attributes findings at hunk granularity, so a batch verdict still points
at the offending change; and the agent can push more often (auto-back already
pushes drafts frequently). Flag this, don't hide it (see Design decision 6).

### Move B — Gate the sandbox behind a pushed branch

If reads are GitHub-tier and the push is the durable boundary, the sandbox has
exactly one job: execute/mutate against a branch. Make that explicit — **the
sandbox is booted/attached in service of a branch that exists on the remote**,
so its working tree is always recoverable by re-cloning that branch. Sandbox
loss then degrades to "re-clone the pushed branch and replay," and the only
unrecoverable window is local commits/edits not yet pushed — bounded by frequent
WIP pushes (Move A's checkpoint).

There is a real design fork in *how* "behind a pushed branch" triggers
(Open Question 2):

- **B1 — Push-to-start:** the sandbox does not boot until there is a pushed
  branch to attach to. Exploration/planning happen entirely GitHub-tier (§11);
  the first mutation creates+pushes a branch (auto-branch already does this on
  commit — pull it earlier, to *sandbox request*), then the sandbox attaches.
  Strongest version; biggest behavior change (cold-start moves to first-write).
- **B2 — Auto-back:** the sandbox boots as today, but its branch is always
  mirrored to a pushed remote branch from the first write (continuous/auto
  draft-push), so the sandbox is never the sole home of work. Softer; closer to
  what auto-branch + `save_draft` already do, made automatic.

B1 is the cleaner expression of the thesis; B2 is the lower-risk increment that
gets most of the durability. Recommend **B2 first, B1 as the destination** —
B2 is shippable on top of auto-branch with a periodic/auto WIP push, and it
de-risks B1 by proving the "always-backed" invariant before we make sandbox boot
depend on it.

## Design decisions to nail (before code)

1. **Auditor review unit at push** — the diff of commits being pushed: new local
   commits vs the remote branch tip, or vs base/default for a brand-new branch.
   Needs a precise definition for the no-upstream case.
2. **Two push flavors** — *delivery push* (audited + approved, to the working
   branch) vs *WIP/draft push* (unaudited, to a `draft/` branch, for durability).
   The latter exists (`sandbox_save_draft`); name and surface the split.
3. **Sandbox git guard split** — allow local `git commit` (no branch change, low
   risk) via a typed tool or relaxed `sandbox_exec` rule; keep `git push` gated
   through the push tool; keep `checkout`/`switch` blocked (branch-sync, per
   CLAUDE.md). Today both commit and push are blocked in `sandbox_exec`.
4. **Protect Main + auto-branch move fully to push** — commits are local/branch
   only; auto-branch-on-first-write keeps work off `main`; Protect Main guards
   the *push*. **Partially shipped:** Protect Main is already enforced at the
   push boundary (#976), and auto-branch already makes it "structurally moot" on
   web. This decision generalizes a direction the code has started.
5. **UI decoupling** — the app's coupled commit+push action splits into "commit"
   (cheap, local) and "push / ship" (the gated, reviewed action).
6. **Approval granularity tradeoff** — per-commit cards (today) pinpoint which
   change introduced an UNSAFE finding; a per-push batch is coarser. Mitigation:
   Auditor already attributes findings at hunk granularity, and the agent can
   push more often. Flag, don't hide.

## What stays / non-goals

- **Reviewer stays advisory at the PR** (only PR-backed branch-diff reviews post
  to GitHub). **Merges stay GitHub-PR-only**; Push never runs local `git merge`.
- **CLI/daemon is out of scope** — its local filesystem is its own reliable
  substrate; the gate-at-push semantics differ (no sandbox lifecycle). Same
  scoping as §11 and as Auto-Branch's CLI deferral.
- **`read_symbols` stays sandbox-only** (no GitHub analog; §11 follow-up).
- **Retiring the model-Auditor entirely** is not proposed — only its *placement*
  is in question (Move A).

## Application: pre-order PRs (detached jobs)

A "pre-order" is the cleanest expression of this model: one detached unit of
work runs in its **own** isolated sandbox and terminates by **pushing its
branch** behind the Auditor + secret-scan gates, surfaced for review — opening
the PR is your opt-in graduation step. One pre-order = one sandbox = one branch
= one durable `CoderJob` = (optionally) one PR.

It rides Move B directly: each pre-order gets a freshly-provisioned sandbox,
does an ordinary single clone + checkout (one HEAD), and is torn down on
terminal — losing nothing, because the branch is already pushed. **Separate
sandboxes, not git worktrees**, so the "one active branch per repo session"
invariant simply becomes "one active branch per sandbox" and the
`git checkout`/`switch` blocks stay intact. The detailed slice
(provision-your-own `sandboxId`, lifecycle terminal + teardown, cap-1 MVP, the
chat intake verb) lives in the archived source note linked below.

## Supersession & consolidation plan

On implementation (status flips happen in the implementing PR, per
[`README`](README.md) editing rules — not pre-emptively, to avoid doc/code
drift):

- **Folds into** [`Platform, Sessions, and Sandbox Decisions.md`](<Platform, Sessions, and Sandbox Decisions.md>):
  the Current commit/push/gate/sandbox-lifecycle decisions land there (it owns
  the git/RPC and sandbox seams); this file becomes provenance.
- **Completes / supersedes**
  [`Auto-Branch on Commit`](<Auto-Branch on Commit — Nothing Lands on Main.md>):
  that doc moved the *secret scan* to push and kept the Auditor at commit; this
  model moves the Auditor to join it. Mark `Superseded by` this doc when the gate
  moves — not before.
- **Absorbed** [`Pre-Order PRs — Detached Sandbox Jobs`](<../archive/decisions/Pre-Order PRs — Detached Sandbox Jobs.md>)
  (was Draft): folded as the "pre-order PRs" application above and moved to
  `../archive/decisions/` as a source note (2026-06-18) — it was Draft, not a
  live contract, so folding now creates no drift.
- **References** (no change): §11 (reads off GitHub), Durable Runs (RunHost makes
  the sandbox disposable for run continuity),
  [`Main as Scratchpad — Branch on Graduation`](<../archive/decisions/Main as Scratchpad — Branch on Graduation.md>)
  (the archived rationale for branch-at-commit; this doc is its natural sequel).

## Open questions (owner calls)

1. **Does the Auditor move to push, or only the UI/delivery approval?**
   **RESOLVED 2026-06-18 — moves to push** (full thesis). The move is a
   feedback-latency tradeoff, not a safety regression: the push gate runs the
   same rubric over the cumulative diff, so nothing unsafe ships either way. The
   2026-06-08 "stays per-commit" call conflated safety with feedback timing, and
   its `[DIAGNOSTICS]`-as-substitute framing was factually wrong (syntax-only).
   See [Move A](#move-a--commit-freely-move-the-gate-to-push) for the full
   rationale. Move A is unblocked for implementation.
2. **B1 (push-to-start) or B2 (auto-back) for the sandbox gate?** Recommend B2
   first, B1 as destination. B1 moves cold-start to first-write and is the purer
   model; B2 is the lower-risk increment on top of auto-branch.
3. **WIP-push cadence for the "always-backed" invariant** — every N edits, on a
   timer, before token expiry, on first `SANDBOX_UNREACHABLE`, or some
   combination? Determines how much unpushed work is at risk between checkpoints.
4. **Pin the destination ref on the approval card, not just source HEAD** —
   **RESOLVED 2026-06-19.** Move A's approval already pinned
   `auditedHeadSha` and re-checked it fail-closed at push
   (`app/src/hooks/chat-card-actions.ts`), so the approved push shipped *the
   same commits* that were audited. The missing piece was destination: a
   `create_branch` (`kind: 'forked'`) at the **same HEAD** with a pending
   `prepare_push` card could migrate that card onto the new branch while leaving
   HEAD at the audited sha, so the `auditedHeadSha` re-check still passed.
   `prepare_push` cards now also carry `auditedBranch` / `auditedUpstream`
   (`app/src/types/index.ts`); approval re-reads branch/upstream through the
   typed Git backend and fails closed with a refresh prompt on mismatch. Covered
   where the HEAD pin was already asserted plus approval-card behavior tests.

   **Extended 2026-06-19 (remote identity, Codex P2 on #991).** Branch + upstream
   weren't the whole destination: the upstream *ref* (`origin/foo`) survives a
   `git remote set-url origin <other>`, so a repointed `origin` passes the HEAD,
   branch, and upstream checks while the approved `git push origin HEAD` ships to
   a different repo. Closed with defense in depth: (1) cards also pin
   `auditedRemoteUrl` (origin's resolved push URL via a new typed
   `GitBackend.remoteUrl(..., { push: true })`), re-verified fail-closed at
   approval with a loud "Remote identity changed" refusal; (2) remote identity
   mutations through `git remote` and equivalent `git config remote.*` /
   `git config url.*InsteadOf` forms are blocked outright in the sandbox policy
   (`remote-mutation`, no `allowDirectGit` escape), so the repoint can't happen
   in-sandbox in the first place.
