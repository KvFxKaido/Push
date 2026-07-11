# CodeWhale — Lessons for Push

Status: Reference (research snapshot, 2026-07-11)
Source: `Hmbown/CodeWhale` v0.8.68 (Rust workspace, ~17 crates) — `docs/`
(RECEIPTS, FLEET, AGENT_RUNTIME, SUBAGENTS, AUTOMATIC_WORKFLOWS, TOOL_LIFECYCLE,
MODES, MEMORY, TTC_DESIGN, PROVIDERS, CONFIGURATION), `crates/execpolicy`,
`crates/workflow` + `workflow-js`, `crates/lane`, `crates/hooks`,
`crates/secrets`, `integrations/` (Telegram/Feishu/WeCom bridges over
`bridge-core`), `web/scripts/` (facts-drift gates), and the agent-process
artifacts (`AGENTS.md`, `HANDOFF_v0.8.68_completion.md`,
`CODEWHALE_0_8_68_TRACKER.md`, `docs/evidence/`) — cross-read against Push's
root `lib/` + `cli/` + `app/src/worker/` runtime.

## Why this doc exists

CodeWhale is a terminal coding agent that grew out of `deepseek-tui`: a
TUI/CLI over one headless runtime, 30+ providers, a durable multi-worker
"Fleet" layer with an append-only ledger, QuickJS-scripted workflows, chat-app
bridges, and — unusually — a development process run largely *by* AI agents
against handoff documents. It approaches Push's thesis from the opposite
direction: instead of building a chat product, it gave a local runtime a
stable HTTP/SSE contract and let every surface (TUI, VS Code, Telegram) be a
thin adapter. Where crush ([`charmbracelet crush — Lessons for
Push.md`](charmbracelet%20crush%20—%20Lessons%20for%20Push.md)) was the
CLI-product comparison and deepagents the harness-library comparison,
CodeWhale is the *governed-orchestration* comparison — receipts, gates,
policy engines, and durable fan-out — plus the best worked example we've seen
of docs-as-infrastructure for agent-run development.

Same disclaimer as the prior reviews: this is a concept map, not a dependency
proposal. Everything worth taking is independently reimplementable, and
several of CodeWhale's own retrospectives (below) *validate* Push decisions
rather than challenge them.

## The map

