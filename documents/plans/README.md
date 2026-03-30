# Plans Folder

Status reviewed: 2026-03-30

This folder mixes active plans, partially completed roadmaps, deferred designs, and historical implementation records. It should not be treated as a flat backlog.

## How To Read These Docs

- Prefer docs marked **Current** when picking follow-up work.
- Treat docs marked **Historical** as provenance, rationale, and implementation history.
- Treat docs marked **Deferred** as reference designs, not pending commitments.
- If a plan conflicts with the code, prefer the code and refresh the plan.

## Document Status

| Document | Status | Notes |
|---|---|---|
| `Background Coder Tasks Plan.md` | Deferred reference | Intentionally deferred while Push remains a PWA; keep for native-app or daemon-first revisits. |
| `Efficiency Plan.md` | Historical, partially shipped | Core decisions landed; doc still contains pre-ship reasoning and is useful mainly as rationale. |
| `Harness Reliability Plan.md` | Historical tracking | Tracks A/B/C/E largely shipped; Track D deferred. Best used as implementation history and rationale. |
| `UX Nice-to-Haves Plan.md` | Wishlist / reference | Still a valid idea bank, but not current roadmap. |
| `Web-CLI Parity Plan.md` | Current, refreshed 2026-03-30 | TypeScript runtime cutover, TUI, and daemon work landed; remaining work is selective convergence, not blanket migration. |
| `Workspace Route Follow-up Plan.md` | Current, refreshed 2026-03-30 | Original draft phases largely landed; remaining work is targeted cleanup and measurement inside the new route boundaries. |

## Quick Triage

If we are choosing implementation work from this folder, the live clusters are:

1. Selective web/CLI convergence where duplication still creates drift.
2. Optional workspace-route cleanup after the major boundary work already shipped.
3. Deferred/background execution work only if product scope changes.
