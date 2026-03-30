# Agent Tool Patterns — Claude Code Cross-Reference

Date: 2026-02-27
Author: Claude (via Claude Code)
Status: Reference document
Reviewed against current Push code: 2026-03-30

---

## What this is

A cross-reference between Push's agent harness patterns and Claude Code's architecture. Push and Claude Code solve the same fundamental problem — making an LLM effective at software engineering — but from different angles: Push is mobile-first, multi-provider, sandbox-based; Claude Code is CLI-native, single-provider, local-filesystem. The convergences and divergences are instructive.

## Current Snapshot

- `ask_user` is now implemented in both the web app and CLI, with structured options, optional multi-select, and automatic "Other..." free-text handling.
- Typed delegation is broader than this document originally described: Push now has `delegate_coder`, `delegate_explorer`, planner pre-pass support, and auditor evaluation in the delegation loop.
- User-visible progress is partially implemented through agent status, console/run events, and UI scaffolding for coder-progress cards, but not yet as a first-class shared todo/task artifact.
- Conditional working-memory injection is now partially implemented. The web Coder only reinjects `[CODER_STATE]` on tool-result paths when it is syncing state for the first time, when state changed, when context pressure is elevated, or on a long-task cadence; the CLI still uses a simpler always-attach metadata model.

---

## 1. Structured Elicitation

### Push's pattern

Push now has a dedicated user-facing `ask_user` tool in the app and CLI. In the web app it renders as an `AskUserCard` with structured options, optional multi-select, and an automatic "Other..." free-text path. The Coder still uses `coder_checkpoint(question, context?)` for agent-to-agent clarification (Coder → Orchestrator), capped at 3 per task.

### Claude Code's pattern

Claude Code has exactly what Push is considering: `AskUserQuestion`. It's a dedicated tool, separate from all other tools.

**Key design decisions:**
- **Structured options**: 2-4 options per question, with labels and descriptions. Users click instead of typing.
- **Multi-select support**: `multiSelect: true` for non-mutually-exclusive choices.
- **Automatic "Other"**: Every question gets a free-text escape hatch — the model never has to anticipate all options.
- **Batching**: Up to 4 questions per invocation, reducing round-trips.
- **Preview support**: Options can include markdown previews (ASCII mockups, code snippets) for visual comparison.
- **Blocks the loop**: The agent stops until the user responds. No speculative execution.

**What works:** Structured questions dramatically reduce friction for common decisions — "Which auth method?", "Which file should I modify?", "Snake case or camelCase?". Users tap instead of composing prose.

**What's tricky:** The model needs to learn *when* to ask vs. when to just act. Over-asking is worse than under-asking. Claude Code's guidance is: ask when there's genuine ambiguity that affects the approach, not when you could reasonably infer the answer. Plan mode has a separate approval mechanism (`ExitPlanMode`) specifically so the model doesn't use `AskUserQuestion` to ask "is this plan okay?" — that conflation was a real problem.

**Relevance to Push:** This is now mostly implemented. The key remaining Claude-style gaps are batching multiple questions in one invocation and richer preview payloads for visual choices. The separation of plan-approval from clarification questions still matters, and Push's approval-mode guidance already leans that way.

---

## 2. Working Memory: Constraint vs. Scaffold

### Push's pattern

`CoderWorkingMemory` now includes the original plan/task fields plus invalidation-aware observations. It is updated via `coder_update_state`, preserved across context trimming, and injected back as `[CODER_STATE]` / diff-style state blocks on tool-result paths whenever the Coder has non-empty state.

### Claude Code's pattern

Claude Code uses `TodoWrite` — a structured task list with `content`, `activeForm`, and `status` (pending/in_progress/completed). It's user-visible (rendered in the UI), not just an internal state block.

**Key differences:**
- **Audience**: Push's working memory is still mostly agent-internal. Users can now see agent status, console events, and there is UI scaffolding for `coder-progress`, but Push still lacks a first-class shared todo artifact on the main Coder path. Claude Code's todo list is explicitly user-visible.
- **Granularity**: Push tracks plans, assumptions, errors, phases. Claude Code tracks a flat task list. Push's is richer but heavier. Claude Code's is simpler but more legible to users.
- **Injection**: Push now reinjects state on tool-result paths conditionally instead of unconditionally once working memory is active. Claude Code's todo state is tracked by the system but not injected into every message — the model maintains awareness through the conversation flow.

**On the "does it become limiting?" question:** This is real. The tension isn't binary — it depends on the task shape:

- **Long, multi-file refactors**: Working memory / todo lists *help*. Even strong models lose coherence across 50+ tool calls without external state.
- **Short, focused fixes**: They add overhead. A 3-step bug fix doesn't need a plan/task structure. Claude Code's guidance is explicit: "Do NOT use this tool if there is only one trivial task."
- **The format trap**: If the working memory schema has fields like `currentPhase`, the model will invent phases to fill them. Push mitigates this with optional fields, but the pull is real.

