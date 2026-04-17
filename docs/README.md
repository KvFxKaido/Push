# Docs Index

Status reviewed: 2026-04-16

Use this file to navigate active design/planning docs versus historical references.
`docs/` is the canonical documentation home for this repo.

## Structure

- `architecture.md` — tech stack, agent roles, key systems, and repo map
- `DESIGN.md` — visual tokens, colors, typography, spacing, and component specs
- `decisions/` — architecture decisions, research, analysis, and shipped design references
- `runbooks/` — active, draft, or deferred product plans
- `research/` — external research notes that inform upcoming design work
- `security/` — security reviews, audits, and provider usage policies
- `cli/design/` — CLI/TUI architecture and UX specs
- `cli/runbooks/` — active or proposed CLI work
- `cli/schemas/` — machine-readable runtime protocol artifacts
- `archive/` — historical root docs plus archived completed history
- `archive/runbooks/` — shipped/completed product plans kept for reference
- `archive/cli/runbooks/` — shipped/completed CLI plans kept for reference

## Architecture

- `architecture.md`
  - Status: Canonical architecture reference (tech stack, agent roles, key systems, repo map).
- `DESIGN.md`
  - Status: Canonical design system reference (colors, typography, spacing, components, motion).

## Decisions

Detailed per-doc status lives in [`decisions/README.md`](decisions/README.md). Summary by role:

- **Shipped design references** — `Agent Experience Wishlist.md`, `Resumable Sessions Design.md`, `Sectioned System Prompts.md`, `CLI Prompt Builder Convergence.md`, `Hashline System Review.md`.
- **Current working designs** — `AgentScope Architecture Review.md`, `Architecture Remediation Plan — Defusing the Big Four.md`, `Context Memory and Retrieval Architecture.md`, `CorrelationContext Contract.md`, `Copilot SDK Research.md`, `Harness Friction — Agent Self-Report.md`, `Duplication and Structural Symmetry Analysis.md`, `Vercel Open Agents Review.md`, `Web and CLI Runtime Contract.md`.
- **Draft / in-motion** — `Modal Sandbox Snapshots Design.md`, `Rerank Before Prompt Packing.md`, `phase-5-tool-runtime-brief.md`, `push-runtime-v2.md`, `Tool-Call Parser Convergence Gap.md`.
- **Reference / comparative** — `Agent Tool Patterns — Claude Code Cross-Reference.md`, `Architecture Rating Snapshot.md`, `External Resource Review — Harness Engineering and Ralph Loop.md`, `Multi-Agent Orchestration Research — open-multi-agent.md`, `Oh My OpenAgent Review.md`, `OpenAI Agents SDK Evolution Review.md`.

## Runbooks

Detailed per-doc status lives in [`runbooks/README.md`](runbooks/README.md). Summary by role:

- **Current** — `Chat Surface Evolution Plan.md` (Track C remaining), `Test Coverage Plan.md` (Phase 1 shipped, Phases 2–6 outlined), `Workspace Publish to GitHub Plan.md` (follow-through), `Workspace Route Follow-up Plan.md` (measurement only), `Web-CLI Parity Plan.md` (foundation shipped).
- **Draft spikes** — `Tiered Orchestrator Routing Spike.md`, `Canonical SOP Playbooks Spike.md`, `Hashline Effectiveness Metric.md`.
- **Deferred reference** — `Background Coder Tasks Plan.md`, `UX Nice-to-Haves Plan.md`.

## Research

- `research/codex-compacting.md`
  - Status: Research compiled 2026-04-12 on how Codex CLI handles context compaction; informs Push's own compaction strategy.

## Security

- `security/SECURITY_AUDIT.md`
  - Status: Security findings and mitigation history.
- `security/PROVIDER_USAGE_POLICY.md`
  - Status: Mistral provider key usage policy and terms-boundary review checklist (last reviewed 2026-02-21).
- `security/PROVIDER_USAGE_POLICY_OPENROUTER.md`
  - Status: OpenRouter provider key usage policy and terms-boundary review checklist (last reviewed 2026-02-21).
- `security/PROVIDER_USAGE_POLICY_OLLAMA.md`
  - Status: Ollama provider key usage policy and terms/data-boundary review checklist (last reviewed 2026-02-21).
- `security/PROVIDER_USAGE_POLICY_ZAI.md`
  - Status: Z.AI provider key usage policy and terms/data-boundary review checklist (last reviewed 2026-02-21).
- `security/PROVIDER_USAGE_POLICY_GOOGLE.md`
  - Status: Google Gemini provider key usage policy and terms/data-boundary review checklist (last reviewed 2026-02-21).
- `security/PROVIDER_USAGE_POLICY_ZEN.md`
  - Status: OpenCode Zen provider key usage policy and terms/data-boundary review checklist (last reviewed 2026-02-21).

