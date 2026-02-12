# Push Roadmap (Canonical)

Last updated: 2026-02-12

This is the single source of truth for active product and engineering direction.

`documents/` is a draft lab for spikes, explorations, and non-final plans.
Only decisions promoted into this file should be treated as implementation commitments.

## How We Use This

1. Draft ideas in `documents/` (untracked is fine).
2. Promote approved work here as concise, actionable items.
3. Keep this file current during execution.
4. Archive completed/abandoned items out of this file to keep it focused.

## Status Legend

- `planned` - approved but not started
- `in_progress` - actively being implemented
- `blocked` - waiting on dependency/decision
- `done` - completed and verified

## Current Priorities

| Item | Status | Scope | Acceptance Criteria |
|---|---|---|---|
| Browser Tools Rollout Hardening | planned | Validate browser tool reliability on real mobile networks before broader enablement | Cellular QA complete (iOS + Android), error/latency within target, rollout gate decision recorded |
| Sandbox Telemetry | blocked | Track creation, expiration, download, and promotion events | Analytics provider selected; sandbox lifecycle events visible in dashboard/logs |
| Workspace Hub v2 | planned | Improve Diff ergonomics and decide long-term drawer vs hub division for history/settings | Decision captured; richer per-file diff navigation shipped; no duplicate navigation paths |
| Roadmap Hygiene Automation | planned | Lightweight template/checklist for promoting `documents/` ideas into this file | New roadmap items consistently include scope + acceptance criteria |

## Recently Completed

| Item | Status | Scope | Acceptance Criteria |
|---|---|---|---|
| Sandbox Mode v1 | done | Ephemeral Modal workspace for brainstorming/prototyping; primary onboarding entry point; tar.gz download export path | User can start sandbox from onboarding (no GitHub auth) or repo picker, edit/run files, and download workspace as tar.gz |
| Repo Sync Reliability | done | Unified auth handling and complete repo pagination for PAT/OAuth + GitHub App paths | Authenticated flows do not silently fall back to demo; repo fetching paginates across accessible pages |
| Sandbox Repo Promotion (v2) | done | In-app `promote_to_github` flow creates a repo, pushes sandbox branch, and transitions app context to repo mode | User can promote sandbox to GitHub without leaving chat; active workspace rebinds to promoted repo |
| Workspace Hub v1 | done | Single top-right workspace trigger with full-screen hub tabs (`Files`, `Diff`, `Console`, `Scratchpad`) and integrated commit/push controls | Hub opens reliably on mobile; tab flows work; commit/push confirmations and protect-main guard enforced |
| Branch UX Consolidation (Phase 1) | done | Branch selector shows existing branches (not just app-created), includes delete action in selector, and home cards support branch selection | User can open repos on specific branches from Home and manage branch switching/deletion from workspace context |
| Home Header Simplification | done | Replaced ambiguous top header strip with compact account menu (settings/disconnect) and profile avatar | Home uses less vertical space and account controls remain discoverable |

## Decision Log

| Date | Decision | Source |
|---|---|---|
| 2026-02-09 | Root `ROADMAP.md` is canonical; `documents/` is draft space | Team decision in chat |
| 2026-02-09 | Sandbox Mode vision: real ephemeral workspace + explicit promotion paths | `documents/Sandbox mode.md` |
| 2026-02-08 | Sandbox v1 descoped: no in-app repo creation (latency/sync concerns); zip download is the only export path; onboarding entry point is v1 priority | `documents/Sandbox mode.md` revision |
| 2026-02-09 | Sandbox Mode v1 implemented: two entry points, sandbox-specific system prompt, `sandbox_download` tool + card, expiry warning banner, persistent download button in header; export format is tar.gz (not zip) | Implementation session |
| 2026-02-12 | Workspace shell consolidated into one mobile hub trigger with `Files`, `Diff`, `Console`, and `Scratchpad` tabs | `documents/Workspace Hub Sprint Plan.md` + implementation session |
| 2026-02-12 | Branch selection now surfaces existing branches across Home/workspace, with in-context delete from the workspace selector | Implementation session |
| 2026-02-12 | Home header simplified to compact account menu with Settings + guarded Disconnect and GitHub avatar | Implementation session |

## Promotion Checklist (Draft -> Canonical)

An item should be promoted from `documents/` to this roadmap only if all are true:

- problem statement is clear
- v1 scope is bounded
- success criteria are testable
- ownership is clear (person/agent/phase)
- non-goals are explicit

## Notes for AI Collaborators

- Always read `ROADMAP.md` first for current priorities.
- Treat `documents/` as exploratory unless explicitly referenced by a roadmap item.
- If implementation diverges from a draft, update this roadmap with the new decision.