| CodeWhale feature | Push equivalent | State |
|---|---|---|
| **Review receipts** — `review --write-receipt` persists a SHA-256 `diff_fingerprint` + structured findings + `unresolved_risk`; `--check-receipt` is a model-free pre-push gate that fails if the current diff no longer matches (`docs/RECEIPTS.md`, `crates/tui/src/tools/review.rs`) | Gate-at-Push runs the Auditor *at* `prepare_push`/`sandbox_push`; a fingerprint primitive exists (`fingerprintString` / `diffFingerprint`, `lib/auditor-agent.ts:206,240`) but only as an in-memory dedup key for audit status — nothing is persisted or re-checked at push time | ⚠️ Gap, highest-value borrow. See takeaway 1. |
| **Enforced repo law** — `.codewhale/constitution.json` `protected_invariants` with path globs compile into write gates evaluated before the write runs (`ask` force-prompts in every mode; `block` denies); schema can only *add* restrictions; parse failures degrade to fewer rules (`crates/tui/src/repo_law.rs`) | Project instructions (`PUSH.md` → `AGENTS.md` → …) are prompt-only content through `lib/project-instructions.ts` — guidance, not mechanism | ⚠️ Gap. See takeaway 2. |
| **`codewhale doctor`** — per-provider key presence with *source attribution* (env vs config vs keyring), live probes with error-classified remediation, skills-discovery listing, `--json` mode that skips network probes for CI (`crates/tui/src/main.rs` `run_doctor`) | No equivalent — `push config init` sets up; nothing diagnoses. Push's surface area (config perms, provider keys, `pushd` reachability, session store, two sandbox backends, multi-dir skill discovery) is exactly where a doctor pays off | ⚠️ Gap. See takeaway 3. |
| **Fleet receipts with failure-source typing** — worker results are `pass/fail/partial/skip/timeout` with the failure *source* attributed (`transport \| task \| verifier`); the manager runbook teaches classify-before-act ("do not restart pure task failures by default") (`docs/FLEET.md`) | Coder-job DO has checkpoint/resume with paired structured logs (`coder_resume_*`, `app/src/worker/coder-job-do.ts`), but the *result* carries no failure-source field — the right reaction must be re-derived from logs | ⚠️ Gap. See takeaway 4. |
| **Side-git turn snapshots** — every turn commits pre/post working-tree snapshots into a side repo (`--git-dir` + `--work-tree` always paired, user's `.git` never touched); `/restore` rolls back a turn; git packfile dedup + retention pruning; non-fatal by design (`crates/tui/src/snapshot/`) | CLI checkpoint store (`cli/checkpoint-store.ts`) — *manual named* checkpoints, file copies of paths differing from HEAD, 1 MB/file cap; native checkpoint store on Android ([`Native Checkpoint Store.md`](../decisions/Native%20Checkpoint%20Store.md)) | ◐ Push has the manual half. The delta is *automatic per-turn* capture with git-object dedup and delete-handling. See takeaway 5. |
| **Soft-auto orchestration** — lead model announces the fan-out shape before launching; read-only plans auto-start, writes need an approval card; a pure `elevation.rs` function computes "needs approval?" from the plan (writes? network? child count? budget?); an explicit suppression list says when *not* to orchestrate (`docs/AUTOMATIC_WORKFLOWS.md`, `crates/workflow/src/elevation.rs`) | Orchestrator decides fan-out case-by-case; Gate-at-Push audits the *diff after* execution; no plan-level elevation function, no announce-first convention, no written suppression list | ◐ See takeaway 6. |
| **Runtime API + thin chat bridges** — Thread→Turn→Item model, monotonic `seq` replay (`/events?since_seq=N`), `approval.required` SSE events answered by `/allow <id>` or inline buttons incl. "Allow + remember"; Telegram/Feishu/WeCom bridges are ~1k-line adapters over a shared `bridge-core` (`docs/RUNTIME_API.md`, `integrations/`) | Substantially shipped: `pushd` has `sinceSeq` event replay (`cli/pushd.ts:3971`), `approval_required`/`submit_approval` round-trips (`cli/pushd.ts:976`), relay + device pairing | ✅ Core exists — validates the architecture. Remaining deltas: a `bridge-core`-style adapter kernel if a Slack/Telegram surface ships, and "allow + remember" amendments (see takeaway 8). |
| **Execpolicy matching machinery** — arity-aware allow prefixes (static positional-token table: `git status` matches `git status --porcelain`, never `git push`); deny matches *any* chained segment while allow requires a single segment; approval prompts can carry a persist-this-prefix amendment, never for chained commands (`crates/execpolicy/`) | `lib/git/policy.ts` already splits on `&&`/`\|\|`/`;`/`&`/newlines and evaluates per segment (line 196); `lib/command-policy.ts` has `isSinglePlainCommand` — the deny/allow asymmetry is present | ✅ Deny side: have it. Deltas worth noting: the arity table (if a user-facing allowlist ever ships) and amendment-on-approval UX. See smaller borrows. |
| **Facts-drift gates for human-facing docs** — scripts parse the *source* (provider enums, tool counts, version) into a generated facts file docs import; CI fails on staleness *and* on unmapped enum variants (deriver blind spots); doc topics carry `repoSource` pointers CI verifies (`web/scripts/check-facts.mjs`, `check-docs.mjs`) | Drift tests cover *protocol* (`cli/tests/protocol-drift.test.mjs`, prompt-vs-capability sync) but not prose: the "~3k tokens across ~68 tools" figure in `CLAUDE.md` is hand-asserted, unmeasured | ⚠️ Gap. See takeaway 7. |
| **Agent-run process artifacts** — handoffs that treat the previous agent's claims as untrusted (evidence per claim, explicit corrections tables), negative knowledge recorded ("load-bearing, a prior agent deleted it and caused 19 compile errors"; "theory measured and disproven"), release trackers with SCOPE/DEFER/CLOSE dispositions, `docs/evidence/` QA matrices (scenario → expected → named test symbol) | `CLAUDE.md` PR self-review checklist (incident-traceable), decision docs with `Status:` lifecycle, known recurring defect classes in `REVIEW.md` | ◐ Push has the review-side half; nothing for multi-session handoff or committed release evidence. See takeaway 9. |
| **The single-`agent`-tool collapse** — `agent_open/eval/close/delegate_to_agent`, a capacity controller that silently cleared transcripts, and "loadout tiers" that never changed routing were all deleted; lifecycle re-absorbed as actions on one tool; `AGENTS.md` pins "removed machinery stays gone" | Push did the same move once — the `'carried'` BranchSwitchPayload kind and migration machinery removed in #1257/#1258 | ✅ Aligned. The transferable residue: "never routes differently" as a standing removal test, and naming removals in the agents file so agents don't resurrect them. |
| **Deterministic orchestration replay** — the workflow VM throws on `Date`/`Math.random`; leaf results are recorded keyed by input hash; replay divergence is a typed error, never silent live fallback — so orchestration logic is CI-tested with zero model calls (`crates/workflow/src/replay.rs`, `crates/workflow-js/`) | `lib/task-graph.ts` is the equivalent coordinator; its tests don't use recorded-replay | ◐ Testing idea, cheap to adopt. See smaller borrows. |
| **Truthfulness enforcement** — the permission chip must report *effective* posture in every mode (tested); a TUI-only setting is structurally unable to loosen managed policy; displays only claim facts the route publishes; sub-agent results are `verification: self_report_only` unless a gate proves them | `lib/role-display.ts` is the single label source; Reviewer/Auditor results don't carry an evidence-level field distinguishing "model claimed it" from "a check proved it" | ◐ See smaller borrows (`self_report_only`). |
| **Delegation brief shape** — `QUESTION / SCOPE / ALREADY_KNOWN / EFFORT / STOP_CONDITION / OUTPUT`, with role-calibrated effort guidance ("explore ≈ 3-5 tool calls") | `lib/delegation-brief.ts` carries task/intent/`knownContext`/constraints/`acceptanceCriteria` + a capabilities line — richer overall, but no explicit stop condition or effort tier | ◐ Two missing fields. See smaller borrows. |
| **Sub-agent governors** — per-provider fanout caps (subscription routes get gentler pressure than direct keys); aggregate token budget shared by root + descendants; heartbeat kept ≥30s above the API timeout so a long request isn't killed before its own timeout fires | Provider lock inherited into delegated runs; `lib/role-memory-budgets.ts` for memory budgets; no per-provider concurrency profile | ◐ Small; the heartbeat-above-timeout invariant applies to coder-job DO alarm timing. |
| **Workflow scripting VM** — QuickJS, heap-capped, host surface limited to `task/parallel/pipeline/phase/log`, spawn caps counted VM-side | `lib/task-graph.ts` — dependency-aware, no scripting layer | ✅ Non-gap: CodeWhale's own docs demote scripting ("ordinary multi-agent work does not require this file"). Validates not building a second executor. |
| **Config overlays can't repoint credentials** — project-local config cannot set `provider`/`api_key`/`base_url`; `insecure_skip_tls_verify` parsed (for doctor warnings) but rejected at the client | Same threat model as the `remote-mutation` block in `lib/git/policy.ts`, applied to git; workspace-loaded content (`.push/skills`, `PUSH.md`) is prompt-only today and has no config authority to abuse — worth keeping true as `.push/` grows | ✅ Posture aligned; add the invariant to review checklists when workspace config lands. |

## What's worth borrowing (ranked)

1. **Push-time receipts: persist the audit fingerprint, re-check before the
   push.** The primitive already exists — `lib/auditor-agent.ts` fingerprints
   the diff to key audit status. The borrow is making it a durable artifact:
   `prepare_push` records `{ diffFingerprint, verdict, unresolvedRisk }`; the
   actual `sandbox_push` re-fingerprints and refuses (model-free, deterministic)
   if the tree changed since the audit. That closes the audit→push TOCTOU
   window, lets an unchanged diff skip re-auditing, and produces an artifact the
   PR flow can carry. CodeWhale's honesty details are worth copying too: the
   receipt stores a hash of the review text (not the diff body) and an explicit
   claim ceiling (`not_safety_certification`).

2. **A tighten-only, mechanically-enforced subset of project instructions.**
   Today `PUSH.md` is guidance; a cooperating model follows it, a
   non-cooperating one doesn't — which by Push's own test ("if a
   non-cooperating model could break it, the fix belongs in code") means the
   protective parts belong in the runtime. CodeWhale's shape: a small
   structured file whose path-glob `protected_invariants` become real write
   gates in the dispatcher (`ask` force-prompts even in permissive modes,
   `block` denies), with three invariants to copy verbatim — the schema **can
   only add restrictions** (a hostile cloned repo must never grant itself
   authority), parse failure degrades to *zero* rules rather than a poisoned
   gate, and the write-tool allowlist needs a drift test proving every
   write-capable tool is enumerated (their gate failed open for a tool they
   forgot; they documented the near-miss in the source). First candidate use:
   glob-protect `wrangler.jsonc` and `secrets/` in `lib/tool-dispatch.ts`.

3. **`push doctor`.** The two details that make CodeWhale's version genuinely
   good, beyond the obvious checklist: **key-source attribution in
   remediation** ("the rejected key came from env `X`, which shadows your
   config — run `push config init` or unset it") — stale-env-var-vs-config is
   the canonical auth confusion and this answers it; and a **`--json` mode
   that skips live probes** so CI can consume it safely. Push's checks:
   config perms (0600 — and consider CodeWhale's stricter posture of
   *refusing to read* a loosened file, since creation-time chmod doesn't
   survive a later `chmod 644`), per-provider key presence (never values),
   `pushd` reachability, session-store integrity, skills discovery across
   `.push/skills` + `.claude/commands`, sandbox backend reachability.

4. **Failure-source typing on delegated results.** CodeWhale's receipts carry
   `transport | task | verifier` because the correct manager action (retry /
   hand to owner / escalate) is a pure function of the source — so it must be
   a typed field, not something re-derived from logs. This is Push's own
   HTTP-status-classification review rule applied to job receipts. Concretely:
   background coder-job outcomes (`meta.*` on the result envelope) gain a
   `failureSource` field, and the orchestrator's retry policy branches on it.
   The companion idea — a `resume`-style **idempotent reconciliation verb**
   ("replay the ledger, retry stale work within budget, launch nothing new") —
   is what would make detached runs trustworthy after DO evictions.

5. **Automatic per-turn snapshots on the CLI.** `cli/checkpoint-store.ts` is
   the manual half; the CodeWhale delta is capture that happens *every turn*
   without being asked, so "undo the agent's last turn" always works. Their
   side-git design is the reference implementation for doing this cheaply at
   scale: snapshots into a side repo (`--git-dir` + `--work-tree` always
   passed together — the user's `.git`, HEAD, and branch are never touched, so
   it composes with Push's blocked-`git checkout` policy and can't desync
   tracked branch state), packfile dedup instead of file copies (removes the
   1 MB/file cap), correct delete-handling on restore, retention pruning, and
   a non-fatal failure model (a snapshot error never blocks the turn).

6. **Plan-level elevation + announce-the-shape.** A pure function over the
   task graph — `assess(plan) → { writes, network, childCount, budget,
   elevated }` — decides whether fan-out needs an approval card, computed from
   the graph rather than from prompt text; read-only Explorer sweeps
   auto-start, Coder delegations show the plan first. Plus two UX conventions:
   the lead **announces the shape before launching** ("three explorers, then
   one synthesis"), and a **written suppression list** of when not to
   orchestrate (one-file edits, factual questions, interactive design
   conversations). Complements Gate-at-Push cleanly: audit the plan before,
   the diff after, both mechanical.

7. **Facts-derivation gates for prose.** Extend the drift-test discipline
   from protocol to human-facing claims. Two concrete applications: replace
   the hand-asserted "~3k tokens across ~68 tools" in `CLAUDE.md` with a
   measuring script + budget test (CodeWhale has exactly this:
   `scripts/measure-tool-catalog.py`); and give doc topics `repoSource`
   pointers that CI verifies still exist. The sharpest detail to copy: their
   CI gate hard-fails on **unmapped enum variants**, catching the case where
   committed and freshly-derived facts *both* silently omit a new entry —
   i.e. it gates the deriver's own completeness, not just staleness.

8. **"Allow + remember" approval amendments.** An approval prompt can carry a
   persist-this-decision amendment (CodeWhale: persist a command prefix as
   trusted — but never for chained commands). Push's `approval_required`
   round-trip over `pushd` already exists; the amendment is the missing UX for
   killing repeat prompts without a settings page, and the never-for-chained
   rule transfers directly since `lib/git/policy.ts` already segments.

9. **Process artifacts for agent-run development.** The pieces Push doesn't
   have: **handoff docs that audit their predecessor** (evidence per claim; an
   explicit "what the previous handoff claimed but isn't done" table),
   **negative knowledge kept where agents will re-read it** ("this module
   looks dead but is load-bearing — deleting it cost 19 compile errors";
   "this theory was measured and disproven, spend effort elsewhere"; "removed
   machinery stays gone" — CodeWhale learned agents resurrect deleted surfaces
   from stale memory unless the removal is named in the agents file),
   **SCOPE/DEFER/CLOSE dispositions** so nothing exits a release untriaged,
   and **`docs/evidence/` QA matrices** (scenario → expected → named test
   symbol) as committed release evidence — the hashline boundary-case list in
   `CLAUDE.md` is one of these waiting to be written down, and naming test
   symbols means a rename breaks the pointer visibly.

### Smaller borrows

- **`STOP_CONDITION` and `EFFORT` fields on the delegation brief.** Push's
  brief has acceptance criteria but no explicit stop condition; CodeWhale's
  finding is that explorers without one burn calls re-verifying
  `ALREADY_KNOWN` facts. Role-calibrated effort hints ("explore ≈ 3-5 tool
  calls") are cheap to add to `lib/delegation-brief.ts`.
- **`self_report_only` as a first-class verification status.** Delegated-run
  summaries are self-reports unless a gate or artifact proves them; a
  `verification` provenance field on coder-job results (pointing at the
  Auditor receipt or test run) makes the distinction machine-readable.
- **Heartbeat ≥ API-timeout + margin.** Their stale-agent reaper is kept 30s
  above the provider timeout so a long request can't be killed before its own
  timeout fires — a one-line invariant relevant to coder-job DO alarm timing.
- **Recorded-replay tests for `lib/task-graph.ts`.** Key leaf results by
  input hash, replay coordination logic with zero model calls, and make
  divergence a typed failure rather than silent live fallback.
- **Named config profiles.** `[profiles.work]` bundles
  provider+model+reasoning; makes the chat-lock story cleaner than implicit
  "defaults + active pick" and gives the CLI `push --profile work`. A shared
  reasoning-effort abstraction (translated per provider dialect) is the
  companion piece a multi-provider lock eventually needs.
- **`.mailmap` for agent identities** before git history gets noisy, and
  commit-trailer-as-automation-API: Push already emits `Claude-Session:`
  trailers; a CI linter guarding the convention plus a workflow consuming it
  (auto-linking sessions to PRs) follows CodeWhale's harvest-credit shape.
- **Dry-run-first automation rollout.** New enforcement gates ship in
  observable dry-run mode with an explicit flip condition; CI workflows no-op
  green until their secret exists, so they're safe to merge before
  configuration.
- **The npm-distributed-binary pattern** (checksum manifest as a release
  artifact, verify on install *and* on cache reuse, atomic temp-file rename,
  version pin checked at install and run time) — the reference if the Push
  CLI ever ships compiled.

## What not to borrow

- **The workflow scripting VM.** CodeWhale's own authoring doc opens with
  "ordinary multi-agent work does not require this file — prefer natural
  language." `lib/task-graph.ts` plus a checked-in *declarative* recipe format
  (if repeatable release-lane runs are ever wanted) covers the need without a
  second executor. Their hard rule is still worth keeping: any recipe format
  must compile into the existing executor, never bypass it.
- **Fleet's distribution machinery** — SSH host adapters, mTLS worker
  identity, four-tier trust model. `lib/sandbox-provider.ts` already owns
  "where work runs," and Push's single-user surfaces don't need worker
  attestation.
- **OS-level sandbox layers** (Seatbelt/Landlock/bwrap). Push's
  container-based sandboxes make them moot. The one transferable fragment is
  denial *classification* — `sandbox_exec` failures distinguishing "policy
  blocked" vs "sandbox denied" vs "command failed" as structured error types,
  which is Push's HTTP-status-classification rule applied to exec.
- **Seven named sub-agent roles.** Push's five internal roles with
  phase-first display already made the leaner choice; CodeWhale's own history
  (deleting decorative vocabulary that never routed differently) argues for
  Push's side.

## Where Push is already ahead

- **One event vocabulary, test-enforced.** CodeWhale's "one runtime, one
  event vocabulary" rule is doc-enforced; Push pins it with
  `cli/tests/protocol-drift.test.mjs` and `lib/protocol-schema.ts` strict
  mode.
- **Segment-aware command policy.** Their execpolicy's chained-command
  handling is a headline feature; `lib/git/policy.ts` already splits and
  evaluates per segment, with the redirection-operator edge cases handled.
- **The remote-control story.** `pushd` already ships `sinceSeq` event
  replay, awaited `approval_required` round-trips, relay, and device pairing —
  the contract CodeWhale's bridges exist to prove out. Their architecture
  *validates* the daemon-as-runtime bet; only the chat-app adapters and
  approval amendments remain as ideas.
- **The Auditor as a required fail-closed gate.** CodeWhale's
  scorers/verifiers are opt-in per task spec; Push's delivery gates fail
  closed when unrunnable.
- **Richer delegation brief and per-message provenance.** The
  capabilities-aware brief and `message.branch` write-time stamps ship today
  what their Workroom doc only drafts.
- **Decision-doc lifecycle.** Their RFCs have a `Status:` header but no label
  vocabulary, no same-PR flip rule, no archive discipline.

## Alignment notes

Three CodeWhale doctrines independently confirm Push conventions, with
phrasings worth adopting into checklists:

- *"Does it launch and observe the one runtime, or does it invent a second
  one? Only the former is allowed."* — their litmus test for new agent
  surfaces, learned after in-process sub-agents and fleet workers drifted
  into different lifecycle semantics. Push's version of that seam is
  inline-lane vs background coder jobs vs CLI daemon; the companion **cutover
  rule** makes it testable: detached work must never have *weaker*
  retry-and-receipt semantics than its durable sibling.
- *"Behavior lives in code, not prompts"* — enforced structurally throughout:
  verify-tool recursion blocked in the registry rather than the prompt,
  config overlays that cannot set credentials, TLS-skip parsed but rejected,
  Plan mode removing write tools from the catalog instead of trusting
  instructions.
- *"Delete vocabulary that never routes differently."* — their standing
  removal test, extracted from three separate cleanups (lifecycle tool
  variants, a destructive capacity controller, decorative loadout tiers).
  Push applied the same test in #1257/#1258; keeping it as a named criterion
  makes the next application cheaper.
