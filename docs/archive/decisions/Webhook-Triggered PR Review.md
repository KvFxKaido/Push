# Webhook-Triggered PR Review

> **Extension (2026-06-28):** the trigger layer now also accepts an on-demand
> `@push-agent review` comment (collaborator-gated) in addition to the
> `pull_request` open events — a commenter can request a review of the current
> head. Operational steps live in the runbook
> [`Enabling Autonomous PR Review.md` §7](<../../runbooks/Enabling Autonomous PR Review.md>);
> the shared enqueue core is `app/src/worker/pr-review-trigger.ts`.

Date: 2026-05-28
Status: **Current** — ROADMAP-tracked (`Autonomous Webhook PR Review`). Shipped: receiver + DO + REVIEW.md base-ref binding (#690), shared token-injectable client (#691), PWA read-only review-history surface (#692), web-tool suppression (#694), deep + cancellable reviews (#693), manual re-run from the PWA (#695), opt-in Checks-API gating (`PR_REVIEW_GATING_REPOS`, critical-only), and manual cancellation of an in-flight review from the PWA. Feature-complete for v1. Not live in prod until the `v4` DO migration is applied via a one-time non-versioned `wrangler deploy`; gating additionally needs the App's `checks: write` permission. Open: PWA gating-status surfacing and the multi-tenant read-authz caveat (both documented).
Owner: Push
Related: `app/src/worker/github-webhook.ts` (the receiver — signature, allowlist, event-select, enqueue),
`app/src/worker/pr-review-job-do.ts` (`PrReviewJob` DO — dedupe, coalesce, advisory post, `list` history),
`app/src/worker/worker-pr-review.ts` (`/api/pr-reviews` — read-only history route),
`app/src/hooks/usePrReviewHistory.ts` + `app/src/components/chat/hub-tabs/PrReviewHistorySection.tsx` (PWA polling surface),
`lib/reviewer-agent.ts` (the single-shot Reviewer the DO drives),
`lib/role-context.ts` (`buildReviewerContextBlock` — REVIEW.md injection, shared),
`lib/review-guidance.ts` (`resolveReviewGuidance` — shared resolver the DO binds at the PR base ref),
`app/src/worker/worker-infra.ts` (`generateGitHubAppJWT` / `exchangeForInstallationToken` — token mint the DO reuses),
`app/src/hooks/useGitHubAppAuth.ts` (the `push-agent` GitHub App this extends),
`app/src/worker/coder-job-do.ts` (the DO-as-async-job pattern this mirrors),
`docs/archive/decisions/Diff and Annotation Envelope.md` (the serializable annotation taxonomy a richer round-trip needs)

## TL;DR

Reference target is `Blue-Bear-Security/baloo-bear`: a self-hosted GitHub App
that auto-reviews every PR on `opened`/`synchronize` via webhook → FastAPI →
agentic LLM pass → severity-routed inline comments. We already have baloo's
*brain* — the agentic Reviewer (`runDeepReviewer`), the PR posting path
(`postReview`), REVIEW.md-as-guidelines, and the `push-agent` GitHub App. What
we lack is baloo's *trigger*: we are entirely **pull-based** (a user opens a PR
in the PWA and asks for a review). This sketch adds a thin **autonomous trigger
layer** — a webhook receiver + a Durable Object job — in front of the Reviewer
we already ship, surfacing results both on the PR and in the PWA review system.

**v1 posture: advisory comments only** (`event: 'COMMENT'`, never
`REQUEST_CHANGES`/`APPROVE`). Gating is a per-repo opt-in for a later phase. This
preserves Push's existing delivery model (advisory Reviewer, gating Auditor,
human-in-loop delivery) instead of silently inverting it.

## What we already have (don't rebuild)

