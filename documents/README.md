# Documents Index

Use this file to navigate active design/planning docs versus historical references.

## Structure

- `plans/` — implementation plans, strategy docs, and execution records
- `design/` — technical design/specification docs
- `analysis/` — research, post-hoc analysis, and wishlist docs
- `security/` — security reviews and audits
- `cli/` — CLI-specific plans, runtime design docs, and protocol schemas
- `archive/` — historical/superseded docs

## Active Docs

### Plans

- `plans/Harness Reliability Plan.md`
  - Status: Active harness strategy and roadmap.
- `plans/Background Coder Tasks Plan.md`
  - Status: Deferred server-side background execution design.
- `plans/Efficiency Plan.md`
  - Status: Active efficiency direction for CLI/runtime behavior.
- `plans/Truncation-Aware Edit Safety Plan.md`
  - Status: Design/rollout history for truncation-aware edit safety.

### Design

- `design/Resumable Sessions Design.md`
  - Status: Shipped resumable sessions design and review log.

### Analysis

- `analysis/Agent Experience Wishlist.md`
  - Status: Wishlist + shipped outcomes reference.
- `analysis/Duplication and Structural Symmetry Analysis.md`
  - Status: Structural/codebase analysis reference.

### Security

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

### CLI Docs

- `cli/plans/Push CLI Plan.md`
  - Status: Active CLI architecture and implementation baseline.
- `cli/plans/Push CLI TUI Phase 1 Plan.md`
  - Status: Proposed scope for optional full-screen `push tui` mode (Phase 1).
- `cli/plans/Push CLI Bootstrap Execution Plan.md`
  - Status: Completed bootstrap execution record.
- `cli/design/Push Runtime Protocol.md`
  - Status: Active protocol spec for `pushd` messaging.
- `cli/design/Push CLI TUI Visual Language Spec.md`
  - Status: Proposed visual language and terminal theming spec for `push tui` Phase 1.
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

## Promotion Rule

If a draft in `documents/` becomes an implementation commitment, promote a concise version into `../ROADMAP.md` first.
