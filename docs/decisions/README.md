# Decisions Folder

Status reviewed: 2026-04-05

This folder contains architecture decisions, research, analysis, and shipped design references. It merges the former `analysis/` and `design/` folders.

## How to use this folder

- Prefer the docs marked **Current** when choosing new work.
- Treat **Historical** docs as context and provenance, not open task lists.
- If a doc conflicts with the code, prefer the code and refresh the doc.

## Document Status

| Document | Status | Notes |
|---|---|---|
| `Agent Experience Wishlist.md` | Historical | Shipped on 2026-02-19; useful for provenance and feature rationale. |
| `Architecture Rating Snapshot.md` | Reference snapshot, added 2026-03-30 | Three-way architecture rating panel doc with Codex, Claude, and Gemini passes plus a synthesis section. |
| `Agent Tool Patterns — Claude Code Cross-Reference.md` | Reference, refreshed 2026-03-30 | Comparative design notes; several February borrow items are now shipped or partial (`ask_user`, typed delegation, adaptive web-side working-memory reinjection). The main remaining follow-up is bringing the CLI working-memory path to the same standard. |
| `AgentScope Architecture Review.md` | Current, refreshed after tracing pass | Web-side OTel spans are now in place for model/tool/sandbox/delegation boundaries; the main remaining work is Worker/server propagation and sandbox-provider abstraction. |
| `Context Memory and Retrieval Architecture.md` | Current, added 2026-04-05 | Concrete follow-up design for moving from transcript compaction to typed, invalidation-aware memory retrieval and prompt packing across orchestration flows. |
| `Copilot SDK Research.md` | Current, partially superseded | Prompt sections, tool scoping, steering/queueing, and the live-vs-persisted event split are now in place; the main still-open carry-over is a dedicated task agent plus richer session/permission telemetry. |
| `Duplication and Structural Symmetry Analysis.md` | Current, refreshed 2026-03-30 | `hashline` drift and shared provider-model catalog drift are now resolved; remaining cleanup is more about Settings state surfaces and other mirrored modules. |
| `Harness Friction — Agent Self-Report.md` | Current, refreshed 2026-03-30 | Ambient runtime state, capability discovery, and structured mutation postconditions are now shipped on the main web path; working-memory evolution and richer structural navigation remain open. |
| `Multi-Agent Orchestration Research — open-multi-agent.md` | Current, added 2026-04-04 | Research on open-multi-agent framework: goal→DAG decomposition, coordinator pattern, shared memory, fan-out/aggregate. Feeds into task graph orchestration plan. |
| `Web and CLI Runtime Contract.md` | Current, added 2026-04-05 | Defines the architecture rule for Push shells: share agent-runtime semantics across web and CLI, allow divergence in transport and UX shell. |

## Quick Triage

If we are choosing implementation work from this folder, the best live clusters are now:

1. End-to-end tracing follow-through (Worker/server propagation, exporter rollout, metric retirement).
2. Working-memory evolution and invalidation-aware investigation state, now with a concrete follow-up in `Context Memory and Retrieval Architecture.md`.
3. Richer structural navigation (`read_symbol_body`, implementations, call-graph queries).
4. Shared-runtime convergence between web and CLI, especially for task graphs, typed memory, and delegation semantics.