## CLI Docs

- `cli/runbooks/Push CLI Plan.md`
  - Status: Superseded baseline; core phases shipped. ROADMAP now drives CLI priorities directly.
- `cli/design/Push Runtime Protocol.md`
  - Status: Implemented baseline; protocol version/envelopes and the `cli/protocol-schema.ts` runtime validator are in code.
- `cli/design/Push CLI TUI Visual Language Spec.md`
  - Status: Shipped baseline for the experimental TUI visual language.
- `cli/design/TUI Architecture.md`
  - Status: Reference architecture for the TUI implementation now in code.
- `cli/design/TUI Visual System.md`
  - Status: Detailed visual reference for the TUI implementation now in code.
- `cli/design/Machine-Readable Output and CLI-Web Bridge.md`
  - Status: Mixed design/reference; event protocol pieces are in code, richer headless/web bridge work remains future-facing.
- `cli/schemas/` (see `cli/schemas/README.md`)
  - Status: Active JSON Schema artifacts for runtime protocol envelopes/payloads.

## Canonical Roadmap

- `../ROADMAP.md` is the canonical product roadmap.
- `docs/` is draft/exploration space unless an item is promoted to roadmap.

## Archive

- `archive/Workspace Hub Sprint Plan.md`
  - Status: Historical/superseded by implementation and roadmap.
- `archive/PR and Branch Awareness.md`
  - Status: Historical planning reference.
- `archive/Memvid Integration Proposal.md`
  - Status: Historical proposal reference.
- `archive/Browserbase Integration Spike.md`
  - Status: Historical implementation spike.
- `archive/Sandbox mode.md`
  - Status: Historical spec reference.
- `archive/DUPLICATION.md`
  - Status: Older duplication analysis snapshot.
- `archive/Google Native Search Decision.md`
  - Status: Historical decision reference.
- `archive/runbooks/Agent Context Sprint Plan.md`
  - Status: Shipped sprint plan retained as implementation history.
- `archive/runbooks/Architecture Follow-up Plan.md`
  - Status: Completed architecture cleanup plan retained as reference.
- `archive/runbooks/Efficiency Plan.md`
  - Status: Archived 2026-04-16; partially shipped rationale kept for provenance.
- `archive/runbooks/Harness Ergonomics Plan.md`
  - Status: Shipped ergonomics sprint plan retained as reference.
- `archive/runbooks/Harness Reliability Plan.md`
  - Status: Archived 2026-04-16; Tracks A/B/C/E shipped, Track D deferred.
- `archive/runbooks/Harness Runtime Evolution Plan.md`
  - Status: Archived 2026-04-16; all five tracks shipped 2026-03-30.
- `archive/runbooks/Runtime Enforcement Follow-up Plan.md`
  - Status: Archived 2026-04-16; completed 2026-03-30.
- `archive/runbooks/Shared Runtime Convergence Plan.md`
  - Status: Archived 2026-04-16; major tranche shipped 2026-04-05.
- `archive/runbooks/Task Graph Orchestration Plan.md`
  - Status: Archived 2026-04-16; dependency-aware `plan_tasks` plus typed memory shipped 2026-04-05.
- `archive/runbooks/Truncation-Aware Edit Safety Plan.md`
  - Status: Implemented track-specific rollout history retained as reference.
- `archive/runbooks/Unified Workspace Plan.md`
  - Status: Shipped multi-sprint workspace consolidation plan retained as reference.
- `archive/runbooks/WorkspaceScreen Extraction Plan.md`
  - Status: Shipped workspace-route extraction plan retained as reference.
- `archive/runbooks/useChat Refactor Plan.md`
  - Status: Completed refactor execution record retained as reference.
- `archive/cli/runbooks/LSP Diagnostics Plan.md`
  - Status: Shipped CLI diagnostics plan retained as reference.
- `archive/cli/runbooks/Push CLI Bootstrap Execution Plan.md`
  - Status: Completed CLI bootstrap plan retained as reference.
- `archive/cli/runbooks/Push CLI TUI Phase 1 Plan.md`
  - Status: Implemented experimental TUI plan retained as reference.

## Filing Rules

- Put new active, draft, or deferred product work in `runbooks/` and new CLI work in `cli/runbooks/`.
- Keep durable specs and shipped design references in `decisions/` or `cli/design/`.
- Keep research, comparisons, and post-hoc analysis in `decisions/` (or `research/` for raw external source writeups).
- When a plan is done but still worth keeping, move it into `archive/runbooks/` or `archive/cli/runbooks/`.
- If a draft in `docs/` becomes an implementation commitment, promote a concise version into `../ROADMAP.md` first.
