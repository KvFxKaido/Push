# Decisions Folder

Status reviewed: 2026-04-16 (Modal snapshot Phases 1+2 shipped check)

This folder contains architecture decisions, research, analysis, and shipped design references.

## How to use this folder

- Prefer the docs marked **Current** when choosing new work.
- Treat **Historical** docs as context and provenance, not open task lists.
- Treat **Draft** docs as design-in-motion; implementation commitments still require a `ROADMAP.md` entry.
- If a doc conflicts with the code, prefer the code and refresh the doc.

## Document Status

| Document | Status | Notes |
|---|---|---|
| `Agent Experience Wishlist.md` | Historical | Shipped 2026-02-19; useful for provenance and feature rationale. |
| `Agent Tool Patterns — Claude Code Cross-Reference.md` | Reference, refreshed 2026-03-30 | Comparative design notes; several February borrow items are now shipped or partial. Remaining CLI follow-through is narrower memory adoption and later task-graph/product decisions. |
| `AgentScope Architecture Review.md` | Current, refreshed after tracing pass | Web-side OTel spans are now in place for model/tool/sandbox/delegation boundaries; main remaining work is Worker/server propagation and sandbox-provider abstraction. |
| `Architecture Rating Snapshot.md` | Reference snapshot, added 2026-03-30 | Three-way architecture rating panel (Codex, Claude, Gemini) plus synthesis. |
| `Architecture Remediation Plan — Defusing the Big Four.md` | Draft, added 2026-04-14, step 1 landed 2026-04-14 | Working plan for the four dense coordination modules flagged by every panel. |
| `CLI Prompt Builder Convergence.md` | Implemented core path, refreshed 2026-04-05 | Shared `SystemPromptBuilder` lives in root `lib/`; CLI prompt pipeline consumes it. |
| `Context Memory and Retrieval Architecture.md` | Current, added 2026-04-05 | Concrete follow-up design for typed, invalidation-aware memory retrieval and prompt packing. |
| `Copilot SDK Research.md` | Current, partially superseded | Prompt sections, tool scoping, steering/queueing, and live-vs-persisted event split are now in place; main open carry-over is a dedicated task agent plus richer session/permission telemetry. |
| `CorrelationContext Contract.md` | Current, docs-and-types only, added 2026-04-14 | Step 1 of the remediation plan: canonical shape for passive cross-surface correlation tags. Propagation is step 3. |
| `Duplication and Structural Symmetry Analysis.md` | Current, refreshed 2026-03-30 | `hashline` drift and shared provider-model catalog drift are resolved; remaining cleanup is Settings state surfaces and other mirrored modules. |
| `External Resource Review — Harness Engineering and Ralph Loop.md` | Reference | Source for the 2026-04-14 Tiered Orchestrator Routing and Canonical SOP Playbooks spikes. |
| `Harness Friction — Agent Self-Report.md` | Current, refreshed 2026-03-30 | Ambient runtime state, capability discovery, and structured mutation postconditions shipped on main web path; working-memory evolution and richer structural navigation remain open. |
| `Hashline System Review.md` | Current scorecard, added 2026-04-08 | Recommendations A, C, D, E shipped; B shipped as a tool-level patchset range form. Effectiveness measurement logged 2026-04-12. |
| `Modal Sandbox Snapshots Design.md` | Partially shipped, added 2026-04-14 | Phase 1 (backend primitives) shipped 2026-04-16 in `23fcb8e`; Phase 2 (auto-restore + idle hibernation timer) shipped 2026-04-16 in `f913f49` with follow-up hardening in `2613527`. Phase 3 (UX polish: explicit Hibernate/Forget controls, snapshot-age on resume banner, Settings list) and Phase 4 (eviction cron + KV index) still open. |
| `Multi-Agent Orchestration Research — open-multi-agent.md` | Reference, added 2026-04-04 | Research on open-multi-agent framework. Core task-graph/memory work shipped; keep for rationale. |
| `Oh My OpenAgent Review.md` | Comparative review | Tier-1/2/3 quick-win list for Push. |
| `OpenAI Agents SDK Evolution Review.md` | Reference | Comparative review of the OpenAI Agents SDK. |
| `phase-5-tool-runtime-brief.md` | Draft, added 2026-04-12 | `ToolExecutionRuntime` interface brief for Phase 5B of the Big Four remediation. Pending review before implementation. |
| `push-runtime-v2.md` | Working design doc | Ongoing design space for the Push runtime v2, including the runtime-schema validator landed 2026-04-14. |
| `Rerank Before Prompt Packing.md` | Draft spike, added 2026-04-14 | Optional rerank stage between deterministic retrieval and sectioned packing for delegation briefs and Auditor. |
| `Resumable Sessions Design.md` | Historical | Shipped 2026-02-19 (Phases 1–4); useful as provenance and for journal-adjacent designs like Modal Sandbox Snapshots. |
| `Sectioned System Prompts.md` | Shipped design reference | Sectioned system prompt builder refactor. |
| `Tool-Call Parser Convergence Gap.md` | CLI side resolved 2026-04-15, Web side pending | `lib/tool-dispatch.ts` now owns the CLI detection kernel; Web dispatcher migration deferred until the phase-grouping state machine can be unified. |
| `Vercel Open Agents Review.md` | Current, added 2026-04-14 | Adoption target is Modal sandbox snapshots; secondary targets are sandbox port exposure, read-only share links, and server-side durable runs on Cloudflare. |
| `Web and CLI Runtime Contract.md` | Current, refreshed 2026-04-05 | Architecture rule for Push shells: share agent-runtime semantics across web and CLI, allow divergence in transport and UX shell. |

## Quick Triage

If we are choosing implementation work from this folder, the best live clusters are now:

1. End-to-end tracing follow-through (Worker/server propagation, exporter rollout, metric retirement).
2. Working-memory evolution and invalidation-aware investigation state, with a concrete follow-up in `Context Memory and Retrieval Architecture.md`.
3. Modal sandbox snapshots Phase 3 (explicit hibernate/forget UX in Workspace Hub, snapshot-age on resume banner, Settings "Hibernated sandboxes" list) and Phase 4 (eviction cron + KV index). Phases 1–2 landed 2026-04-16.
4. Phase 5B `ToolExecutionRuntime` interface land + Phase 5C deep-reviewer move.
5. Selective CLI adoption of the shared runtime substrate where it clearly improves the terminal product.
