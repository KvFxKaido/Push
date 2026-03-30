# Analysis Folder

Status reviewed: 2026-03-30

This folder is a mix of current architecture analysis, comparative research, and historical records of already-shipped harness work. It is not a flat backlog.

## How to use this folder

- Prefer the docs marked **Current** when choosing new work.
- Treat **Historical** docs as context and provenance, not open task lists.
- If a doc conflicts with the code, prefer the code and refresh the doc.

## Document Status

| Document | Status | Notes |
|---|---|---|
| `Agent Experience Wishlist.md` | Historical | Shipped on 2026-02-19; useful for provenance and feature rationale. |
| `Agent Tool Patterns — Claude Code Cross-Reference.md` | Reference, refreshed 2026-03-30 | Comparative design notes; several February borrow items are now shipped or partial (`ask_user`, typed delegation, adaptive web-side working-memory reinjection). The main remaining follow-up is bringing the CLI working-memory path to the same standard. |
| `AgentScope Architecture Review.md` | Current | Main still-open takeaways: OTel tracing and sandbox-provider abstraction. |
| `Copilot SDK Research.md` | Current, partially superseded | Prompt sections, tool scoping, steering/queueing, and the live-vs-persisted event split are now in place; the main still-open carry-over is a dedicated task agent plus richer session/permission telemetry. |
| `Duplication and Structural Symmetry Analysis.md` | Current, refreshed 2026-03-30 | `hashline` drift and shared provider-model catalog drift are now resolved; remaining cleanup is more about Settings state surfaces and other mirrored modules. |
| `Harness Friction — Agent Self-Report.md` | Current, refreshed 2026-03-30 | Ambient runtime state, capability discovery, and structured mutation postconditions are now shipped on the main web path; working-memory evolution and richer structural navigation remain open. |

## Quick Triage

If we are choosing implementation work from this folder, the best live clusters are now:

1. OpenTelemetry tracing and runtime observability.
2. Working-memory evolution and invalidation-aware investigation state.
3. Richer structural navigation (`read_symbol_body`, implementations, call-graph queries).
