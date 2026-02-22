# Push Harness Reliability Plan (Hashline Included)

## Status
- Last updated: 2026-02-22
- State: Track A shipped (hashline active), Track B complete, Track C extended (metrics + settings diagnostics shipped), Track E wishlist outcomes shipped, Track D (server-side background jobs) deferred
- Intent: Improve coding task success by upgrading the harness, not just swapping models

## Implementation Status Snapshot (2026-02-22)

- [x] Track A (hashline edit reliability) shipped and active.
- [x] Track B (range reads + truncation-aware safety) complete.
- [x] Track C Phase 1 + structured malformed-call feedback shipped.
- [x] Track C metrics/visibility shipped: malformed-call metrics by provider/model are instrumented and exposed in Settings diagnostics.
- [x] Track C architecture simplification shipped: unified prompt-engineered tool path is active; native function-calling experiments were removed from the production web path.
- [x] Track E (error taxonomy, meta envelope, edit diffs) shipped.
- [ ] Track D remains deferred in current PWA scope.

## Why this doc changed

This started as a hashline-only spike. That was too narrow.  
The bigger opportunity is harness reliability across the full coding loop:

1. task interpretation
2. file reads/edits
3. tool execution + retries
4. validation + commit flow
5. mobile/session resilience
6. operator visibility

Hashline remains a candidate within this larger plan.

## Harness Principles

1. Prioritize reliability over raw capability.
2. Prefer small, reversible bets over broad rewrites.
3. Add measurement before rollout.
4. Keep fallback paths available.
5. Kill experiments quickly if metrics do not improve.

## Current Baseline (Already in place)

- File-level stale write protection for `sandbox_write_file` via `expected_version`.
- Baseline write-path metrics (`success`, `stale`, `error`, latency).
- Tool-result provenance metadata for execution traceability.
- Console now surfaces Coder status events, not only Orchestrator/tool logs.
- Chat now preserves assistant dialogue even when a tool call is emitted in the same message.
- Snapshot and restore primitives exist for sandbox continuity.
- **Garbled tool-call recovery** (shipped 2026-02-14):
  - `repairToolJson` fixes trailing commas, single quotes, unquoted keys.
  - `detectTruncatedToolCall` catches unbalanced-brace truncation.
  - `diagnoseToolCallFailure` replaces the narrow `detectMalformedToolAttempt` regex with three-phase diagnosis (truncated → validation failure → broad pattern match).
  - Garbled assistant messages now marked `isToolCall: true` so `stripToolCallPayload` hides raw JSON from users.
  - Error feedback is specific (names the tool, describes the failure mode) — model can self-correct in one retry instead of looping.
- **Range-aware file reads** (shipped 2026-02-14):
  - `sandbox_read_file` supports optional `start_line` and `end_line`.
  - Range reads include line-number prefixes in tool text while editor cards stay clean.
  - Invalid ranges are rejected early (`start_line > end_line`, non-positive/invalid values).
  - Empty out-of-bounds range reads now return a clear warning instead of silent blank output.
- **Truncation-Aware Edit Safety** (shipped 2026-02-17):
  - Edit Guard & Awareness Ledger: blocks/warns when model attempts edits on truncated/unseen code.
  - Signature Extraction: regex-based structural hints (functions/classes) included in truncation notices.
  - Scoped Auto-Expand: harness automatically fetches missing line ranges when an edit is blocked by the guard.

## Main Harness Opportunities

### Track A: Edit Reliability (Hashline Experiment)

Problem:
- Full-file replacement still forces brittle content reproduction.

Hypothesis:
- Line-tagged references (`line:hash`) reduce edit failures and retries.

Gate first (required):
- Run provider compliance micro-test before implementation.
- Go only if at least 2 providers can produce valid hashline edit calls consistently.