**The bar:** Working memory helps when the task exceeds the model's reliable coherence window (roughly 15-20 tool calls for current models). Below that threshold, it's overhead. The right move isn't removing it — it's making it opt-in or auto-triggered by task complexity.

---

## 3. Progressive Disclosure vs. Front-Loading

### Push's pattern

Two-phase project instructions (GitHub API fetch → sandbox filesystem upgrade) are still the base pattern, but Push now layers them through a sectioned `SystemPromptBuilder`, a machine-readable session capability block, and conditional injection of GitHub, sandbox, scratchpad, web-search, and `ask_user` protocols. Push also has a dedicated Explorer agent, so some codebase discovery is already on-demand instead of being front-loaded into the Orchestrator.

### Claude Code's pattern

Claude Code is aggressive about progressive disclosure:

- **System prompt**: Core behavior, tool descriptions, conventions. No codebase-specific knowledge front-loaded.
- **CLAUDE.md**: Loaded from the project directory, but it's the *user's* choice what goes in it. The model doesn't get a dump of the entire codebase structure.
- **Explore agent**: A specialized subagent for codebase exploration. Instead of front-loading "here's what every file does," Claude Code spawns an explorer that searches, reads, and synthesizes on demand.
- **WebFetch / WebSearch**: External knowledge is fetched when needed, not pre-cached in the prompt.
- **`claude-code-guide` agent**: Self-knowledge (slash commands, MCP setup, settings) lives in a specialized subagent, not the system prompt. The model only queries it when users ask about Claude Code itself.

**The convergence:** Both systems learned the same lesson — tool protocols should be conditionally injected based on what's active. Push does `if (sandbox) → inject sandbox tools`. Claude Code's tool set is fixed but guidance on *when* to use each tool is contextual.

**The divergence:** Push front-loads project instructions because its agents need context from message one (mobile UX — users expect instant responses). Claude Code can afford a "read the codebase as needed" approach because CLI users expect a brief exploration phase. The right strategy depends on latency tolerance.

**Relevance to Push:** Push has already adopted a meaningful chunk of this through sectioned prompts and `delegate_explorer`, but it still front-loads full tool protocols rather than making detailed tool docs discoverable on demand. A `claude-code-guide`-style self-knowledge agent still looks optional rather than urgent.

---

## 4. Tool Count Discipline

### Push's tool inventory

The centralized tool registry now has 44 canonical tools (18 GitHub, 19 sandbox, 2 delegate, 3 scratchpad, 1 web search, 1 ask-user), but the live tool surface is still heavily filtered by workspace mode, agent role, and read-only policy. Explorer delegation, for example, gets a much smaller read-only allowlist than the Orchestrator.

The `detectAllToolCalls()` / read-mutate split adds structural discipline: max 6 parallel reads, 1 trailing mutation per turn.

### Claude Code's tool inventory

~11 tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, Task (subagents), TodoWrite, AskUserQuestion, NotebookEdit, Skill.

**Key discipline:**
- **Subagents absorb complexity**: Instead of adding specialized tools (explore-codebase, run-tests, validate-build), Claude Code delegates to typed subagents via `Task`. The Explore agent has access to Read, Glob, Grep. The general-purpose agent has access to everything. This keeps the top-level tool count low while enabling specialization.
- **Edit over Write**: The Edit tool does surgical string replacement. Write does full-file overwrites. The guidance is explicit: prefer Edit for modifications, Write only for new files. This is analogous to Push's `sandbox_edit_file` (hashline ops) vs. `sandbox_write_file`.
- **Bash as escape hatch**: Anything that doesn't have a dedicated tool falls to Bash, but with strong guidance to prefer dedicated tools. This prevents tool proliferation — you don't need `run_tests`, `install_deps`, `check_types` as separate tools when `Bash("npm test")` works.

**The tradeoff Push faces:** the registry is now even broader than when this note was written, but filtering and typed delegation have improved too. The question is no longer "does Push have subagents?" — it does. The question is whether the Orchestrator still sees too many direct tools compared with what could be delegated to narrower read-only sub-loops.

**A concrete suggestion:** Push's read-only GitHub tools (`fetch_pr`, `list_prs`, `list_commits`, `list_branches`, `list_commit_files`, `fetch_checks`, `get_workflow_runs`, `get_workflow_logs`) could potentially collapse into a smaller set with richer query parameters. `github_query(resource, filters)` instead of 8 separate tools. The model already knows what it wants — the tool boundaries are more about API design than capability boundaries. Worth testing whether mid-tier models handle parameterized queries as well as named tools.

---

## 5. "See Like an Agent" — Design Implications

This framing maps cleanly to specific decisions in both systems:

