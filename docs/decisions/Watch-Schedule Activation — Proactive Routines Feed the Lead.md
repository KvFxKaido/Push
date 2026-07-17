# Watch/Schedule Activation — Proactive Routines Feed the Lead

**Status:** Current (partially implemented) — the activation *seam* landed 2026-07-16 as
step 1 of the phasing below: the shared watch vocabulary (`lib/routine-activation.ts`),
and the webhook receiver dispatching through a routine registry instead of a hardcoded
event fork. The PR reviewer is the first consumer, expressed as two built-in routines
(`pr-review` on `pr_opened`/`pr_reopened`/`pr_ready_for_review`, `pr-review-command` on
`pr_comment`). Behavior-neutral: no new firing path, no repo-sourced routines yet.
The `schedule` mechanism's first consumer landed 2026-07-16 too: the reviewer's
head-advance sweep (`sweepHeadAdvance`), which closed a bug where a review racing a push
was silently dropped and the new head never reviewed — see
[First consumer](#first-consumer-the-autonomous-reviewer).
**Remaining:** repo-committed `.push/routines/*.md` (the capability ceiling, per-repo
enable, and base-ref trust rule are specified below but *not enforced by any code yet* —
see Guardrails); `schedule` as a general mechanism (today it is one hardcoded sweep, not a
`schedule:` frontmatter field); fan-out (the receiver is single-dispatch); pushd parity.
Tracked with the open questions at [#1518](https://github.com/KvFxKaido/Push/issues/1518).
Owner: Push runtime.
**Date:** 2026-07-09
Related:
[`Durable Runs — Adopt-on-Silence.md`](<Durable Runs — Adopt-on-Silence.md>)
(the execution substrate this rides on);
[`Platform, Sessions, and Sandbox Decisions.md`](<Platform, Sessions, and Sandbox Decisions.md>)
§9 (the shipped webhook→PR-review special case this generalizes);
[`Repo-Scoped Chats — Branch as Session State.md`](<Repo-Scoped Chats — Branch as Session State.md>)
(the chat model activations post into).

## Problem

Push is entirely pull-driven: every run starts with the user typing. But the north-star surface
is a phone — the best surface in the product for *receiving and approving* work and the worst
one for *composing* it — and the events that actually warrant work happen while nobody is
typing: CI fails on a pushed branch, a review lands, a PR goes stale, a scheduled maintenance
task comes due. Today the user finds out by opening the app and asking.

Exactly one event class is already wired end-to-end: `pull_request` webhooks trigger an
autonomous PR review (`app/src/worker/github-webhook.ts` → `pr-review-job-do.ts`, Platform §9),
plus the `@push-agent review` comment trigger. That path has everything an activation layer
needs — receiver, signature verification, dedupe/coalescing, a Durable Object with alarms,
structured logs on every non-action branch — but it is a special case: one hardcoded event
mapped to one hardcoded job. Adding a second proactive behavior today means cloning that
pipeline.

**Market context.** Charlie Labs' Daemons (repo-committed `.agents/daemons/<name>/DAEMON.md`
files with `watch` + `schedule` activation, risk-based approval pauses) validate the category:
always-on routines doing the follow-through work interactive agents leave behind. Their shape,
though, is a *separate proactive product* — "no prompts required" — that replaces chat. Push's
single-lead thesis suggests the opposite: proactive activations should feed the **same
conversational lead** the user already talks to, because the phone chat is precisely the right
approval-and-steering surface for work that started without a prompt.

## Decision (proposed)

Generalize the PR-review special case into a first-class **activation layer** with two
mechanisms, feeding the existing lead:

- **`watch`** — event-driven. GitHub webhooks on the web/cloud side (the existing receiver,
  routing to matching routines instead of one hardcoded job); pushd-side polling or local hooks
  on the CLI.
- **`schedule`** — time-driven. DO alarms cloud-side (already in production use in
  `coder-job-do.ts` and `pr-review-job-do.ts`); a pushd timer CLI-side.

An activation does **not** introduce a new agent model, role, or persona. It starts a turn for
the single conversational lead, in a repo-scoped chat, executing on the durable job engine that
Durable Runs already built (the server-side loop consumes checkpoints whether a browser ever
existed or not). Output surfaces as a proactive message in the chat; anything requiring consent
pauses at the **existing** gates and the phone gets the approval card. The user's relationship
to the work is identical to work they asked for — they just didn't have to ask.

### Routine definition format

`.push/routines/<name>.md`, a sibling of the `.push/skills/` tree the CLI already loads.
Frontmatter is the machine contract; the body is the task brief in prose.

```yaml
---
name: ci-triage
description: Diagnose CI failures on pushed branches and propose a fix
watch: [ci_failed]            # names from a shared vocabulary, not free-form strings
schedule: "0 6 * * 1"         # optional; watch and schedule can coexist
capabilities: read            # read | write — runtime-enforced ceiling, default read
approval: gate                # gate | auto — write routines hit Gate-at-Push regardless
chat: pinned                  # pinned (one ongoing chat per routine) | new (chat per firing)
---
When CI fails on a branch with an open PR, read the failing job logs, identify the
root cause, and reply with a diagnosis. If the fix is mechanical (lint, snapshot,
lockfile), prepare it on the branch and stop at the push gate.
```

This follows the **Behavior lives in code, not prompts** convention deliberately: the markdown
body carries *intent* for a cooperating model; activation, capability ceilings, budgets, and
approval policy are frontmatter parsed and enforced by the runtime. A routine whose safety
depends on the prose being obeyed is a runtime bug, not a prompt bug.

### Guardrails

- **No new delivery path.** Routines default to read-only. Write-capable routines flow through
  the same delivery rules as interactive work — Gate-at-Push, Auditor fail-closed, Protect
  Main. `approval: auto` can skip *conversation* pauses, never delivery gates.
- **Repo-committed ≠ trusted.** Routine files arrive with the repo, so anyone with repo write
  access authors automation. The `capabilities` ceiling is enforced by the runtime against a
  per-repo user setting: write-capable routines require an explicit one-time enable by the Push
  user for that repo, and are inert until then.
- **Bounded firings.** Per-activation budget (turns, wall clock, spend) with a terminal
  outcome; dedupe/coalescing inherited from the PR-review DO pattern so an event storm
  coalesces instead of fanning out.
- **Symmetric structured logs** on every branch of the activation decision — fired ↔ skipped
  (no matching routine) ↔ deduped ↔ budget-exhausted ↔ disabled — same discipline as the
  `coder_checkpoint_captured` ↔ `coder_checkpoint_failed` pairs. An activation the user can't
  distinguish from "never fired" is invisible to ops.

### Execution home and phasing

1. **Cloud `watch` first.** Generalize `github-webhook.ts` from "pull_request → review job" to
   "event → matching routines". Smallest step; every hard piece (receiver, DO, alarms, dedupe,
   Checks gating) already exists. The PR-review pipeline becomes the first routine expressed in
   the new vocabulary rather than a parallel special case (see
   [First consumer: the autonomous reviewer](#first-consumer-the-autonomous-reviewer)).
   **Seam shipped 2026-07-16** — vocabulary + registry + match loop, PR reviewer as
   `pr-review` / `pr-review-command`. Two constraints learned in the build, both binding on
   the repo-sourced half:
   - *Matching moves behind a DO when routines come from files.* The receiver is
     contractually cheap-and-synchronous, and matching a repo-committed routine needs an
     installation token plus a base-ref fetch. That is not gate-path work. Built-in routines
     match purely, so the registry stays in the receiver today; the file-sourced half needs a
     DO in front of it. No router DO was built for this step — with nothing to fetch, it
     would have been infrastructure with no job.
   - *The receiver is single-dispatch.* A routine handler returns the `Response` that acks
     GitHub, and there is one ack per delivery. The built-ins have disjoint `watch:` sets, so
     nothing fans out yet; an invariant test (`github-webhook.test.ts`) pins that and goes red
     on the first routine to claim a taken event. **Fan-out is unimplemented** — the second
     claimant must build it, and the receiver logs `webhook_routine_fanout_unsupported` and
     drops the extras rather than failing silently in the meantime.
2. **Cloud `schedule`** via DO alarms.
3. **CLI daemon (pushd) parity** — polling watch + local timers. Also the only legitimate home
   for MCP-sourced events, per the CLI-scoped MCP rule in `CLAUDE.md`: an ungoverned event
   source on the deployed surface is the same governance hole as an ungoverned tool.

Surfacing is the genuinely new piece: the proactive turn lands in chat, but the user has to
learn it exists. Notification transport (web push; Capacitor local notifications on the Android
shell) is an open question below — the activation layer is useful without it (badge/unread on
next open), and much better with it.

### New-feature checklist compliance

1. **Storage:** routine run-state keyed `repoFullName + routineName` (+ branch where the event
   is branch-scoped), resolver in `lib/` from day one — never web `chatId` or CLI `sessionId`.
2. **Coordinator home, named now:** `lib/routine-activation.ts` (shared kernel: frontmatter
   schema, event matching, budget accounting), a worker-side router module beside
   `github-webhook.ts`, a pushd-side scheduler module. Nothing lands in `useChat.ts`.
3. **One vocabulary:** the `watch` event names are a closed union in
   `lib/routine-activation.ts` — **corrected 2026-07-16**, this doc originally put them in
   `lib/capabilities.ts`, which is the *permission* enum (`repo:read`, `git:push`, …). Event
   names are not permissions, and conflating the two would have made a routine's `watch:`
   list read like a grant. The frontmatter's `capabilities: read | write` ceiling *is* a
   real fit for `lib/capabilities.ts` and maps onto its subsets when the enforcing runtime
   lands. The routine frontmatter schema pins in `lib/protocol-schema.ts` strict mode, with
   drift tests in the same PR, once routines are parsed from files rather than declared in
   code.

## First consumer: the autonomous reviewer

The webhook-triggered PR reviewer is the natural first consumer — it grounds this proposal in a
shipped subsystem rather than a hypothetical routine, and it already owns the infrastructure an
activation layer needs (a per-PR Durable Object with SQLite history, alarms, dedupe/coalescing,
budgets). Today all of that machinery serves **crash-safety within a single firing** — checkpoint
relaunch, watchdog, one auto-retry — and none of it serves **intelligence across firings**. Each
gap below is a daemon-shaped idea expressed in this doc's vocabulary:

- **Cross-review memory (durable state across activations).** *(Shipped 2026-07-09 —
  the DO feeds the latest posted review's findings + reviewed SHA into re-review
  context as `priorReview`, with addressed-vs-remaining instructions.)* The DO persists every review's
  full findings (`result_json` in the `review` table, `pr-review-job-do.ts`), but a re-review
  never reads them: the executor builds each pass from the fresh diff + REVIEW.md only. So
  `@push-agent review` after a fix round re-reviews from scratch — it can re-state findings
  verbatim and cannot say "3 of 5 addressed, 2 remain," the most useful thing a re-review could
  say. The storage already exists; the change is feeding prior findings + the previously
  reviewed SHA into the re-review context with instructions to diff against them. Directly
  attacks the multi-round review churn named in `CLAUDE.md` (the #1089–#1093 arc).
- **Own-thread resolution (a `capabilities` ceiling test case).** The reviewer is fire-and-
  forget: it posts a `COMMENT` review and never touches the PR again. On re-review it should be
  able to **resolve threads it authored** that the new head addresses — and nothing else. The
  deep reviewer's tool blocklist forbids all mutation today (correctly); this is a deliberate,
  narrow widening and the first real exercise of the runtime-enforced capability ceiling this
  doc proposes.
- **Condition sweeps (the `schedule` mechanism, reusing the existing alarm).** Triggers today
  are instant-shaped (`opened` / `reopened` / `ready_for_review`; `synchronize` deliberately
  excluded as noisy). Daemons watch *conditions over time* — the non-noisy middle ground: a
  periodic sweep noticing "unaddressed critical finding *and* new commits since the last
  review" → coalesced re-review, or "review died past terminal retry" → re-arm. The DO already
  holds an alarm used only as a 90-second crash watchdog; a condition sweep is the same
  primitive pointed at product behavior. It also retires the current terminal advice ("close
  and reopen the PR"), which exists only because nothing ever fires twice.

  **First sweep shipped 2026-07-16 — and it closed a bug this doc didn't know about.** Scoping
  the sweep surfaced that `pr-review-job-do.ts` contradicted itself: the executor's
  head-advanced guard justified skipping the post with "the newer push has its own delivery
  that will review the new head", while `TERMINAL_RETRY_ADVICE` in the same file said "New
  commits do not trigger reviews". The advice was the true one — `synchronize` is not a
  reviewable action — so a review that raced a push was **silently dropped and the new head
  never reviewed at all**. The PR got zero reviews behind a "Skipped — newer commit" check.

  `sweepHeadAdvance` closes it: the executor now reports `headAdvancedTo`, the row persists it
  (`head_advanced_to`), and the alarm re-reviews the current head once it has held still for
  `HEAD_ADVANCE_DEBOUNCE_MS` (3 min — a push burst coalesces into one review, which is the
  noise objection that excluded `synchronize` in the first place). Bounded by
  `MAX_HEAD_ADVANCE_SWEEPS`; idempotent via a deterministic `sweep-<sha>` delivery id riding
  the existing primary-key dedupe.

  **This is deliberately not the reviewer becoming persistent.** The sweep stands down the
  moment *any* review has posted, so it can only ever deliver the one review the PR was already
  promised. The "fires on first open only" decision is untouched.

  **Remaining (the doc's original condition, still unbuilt):** "unaddressed critical finding
  *and* new commits" → coalesced re-review, and "review died past terminal retry" → re-arm.
  Both make the reviewer genuinely persistent and reverse that settled decision, so they want a
  deliberate call rather than a rider on a bug fix. They inherit the substrate the head-advance
  sweep built: the alarm's earliest-of now carries a non-watchdog target, and the deterministic
  sweep-id pattern generalizes. `TERMINAL_RETRY_ADVICE` still says "close and reopen the PR"
  because it is still true for the died-past-retry case this sweep does not cover.

  One constraint worth carrying forward: the alarm's merge rule is one-directional. Every other
  writer only pulls the alarm *sooner*, so any sweep target further out than the 90s watchdog
  must be re-derived inside `alarm()`'s earliest-of on each firing — arming it out-of-band gets
  it silently overwritten while a review is live.
- **Risk-scaled depth.** *(Rejected 2026-07-09 — the uniform deep pass (16 rounds, raised from
  12 to make room for the verification rounds below) is a trusted
  floor, not a cost to optimize; for a solo repo the review's job is catching what the author
  missed, and token cost is noise. The real enforcement gap was verification, shipped as the
  next bullet.)* ~~Classify the diff and route trivial diffs to the quick pass.~~
- **Verify-before-clean-pass (CI-sourced verification).** *(Superseded 2026-07-14 by
  [`Platform, Sessions, and Sandbox Decisions.md`](<Platform, Sessions, and Sandbox Decisions.md>)
  §9a.)* The 2026-07-09 implementation added sandbox `typecheck` / `tests` verifiers,
  runtime-tracked their results, and gated a clean-pass check on at least one passing verifier.
  §9a removed that path after the review container proved unable to run the repo workload
  reliably. Verification now reads one aggregate verdict from the PR head's GitHub check runs;
  a clean pass is green only when that CI verdict passes, and missing/blocked/failing CI cannot
  launder into a successful review check.
- **Per-repo policy as repo contract (the frontmatter split).** `REVIEW.md` is already the
  prose contract with the right trust posture (fetched from the base ref, never the fork
  head), but the machine policy lives in worker env (`PR_REVIEW_GATING_REPOS`, installation
  allowlist) and a global owner setting. Frontmatter on `REVIEW.md` — gating threshold, path
  ignores, depth policy, whether condition sweeps run — applies this doc's prose/frontmatter
  split under the same base-ref trust rule.

What the reviewer does **not** borrow from daemons is autonomy of action: advisory-only
(`event: 'COMMENT'`, never `REQUEST_CHANGES`, no auto-fix) is a settled decision this track
keeps. The items above make the reviewer more *persistent*, not more *powerful* — the sole
carve-out being resolution of its own threads.

## What this is not

- Not a new role or a daemon persona — the lead runs the routine. No org-chart revival.
- Not local merge automation; standard merges remain the GitHub PR flow.
- Not auto-approved writes. `approval: auto` governs conversational pauses only.
- Not a third-party integration surface. Watch sources are the runtime-contract stack (GitHub,
  CI, git); external-product events stay MCP-and-CLI-scoped per the capability-sourcing rule.

## Relationship to Charlie Labs' Daemons

Credit where due: the markdown-defined routine, the watch/schedule split, and pause-on-risk are
their validated shape. The deliberate divergence is the destination of the work. Charlie's
daemons are a standalone proactive product whose pitch is the *absence* of chat; Push routes
proactive work into the existing conversation because a phone chat is the natural approval
surface for work the user didn't initiate. Their semantic risk classifier (pause on "risk,
scope, or customer impact") is noted as a possible later layer; v1 pauses at Push's existing
point-in-pipeline gates only, which are already fail-closed.

## Open questions

- **Notification transport.** Web push vs. Android-shell local notifications vs. unread-badge
  only for v1.
- **Provider lock for routine-fired turns.** No chat lock exists at firing time for `chat: new`
  routines. Likely the Auditor rule: chat lock when a pinned chat has one, else the active
  backend.
- **Stale-event semantics.** A `watch` firing races the user working interactively in the same
  repo chat; does the routine turn queue behind the live turn, post to a separate chat, or drop?
- **Schedule floor and storm control.** Minimum cron granularity, per-repo concurrent-routine
  cap, and backoff when firings repeatedly exhaust their budget without a terminal outcome.
- **Semantic risk pause.** Whether a risk/scope classifier ever fronts the delivery gates, or
  point gates remain the only pause vocabulary.