If gate passes, MVP scope only:
- Add `sandbox_edit_file(path, edits, expected_version?)`
- Ops: `replace_line`, `insert_after`, `delete_line`
- Reject stale/invalid refs and overlapping edits
- Return touched-window refs + unified diff + rich error details
- Keep `sandbox_write_file` fallback
- Ship behind `hashlineEditEnabled` flag

Patterns from external research (Claude Code `str_replace` + Codex `apply_patch`):
- **Progressive fuzzy matching**: if hash doesn't match but line content is close (trimmed whitespace, Levenshtein), apply with warning rather than hard-reject. Both production tools have fuzzy fallbacks; hard-match-only is too brittle.
- **Structured error detail**: on edit failure, return expected vs actual content for the failing ref, not just "invalid ref." Both tools return enough context for the model to self-correct in one retry.
- **No line numbers as edit targets**: both tools avoid absolute line numbers for edits (Codex uses context anchors, Claude uses string content). Hashline's content-addressed hashes align with this — use hashes as anchors, treat line numbers as hints only.

Success targets:
- >= +10pp edit-apply success rate vs baseline
- >= 20% reduction in retry loops
- no truncation regression from annotation overhead

Kill criteria:
- gate fails
- one week of dogfooding shows no meaningful gain
- annotation overhead causes frequent regressions

### Track B: Read/Context Efficiency for Editing ✅ COMPLETE

Problem:
- Edit flows over-read large files; tokens and truncation pressure increase.

Done (2026-02-17):
- [x] Added `start_line` and `end_line` optional args to `sandbox_read_file` (Phase 1).
- [x] Added line-number prefix in range read tool output (`cat -n` style) for model orientation.
- [x] Kept UI editor card content clean (no injected line numbers).
- [x] Added explicit warning when a requested range is out-of-bounds.
- [x] Default full-file read cap (~2000 lines) implemented to reduce payload size (Phase 2).
- [x] **Truncation-Aware Edit Safety** (Phase 3):
    - [x] Edit Guard & Awareness Ledger (blocks blind edits to truncated content).
    - [x] Signature Extraction (regex-based structural hints in truncation notices).
    - [x] Scoped Auto-Expand (automatically retrieves missing context for blocked edits).

Success signal:
- reduced average read payload size in edit-heavy tasks
- fewer truncation-adjacent failures
- zero blind-edits on truncated files

### Track C: Tool-Loop Robustness

Problem:
- Minor tool-call formatting failures still cost rounds/time.

Done (2026-02-14):
- [x] Three-phase garbled tool-call diagnosis (`diagnoseToolCallFailure`).
- [x] JSON repair for common LLM garbling (trailing commas, single quotes, unquoted keys).
- [x] Truncated tool-call detection (unbalanced braces).
- [x] Specific error feedback (names the tool, describes failure mode).
- [x] Garbled messages hidden from chat UI via `isToolCall: true` + `stripToolCallPayload` extension.

Remaining scope:
- Reduce prompt-engineering tax within the unified path (protocol sizing, role-scoped prompt injection, malformed-call recovery, diagnostics-driven tuning).

Done (2026-02-19, Agent Experience Wishlist):
- [x] Structured malformed-call feedback to agent — `[TOOL_CALL_PARSE_ERROR]` header with `error_type`, `detected_tool`, and `problem` fields injected into correction messages. Closes the loop between Track C telemetry and agent behavior.

Done (2026-02-21):
- [x] Malformed-call rate metrics by provider/model/tool added (`recordMalformedToolCallMetric`, `tool-call-metrics`).
- [x] Provider/model diagnostics surfaced in Settings (`Tool Call Diagnostics` panel).

Context note:
- Both Claude Code and Codex CLI avoid this problem entirely via native API-level function calling. Push's prompt-engineered protocol is the cost of provider-agnostic design. The garbled recovery layer is the right investment; tracking per-provider compliance rates will show where the cost is highest.

Success signal:
- fewer recoverable tool-loop stalls
- lower average rounds per successful task
- per-provider malformed-call rate data available for comparison