| Capability gap | Push's tool | Claude Code's tool | Notes |
|---|---|---|---|
| Can't see files | `sandbox_read_file` (with line ranges) | `Read` (with offset/limit) | Both learned: line ranges > whole files |
| Can't search | `sandbox_search` + `search_files` | `Grep` + `Glob` + Explore agent | Push has two (sandbox + GitHub); CC unifies |
| Can't edit reliably | `sandbox_edit_file` (hashline ops) | `Edit` (string replacement) | Different bet: content-hash vs. exact-match |
| Can't track progress | `CoderWorkingMemory` + agent status/console | `TodoWrite` | Push now exposes runtime progress signals, but not a shared todo artifact |
| Can't ask questions | `ask_user` + `coder_checkpoint` | `AskUserQuestion` | Push now covers both agent→user and agent→agent questions |
| Can't delegate | `delegate_coder` + `delegate_explorer` | `Task` (typed subagents) | Push also has planner/auditor sub-loops inside delegation, but the Orchestrator still keeps a wider direct tool surface |
| Can't verify work | `acceptanceCriteria[]` | Bash (run tests) | Push: structured. CC: ad-hoc |

**The hashline vs. string-replacement bet is worth noting.** Push's hashline edits use content hashes (default 7-char, extendable to 12-char for disambiguation) to anchor edits, eliminating line-number drift. Claude Code's Edit uses exact string matching — the edit fails if the old string isn't unique or doesn't match. Both solve the same problem (reliable edits despite stale context) but with different failure modes:
- Hashline: fails on hash collision (rare, and recoverable via longer 12-char prefix) or stale content (detectable). Requires the model to compute hashes.
- String replacement: fails on non-unique matches (common in repetitive code) or whitespace mismatches. Requires the model to reproduce exact content.

Neither is strictly better. Hashline is more robust for large files with repetitive patterns. String replacement is simpler for small, unique edits. If Push ever supports stronger models that can reliably reproduce exact content, string replacement might be worth offering as an alternative for simple cases.

---

## 6. What Push Could Borrow

1. ~~**Dedicated `ask_user` tool** with structured options + automatic "Other".~~ ✅ **Mostly done** — the app and CLI both support structured user questions, optional multi-select, and automatic "Other..." handling. The remaining Claude-style gaps are batching and richer preview payloads.

2. **Subagent delegation for tool count reduction**. ✅ **Partly done** — Push now has `delegate_explorer` plus planner/auditor delegation stages, so typed sub-loops are real. The still-open part is whether more of the Orchestrator's direct read-only GitHub surface should collapse behind narrower delegated readers.

3. **User-visible progress tracking**. ✅ **Partly done** — users can already see agent status, console/run events, and Push has `coder-progress` card scaffolding. The missing piece is a first-class shared task/progress artifact emitted consistently by the Coder loop.

4. **Conditional working memory**. ✅ **Partly done** — the web Coder now gates reinjection on first sync, actual state changes, elevated context pressure, or a periodic long-task cadence. The remaining asymmetry is the CLI, which still carries working memory in every tool-result metadata payload.

## 7. What Claude Code Could Borrow

1. **Acceptance criteria**. Push's `acceptanceCriteria[]` — shell commands that verify the task succeeded — is a pattern Claude Code lacks as structured tooling. Claude Code relies on the model deciding to run tests; Push makes verification explicit and machine-checkable. This is especially valuable for delegation.

2. **Read/mutate split enforcement**. Push's `detectAllToolCalls()` structurally prevents interleaving reads and writes in a single turn. Claude Code allows it (a single response can contain Edit + Read + Bash calls in any order). The structural guarantee simplifies reasoning about side effects.

3. **Error taxonomy**. Push's `ToolErrorType` enum with `retryable` boolean is more structured than Claude Code's tool error handling, which relies on the model interpreting error messages. A structured error taxonomy would help Claude Code make better retry decisions.

4. **Hashline edits for repetitive code**. Claude Code's string-replacement Edit fails on non-unique matches. A content-hash anchoring option would handle repetitive patterns more gracefully.

---

## Summary

The biggest pattern both systems are converging on: **tools should degrade gracefully as models improve**. Push has now already adopted more of the Claude Code playbook than this February snapshot suggested — `ask_user`, typed exploration delegation, richer runtime visibility, sectioned prompts, and now adaptive web-side working-memory reinjection are all real. The remaining Claude-inspired follow-ups are narrower: a shared user-visible task artifact and eventually bringing the CLI working-memory path to the same standard.

The second pattern: **progressive disclosure beats front-loading, but only if the model can self-serve reliably**. Claude Code's subagent architecture makes this work — the model delegates exploration to specialized agents. Push could achieve similar results by making tool protocols discoverable rather than always-injected.

The third pattern: **structured interaction beats prose, but only for decisions with bounded option spaces**. `AskUserQuestion` with 2-4 options works for "which approach?" questions. It doesn't work for "describe your requirements" — that's still prose. The key is knowing which is which.