| baloo capability | Push equivalent | gap |
|---|---|---|
| Agentic review beyond the diff | `lib/deep-reviewer-agent.ts` — 7-round tool loop, reads surrounding code | none; ours is richer |
| Reads `AGENTS.md`/`CONTRIBUTING.md` as guidelines | REVIEW.md, injected by `buildReviewerContextBlock` (`lib/role-context.ts:114`) | resolver is web-only (see below) |
| Posts inline PR comments | `postReview` (`app/src/lib/github-tools.ts:880`), 422→body fallback | none |
| Severity labels | Reviewer criteria (critical/warning/suggestion/note); REVIEW.md severity scale | we don't *act* on severity (no auto request-changes) — intentional for v1 |
| False-positive second pass | Auditor SAFE/UNSAFE gate (`lib/auditor-agent.ts`) | different purpose; reuse as optional verifier later |
| GitHub App auth | `push-agent` app, installation tokens (`useGitHubAppAuth.ts`) | **no webhook receiver** |

The one genuinely new surface is the **webhook receiver + the async job that
drives the Reviewer off it**. Everything downstream of "we have a diff and a
PR number" already exists.

## Architecture

Prototype path (solid); PWA history is the open follow-up (dashed):

```
GitHub  ──(pull_request: opened/synchronize)──▶  Worker  /api/github/webhook
                                                   │  verify HMAC sig (X-Hub-Signature-256)
                                                   │  installation-id allowlist (fail-closed)
                                                   │  event/draft filter
                                                   ▼
                                            PrReviewJob (Durable Object)
                                                   │  dedupe by delivery-id, coalesce by head SHA
                                                   │  fetch PR diff + REVIEW.md @ BASE ref
                                                   │  runReviewer(diff, { reviewGuidance, … })
                                                   │  re-check PR head == reviewed SHA
                                                   ▼
                              ┌────────────────────┴─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐
                              ▼                                            ▼
        advisory review (event: 'COMMENT')              PWA review-history store  (follow-up)
        inline annotations + 422→body fallback          (re-run, drill into reasoning)
```

REVIEW.md is resolved from the **base** ref (never a fork head) and the
prototype drives the single-shot `runReviewer`; `runDeepReviewer` (tool loop)
and the PWA store are documented follow-ups, not the landed path.

### 1. Webhook receiver (the new surface)

New route `/api/github/webhook` in the Worker (`app/src/worker.ts`). Responsibilities,
in order, each a hard gate:

1. **Signature verification.** HMAC-SHA256 of the raw body against the App's
   webhook secret (`GITHUB_WEBHOOK_SECRET`, dashboard var / `.dev.vars`, never
   committed — see CLAUDE.md config-file checklist). Constant-time compare.
   Reject with `401` on mismatch. This is the auth seam — trace one denied and
   one allowed path end-to-end per the PR self-review checklist.
2. **Installation allowlist.** Reuse `GITHUB_ALLOWED_INSTALLATION_IDS`
   (`useGitHubAppAuth.ts:69`). Reject unknown installations with `403`.
3. **Event filter.** Only `pull_request` with `action ∈ {opened, synchronize, reopened}`.
   Everything else → `204` no-op (logged, not silent — symmetric structured log).
4. **Dedupe.** GitHub retries deliveries; key `X-GitHub-Delivery` in a KV with a
   short TTL and drop replays. (Reuse the `SANDBOX_TOKENS` KV pattern or a new
   `WEBHOOK_DELIVERIES` namespace.)
5. **Enqueue + ACK fast.** Hand off to the DO and return `202` within GitHub's
   10s budget. The review itself must not run inline on the webhook request.

Each early-exit arm gets a paired structured log (`webhook_rejected_signature`
↔ `webhook_rejected_installation` ↔ `webhook_skipped_event` ↔
`webhook_dedup_dropped` ↔ `webhook_enqueued`) — per the Symmetric structured
logs convention. A webhook that silently drops a delivery is invisible to ops.

### 2. `PrReviewJob` Durable Object (the coordinator's home)

Per the new-feature checklist ("name the coordinator's home first"): the owning
module is a new `app/src/worker/pr-review-job-do.ts`, modeled on
`coder-job-do.ts`. It is **not** appended to any existing handler. One DO
instance per `(repoFullName, prNumber)` so concurrent `synchronize` events on
the same PR coalesce/cancel-stale instead of racing.