### Track D: Long-Run Resilience (Mobile Background Reality) — DEFERRED

Status (2026-02-20):
- Deferred in current PWA scope.
- Kept as design reference for potential native-app/CLI runtime phases.

Problem:
- Browser-driven loops pause when phone app backgrounds/locks.

Scope (design now, implementation separate):
- server-run background job model
- reconnectable job timelines
- cancel/resume controls

Design doc: `documents/plans/Background Coder Tasks Plan.md`

Patterns from external research:
- **Pre-approved tool allowlist** (from Claude Code background agents): background jobs declare their allowed tools at start time. Anything not pre-approved → auto-deny. No runtime permission prompts. For Push: `POST /api/jobs/start` should include the full tool allowlist.
- **SSE with event replay** (over polling): Claude Code uses polling for background tasks, but Push is mobile-first. Polling drains battery and is unreliable after sleep. SSE from the Durable Object with automatic reconnect + replay from last-seen event ID is the right model. The DO already holds the event log.
- **Context compaction within background jobs**: long-running coder loops need their own compression. The existing 60KB context cap is the right instinct. Background jobs should checkpoint summaries to the event log so the reconnecting client can reconstruct progress without replaying every tool call.

This is a harness-level capability and should be planned independently of hashline.

### Track E: Operator Visibility

Problem:
- Debugging harness issues is slow without clear execution traces.

Scope:
- Keep improving console signal quality (role/source labeling, useful status granularity).
- Keep tool calls and dialogue understandable in chat.
- Preserve actionable logs for "why task failed" analysis.
- Expand `toolMeta` to all error paths (not just garbled calls) — every tool failure should carry enough metadata for post-hoc debugging without reading the full conversation.

Done (2026-02-19, Agent Experience Wishlist):
- [x] Structured error taxonomy — `classifyError()` maps every tool failure to a `ToolErrorType` with `retryable` flag. All error paths in `executeSandboxToolCall()` include `structuredError`.
- [x] Universal meta envelope — `[meta] round=N ctx=Xkb/120kb dirty=bool files=N` injected into every tool result in both Orchestrator and Coder loops. Per-round sandbox status cached.
- [x] Edit result diff — `sandbox_edit_file` returns before/after versions and git diff hunks instead of a bare success message.

Success signal:
- faster root-cause diagnosis for failed tasks
- lower "mystery failure" incidents during dogfooding

## Prioritization (Now / Next / Later)

> Track A hashline is shipped and active. Track B complete. Track C Phase 1 + structured feedback shipped.
> Agent Experience Wishlist shipped (2026-02-19): 9 items across error taxonomy, multi-tool dispatch, meta envelope, acceptance criteria, working memory, and two new tools.
> Track D (server-side background jobs) is deferred in current product scope.

Now:
1. Dogfood Agent Experience Wishlist features and measure round/retry reduction.
2. Validate Track C metrics over a full week and set provider/model compliance thresholds.
3. Expand operator-visibility diagnostics (`toolMeta`) across remaining error paths.

Next:
1. Reduce prompt/tool protocol overhead without reintroducing native function-calling (compact protocol variants, duplication audits, role-scoped injection).
2. Add a lightweight compliance score surface (provider/model trend view) if dogfood metrics are stable.
3. Revisit Track D only if roadmap scope changes (native app or deeper daemon-first runtime).

Later:
1. Revisit Track D server-side background jobs if native app/CLI runtime direction requires it.
2. Additional hashline ops (`replace_range`, `delete_range`) only if MVP earns it.
3. Provider compliance scoring surface in settings.

## Measurement Framework

Primary metrics:
- edit apply success rate
- retries per task
- coder rounds per successful task
- p99 edit latency

Secondary metrics:
- read payload size for edit tasks
- truncation incidents
- malformed tool-call rate

