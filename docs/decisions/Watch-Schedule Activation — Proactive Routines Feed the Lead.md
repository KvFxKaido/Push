# Watch/Schedule Activation — Proactive Routines Feed the Lead

**Status:** Draft — design-in-motion; needs roadmap promotion before implementation.
**Date:** 2026-07-09
Related: [`Durable Runs — Adopt-on-Silence.md`](<Durable Runs — Adopt-on-Silence.md>) (the
execution substrate this rides on), [`Platform, Sessions, and Sandbox Decisions.md`](<Platform,
Sessions, and Sandbox Decisions.md>) §9 (the shipped webhook→PR-review special case this
generalizes), [`Repo-Scoped Chats — Branch as Session State.md`](<Repo-Scoped Chats — Branch as
Session State.md>) (the chat model activations post into).

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
   the new vocabulary rather than a parallel special case.
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
3. **One vocabulary:** the `watch` event names are a shared capability table in
   `lib/capabilities.ts`; the routine frontmatter schema pins in `lib/protocol-schema.ts`
   strict mode, with drift tests in the same PR.

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
