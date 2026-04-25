# Push Roadmap (Canonical)

Last updated: 2026-04-24

This is the single source of truth for active product and engineering direction.

`docs/` is a draft lab for spikes, explorations, and non-final plans.
Only decisions promoted into this file should be treated as implementation commitments.

Current cycle emphasis: transcript-first CLI ergonomics, selective CLI adoption of the shared runtime foundation, and chat/workspace product follow-through. **Push CLI Muscle-Memory UX is also load-bearing for the Architecture Remediation Plan's evaluation gate** — extraction validation depends on real-use observations, which require the CLI to be daily-driver ready (see `docs/decisions/Architecture Remediation Plan — Defusing the Big Four.md §CLI Runtime Parity` for the full framing). Treat CLI usability as equivalent-priority to extraction, not adjacent.

## How We Use This

1. Draft ideas in `docs/` (untracked is fine).
2. Promote approved work here as concise, actionable items.
3. Keep this file current during execution.
4. Archive completed/abandoned items out of this file to keep it focused.

## Status Legend

- `planned` - approved but not started
- `in_progress` - actively being implemented
- `blocked` - waiting on dependency/decision
- `done` - completed and verified

## Current Priorities

| Item | Status | Scope | Acceptance Criteria |
|---|---|---|---|
| Push CLI Muscle-Memory UX | in_progress | Continue aligning `push` with Claude Code/Codex-style terminal muscle memory using a transcript-first REPL (no full-screen TUI) | Session flow feels transcript-first (prompting, interrupts, outputs, tool visibility), common tasks require fewer commands/flags, and day-to-day usage no longer depends on roadmap-specific operator knowledge |
| Selective CLI Adoption of Shared Runtime | in_progress | Bring more of the now-shared runtime substrate into CLI only where it improves the terminal product (task framing, events, memory, later task-graph/runtime features) | Adopted CLI flows use the same runtime semantics as web without introducing new CLI-only semantic drift; any remaining differences are shell-specific by design |
| CLI/TUI-lite Ergonomics | planned | Add terminal UX improvements that stop short of a full-screen TUI (session picker, transcript navigation, command shortcuts, compact status surfaces) | Interactive users can navigate session history and active runs faster without leaving the transcript-first model |
| Chat Surface Evolution | planned | Make chat a first-class surface with cleaner chat-first launcher framing, explicit context escalation, and mode-specific restore behavior | Chat can be described as its own surface instead of a workspace flag, while runtime/storage/auth remain shared |
| Workspace Publish Follow-through | planned | Polish the post-publish repo-backed handoff and decide the optional empty-repo path after the first publish flow shipped | Publishing a workspace to GitHub feels explicit and understandable end-to-end, and the next empty-repo path is either shipped or clearly scoped |
| Workspace Hub v2 | planned | Improve Diff ergonomics and decide long-term drawer vs hub division for history/settings | Decision captured; richer per-file diff navigation shipped; no duplicate navigation paths |
| UX: Preserving Context on Branch Creation | planned | Add "Fork Workspace" flow so when a user switches branches from the UI, the active chat session (and uncommitted sandbox state) carries over instead of being wiped | A new branch can be created from an active chat without dropping the conversation context or destroying uncommitted work |

## Recently Completed