Evaluation cadence:
- baseline capture before each experiment
- 1-week dogfood window per enabled experiment
- go/hold/kill review at end of each window

## Decision Log

### Track B Phases 1-3 — Range reads & Truncation Safety

- Experiment: Track B — Read efficiency and context safety
- Date enabled: 2026-02-14 (Ph 1), 2026-02-17 (Ph 2-3)
- Cohort/flag: Global (no flag)
- Baseline: Full-file reads only; frequent "blind edits" on truncated content.
- Result: Shipped range reads, 2000-line read cap, Awareness Ledger, Edit Guard, and Scoped Auto-Expand.
- Decision: `go` (Track B complete)
- Notes: Track B has significantly reduced payload size and eliminated a major class of edit failures where the model would guess missing code. See `documents/plans/Truncation-Aware Edit Safety Plan.md`.

### Track C Phase 1 — Garbled tool-call recovery

- Experiment: Track C Phase 1 — Garbled tool-call recovery
- Date enabled: 2026-02-14
- Cohort/flag: Global (no flag)
- Baseline: Narrow regex detection, generic error messages, raw JSON visible in chat
- Result: Three-phase diagnosis, JSON repair, truncation detection, specific error feedback, garbled messages hidden from UI
- Decision: `go` (Phase 1 complete; metrics instrumentation shipped 2026-02-21)
- Notes: Shipped same day as Track B Phase 1. Covers `repairToolJson`, `detectTruncatedToolCall`, `diagnoseToolCallFailure`.

### Track C Phase 2 — Metrics + Settings Visibility

- Experiment: Track C Phase 2 — Provider/model malformed-call observability
- Date enabled: 2026-02-21
- Cohort/flag: Global (no flag)
- Baseline: Recovery worked, but provider/model failure rates were opaque during dogfooding.
- Result: In-memory malformed-call metrics by provider/model/tool shipped; Settings now surfaces counts and reason breakdowns.
- Decision: `go` (visibility objective met; proceed to thresholding and trend analysis)
- Notes: Completes the original "instrument + surface" follow-up from Track C.

## External Review Checklist (PWA-GPT)

Source: external PWA-focused review (2026-02-13).  
Decision labels: `accept`, `partial`, `reject`.

| Recommendation | Decision | Why | Next Step |
|---|---|---|---|
| Narrow primary persona to power users (solo founder, lead dev, CTO in motion) | accept | Tightens product narrative and onboarding clarity | Update README/onboarding copy to explicitly target power users |
| Emphasize true differentiators (role-separation, branch-scoped chats, provider-agnostic backends) | accept | Already core strengths; should be foregrounded consistently | Keep these three as top-level positioning in root docs and pitch copy |
| Treat PWA as first-class feature (offline, push, background sync) | partial | Good direction, but API support is inconsistent on mobile (especially iOS) | Prioritize reliable pieces first: offline scratchpad/read-only history + completion notifications |
| Move long-running orchestration to server-side jobs | defer | Useful in theory, but high complexity for current PWA scope after resumable sessions shipped | Keep `documents/plans/Background Coder Tasks Plan.md` as reference; revisit for native app/CLI runtime direction |
| Add explicit service worker cache strategy | partial | Useful, but must avoid stale execution state and broken live sessions | Add a documented cache policy pass for app shell/static/api paths before broad SW changes |
| Harden pre-merge safeguards and surface checks clearly | partial | Most merge safeguards exist; visibility can improve | Add clearer merge-flow UI states for stale base, CI required, and branch protection blocks |
| Add provider tool-call compliance validation + scoring | accept | Directly aligns with harness reliability goals | Add malformed-call and recovery metrics by provider/model in settings/debug view |
| Make chat less central over time | reject | Push remains chat-first by product principle | Keep chat as interface, but continue shifting execution UX toward card-first actions |
| Make Workspace Hub feel like mission control | accept | Fits mobile execution-control positioning | Prioritize Hub v2 diff ergonomics + status visibility |
| Build-in-public growth metrics and signature feature ideation | hold | Valuable for growth, but secondary to reliability work | Revisit after harness tracks A-C/E show measurable stability gains |
| Keep surface area small; hide complexity under the hood | accept | Matches biggest current risk (feature sprawl) | Enforce explicit non-goals and kill criteria for each harness experiment |

