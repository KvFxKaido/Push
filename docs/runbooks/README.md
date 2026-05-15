# Runbooks Folder

Status reviewed: 2026-05-15

This folder contains active plans, draft spikes, deferred designs, and a few shipped-but-still-active reference runbooks. Fully retired shipped plans live in `../archive/runbooks/`.

## How To Read These Docs

- Prefer docs marked **Current** when picking follow-up work.
- Treat docs marked **Draft spike** as exploration that has not been promoted into `ROADMAP.md` yet.
- Treat docs marked **Deferred** as reference designs, not pending commitments.
- If a plan conflicts with the code, prefer the code and refresh the plan.

## Document Status

| Document | Status | Notes |
|---|---|---|
| `AgentJob Foundation.md` | Shipped 2026-04-27 (PRs #433, #434, #435) | Role-aware contract, main-chat bg branch, chatRef context-loader. Carries the bundled + standalone follow-ups. |
| `Background Coder Tasks Plan.md` | Partially superseded by `AgentJob Foundation.md` | Original multi-phase reference; main-chat migration arc shipped via the AgentJob Foundation. Phases 2–4 (retry/backoff, push notifications, job history, multi-role background jobs) still deferred. |
| `Canonical SOP Playbooks Spike.md` | Draft spike, added 2026-04-14 | Named playbooks that compile to task graphs on top of the existing `plan_tasks` runtime. No code yet. |
| `Chat Surface Evolution Plan.md` | Mostly shipped 2026-03-31 | Tracks A, B, D, E, F landed; Track C (explicit context escalation) remains open. |
| `Hashline Effectiveness Metric.md` | Draft plan | Fixture-based measurement of hashline edit-success delta. Initial 3-fixture run logged in `../decisions/Hashline System Review.md`; full corpus not yet executed. |
| `Private Cloudflare Deployment.md` | Current runbook | Cloudflare Access plus `PUSH_DEPLOYMENT_TOKEN` fallback for private app/phone testing. |
| `Provider Stats Endpoint.md` | Active, shipped 2026-04-29 | Operating notes for the Workers Analytics Engine-backed provider stats endpoint. |
| `Test Coverage Plan.md` | Current, Phases 1–5 shipped 2026-04-17 | Post-audit coverage push. Phase 6 remains outlined with target files and acceptance bars. |
| `Tiered Orchestrator Routing Spike.md` | Draft spike, added 2026-04-14 | Rule-engine router in front of Orchestrator to resolve trivial intents without a frontier-model call. No code yet. |
| `Workspace Publish to GitHub Plan.md` | Current, Phase 1 shipped 2026-04-05 | Initial publish flow landed; remaining work is follow-through and optional empty-repo creation. |

## Quick Triage

If we are choosing implementation work from this folder, the live clusters are:

1. Chat-surface Track C (explicit context escalation) once the plain-chat baseline has settled.
2. Playbooks + Tiered Routing spikes — both are cheap-to-try wins that would reduce Orchestrator cost and latency; promote whichever measures better to `ROADMAP.md`.
3. Workspace-to-GitHub publish follow-through after the first in-app publish flow shipped.
4. Deferred/background execution work (`Background Coder Tasks Plan.md`) only if product scope changes.

## Where Shipped Plans Went

The following plans were archived to `../archive/runbooks/` during docs audits:

- `Efficiency Plan.md`
- `Harness Reliability Plan.md`
- `Harness Runtime Evolution Plan.md`
- `Runtime Enforcement Follow-up Plan.md`
- `Shared Runtime Convergence Plan.md`
- `Task Graph Orchestration Plan.md`
- `Background Coder Tasks Phase 1.md`
- `UX Nice-to-Haves Plan.md`
- `Web-CLI Parity Plan.md`
- `Workspace Route Follow-up Plan.md`

These describe shipped, superseded, or inactive work retained for provenance.