| Item | Status | Scope | Acceptance Criteria |
|---|---|---|---|
| PushStream Gateway Migration | done | Migrated model-streaming transport from the 12-arg `ProviderStreamFn` callback contract onto the async-iterable `PushStream` contract end-to-end. Provider side: all eleven providers (Ollama Cloud + Cloudflare Workers AI + OpenRouter + OpenCode Zen + Kilo Code + OpenAdapter + Nvidia NIM + Blackbox AI + Azure OpenAI + AWS Bedrock + Google Vertex) ported onto native `<provider>Stream` modules consuming the shared `lib/openai-sse-pump.ts`. Consumer side: every agent role (Auditor, Coder, Reviewer, Planner, Explorer, DeepReviewer) iterates `PushStream` events directly via `iteratePushStreamText`. Both bridges (`providerStreamFnToPushStream`, `createProviderStreamAdapter`), the `ProviderStreamFn` callback shape, `legacyChatPushStream`, `PROVIDER_STREAM_CONFIGS`, and the `streamSSEChat` / `streamSSEChatOnce` machinery are all deleted. See `docs/decisions/PushStream Gateway Migration.md` for the phase-by-phase log | All agent roles consume `PushStream` events directly; both bridges and the legacy callback shape are gone; `streamSSEChat` / `streamSSEChatOnce` legacy path removed |
| GitHub Tools: Fetch inline PR Review Comments | done | `pr` now fetches inline `pull_request_review_comments` plus top-level issue comments, and the shared/web renderers expose both alongside the diff | Agent can read reviewer feedback on a PR without the user copy-pasting it; shared PR tool tests and PR card rendering cover both comment classes |
| Sandbox Awareness Matrix | done | Session capability blocks now include container TTL, remaining TTL, persisted lifecycle events, readiness hints, and workspace lifecycle history directly in the prompt context | Models receive rich lifetime and event history in prompt context and can proactively reason about save/download timing without an external dashboard |
| `pushd` Attach + Event Stream UX | done | Shipped explicit CLI attach/resume event streaming over the existing NDJSON socket protocol, including raw v2 delegation events, local attach-token payloads, visible subagent transcript boundaries, and transcript-compatible task-graph node-focus snapshots | User can attach to a live session, watch delegation progress in a readable transcript, and recover after disconnect without manual state inspection; focused formatter/handler tests, CLI typecheck, and daemon integration coverage are green |
| CLI Protocol/Schema Hardening | done | Hardened the pushd wire envelopes with a runtime schema validator (`cli/protocol-schema.ts`) covering the `SessionEvent` contract plus per-type payload schemas for the nine delegation events (`subagent.*` × 3, `task_graph.*` × 6). Explicit rejection of `runId: null` and `payload: undefined`. Strict-mode validation wired into `broadcastEvent()` under `PUSH_PROTOCOL_STRICT=1`, enabled in the daemon-integration test harness so every handler test validates its outgoing events | Schema validation mode exists and is on for core events in `test:cli`; drift guard-rail tests re-extract delegation event literals, `RunEventSubagent`, and `TaskGraphNode.agent` from `lib/runtime-contract.ts` at test time so a new variant without a matching validator fails the suite; 56 new unit + integration tests shipped |
| UX: Multi-image Upload | done | Verified web chat UI already supports batch selection/upload and that orchestrator + provider adapters (OpenAI, Anthropic, OpenRouter) pass every staged image through as a distinct vision block | User can upload multiple screenshots per turn and the agent processes them in a single vision-block payload; no single-image bottleneck in the serialization path |
| Shared Runtime Convergence Tranche | done | Shipped the main semantic web/CLI convergence pass: shared runtime contract, task graph executor, typed context-memory stack, delegation brief formatter, run-event vocabulary, role-context helpers, and first CLI adoption of shared task framing/events | Core runtime semantics live in shared `lib/`; web uses the canonical modules; CLI has started consuming the same contracts without forcing blanket feature parity |
| Task Graph Orchestration + Typed Context Memory Foundation | done | Shipped dependency-aware `plan_tasks`, task-level graph events, graph memory, typed memory retrieval, invalidation, and sectioned prompt packing | Orchestrator can execute mixed Explorer/Coder task graphs with dependency context; typed memory retrieval and freshness-aware packing are live in the main runtime |
| Workspace Publish to GitHub Phase 1 | done | Added first-class in-app publish UI for scratch workspaces plus launcher entry points and workspace transition plumbing | User can publish a scratch workspace to a private/public GitHub repo from the app without relying on a chat-only tool flow |
| Harness Reliability Program (Tracks A-C + E) | done | Shipped the harness-first reliability push: hashline edits, range reads + truncation-aware safety, garbled tool-call recovery, structured error taxonomy, multi-tool dispatch, meta envelopes, acceptance criteria, working memory, symbol reads, and patchsets | Core checklist shipped; harness reliability remains an ongoing product priority, with future work handled as incremental maintenance rather than a roadmap checklist |
| Push CLI Foundation + Harness Transition (No Checkpoint Resume) | done | Built modular `push`/`pushd` foundation and added advanced harness semantics to CLI runtime: multi-tool turns (parallel reads + single mutation), hashline `edit_file`, working memory updates, malformed tool-call diagnostics, file-ledger/meta envelopes, and headless acceptance checks | `push` supports config init/show/set and persisted defaults; `run --json`/`sessions --json` stable; protocol envelope persisted in session events; advanced harness features shipped in `9ec31c5` with passing `scripts/push/tests/*.test.mjs` |
| Resumable Sessions (Phases 1-4) | done | Added interruption-safe run checkpointing + resume flow across orchestrator and coder delegation, including reconciliation and lock safety | Interrupted runs surface a `ResumeBanner`; resume revalidates sandbox/branch/repo, injects `[SESSION_RESUMED]` with sandbox HEAD/dirty/diff context, preserves coder state, and records resume telemetry |
| Agent Experience Wishlist (Track C) | done | Implement 10 harness improvements: structured error taxonomy, edit diffs, multi-tool per turn, universal meta envelope, and machine-readable tool-call feedback | All items shipped and verified in harness metrics (Commit 0336f11) |
| Scratch Workspace v1 (formerly Sandbox Mode) | done | Ephemeral Modal workspace for brainstorming/prototyping; primary onboarding entry point; tar.gz download export path | User can start a scratch workspace from onboarding (no GitHub auth) or repo picker, edit/run files, and download workspace as tar.gz |
| Repo Sync Reliability | done | Unified auth handling and complete repo pagination for PAT/OAuth + GitHub App paths | Authenticated flows do not silently fall back to demo; repo fetching paginates across accessible pages |
| Scratch Workspace Repo Promotion (v2) | done | In-app `promote_to_github` flow creates a repo, pushes the scratch workspace branch, and transitions app context to repo mode | User can promote a scratch workspace to GitHub without leaving chat; active workspace rebinds to the promoted repo |
| Workspace Hub v1 | done | Single top-right workspace trigger with full-screen hub tabs (`Files`, `Diff`, `Console`, `Scratchpad`) and integrated commit/push controls | Hub opens reliably on mobile; tab flows work; commit/push confirmations and protect-main guard enforced |
| Branch UX Consolidation (Phase 1) | done | Branch selector shows existing branches (not just app-created), includes delete action in selector, and home cards support branch selection | User can open repos on specific branches from Home and manage branch switching/deletion from workspace context |
| Home Header Simplification | done | Replaced ambiguous top header strip with compact account menu (settings/disconnect) and profile avatar | Home uses less vertical space and account controls remain discoverable |
| Sandbox Read Efficiency (Track B Phase 1) | done | Added `sandbox_read_file` line-range args, range line numbering for tool output, and explicit warning for out-of-bounds empty ranges | Agent can request targeted ranges and gets clear warning signal when range is beyond file content; editor card content remains clean |

