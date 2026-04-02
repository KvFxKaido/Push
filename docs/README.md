# Docs Index

Use this file to navigate active design/planning docs versus historical references.

`docs/` is the canonical documentation home for this repo.

## Structure

- `architecture.md` — design system, visual tokens, and component specs (moved from root `DESIGN.md`)
- `decisions/` — architecture decisions, research, analysis, and shipped design references
- `runbooks/` — active, draft, or deferred product plans
- `security/` — security reviews, audits, and provider usage policies
- `cli/design/` — CLI/TUI architecture and UX specs
- `cli/runbooks/` — active or proposed CLI work
- `cli/schemas/` — machine-readable runtime protocol artifacts
- `archive/` — historical root docs plus archived completed history
- `archive/runbooks/` — shipped/completed product plans kept for reference
- `archive/cli/runbooks/` — shipped/completed CLI plans kept for reference

## Architecture

- `architecture.md`
  - Status: Canonical design system reference (colors, typography, spacing, components, motion).

## Decisions

- `decisions/Agent Experience Wishlist.md`
  - Status: Wishlist + shipped outcomes reference.
- `decisions/Agent Tool Patterns — Claude Code Cross-Reference.md`
  - Status: Reference comparison against Claude Code's agent/tool patterns.
- `decisions/Duplication and Structural Symmetry Analysis.md`
  - Status: Structural/codebase analysis reference.
- `decisions/Harness Friction — Agent Self-Report.md`
  - Status: Source analysis that informed the harness ergonomics follow-up work.
- `decisions/AgentScope Architecture Review.md`
  - Status: Comparative architecture review with concrete recommendations worth borrowing from AgentScope.
- `decisions/Copilot SDK Research.md`
  - Status: Copilot SDK feature comparison and adoption notes for Push.
- `decisions/Architecture Rating Snapshot.md`
  - Status: Architecture quality ratings and improvement tracking.
- `decisions/External Resource Review — Harness Engineering and Ralph Loop.md`
  - Status: External resource review reference.
- `decisions/Resumable Sessions Design.md`
  - Status: Shipped resumable sessions design and review log.
- `decisions/Sectioned System Prompts.md`
  - Status: Shipped design reference for the sectioned system prompt builder refactor.
- `decisions/CLI Prompt Builder Convergence.md`
  - Status: CLI prompt builder convergence design reference.

## Runbooks

- `runbooks/Background Coder Tasks Plan.md`
  - Status: Deferred design; intentionally not in code for the current PWA architecture.
- `runbooks/Efficiency Plan.md`
  - Status: Partially shipped; context trimming and the prompt-engineered tool path are in code, follow-up optimization remains open.
- `runbooks/Harness Reliability Plan.md`
  - Status: Mostly shipped; Tracks A/B/C/E are in code, while Track D remains deferred.
- `runbooks/UX Nice-to-Haves Plan.md`
  - Status: Wishlist parking lot; treat as mostly not in code unless separately promoted.
- `runbooks/Web-CLI Parity Plan.md`
  - Status: In progress; shared root modules plus daemon/TUI convergence are in code, full CLI runtime TypeScript cutover is not.
- `runbooks/Workspace Route Follow-up Plan.md`
  - Status: Draft follow-up; some boundary cleanup is in code, but the route-shaping work tracked here is still open.
- `runbooks/Harness Runtime Evolution Plan.md`
  - Status: Completed implementation history for the harness runtime layer.
- `runbooks/Runtime Enforcement Follow-up Plan.md`
  - Status: Completed follow-on for the runtime enforcement layer.
- `runbooks/Chat Surface Evolution Plan.md`
  - Status: Chat surface evolution tracking.

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
  - Status: In progress; REPL, daemon, attach, and the experimental TUI are in code, while broader convergence work remains open.
- `cli/design/Push Runtime Protocol.md`
  - Status: Implemented baseline; protocol version/envelopes are in code and tests, but JSON Schema validation is not wired into runtime checks.
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
- `archive/runbooks/Harness Ergonomics Plan.md`
- If a draft in `docs/` becomes an implementation commitment, promote a concise version into `../ROADMAP.md` first.
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
- Keep research, comparisons, and post-hoc analysis in `decisions/`.
- When a plan is done but still worth keeping, move it into `archive/runbooks/` or `archive/cli/runbooks/`.
- If a draft in `docs/` becomes an implementation commitment, promote a concise version into `../ROADMAP.md` first.
