# PR & Branch Awareness + Change Pooling — Draft Plan

**Status:** Draft (for `documents/`)
**Date:** 2026-02-10
**Scope:** Read-only PR and branch context (Layers 1-3), AI-powered change organization (Layer 4)

---

## Problem

Push users have no visibility into PR or branch activity without leaving the app. The GitHub mobile site solves this with nested navigation that breaks orientation on every drill-down. Push's structural advantage — chat flattens navigation — means PR/branch info should come *to* the conversation, not require the user to go find it.

## Design Principle

**Read first, write later.** This plan covers reading PR and branch state. Write operations (creating branches, pushing to PRs, merging) are explicitly deferred. The Coder already handles commits through the sandbox — that remains the sole write path until a future decision says otherwise.

## Non-Goals

- Branch switching UI or branch management
- Merge conflict resolution UI
- PR creation, review submission, or merge actions
- Dedicated PR list/detail views (no new navigation layers)
- Notifications or webhook-driven updates
- Real-time file watching or virtual branch filesystem layer (GitButler-style)
- Hunk-level change splitting in v1 (file-level grouping first)

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

Extra API call per repo on Home load. Mitigation strategy:

- Render repo cards immediately with existing metadata (fast paint)
- Lazy-load PR data only for the top 3-5 "Recent" repos after initial render
- Do not fetch PR data for the full "Browse All Repos" list — only on drill-down or explicit refresh
- Cache aggressively — PR counts don't need to be real-time on a home screen
- Pull-to-refresh on Home screen is acceptable for v1 (mobile users expect this pattern)

---

## Layer 2: PR-Aware Chat — New Tools + Cards

**Goal:** Talk about PRs without leaving the conversation.

### New Tools

These follow the existing tool protocol pattern: prompt-engineered JSON blocks, detected and dispatched through `tool-dispatch.ts`.

| Tool | Endpoint | Returns |
|------|----------|---------|
| `github_list_prs` | `GET /repos/{owner}/{repo}/pulls` | Open PRs with title, author, branch, status, diff stats, review state |
| `github_get_pr` | `GET /repos/{owner}/{repo}/pulls/{number}` | Single PR detail — description, diff summary, review comments, CI status |
| `github_pr_diff` | `GET /repos/{owner}/{repo}/pulls/{number}` (Accept: diff) | Summary first: file list + diff stats. Raw diff loaded per-file on request. |
| `github_list_branches` | `GET /repos/{owner}/{repo}/branches` | Branch list with last commit info |

**Diff size guardrail:** `github_pr_diff` must not load full raw diffs by default. A 2,000-line diff will blow the Coder's 60KB context cap or the Orchestrator's token budget. Default behavior: return file change summary (filenames + per-file stats). The agent can then drill into specific files on request. If the total diff exceeds a threshold (~500 lines), the agent should say "This is a large diff — I've loaded the summary. Want me to look at specific files?" rather than silently truncating.

### New Cards

| Card | Triggered By | Shows |
|------|-------------|-------|
| `PRListCard` | `github_list_prs` | Compact list of open PRs — number, title, author, branch, +/- stats, review state |
| `PRDetailCard` | `github_get_pr` | Single PR — description summary, file change list, review status, CI badge |

These follow the existing card pattern in `components/cards/`. Discriminated union types added to `types/index.ts`.

### System Prompt Changes

Add PR tools to the Orchestrator's tool protocol block in the system prompt. The Orchestrator already handles GitHub tools — this is additive vocabulary, not a new dispatch path.

Include minimal PR signal in workspace context (`workspace-context.ts`): open PR count and PR numbers only. No titles, no descriptions — those are fetched on demand when the user asks. This prevents the agent from proactively opining about PRs the user didn't mention. The passive context answers "PRs exist" not "here's what they're about."

### Action Chips (Optional, Low-Effort)

Below the chat input, show contextual suggestion chips based on repo state:

- `Open PRs` — visible when repo has open PRs (injects "Show me open PRs" as user message)
- `Recent changes` — always visible (injects "What changed recently?")
- `Start Coder` — always visible (injects "I need to make some changes")

These are purely UI sugar. They compose a prompt and send it as a regular message. No new tool infrastructure. **Key constraint:** chips reflect repo state ("you have open PRs"), they never recommend action ("you should review your PRs"). They are shortcuts, not nudges.

### Sandbox Mode

PR and branch tools are blocked in Sandbox Mode, same as existing GitHub tools. No changes to sandbox tool gating logic.

---

## Layer 3: Branch Context as a Filter (Future)

**Goal:** Shift branch context without navigating away from chat.