## External Research: Claude Code + Codex CLI Patterns (2026-02-14)

Source: architecture comparison of two production CLI coding agents.

| Area | Claude Code Pattern | Codex CLI Pattern | Push Takeaway |
|---|---|---|---|
| Edit tool | `str_replace` (exact string match, uniqueness enforced) | `apply_patch` with V4A structured diff (context anchors, progressive fuzzy matching) | Both avoid line numbers as edit targets. Hashline's content-addressed hashes are aligned. Add fuzzy fallback to hashline MVP. |
| Edit errors | Returns "no match" or "N matches found" — model self-corrects | Returns JSON error with mismatch details | Structured error detail is critical. Hashline errors should include expected vs actual line content. |
| File reads | `offset`/`limit` params, 2000-line default, `cat -n` format | Shell-based reads | Track B should match Claude Code's pattern: line-range reads with numbered output. |
| Context | Server-side compaction at 150K tokens + client auto-compact at 95% | Model-native multi-window compaction + session persistence | Push's rolling window + summarization is the right client-side approach. Consider `pause_after_compaction`-style preserved-message injection. |
| Tool calls | Native API-level function calling (no JSON parsing needed) | Native API-level function calling | Push's prompt-engineered protocol is the cost of provider-agnostic design. Track C recovery layer compensates. Track per-provider compliance. |
| Background | `run_in_background` on Bash, background subagents with pre-approved permissions | Cloud-side execution, `--resume` for session recovery | Pre-approved tool allowlist at job start. SSE over polling for mobile. Context compaction within background jobs. |
| Permissions | deny→ask→allow rule chain, OS-level sandbox (bwrap/Seatbelt) | Sandbox mode × approval policy, enterprise-managed config | Push's Modal containers are stronger than OS-level sandboxing. Current Auditor gate is adequate. |

Key conclusion: **Push's prompt-engineered tool protocol is its biggest reliability tax vs production tools, but also its biggest flexibility advantage.** The harness work (garbled recovery, hashline, read efficiency) is specifically about closing the reliability gap while keeping provider-agnostic design.

### Agent Experience Wishlist — Full Sprint (9 items)

- Experiment: Agent Experience Wishlist — 9 harness improvements from the agent's perspective
- Date enabled: 2026-02-19
- Cohort/flag: Global (no flag)
- Baseline: No structured errors, single-tool-per-turn, no meta context, no acceptance criteria, no working memory
- Result: All 9 items shipped in 4 phases. Error taxonomy (`classifyError()`), structured malformed-call feedback (`[TOOL_CALL_PARSE_ERROR]`), edit result diffs, multi-tool dispatch (`detectAllToolCalls()`), universal meta envelope (`[meta]` line), machine-checkable acceptance criteria, Coder working memory (`CoderWorkingMemory`), `sandbox_read_symbols` (AST/regex symbol extraction), `sandbox_apply_patchset` (all-or-nothing validation, sequential writes). Post-sprint Codex review caught 5 issues (parallel criteria passthrough, patchset atomicity wording, duplicate-path bug, state-update swallowing checkpoint, unused imports) — all fixed.
- Decision: `go` (shipped)
- Notes: No backend (Python/Worker) changes needed. All client-side. See `documents/analysis/Agent Experience Wishlist.md` for the original spec.

## Immediate Next Action

Dogfood the Agent Experience Wishlist features in real coding tasks.
Measure round count and retry reduction vs pre-sprint baseline.
Track D (server-side background jobs) remains deferred unless roadmap scope changes.
