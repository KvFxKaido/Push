# UX Nice-to-Haves Plan

## Status
- Last updated: 2026-02-22
- State: Research / wishlist — nothing started (not current roadmap focus; terminal UX is)
- Intent: Quality-of-life features inspired by Claude Code's workflow, adapted for Push's mobile-first context

## Origin

Conversation about whether to add Google native search grounding led to a broader question: what CLI-agent UX patterns (specifically from Claude Code) translate well to Push? These five items came out of that discussion, ranked roughly by value-to-effort ratio.

## Items

### 1. User-Triggered Context Compaction

**What:** Let the user explicitly compress/summarize the conversation when context is getting heavy, rather than relying solely on automatic rolling window trimming.

**Why:** On mobile, conversations feel longer faster. The user can see the ContextMeter climbing but has no way to say "I'm done with that tangent, compress it." Claude Code's `/compact` command solves this.

**What exists today:**
- `ContextMeter.tsx` — shows token budget usage (bar + label)
- `orchestrator.ts` — automatic rolling window: summarizes tool-heavy messages first, then trims oldest pairs
- Summarization logic exists for the automatic path

**Gap:** No user-initiated trigger. The automatic trimming is invisible and reactive — by the time it kicks in, the context is already at the limit.

**Possible shape:**
- Button near the ContextMeter (or in the Workspace Hub)
- Chat command the Orchestrator recognizes (e.g., "compact" or a `/compact` prefix)
- Summarize all messages older than the last N turns, replace with a single summary message
- Show the user what got compressed ("Compacted 34 messages into summary")

**Effort:** Low. Summarization infra exists — this is mostly a trigger + UI affordance.

**Risk / rollout notes:** Summary quality or over-compaction could hide context the user still cares about. MVP should preserve the last N turns and show a clear "compacted X messages" notice (ideally with an undo path).

---

### 2. Cross-Session Project Memory

**What:** Agent remembers patterns, decisions, and repo-specific context across conversations. Returning to a repo feels continuous rather than starting from zero.

**Why:** Claude Code's auto-memory is one of its strongest workflow features. Push has Scratchpad, but it's manual and chat-scoped. The agent can't say "last time we worked on this repo, you were refactoring the auth module" because it doesn't know.

**What exists today:**
- `useScratchpad.ts` / `scratchpad-tools.ts` — shared notepad, agent can read/write, persists in localStorage, injected into system prompt. But scoped to current chat, not to repo.
- `AGENTS.md` / `CLAUDE.md` — project instructions from the repo. Static, not agent-writable.
- `CoderWorkingMemory` — Coder's internal state (plan, tasks, files). Per-delegation, not cross-session.

**Gap:** No repo-scoped, agent-writable, cross-session memory. The agent starts every new chat on a repo with zero learned context.

**Possible shape:**
- New localStorage key scoped by repo (`push_memory_${owner}/${repo}`)
- Agent tools: `read_project_memory`, `update_project_memory` (append/replace sections)
- Content injected into system prompt alongside project instructions
- Size cap (e.g., 2KB) to prevent prompt bloat
- Organized by topic/section, not chronological — agent maintains it like notes, not a log

**Design questions:**
- How does the agent decide what to remember vs. what's transient?
- How does stale memory get cleaned up? (Claude Code struggles with this too)
- Should the user be able to see/edit it? (Probably yes — Scratchpad-style tab)
- Should it be per-branch or per-repo? (Repo — branches are ephemeral)

**Effort:** Medium-high. Scratchpad is ~80% of the plumbing, but stale-memory cleanup, prompt-budget control, and user visibility/editing push this beyond a simple plumbing task.

**Risk / rollout notes:** Stale or incorrect memory can be worse than no memory. Ship with explicit user visibility/editing and a small size cap before attempting aggressive auto-memory behavior.

---

### 3. Per-Session Cost Ticker

**What:** Show estimated session cost inline near the ContextMeter, not buried in Settings.

**Why:** Claude Code shows token/cost info as you work. Push already tracks everything needed (`useUsageTracking.ts` has per-request tokens, cost estimates, `formatCost()`), but it's only visible in Settings. Users on OpenRouter with Opus ($15/M input) vs. free Qwen3 have very different cost profiles and deserve real-time visibility.

**What exists today:**
- `useUsageTracking.ts` — full tracking: per-request entries, today/week/allTime stats, `estimateCost()`, `formatCost()`
- `ContextMeter.tsx` — token budget visualization in chat header
- Cost display in Settings only

**Gap:** No per-session or real-time cost indicator in the chat UI.

