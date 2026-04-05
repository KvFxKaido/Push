# Runbooks Folder

Status reviewed: 2026-04-05

This folder contains active plans, partially completed roadmaps, deferred designs, and historical implementation records. Renamed from the former `plans/` folder.

## How To Read These Docs

- Prefer docs marked **Current** when picking follow-up work.
- Treat docs marked **Historical** as provenance, rationale, and implementation history.
- Treat docs marked **Deferred** as reference designs, not pending commitments.
- If a plan conflicts with the code, prefer the code and refresh the plan.

## Document Status

| Document | Status | Notes |
|---|---|---|
| `Background Coder Tasks Plan.md` | Deferred reference | Intentionally deferred while Push remains a PWA; keep for native-app or daemon-first revisits. |
| `Chat Surface Evolution Plan.md` | Current, created 2026-03-31 | Defines the next product/UI trajectory for chat mode: separate surface, shared platform. |
| `Efficiency Plan.md` | Historical, partially shipped | Core decisions landed; doc still contains pre-ship reasoning and is useful mainly as rationale. |
| `Harness Reliability Plan.md` | Historical tracking | Tracks A/B/C/E largely shipped; Track D deferred. Best used as implementation history and rationale. |
| `Harness Runtime Evolution Plan.md` | Historical, completed 2026-03-30 | All five harness-runtime tracks shipped; use as implementation history and follow-up rationale, not as the live roadmap. |
| `Runtime Enforcement Follow-up Plan.md` | Historical, completed 2026-03-30 | Structured delegation outcomes, post-tool bridge activation, and approval-sensitive runtime gates are now shipped; use this as implementation history. |
| `Shared Runtime Convergence Plan.md` | Historical, major tranche shipped 2026-04-05 | The core semantic convergence work is now in shared `lib/`; use this as implementation history plus guidance for selective CLI follow-through. |
| `Workspace Publish to GitHub Plan.md` | Current, Phase 1 shipped 2026-04-05 | Product and implementation plan for first-class in-app repo creation as a workspace-publish flow. The initial publish UI/transition flow is now landed; remaining work is follow-through and optional empty-repo creation. |
| `UX Nice-to-Haves Plan.md` | Wishlist / reference | Still a valid idea bank, but not current roadmap. |
| `Web-CLI Parity Plan.md` | Current, refreshed 2026-03-30 | TypeScript runtime cutover, TUI, and daemon work landed; remaining work is selective convergence, not blanket migration. |
| `Workspace Route Follow-up Plan.md` | Current, refreshed 2026-03-30 | Original draft phases largely landed; remaining work is targeted cleanup and measurement inside the new route boundaries. |

## Quick Triage

If we are choosing implementation work from this folder, the live clusters are:

1. Chat-surface evolution: make chat feel like a first-class app surface without splitting the platform.
2. Selective CLI adoption of the now-shared runtime substrate where it clearly improves the terminal product.
3. Optional workspace-route cleanup after the major boundary work already shipped.
4. Workspace-to-GitHub publishing follow-through after the first in-app publish flow shipped.
5. Deferred/background execution work only if product scope changes.
