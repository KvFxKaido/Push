# PR & Branch Awareness — Draft Plan

**Status:** Draft (for `documents/`)
**Date:** 2026-02-10
**Scope:** Read-only PR and branch context across Home screen and chat

---

## Problem

Push users have no visibility into PR or branch activity without leaving the app. The GitHub mobile site solves this with nested navigation that breaks orientation on every drill-down. Push's structural advantage — chat flattens navigation — means PR/branch info should come *to* the conversation, not require the user to go find it.

## Design Principle

**Read first, write later.** This plan covers reading PR and branch state. Write operations (creating branches, pushing to PRs, merging) are explicitly deferred. The Coder already handles commits through the sandbox — that remains the sole write path until a future decision says otherwise.

## Non-Goals

- Branch switching UI or branch management
- Merge conflict resolution
- PR creation, review submission, or merge actions
- Dedicated PR list/detail views (no new navigation layers)
- Notifications or webhook-driven updates

---

## Layer 1: Home Screen — PR Signals on Repo Cards

**Goal:** Answer "does this repo need my attention?" without tapping in.

### What Changes

Each repo card on the Home screen gains a PR activity indicator alongside the existing commit/issue counts. The data comes from the same GitHub REST API calls that already power the repo list.

### Spec

- Add open PR count to repo card metadata row (alongside existing language, commit, issue badges)
- If any open PR has requested the user's review, show a distinct review-requested indicator (e.g. colored dot or badge)
- "Resume latest chat" card already shows the last conversation topic — no changes needed here for v1

### Data Source

`GET /repos/{owner}/{repo}/pulls?state=open&per_page=5` — count for badge, scan `requested_reviewers` for review signal. This is a lightweight call that can run alongside the existing repo fetch.

### Risk

Extra API call per repo on Home load. Mitigate by fetching only for the top 3-5 recent repos, not the full list. Cache aggressively — PR counts don't need to be real-time on a home screen.

---

## Layer 2: PR-Aware Chat — New Tools + Cards

**Goal:** Talk about PRs without leaving the conversation.

### New Tools

These follow the existing tool protocol pattern: prompt-engineered JSON blocks, detected and dispatched through `tool-dispatch.ts`.

| Tool | Endpoint | Returns |
|------|----------|---------|
| `github_list_prs` | `GET /repos/{owner}/{repo}/pulls` | Open PRs with title, author, branch, status, diff stats, review state |
| `github_get_pr` | `GET /repos/{owner}/{repo}/pulls/{number}` | Single PR detail — description, diff summary, review comments, CI status |
| `github_pr_diff` | `GET /repos/{owner}/{repo}/pulls/{number}` (Accept: diff) | Raw diff for Orchestrator analysis, condensed into a card |
| `github_list_branches` | `GET /repos/{owner}/{repo}/branches` | Branch list with last commit info |

### New Cards

| Card | Triggered By | Shows |
|------|-------------|-------|
| `PRListCard` | `github_list_prs` | Compact list of open PRs — number, title, author, branch, +/- stats, review state |
| `PRDetailCard` | `github_get_pr` | Single PR — description summary, file change list, review status, CI badge |

These follow the existing card pattern in `components/cards/`. Discriminated union types added to `types/index.ts`.

### System Prompt Changes

Add PR tools to the Orchestrator's tool protocol block in the system prompt. The Orchestrator already handles GitHub tools — this is additive vocabulary, not a new dispatch path.

Include open PR summary in workspace context (`workspace-context.ts`) so the agent is passively aware of PR state without needing the user to ask. Light touch: just count + most recent PR title, not full PR data.

### Action Chips (Optional, Low-Effort)

Below the chat input, show contextual suggestion chips based on repo state:

- `Open PRs` — visible when repo has open PRs (injects "Show me open PRs" as user message)
- `Recent changes` — always visible (injects "What changed recently?")
- `Start Coder` — always visible (injects "I need to make some changes")

These are purely UI sugar. They compose a prompt and send it as a regular message. No new tool infrastructure.

### Sandbox Mode

PR and branch tools are blocked in Sandbox Mode, same as existing GitHub tools. No changes to sandbox tool gating logic.

---

## Layer 3: Branch Context as a Filter (Future)

**Goal:** Shift branch context without navigating away from chat.

**Note:** This layer is a design direction, not a v1 commitment. Documenting it to inform Layer 1-2 decisions.

### Concept

Branch is not a place you navigate to — it's a lens the agent sees through. A small pill in the chat header (next to repo name) shows current branch context. Tapping it shows a branch picker. Switching branches tells the agent to adjust its context without starting a new chat.

### Why Defer

- Requires deciding how branch context interacts with sandbox (sandbox clones a specific branch)
- The Coder currently operates on whatever branch the sandbox cloned — branch switching mid-session is a state management question
- Read-only branch awareness (Layer 2's `github_list_branches`) covers the immediate need
- Most mobile PR triage is against the default branch anyway

### Promotion Criteria

Promote to active development when: (a) users are regularly asking the agent about non-default branches in chat, and (b) the answer to "which branch?" is ambiguous often enough to warrant a persistent UI element.

---

## Implementation Sequence

### Phase 1 — PR Tools + Cards (Core Value)

1. Define `github_list_prs` and `github_get_pr` tool schemas in `github-tools.ts`
2. Add detection/execution to `tool-dispatch.ts`
3. Build `PRListCard` and `PRDetailCard` components
4. Add card data types to `types/index.ts`
5. Update Orchestrator system prompt with PR tool definitions
6. Add light PR context to `workspace-context.ts` (open count + latest title)

**Validates:** Can the agent usefully talk about PRs with read-only tools?

### Phase 2 — Home Screen Enrichment

1. Fetch open PR count alongside repo data in `useRepos.ts`
2. Add PR badge to repo card component
3. Add review-requested signal if user's GitHub login matches `requested_reviewers`

**Validates:** Does PR metadata on repo cards change how people pick which repo to open?

### Phase 3 — Action Chips (If Phase 1 Proves Useful)

1. Build chip component (list of contextual suggestions below input)
2. Wire chips to inject prompt text as user message
3. Conditionally show PR-related chips based on repo state from workspace context

**Validates:** Do people use suggested actions, or do they just type?

### Phase 4 — Diff + Branch Tools (Stretch)

1. Add `github_pr_diff` and `github_list_branches` tools
2. Integrate diff rendering into card or inline display
3. Evaluate whether branch context pill (Layer 3) has earned its way in

---

## Open Questions

1. **Diff rendering:** Show raw diff in a card (like `DiffPreviewCard`), or have the agent summarize and only show the card on request? Summarize-first matches "show, don't dump" but loses detail.
2. **PR comment threading:** `github_get_pr` can return review comments. Display inline in chat, or as an expandable section in `PRDetailCard`? Threading in a linear chat is awkward.
3. **Stale data:** Home screen PR counts and chat-injected PR context are point-in-time snapshots. Is "stale until you ask again" acceptable, or does the home screen need a refresh gesture?
4. **Rate limits:** Adding PR fetches to home screen load and workspace context increases GitHub API calls. Monitor against rate limits, especially for PAT users with lower quotas.

---

## Promotion Criteria (Draft → Roadmap)

Per `ROADMAP.md` checklist:

- ✅ Problem statement is clear
- ✅ V1 scope is bounded (read-only, Phase 1-2)
- ✅ Success criteria are testable (agent can discuss PRs; repo cards show PR count)
- ✅ Ownership is clear (solo dev, phased)
- ✅ Non-goals are explicit
