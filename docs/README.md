# Docs Index

Status reviewed: 2026-06-07

Use this file to navigate active design/planning docs versus historical references.
The canonical architecture and design-system docs live at the repo root
([`../ARCHITECTURE.md`](../ARCHITECTURE.md), [`../DESIGN.md`](../DESIGN.md));
`docs/` is the home for decisions, runbooks, research, and security.

## Structure

- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) (repo root) — tech stack, runtime roles, display vocabulary, key systems, and repo map
- [`../DESIGN.md`](../DESIGN.md) (repo root) — visual tokens, colors, typography, spacing, and component specs
- `decisions/` — small live architecture-decision surface
- `runbooks/` — active, draft, or deferred product plans
- `research/` — external research notes that inform upcoming design work
- `security/` — security reviews, audits, and provider usage policies
- `cli/design/` — CLI/TUI architecture and UX specs
- `cli/runbooks/` — active or proposed CLI work
- `cli/schemas/` — machine-readable runtime protocol artifacts
- `archive/` — historical root docs plus archived completed history
- `archive/decisions/` — archived per-topic decision notes and research/provenance
- `archive/runbooks/` — shipped/completed product plans kept for reference
- `archive/cli/runbooks/` — shipped/completed CLI plans kept for reference

## Architecture

- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) (repo root)
  - Status: Canonical architecture reference (tech stack, runtime roles, display vocabulary, key systems, repo map).
- [`../DESIGN.md`](../DESIGN.md) (repo root)
  - Status: Canonical design system reference (colors, typography, spacing, components, motion).

## Decisions

Detailed status lives in [`decisions/README.md`](decisions/README.md).
The live decision surface is intentionally small:

- [`decisions/Agent Runtime Decisions.md`](<decisions/Agent Runtime Decisions.md>)
  - Status: Current. Covers agent-loop shape, runtime protocol, role/display vocabulary, memory, prompt packing, task graph, tool dispatch, loop detection, and TUI decomposition.
- [`decisions/Platform, Sessions, and Sandbox Decisions.md`](<decisions/Platform, Sessions, and Sandbox Decisions.md>)
  - Status: Current. Covers auth, session/bearer model, remote relay, sandbox providers, background execution, provider observability, PR review automation, repo mirror, and git/RPC seams.
- [`archive/decisions/README.md`](archive/decisions/README.md)
  - Status: Archived source notes. Preserves the old per-topic decision docs, shipped chronicles, and comparative research.

## Runbooks

Detailed per-doc status lives in [`runbooks/README.md`](runbooks/README.md). Summary by status:

- **Current** — `Chat Surface Evolution Plan.md` (Track C remaining), `Private Cloudflare Deployment.md`, `Provider Stats Endpoint.md`, `Test Coverage Plan.md` (Phases 1–5 shipped, Phase 6 outlined), `Workspace Publish to GitHub Plan.md` (follow-through).
- **Draft spikes / plans** — `Tiered Orchestrator Routing Spike.md`, `Canonical SOP Playbooks Spike.md`, `Hashline Effectiveness Metric.md`, `Design Token Migration Plan.md`.
- **Deferred reference** — `Background Coder Tasks Plan.md`.

## Research

- `research/codex-compacting.md`
  - Status: Research compiled 2026-04-12 on how Codex CLI handles context compaction; informs Push's own compaction strategy.

## Security

- `security/SECURITY_AUDIT.md`
  - Status: Security findings and mitigation history.
## CLI Docs

- `cli/design/Push Runtime Protocol.md`
  - Status: Implemented baseline; protocol version/envelopes and the `lib/protocol-schema.ts` runtime validator are in code.
- `cli/design/Push CLI TUI Visual Language Spec.md`
  - Status: Shipped baseline for the experimental TUI visual language.
- `cli/design/TUI Architecture.md`
  - Status: Reference architecture for the TUI implementation now in code.
- `cli/design/TUI Visual System.md`
  - Status: Detailed visual reference for the TUI implementation now in code.
- `cli/design/Machine-Readable Output and CLI-Web Bridge.md`
  - Status: Historical for the web bridge; the shipped bridge uses loopback WebSocket and Worker relay. Headless NDJSON streaming remains an optional future CLI improvement.
- `cli/schemas/` (see `cli/schemas/README.md`)
  - Status: Active JSON Schema artifacts for runtime protocol envelopes/payloads.

## Priority surface

- `docs/decisions/` is the canonical decision + priority surface — each doc carries a `Status:` (see the vocabulary in [`decisions/README.md`](decisions/README.md)). The root `ROADMAP.md` was retired 2026-07-15; the decision docs and the code are canonical for what has shipped and what is committed.
- `docs/` is draft/exploration space; committing a draft means flipping its `Status:` and recording the decision in the relevant decision doc.

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
- `archive/branch-context-preservation-slice-2-draft.md`
  - Status: Archived 2026-05-15; branch context preservation shipped via PRs #412–#415.
- `archive/runbooks/Agent Context Sprint Plan.md`
  - Status: Shipped sprint plan retained as implementation history.
- `archive/runbooks/Architecture Follow-up Plan.md`
  - Status: Completed architecture cleanup plan retained as reference.
- `archive/runbooks/Background Coder Tasks Phase 1.md`
  - Status: Archived 2026-05-15; Phase 1 shipped and was superseded operationally by `AgentJob Foundation.md`.
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
- `archive/runbooks/UX Nice-to-Haves Plan.md`
  - Status: Archived 2026-05-15; old wishlist/reference, not current roadmap.
- `archive/runbooks/Web-CLI Parity Plan.md`
  - Status: Archived 2026-05-15; Tracks 1–4 shipped and remaining work is tracked in the decision docs.
- `archive/runbooks/Workspace Route Follow-up Plan.md`
  - Status: Archived 2026-05-15; route-boundary cleanup shipped and remaining work is optional/product-scoped elsewhere.
- `archive/runbooks/WorkspaceScreen Extraction Plan.md`
  - Status: Shipped workspace-route extraction plan retained as reference.
- `archive/runbooks/useChat Refactor Plan.md`
  - Status: Completed refactor execution record retained as reference.
- `archive/cli/runbooks/LSP Diagnostics Plan.md`
  - Status: Shipped CLI diagnostics plan retained as reference.
- `archive/cli/runbooks/Push CLI Plan.md`
  - Status: Archived 2026-05-15; superseded baseline, with live CLI priorities in the decision docs.
- `archive/cli/runbooks/Push CLI Bootstrap Execution Plan.md`
  - Status: Completed CLI bootstrap plan retained as reference.
- `archive/cli/runbooks/Push CLI TUI Phase 1 Plan.md`
  - Status: Implemented experimental TUI plan retained as reference.

## Filing Rules

- Put new active, draft, or deferred product work in `runbooks/` and new CLI work in `cli/runbooks/`.
- Keep durable, active decision summaries in `decisions/` or `cli/design/`.
- Keep research, comparisons, shipped chronicles, and post-hoc analysis in `archive/decisions/` once their current takeaways are summarized in the live decision docs. Use `research/` for raw external source writeups.
- When a plan is done but still worth keeping, move it into `archive/runbooks/` or `archive/cli/runbooks/`.
- If a draft in `docs/` becomes an implementation commitment, flip its `Status:` and record the decision in the relevant decision doc.