## Decision Log

| Date | Decision | Source |
|---|---|---|
| 2026-04-25 | PushStream Gateway Migration completed across PRs #365 → #401. Every agent role iterates `PushStream<M>` events directly; every provider routes through a native `<provider>Stream` consuming the shared `openAISSEPump`; both bridges, the `ProviderStreamFn` callback shape, `legacyChatPushStream`, `PROVIDER_STREAM_CONFIGS`, and the `streamSSEChat` / `streamSSEChatOnce` machinery are all deleted. CLI consumption (`cli/provider.ts`) tracked separately under "Selective CLI Adoption of Shared Runtime" — different surface, parallel work. | `docs/decisions/PushStream Gateway Migration.md` rows 1–18 |
| 2026-04-21 | Verified and promoted two already-shipped items: the Sandbox Awareness Matrix is live through `[SESSION_CAPABILITIES]` / `[SANDBOX_ENVIRONMENT]` prompt blocks with TTL and lifecycle history, and the `pr` tool now returns inline review comments plus issue-thread conversation comments. | Documentation verification pass against current code/tests |
| 2026-04-14 | CLI Protocol/Schema Hardening shipped. `cli/protocol-schema.ts` is the canonical runtime validator for the pushd wire envelope and the nine delegation event payloads. Strict mode opt-in via `PUSH_PROTOCOL_STRICT=1`; daemon-integration test harness enables it so every handler test runs through the validator. Drift guard-rails re-extract delegation types and role literals from `lib/runtime-contract.ts` source at test time. Request/response envelopes and daemon-only event payloads (`session_started`, `approval_required`, etc.) are deliberately out of scope for this tranche. | `docs/decisions/push-runtime-v2.md` Runtime schema validation section + `docs/decisions/Web and CLI Runtime Contract.md` cli/protocol-schema.ts note |
| 2026-04-09 | Pivoted Sandbox Telemetry from external analytics to an internal Sandbox Awareness Matrix. Models will get TTL and lifecycle events directly in prompts instead of building operator dashboards. | Chat decision |
| 2026-04-05 | Shared runtime convergence tranche shipped: task-graph runtime, typed memory, delegation briefs, run-event vocabulary, and role-context semantics now live in shared `lib/`; further CLI work should be selective product adoption, not blanket parity extraction | Implementation session + `docs/archive/runbooks/Shared Runtime Convergence Plan.md` |
| 2026-04-05 | Task graph orchestration, graph memory, typed context-memory retrieval/invalidation/packing, and task-level trace events shipped as the new orchestration baseline | Implementation session + `docs/archive/runbooks/Task Graph Orchestration Plan.md` + `docs/decisions/Context Memory and Retrieval Architecture.md` |
| 2026-04-05 | In-app repo creation should be treated as "publish workspace to GitHub" first; Phase 1 publish UI/workspace handoff shipped | Implementation session + `docs/runbooks/Workspace Publish to GitHub Plan.md` |
| 2026-02-22 | Roadmap focus shifted to CLI/TUI terminal UX improvements; harness reliability program moved from active checklist to completed baseline priority | Documentation/roadmap update |
| 2026-02-20 | Push CLI foundation and harness transition shipped in staged commits (`53b3c29`, `9b10856`, `aa80d7f`, `9ec31c5`) with checkpoint resume intentionally deferred for CLI | Implementation session |
| 2026-02-20 | Track D server-side background jobs deferred; resumable sessions remain the active interruption-recovery strategy | Product scope decision |
| 2026-02-20 | Push CLI direction changed: no full-screen TUI; target transcript-first interactive REPL with Claude Code/Codex muscle memory | Product scope decision |
| 2026-02-20 | Resumable Sessions hardening pass fixed resume race conditions and lock handling after merge review | Commit 61a262a |
| 2026-02-19 | Resumable Sessions completed (Phase 2-4): resume banner UX, sandbox reconciliation, multi-tab lock, checkpoint size controls, and resume telemetry | PR #106 (`3ded27f`) |
| 2026-02-19 | Resumable Sessions Phase 1 shipped: local checkpoint persistence and interrupted-run detection baseline | PR #105 (`d311af6`) |
| 2026-02-19 | Agent Experience Wishlist (Track C) fully implemented | Commit 0336f11 + follow-ups |
| 2026-02-19 | OpenRouter catalog updated: Sonnet 4.6, Gemini 3.1 Pro Preview added; Codex 5.3 removed | Commits f323e1b, 4b97df9 |
| 2026-02-09 | Root `ROADMAP.md` is canonical; `docs/` is draft space | Team decision in chat |
| 2026-02-09 | Scratch workspace vision (then called Sandbox Mode): real ephemeral workspace + explicit promotion paths | `docs/archive/Sandbox mode.md` |
| 2026-02-08 | Scratch workspace v1 descoped: no in-app repo creation (latency/sync concerns); zip download is the only export path; onboarding entry point is v1 priority | `docs/archive/Sandbox mode.md` revision |
| 2026-02-09 | Scratch workspace v1 implemented: two entry points, scratch-workspace system prompt, `sandbox_download` tool + card, expiry warning banner, persistent download button in header; export format is tar.gz (not zip) | Implementation session |
| 2026-02-12 | Workspace shell consolidated into one mobile hub trigger with `Files`, `Diff`, `Console`, and `Scratchpad` tabs | `docs/archive/Workspace Hub Sprint Plan.md` + implementation session |
| 2026-02-12 | Branch selection now surfaces existing branches across Home/workspace, with in-context delete from the workspace selector | Implementation session |
| 2026-02-12 | Home header simplified to compact account menu with Settings + guarded Disconnect and GitHub avatar | Implementation session |
| 2026-02-13 | Harness-first reliability promoted as canonical planning focus; browser tooling treated as one capability within harness work, not a standalone roadmap pillar | `docs/archive/runbooks/Harness Reliability Plan.md` |
| 2026-02-14 | Track B phase 1 shipped: `sandbox_read_file` supports line ranges with numbered tool output and out-of-bounds empty-range warnings | `docs/archive/runbooks/Harness Reliability Plan.md` + implementation session |
| 2026-02-17 | Activated Hashline protocol (`sandbox_edit_file`) in the harness to replace full-file rewrites with surgical edits | Implementation session |

## Promotion Checklist (Draft -> Canonical)

An item should be promoted from `docs/` to this roadmap only if all are true:

- problem statement is clear
- v1 scope is bounded
- success criteria are testable
- ownership is clear (person/agent/phase)
- non-goals are explicit

## Notes for AI Collaborators

- Always read `ROADMAP.md` first for current priorities.
- Treat `docs/` as exploratory unless explicitly referenced by a roadmap item.
- If implementation diverges from a draft, update this roadmap with the new decision.
