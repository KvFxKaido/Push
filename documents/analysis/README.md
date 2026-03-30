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
| `Agent Tool Patterns — Claude Code Cross-Reference.md` | Reference | Comparative design notes; still useful, but not a task list. |
| `AgentScope Architecture Review.md` | Current | Main still-open takeaways: OTel tracing and sandbox-provider abstraction. |
| `Copilot SDK Research.md` | Current, partially superseded | Prompt sections, tool scoping, and tool hooks are done; steering/queueing and event persistence split remain interesting. |
| `Duplication and Structural Symmetry Analysis.md` | Current, refreshed 2026-03-30 | `hashline` drift has been resolved; model catalog/settings and mirrored web/CLI modules remain the main cleanup targets. |
| `Harness Friction — Agent Self-Report.md` | Current, refreshed 2026-03-30 | Ambient runtime state, stronger postconditions, capability discovery, and working-memory evolution remain the main open themes. |

## Quick Triage

If we are choosing implementation work from this folder, the best live clusters are:

1. Agent runtime contract and ambient state.
2. Structured mutation postconditions and diagnostics.
3. Settings/model-catalog consolidation and other mirrored-surface drift.