Responsibilities:
- Mint an installation token (existing `/api/github/app-token` exchange).
- Fetch the PR diff and head SHA.
- Resolve REVIEW.md at the PR head ref (see §"REVIEW.md by default").
- Run `runDeepReviewer(diff, { reviewGuidance, provider, modelId, … })`.
  Reviewer keeps its own sticky provider selection (per the provider-routing
  contract) — the webhook path has no chat lock to inherit, so it falls to the
  Reviewer default / active backend.
- Post results via `postReview` with `event: 'COMMENT'`.
- Write a review-history record for the PWA.

Bound the loop: `runDeepReviewer` already caps at 7 rounds / 60s per round, but
the DO needs its own deadline + abort wired into the stream signal (see the
`await`-in-a-loop checklist item — prove it exits on the deadline, not just on
`[REVIEW_COMPLETE]`).

### 3. Scope-keying (storage, CLI-first)

Per the new-feature checklist, the review-history store keys on durable
identifiers: `repoFullName + prNumber + headSha`, **not** a per-session id. This
is the key shape the PWA review tab queries and the key the dedupe layer reasons
about. The scope resolver lives in `lib/` from day one (follow
`lib/role-memory-budgets.ts`) so a future CLI `push review --pr <n>` can read the
same history.

### 4. PWA tie-in (the differentiator)

baloo dumps results into PR comments plus its own standalone dashboard. We
already have the review surface (`HubReviewTab.tsx`). Webhook-triggered reviews
write into the same review-history store the in-app Reviewer uses, so the PWA
gets: live status as the job runs, the deep-reviewer's reasoning trail (not just
the final comments), one-tap re-run, and history across PR iterations — in the
UI users already work in. This is a strictly better product than a bolt-on
dashboard because it's *the same review system*, just with a second trigger.

## REVIEW.md by default

**Status: already true on the PWA; this sketch makes it true everywhere.**

The in-app Reviewer already looks for a repo-root `REVIEW.md` by default:
`resolveReviewGuidance` (`app/src/lib/review-guidance.ts:30`) reads the
working-copy `/workspace/REVIEW.md` from the sandbox first (so unpushed edits
count), falls back to the GitHub copy on the branch ref
(`fetchReviewGuidance`, `github-tools.ts:945`), and returns `null` when none
exists. `HubReviewTab.tsx:770` calls it before every review and threads the
result into `buildReviewerContextBlock` (`lib/role-context.ts:114`), which
renders a `## Repository Review Guidance (REVIEW.md)` block instructing the
model to weight findings by the repo's priorities without lowering the
correctness/security bar. Covered by `review-guidance.test.ts` and
`role-context.test.ts`.

The resolver has now been **promoted into `lib/review-guidance.ts`** (shared
core) so every surface inherits one fail-open, working-copy-first lookup. The
core takes injected reads — `resolveReviewGuidance({ readWorkingCopy?,
fetchCommitted? })` — and surfaces supply the fetchers, mirroring how the
project-instructions loader is split (shared `lib/project-instructions.ts`
sanitizer, per-surface fetch). It emits one structured log per outcome
(`review_guidance_resolved` ↔ `review_guidance_working_copy_failed` ↔
`review_guidance_committed_failed` ↔ `review_guidance_absent`).

Landed with the promotion:

1. **Web** (`app/src/lib/review-guidance.ts`) is now a thin binding over the
   core — sandbox read as `readWorkingCopy`, GitHub-at-ref as `fetchCommitted`.
   Public signature (`{ repoFullName, ref, sandboxId }`) unchanged, so
   `HubReviewTab.tsx` is untouched and the existing test still passes.

2. **CLI Reviewer** now resolves REVIEW.md by default. `handleDelegateReviewer`
   (`cli/pushd.ts`) reads the daemon workspace's working-copy `REVIEW.md`
   (line-capped, ENOENT→absent) via the core and populates
   `context.reviewGuidance` before `runReviewer`. An explicit caller-supplied
   `reviewGuidance` still wins (the RPC client may know the review ref);
   otherwise the local working copy fills it. Closes the gap where
   `buildReviewerContextBlock` only rendered guidance when a caller happened to
   supply it.

