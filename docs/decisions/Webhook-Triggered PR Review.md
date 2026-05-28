# Webhook-Triggered PR Review

Date: 2026-05-28
Status: **Draft** — design sketch; needs a `ROADMAP.md` entry to graduate to an implementation commitment
Owner: Push
Related: `lib/deep-reviewer-agent.ts` (the agent this reuses unchanged),
`lib/reviewer-agent.ts` (quick-pass fallback),
`lib/role-context.ts` (`buildReviewerContextBlock` — REVIEW.md injection, already shared),
`app/src/lib/review-guidance.ts` (`resolveReviewGuidance` — web-only resolver this generalizes),
`app/src/lib/github-tools.ts:880` (`postReview` — the PR round-trip this reuses),
`app/src/hooks/useGitHubAppAuth.ts` (the `push-agent` GitHub App this extends),
`app/src/worker/coder-job-do.ts` (the DO-as-async-job pattern this mirrors),
`docs/decisions/Diff and Annotation Envelope.md` (the serializable annotation taxonomy the round-trip needs)

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

```
GitHub  ──(pull_request: opened/synchronize)──▶  Worker  /api/github/webhook
                                                   │  verify HMAC sig (X-Hub-Signature-256)
                                                   │  installation-id allowlist
                                                   │  dedupe (delivery-id KV)
                                                   ▼
                                            PrReviewJob (Durable Object)
                                                   │  fetch diff + REVIEW.md @ PR head
                                                   │  runDeepReviewer(diff, { reviewGuidance, … })
                                                   ▼
                              ┌────────────────────┴────────────────────┐
                              ▼                                          ▼
                  postReview (COMMENT only)                  PWA review-history store
                  inline annotations on the PR              (re-run, drill into reasoning)
```

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

Remaining for **the webhook path** (this doc): supply a `fetchCommitted` that
reads REVIEW.md at the PR ref via the installation token — resolved from the
**base** repo ref, not a fork head (see Security checklist). No new resolver
work; just the third binding.

## Severity → action mapping (deliberately deferred)

baloo maps CRITICAL/HIGH → request-changes, MEDIUM → Checks annotations,
LOW → dropped. Push's REVIEW.md already defines the severity scale
(🔴/🟠/🟡/🟢). For v1 we **render** severity in the posted comments but take no
gating action — `event: 'COMMENT'` only. Reasons:

- It inverts Push's posture. Our model is advisory Reviewer + gating Auditor +
  human-in-loop delivery. A bot that auto-requests-changes on every PR is a
  different product decision, not a config tweak.
- False positives on `REQUEST_CHANGES` are high-friction (they block merge and
  require a human dismiss). Advisory comments degrade gracefully.

Phase 2 opt-in (per-repo, off by default): map 🔴 → `REQUEST_CHANGES`, optionally
run the Auditor as the false-positive verifier baloo bolts on as a second LLM
pass — we already have that agent. The Checks API annotation path
(neutral/failure on the PR's checks tab) is the lower-friction middle ground and
probably the right first gating step.

## New vocabulary + drift tests

Per the new-feature checklist ("one source of truth per vocabulary"):
- The webhook payload subset we consume and the review-history record are new
  envelope types. Canonical definition goes in `lib/` (extend
  `lib/protocol-schema.ts` strict mode) with a drift-detector test in
  `cli/tests/protocol-drift.test.mjs` in the same PR.
- No new *tool* is required (the DO calls `runDeepReviewer` directly, not via
  the tool dispatcher), so `daemon-integration.test.mjs` is untouched.

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
- **HTTP status classification.** The webhook handler's `if (status >= 400)`
  arms (token exchange, diff fetch, `postReview`) each enumerate
  auth/rate-limit/not-found/validation rather than collapsing to "unknown" —
  see PR #656.

## Scope / estimate

In: webhook receiver, `PrReviewJob` DO, REVIEW.md resolver promotion to `lib/`,
PWA review-history wiring, advisory-only posting, drift tests. Roughly 2–3 days.

Out (explicit non-goals for v1): merge gating / `REQUEST_CHANGES`, Checks API
annotations, Dependabot-specific logic, multi-model fallback (we route through
one locked provider), cross-fork `pull_request_target` handling beyond the
base-ref REVIEW.md guard above.

## Graduation triggers

Promote from Draft to an implementation commitment when **either**: a `ROADMAP.md`
entry lands prioritizing autonomous PR review, **or** the REVIEW.md resolver
needs promoting to `lib/` for an unrelated reason (CLI Reviewer guidance) — at
which point the webhook trigger is a small increment on top.