**Note:** This layer is a design direction, not a v1 commitment. Documenting it to inform Layer 1-2 decisions.

### Concept

Branch is not a place you navigate to — it's a lens the agent sees through. A small pill in the chat header (next to repo name) shows current branch context. Tapping it shows a branch picker. Switching branches tells the agent to adjust its context without starting a new chat.

### Why Defer

- **Branch/sandbox dissonance:** If switching the branch "lens" also switches the sandbox branch, you lose uncommitted work (unless you stash/commit first). If it *doesn't* switch the sandbox, the agent reads code from one branch (via GitHub API) but runs code on another (in sandbox). Either path creates confusion for both the agent and the user. This requires a unified state model between chat context and sandbox filesystem that is too much scope for v1.
- The Coder currently operates on whatever branch the sandbox cloned — branch switching mid-session is a state management question with no clean answer yet
- Read-only branch awareness (Layer 2's `github_list_branches`) covers the immediate need
- Most mobile PR triage is against the default branch anyway

### Promotion Criteria

Promote to active development when: (a) users are regularly asking the agent about non-default branches in chat, and (b) the answer to "which branch?" is ambiguous often enough to warrant a persistent UI element.

---

## Layer 4: AI-Powered Change Pooling (Future — GitButler-Inspired)

**Goal:** Let the agent organize uncommitted changes into logical groups, then commit or branch them separately — through conversation, not drag-and-drop.

**Inspiration:** GitButler (built by Scott Chacon, GitHub co-founder) introduced "virtual branches" — all in-progress changes are pooled in a single working tree and you assign hunks to branches after writing code, not before. Their desktop app uses drag-and-drop lane assignment. Push can achieve the same intent through chat, which is actually a better fit for mobile.

**Note:** This layer is a design direction that builds on Layers 1-3. It requires the Coder to be reliable at diff analysis and git operations before it's worth attempting.

### Concept

The core interaction pattern:

1. **Pool** — User works in the sandbox (or the Coder makes changes). Multiple concerns accumulate in the working tree — bug fix, feature work, refactor, etc.
2. **Analyze** — User asks the agent to look at what changed. The agent reads the full working tree diff and clusters changes by semantic concern (file relationships, logical groupings, change intent).
3. **Propose** — The agent presents a `ChangeGroupCard` showing proposed groupings: "I see three logical changes: API endpoint refactor (4 files), button styling fix (2 files), and new test coverage (3 files)."
4. **Adjust** — User confirms, renames groups, moves files between groups, or drops a group entirely — all through chat. "Move the test file into the API group." "Drop the styling changes, I'll handle those later."
5. **Commit** — The agent commits each group as a separate, clean commit with a semantic message. Optionally creates branches per group. **Every commit requires explicit user confirmation** — even after groupings are approved, the agent confirms before each sequential commit. No silent commits, ever.

### Auditor Integration

The existing Auditor gate runs on every `sandbox_commit` in repo mode. Change pooling creates a new pattern: multiple sequential commits in one interaction. Two options:

- **Per-group audit (safer, slower):** The Auditor reviews each group's diff independently before each commit. User sees a verdict per group. If one group fails, the others can still proceed.
- **Batch audit (faster, less granular):** The Auditor reviews the full proposed plan (all groups + their diffs) in one pass. One verdict for the whole operation.

**v1 recommendation:** Per-group audit. It's consistent with the existing "every commit gets a verdict" model and avoids designing a new batch-audit prompt. The speed cost is acceptable because change pooling is not a frequent operation — it's a deliberate "let me organize my work" moment, not a tight loop.

### Why Chat Beats Drag-and-Drop Here

- **Semantic understanding:** An LLM can read the actual code and understand *why* changes belong together, not just which files they're in. A human dragging hunks has to make that judgment visually.
- **Mobile-native:** Drag-and-drop between lanes is a desktop interaction. "Split the API changes from the UI changes" is a sentence you can type on a phone.
- **Progressive complexity:** Simple case ("commit everything") is one message. Complex case ("split into three branches") is a conversation. The UI doesn't change — only the depth of interaction.
- **Batch intelligence:** The agent can propose commit messages, suggest branch names, and flag if a group has incomplete changes (e.g., new function with no import) — all things a drag-and-drop UI can't do.

### What This Requires

**Already exists in Push:**
- `sandbox_exec` can run any git command (branch creation, selective staging via `git add -p` or `git add <file>`, commits)
- `sandbox_read_file` and `sandbox_diff` for reading the working tree state
- The Coder's autonomous loop for multi-step git operations
- `DiffPreviewCard` as a starting point for change visualization

**New capabilities needed:**
- A diff analysis prompt that reliably clusters changes by semantic concern (this is the core LLM task — needs prompt engineering and validation)
- `ChangeGroupCard` as a **stateful component** — this is not just a display card, it's the source of truth for the current grouping. When the user says "move utils.ts to Group 1," the agent updates the card's data and re-renders it. The agent must never track groupings in its own context alone — it will drift after 2-3 adjustments. The card holds the state; the agent reads from and writes to it.
- Git operations for selective staging: the Coder needs to reliably `git add` specific files/hunks and commit in sequence without corrupting the index
- Branch-per-group flow: `git checkout -b <name>`, commit, switch back, repeat

**Explicitly not needed:**
- Custom virtual branch data model (GitButler builds this in Rust at the filesystem level — Push doesn't need it because the agent handles sequencing)
- Real-time file watching (GitButler tracks which keystrokes go to which virtual branch — irrelevant for mobile where changes already exist by the time you're triaging)
- Multi-worktree support (the sandbox is a single workspace; branching is sequential, not parallel)

### Interaction Examples

**Simple — organize and commit:**
```
User: "I've been making changes all morning. Clean this up into commits."
Agent: [reads diff, proposes 3 groups via ChangeGroupCard]
Agent: "I see three logical changes:
  1. Auth middleware refactor (auth.ts, middleware.ts, types.ts) +82 -45
  2. Dashboard loading state fix (Dashboard.tsx, useData.ts) +12 -3
  3. README update (README.md) +8 -2
Want me to commit these as separate commits on the current branch?"
User: "Yes, go ahead."
Agent: [stages group 1, runs Auditor] "Auditor passed on auth refactor. Committing..."
Agent: [stages group 2, runs Auditor] "Auditor passed on dashboard fix. Committing..."
Agent: [stages group 3, runs Auditor] "Auditor passed on README. Committing..."
Agent: "Done. 3 commits on main."
```

**Advanced — split into branches:**
```
User: "Split the auth refactor into its own branch. Commit the rest here."
Agent: [creates branch `auth-middleware-refactor`, commits group 1,
        switches back, commits groups 2 and 3 on current branch]
Agent: "Done. Created `auth-middleware-refactor` with 1 commit (+82 -45).
The dashboard fix and README update are committed on `main`."
```

**Iterative — adjust groupings:**
```
User: "Actually, move types.ts into the dashboard group — those type
changes are for the loading state, not the auth work."
Agent: [updates ChangeGroupCard state, re-renders card with new groupings]
Agent: "Updated. Group 1 (auth refactor) is now 2 files, Group 2
(dashboard fix) is now 3 files. Here's the updated breakdown."
```

### Risk and Limitations

- **Selective staging reliability:** `git add -p` via automated scripting is fragile. File-level staging (`git add <path>`) is much safer. V1 should group at file granularity, not hunk granularity. Hunk-level splitting is a future refinement.
- **LLM clustering accuracy:** The agent may misjudge which changes belong together, especially in large diffs. The "adjust via chat" step is essential — this can't be fully autonomous.
- **Merge conflicts on branch creation:** If changes span the same files across groups, splitting into branches will conflict. The agent needs to detect this and warn before attempting.
- **Context window pressure:** Large diffs may push against the Coder's 60KB context cap. May need to summarize file-level changes first, then drill into specific files. (Same guardrail pattern as `github_pr_diff`'s summary-first approach.)
- **Trust risk:** One botched commit that stages the wrong files will kill confidence in the feature. Per-group Auditor gate and explicit confirmation before each commit are non-negotiable safety layers, not optional niceties.

### Why Defer

- Layers 1-3 establish the PR/branch vocabulary and tooling foundation
- The Coder needs to prove reliable at multi-step git operations before attempting selective staging
- Diff clustering prompt needs dedicated engineering and testing
- The interaction pattern (propose → adjust → commit) needs UX validation — does it feel natural in chat, or does it need a richer card interaction?

### Promotion Criteria

Promote to active development when: (a) the Coder reliably executes multi-step git operations in the sandbox, (b) Layers 1-2 are shipped and stable, (c) diff analysis prompts can cluster changes with >80% accuracy on real-world working trees, and (d) at least one real "I have a messy working tree" dogfooding session confirms the interaction pattern works.

---

## Implementation Sequence

### Phase 1 — PR Tools + Cards (Core Value)

1. Define `github_list_prs` and `github_get_pr` tool schemas in `github-tools.ts`
2. Add detection/execution to `tool-dispatch.ts`
3. Build `PRListCard` and `PRDetailCard` components
4. Add card data types to `types/index.ts`
5. Update Orchestrator system prompt with PR tool definitions
6. Add minimal PR signal to `workspace-context.ts` (open count + PR numbers only, no titles)

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

### Phase 5 — Change Pooling (Layer 4, When Earned)

1. Build diff clustering prompt — test against real working trees from dogfooding
2. Build `ChangeGroupCard` as stateful component (source of truth for groupings, re-renders on every adjustment)
3. Implement file-level selective staging via Coder (`git add <paths>`, commit, repeat)
4. Wire per-group Auditor gate (each group's diff reviewed before its commit)
5. Add branch-per-group flow (create branch, commit group, switch back)
6. Add conflict detection (warn if file appears in multiple groups and branching is requested)
7. Hunk-level splitting as future refinement after file-level proves reliable

**Validates:** Can the agent reliably analyze, group, and commit changes through conversation? Does the stateful card interaction feel natural on mobile? Does per-group audit add unacceptable friction?

---

## Open Questions

1. **Diff rendering:** Show raw diff in a card (like `DiffPreviewCard`), or have the agent summarize and only show the card on request? Summarize-first matches "show, don't dump" but loses detail.
2. **PR comment threading:** `github_get_pr` can return review comments. Display inline in chat, or as an expandable section in `PRDetailCard`? Threading in a linear chat is awkward.
3. **Stale data:** Home screen PR counts and chat-injected PR context are point-in-time snapshots. Pull-to-refresh is acceptable for v1 (mobile users expect this pattern). Revisit if stale data causes real confusion in practice.
4. **Rate limits:** Adding PR fetches to home screen load and workspace context increases GitHub API calls. Lazy-loading mitigates this, but monitor against rate limits, especially for PAT users with lower quotas.
5. **Change grouping granularity:** File-level grouping is safe and simple. Hunk-level grouping (splitting a single file's changes across commits) is more powerful but requires `git add -p` automation, which is fragile. Where's the line for v1?
6. **ChangeGroupCard state persistence:** The card is the source of truth for groupings (decided). But how does it persist across message re-renders? Does the card's state live in the message data, in a React ref, or in a separate store? This is an implementation question that needs prototyping.
7. **Branch naming:** When the agent creates branches per group, should it propose names and let the user confirm, or auto-name with a convention (e.g., `push/auth-refactor`)? Auto-naming is faster; confirmation is safer.
8. **Auditor scaling:** Per-group audit is the v1 recommendation. If change pooling commonly produces 4-5 groups, does 4-5 sequential audit calls create unacceptable latency? Could parallel audit calls help, or does that break the sequential commit model?

---

## Decisions Made (From Review)

These decisions were made after external review of the initial draft:

| Decision | Rationale | Source |
|----------|-----------|--------|
| Workspace context: count + PR numbers only, no titles | Prevents agent from proactively mentioning PRs user didn't ask about | ChatGPT review |
| ChangeGroupCard is stateful source of truth, not just display | Agent context will drift after 2-3 adjustments; card must hold and re-render state | Gemini review |
| `github_pr_diff` returns summary by default, raw diff per-file on request | Large diffs blow 60KB context cap; summary-first with drill-down | Gemini review |
| Action chips reflect state, never recommend action | "You have open PRs" is a shortcut; "You should review your PRs" is a nudge | ChatGPT review |
| Per-group Auditor gate for change pooling commits | Consistent with "every commit gets a verdict"; batch audit requires new prompt design | Team discussion |
| No silent commits in change pooling — explicit confirmation before each | Aligns with "Auditor earns trust" philosophy; multi-commit flow is new trust surface | ChatGPT review |
| Layer 3 deferred: branch/sandbox dissonance has no clean solution yet | Switching lens without switching sandbox creates read/run context mismatch | Gemini review |
| Lazy-load PR data for recent repos only, not full list | Rate limit and latency mitigation; render repo cards fast, enrich async | Gemini review |

---

## Promotion Criteria (Draft → Roadmap)

Per `ROADMAP.md` checklist:

- ✅ Problem statement is clear
- ✅ V1 scope is bounded (read-only, Phase 1-2)
- ✅ Success criteria are testable (agent can discuss PRs; repo cards show PR count)
- ✅ Ownership is clear (solo dev, phased)
- ✅ Non-goals are explicit

Layer 4 (change pooling) has its own promotion criteria within its section. It does not need to be promoted to ROADMAP.md until Layers 1-2 are shipped and the Coder proves reliable at multi-step git operations.
