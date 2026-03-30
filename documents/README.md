# Documents Index

Use this file to navigate active design/planning docs versus historical references.

`documents/` is the canonical documentation home for this repo. Do not create a parallel top-level `docs/` tree; place new material in the appropriate `documents/` subfolder instead.

## Structure

- `plans/` — active, draft, or deferred product plans
- `design/` — durable technical specs and shipped design references
- `analysis/` — research, comparisons, audits, and wishlist/reference docs
- `security/` — security reviews and audits
- `cli/design/` — CLI/TUI architecture and UX specs
- `cli/plans/` — active or proposed CLI work
- `cli/schemas/` — machine-readable runtime protocol artifacts
- `archive/` — historical root docs plus archived completed plan history
- `archive/plans/` — shipped/completed product plans kept for reference
- `archive/cli/plans/` — shipped/completed CLI plans kept for reference

## Active Product Plans

- `plans/Background Coder Tasks Plan.md`
  - Status: Deferred design; intentionally not in code for the current PWA architecture.
- `plans/Efficiency Plan.md`
  - Status: Partially shipped; context trimming and the prompt-engineered tool path are in code, follow-up optimization remains open.
- `plans/Harness Reliability Plan.md`
  - Status: Mostly shipped; Tracks A/B/C/E are in code, while Track D remains deferred.
- `plans/UX Nice-to-Haves Plan.md`
  - Status: Wishlist parking lot; treat as mostly not in code unless separately promoted.
- `plans/Web-CLI Parity Plan.md`
  - Status: In progress; shared root modules plus daemon/TUI convergence are in code, full CLI runtime TypeScript cutover is not.
- `plans/Workspace Route Follow-up Plan.md`
  - Status: Draft follow-up; some boundary cleanup is in code, but the route-shaping work tracked here is still open.

## Design References

- `design/Resumable Sessions Design.md`
  - Status: Shipped resumable sessions design and review log.
- `design/Sectioned System Prompts.md`
  - Status: Shipped design reference for the sectioned system prompt builder refactor.

## Analysis And Research

- `analysis/Agent Experience Wishlist.md`
  - Status: Wishlist + shipped outcomes reference.
- `analysis/Agent Tool Patterns — Claude Code Cross-Reference.md`
  - Status: Reference comparison against Claude Code's agent/tool patterns.
- `analysis/Duplication and Structural Symmetry Analysis.md`
  - Status: Structural/codebase analysis reference.
- `analysis/Harness Friction — Agent Self-Report.md`
  - Status: Source analysis that informed the harness ergonomics follow-up work.
- `analysis/AgentScope Architecture Review.md`
  - Status: Comparative architecture review with concrete recommendations worth borrowing from AgentScope.
- `analysis/Copilot SDK Research.md`
  - Status: Copilot SDK feature comparison and adoption notes for Push.

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

- `cli/plans/Push CLI Plan.md`
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
- `documents/` is draft/exploration space unless an item is promoted to roadmap.

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
- `archive/plans/Agent Context Sprint Plan.md`
  - Status: Shipped sprint plan retained as implementation history.
- `archive/plans/Architecture Follow-up Plan.md`
  - Status: Completed architecture cleanup plan retained as reference.
- `archive/plans/Harness Ergonomics Plan.md`
  - Status: Shipped ergonomics sprint plan retained as reference.
- `archive/plans/Truncation-Aware Edit Safety Plan.md`
  - Status: Implemented track-specific rollout history retained as reference.
- `archive/plans/Unified Workspace Plan.md`
  - Status: Shipped multi-sprint workspace consolidation plan retained as reference.
- `archive/plans/WorkspaceScreen Extraction Plan.md`
  - Status: Shipped workspace-route extraction plan retained as reference.
- `archive/plans/useChat Refactor Plan.md`
  - Status: Completed refactor execution record retained as reference.
- `archive/cli/plans/LSP Diagnostics Plan.md`
  - Status: Shipped CLI diagnostics plan retained as reference.
- `archive/cli/plans/Push CLI Bootstrap Execution Plan.md`
  - Status: Completed CLI bootstrap plan retained as reference.
- `archive/cli/plans/Push CLI TUI Phase 1 Plan.md`
  - Status: Implemented experimental TUI plan retained as reference.

## Filing Rules

- Put new active, draft, or deferred product work in `plans/` and new CLI work in `cli/plans/`.
- Keep durable specs and shipped design references in `design/` or `cli/design/`.
- Keep research, comparisons, and post-hoc analysis in `analysis/`.
- When a plan is done but still worth keeping, move it into `archive/plans/` or `archive/cli/plans/`.
- If a draft in `documents/` becomes an implementation commitment, promote a concise version into `../ROADMAP.md` first.