3. **Webhook DO** is now the third binding. `defaultPrReviewExecutor`
   (`pr-review-job-do.ts`) supplies a `fetchCommitted` that reads REVIEW.md at
   the PR **base** ref via the installation token, and skips guidance entirely
   for cross-fork PRs (a fork head is attacker-controlled — see Security
   checklist). No working-copy source, since there's no sandbox in the webhook
   path. The result threads into `buildReviewerContextBlock` like every other
   surface.

## Severity → action mapping (shipped — opt-in gating)

Advisory comments stay the **default** for every repo. Gating is **opt-in per
repo** via `PR_REVIEW_GATING_REPOS` (comma/space-separated `owner/name`,
case-insensitive). For a listed repo the DO posts a **GitHub Checks API run** on
the reviewed commit alongside the advisory comment:

- any 🔴 **critical** finding → check `conclusion: failure`
- otherwise → `conclusion: success`

We deliberately chose the **Checks API** over `event: 'REQUEST_CHANGES'`: it's
lower-friction (only blocks merge if the repo *requires* that check, and the
next review's check supersedes it — no human dismissal needed) and doesn't
invert Push's advisory-Reviewer posture for repos that don't opt in. The
threshold is **critical-only** to minimize false blocks. The GitHub App needs
the `checks: write` permission; a check-run post failure is logged
(`pr_review_check_run_failed`) but never aborts the already-posted advisory
review. `REQUEST_CHANGES` and the Auditor-as-false-positive-verifier remain
possible future escalations, not part of this opt-in.

## New vocabulary + drift tests

Per the new-feature checklist ("one source of truth per vocabulary"):
- The webhook payload subset we consume (`ReviewablePullRequest`) lives in
  `github-webhook.ts`; the prototype keeps it local. When the PWA review-history
  record lands, its canonical definition goes in `lib/` (extend
  `lib/protocol-schema.ts` strict mode) with a drift-detector test in
  `cli/tests/protocol-drift.test.mjs` in the same PR.
- No new *tool* is required (the DO calls the single-shot `runReviewer` directly,
  not via the tool dispatcher), so `daemon-integration.test.mjs` is untouched.
  The prototype uses the quick Reviewer; switching to `runDeepReviewer` (tool
  loop, reads beyond the diff) is a follow-up that needs GitHub tool execution
  wired into the DO.

## Security checklist (this is mostly an auth-seam feature)

- **Webhook secret + installation allowlist** are the gates; grep the diff for a
  committed secret before pushing (`wrangler.jsonc` config-file checklist).
- **Token scope.** Installation tokens are repo-scoped already; the DO must not
  widen them. The MCP GitHub server is repo-restricted by config — the webhook
  DO talks to GitHub via the app-token exchange, not the MCP server.
- **Untrusted PR content.** PR title/body/diff and comment threads are
  external, attacker-controllable input (anyone who can open a PR). The
  deep-reviewer already treats diff content as data, but the error-formatting
  checklist applies: don't render raw upstream JSON/stderr into PR comments
  verbatim — wrap/escape. REVIEW.md fetched from a fork's head is also
  attacker-controlled on `pull_request_target`-style events; resolve it from the
  **base** repo ref, not the fork head, or skip guidance for cross-fork PRs.
- **HTTP status classification.** The DO's GitHub failures (token exchange, diff
  fetch, review post) carry the status into `classifyError`, which maps them to
  `auth` / `rate_limit` / `not_found` / `validation` / `upstream` on the
  `review.failed` event rather than collapsing to "unknown" — see PR #656.
- **`/api/pr-reviews` read authorization (decided: keep as-is).** The history
  read is gated by the deployment-token + origin checks like every other Push
  read endpoint (`/api/jobs`, `/api/artifacts`), but unlike those its key
  (`repo`+`pr`) is *guessable* and it does **not** verify the caller's GitHub
  token can access that repo/PR. Accepted for the **single-owner private
  deployment** model: a caller with the deployment token already has full app
  access (and can open those PRs / run reviews in-app), and completed findings
  are PR-bound anyway. Adding per-request GitHub authz here alone would create
  the auth asymmetry CLAUDE.md warns against. **Multi-tenant caveat:** a shared
  deployment token across distinct GitHub users would leak one user's review
  history to another via the guessable key — revisit (across all read
  endpoints, not just this one) if Push ever supports multi-tenant deployments.
  Raised by Copilot on PR #692.