**Possible shape:**
- Tiny "$0.03" label near the ContextMeter, or tappable to expand
- Per-session tracking (reset on new chat) alongside existing per-day stats
- Provider-specific cost rates instead of the current flat estimate ($0.15/$0.60 per 1M) — actual rates vary wildly by model

**Caveats:**
- Current cost estimates use flat rates (`COST_PER_1M_INPUT = 0.15`). Real accuracy needs per-model pricing, which is a maintenance burden.
- "Estimated" should be visible — don't present guesses as invoices

**Effort:** Low for display-only MVP. Medium for a true per-session ticker and/or per-model pricing. Wiring `costs.today` into the chat header is a stopgap, not a real per-session implementation.

**Risk / rollout notes:** Cost estimates can erode trust if they look precise but are not. Label clearly as estimated and avoid invoice-like formatting until per-model pricing is maintained.

---

### 4. Quick Actions on Code Blocks

**What:** Tap or long-press actions on code blocks in chat messages: **Copy**, **Apply to sandbox file**, **Run in sandbox**. On file paths: **Read file**, **Open in editor**.

**Why:** Claude Code implicitly applies diffs. On mobile, the chat-to-action gap is wider — the user sees a code block but can't easily do anything with it except read it. Quick actions turn passive output into actionable surfaces.

**What exists today:**
- `MessageBubble` renders code blocks with syntax highlighting
- Sandbox tools exist for reading/writing/executing
- File browser exists for direct file interaction
- No interactive affordances on inline code blocks

**Gap:** Code blocks in messages are display-only. No way to act on them without typing a follow-up message.

**Possible shape:**
- Tap on code block → floating action bar (Copy / Apply / Run)
- "Apply" needs: detect target file (from context or preceding message), write via sandbox
- "Run" needs: detect language, execute via `sandbox_exec`
- File path detection in messages → tappable links that open in file browser or trigger `sandbox_read_file`

**Design questions:**
- How to detect the target file for "Apply"? (Filename in code fence, preceding message context, or user picks)
- "Run" only makes sense for shell commands and scripts — need language/context detection
- How to handle conflicts with text selection on mobile?

**Effort:** Medium-high. Context menu UI is straightforward, but target-file resolution ("Apply"), execution safety ("Run"), and mobile gesture conflicts add complexity.

**Risk / rollout notes:** Easy to ship a flashy surface that produces wrong-file writes or unsafe runs. Split MVP by action (`Copy` first, then file-path actions, then `Apply`/`Run` with explicit confirmation).

---

### 5. Message Bookmarks

**What:** Long-press a message to bookmark it. Bookmarked messages show as jump-to anchors (floating chips or a mini-nav) at the top of the chat.

**Why:** In long mobile conversations, the important messages — the plan, the key diff, the commit — get buried under 50+ follow-ups. Scrolling to find them is painful. This gives users a way to mark "these are the messages that matter" and jump back.

**What exists today:**
- Messages have unique IDs
- Chat history is stored in localStorage
- No message-level metadata (starred, pinned, etc.)

**Gap:** No way to mark or navigate to specific messages in a long conversation.

**Possible shape:**
- Long-press → "Bookmark" action
- Bookmarks stored as array of message IDs in the chat object
- Floating bookmark chips at top of chat (scrollable horizontal strip)
- Tap chip → scroll to message
- Auto-bookmark candidates: commit messages, audit verdicts, delegation summaries

**Effort:** Low-medium. State is simple (array of IDs). UI is a horizontal chip strip + scroll-to behavior.

**Risk / rollout notes:** Can become visual clutter on small screens if overused. Limit visible chips and make bookmark UI collapsible.

---

## Priority Recommendation

| Item | Value | Effort | Ship order |
|------|-------|--------|------------|
| Context compaction | High | Low | 1 |
| Message bookmarks | Medium | Low-medium | 2 |
| Cost ticker | Medium | Low | 3 |
| Cross-session memory | High | Medium-high | 4 |
| Code block actions | High | Medium-high | 5 |

Items 1-3 are the best near-term wins and can ship incrementally. Cross-session memory is the most transformative but needs stronger design constraints (staleness + visibility). Code block actions are high-value, but likely easiest to overscope.

## Decisions Not Yet Made

- Whether compaction should be a button, a chat command, or both
- Whether cross-session memory should be visible/editable by the user
- Whether cost estimates should use per-model pricing (maintenance burden) or stay with flat rates
- Whether code block actions warrant a full context menu or simpler inline buttons
- Whether any of these should preempt the current canonical roadmap focus on CLI/TUI terminal UX improvements