## Scope

**Landed (prototype):**

- `github-webhook.ts` — receiver with HMAC signature verify (constant-time),
  fail-closed on unset secret, installation allowlist (fail-closed on empty),
  event/draft filter, fast 202 enqueue. Exempted from the deployment-token gate
  (`isDeploymentTokenExemptPath`) since GitHub can't carry that token. 15 tests.
- `pr-review-job-do.ts` — `PrReviewJob` DO: per-PR SQLite, replay dedupe by
  delivery id, coalesce-by-head-SHA with abort of the superseded run, status
  snapshot, structured event log. Advisory-only post (`event: 'COMMENT'`) with
  the 422→body-only fallback. REVIEW.md resolved at the base ref. Model/GitHub
  leaf behind an injectable executor seam. 5 tests.
- Wiring: route in `EXACT_API_ROUTES`, DO export + `wrangler.jsonc` binding +
  `v4` migration, `Env` fields (`GITHUB_WEBHOOK_SECRET`, `PrReviewJob`,
  `PR_REVIEW_PROVIDER`/`PR_REVIEW_MODEL`).
- **Shared client** (#691): `github-tools` REST helpers are token-injectable, so
  the DO posts through the same client as the browser reviewer (one format, one
  retry policy — review POST is non-retrying). No DO-local fetch helpers.
- **PWA read-only history** (this cycle): the DO persists the full `ReviewResult`
  (`result_json`) and exposes a `list` action; `/api/pr-reviews?repo=&pr=`
  forwards to it; `usePrReviewHistory` polls (fast while in-flight, slow idle)
  and `PrReviewHistorySection` renders per-PR review status + findings in the
  review tab, self-hiding when there's no open PR or no reviews.
- **Manual cancellation**: a `cancel` DO action drives a `queued`/`running`
  review to a terminal `cancelled` status, aborts the live `AbortController`
  (the deep reviewer composes the signal, so the in-flight model/tool round stops
  rather than running to its budget), and closes the check-run as neutral
  ("Review cancelled"). The cancel path is the single owner of that terminal
  transition + check-run close — `runReview`'s abort catch early-returns on
  `cancelled` exactly as it does for the timeout sweep's `failed`, so the close
  isn't double-driven. `POST /api/pr-reviews/cancel { repo, pr, deliveryId }`
  forwards to it (origin- + rate-limit-gated like the other actions, but
  deliberately **not** gated on the reviewer kill-switch or App creds — cancelling
  a running review must work after the reviewer is turned off, and the check-run
  close is best-effort/token-gated). Already-terminal reviews return 409 so a
  stale tab gets a clear signal. A per-row "Cancel" control in
  `PrReviewHistorySection` (shown only for in-flight rows) calls it and refreshes.

**Remaining:** `runDeepReviewer` upgrade (needs DO-side GitHub tool exec; the
shared client unblocks it), re-run-from-PWA (a manual trigger route), and
severity→gating (below).

**Abort propagation (follow-up).** Superseding aborts the DO's `AbortController`,
but `runReviewer` doesn't take an `AbortSignal` and `createWebStreamAdapter`
isn't signal-aware, so a superseded run's underlying model call keeps going
until the reviewer's 90s timeout — the DO only checks `signal.aborted` *after*
`runReviewer` returns and skips the post then (plus the post-time head re-check
catches a head that advanced before our own delivery's coalescing fired). The
wasted model time is bounded by that timeout but real. Closing it means
threading a signal through the reviewer kernel / stream adapter (shared API
change, same plumbing the CLI's `signalAwareStream` wrapper does for
`delegate_reviewer`) — deferred to keep this change contained.

**Out (non-goals for v1):** merge gating / `REQUEST_CHANGES`, Checks API
annotations, Dependabot-specific logic, multi-model fallback, cross-fork
`pull_request_target` handling beyond the base-ref REVIEW.md guard above.

## Graduation triggers

Promote from Draft to a supported feature when a `ROADMAP.md` entry lands
prioritizing autonomous PR review — at which point the PWA review-history wiring
and the deep-reviewer upgrade are the first increments on top of the prototype.
