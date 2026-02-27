# Agent Tool Patterns — Claude Code Cross-Reference

Date: 2026-02-27
Author: Claude (via Claude Code)
Status: Reference document

---

## What this is

A cross-reference between Push's agent harness patterns and Claude Code's architecture. Push and Claude Code solve the same fundamental problem — making an LLM effective at software engineering — but from different angles: Push is mobile-first, multi-provider, sandbox-based; Claude Code is CLI-native, single-provider, local-filesystem. The convergences and divergences are instructive.

---

## 1. Structured Elicitation

### Push's pattern

Push doesn't have a dedicated user-facing elicitation tool yet. The Coder uses `coder_checkpoint(question, context?)` for agent-to-agent clarification (Coder → Orchestrator), capped at 3 per task. User-facing questions are prose in chat.

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

**Relevance to Push:** The separation of plan-approval from clarification-questions is the key insight. Push's `coder_checkpoint` solves agent-to-agent elicitation; a user-facing `ask_user` tool would complement it without overlap. The "automatic Other" pattern is worth stealing — it prevents the model from boxing users into its own assumptions.

---

## 2. Working Memory: Constraint vs. Scaffold

### Push's pattern

`CoderWorkingMemory` — `plan`, `openTasks`, `filesTouched`, `assumptions`, `errorsEncountered`, `currentPhase`, `completedPhases`. Updated via `coder_update_state` tool call, injected as `[CODER_STATE]` block on every tool result. Survives context trimming. Max ~2KB.

### Claude Code's pattern

Claude Code uses `TodoWrite` — a structured task list with `content`, `activeForm`, and `status` (pending/in_progress/completed). It's user-visible (rendered in the UI), not just an internal state block.

**Key differences:**
- **Audience**: Push's working memory is agent-internal (not shown to users). Claude Code's todo list is shared — the user sees progress in real time. This changes the incentive structure: the model uses it partly to communicate, not just to remember.
- **Granularity**: Push tracks plans, assumptions, errors, phases. Claude Code tracks a flat task list. Push's is richer but heavier. Claude Code's is simpler but more legible to users.
- **Injection**: Push injects on every tool result (compaction-safe). Claude Code's todo state is tracked by the system but not injected into every message — the model maintains awareness through the conversation flow.

**On the "does it become limiting?" question:** This is real. The tension isn't binary — it depends on the task shape:

- **Long, multi-file refactors**: Working memory / todo lists *help*. Even strong models lose coherence across 50+ tool calls without external state.
- **Short, focused fixes**: They add overhead. A 3-step bug fix doesn't need a plan/task structure. Claude Code's guidance is explicit: "Do NOT use this tool if there is only one trivial task."
- **The format trap**: If the working memory schema has fields like `currentPhase`, the model will invent phases to fill them. Push mitigates this with optional fields, but the pull is real.

**The bar:** Working memory helps when the task exceeds the model's reliable coherence window (roughly 15-20 tool calls for current models). Below that threshold, it's overhead. The right move isn't removing it — it's making it opt-in or auto-triggered by task complexity.

---

## 3. Progressive Disclosure vs. Front-Loading

### Push's pattern

Two-phase project instructions (GitHub API fetch → sandbox filesystem upgrade). System prompt stacks tool protocols conditionally — sandbox tools only when sandbox is active, GitHub tools only when a repo is connected. Workspace context is always injected.

### Claude Code's pattern

Claude Code is aggressive about progressive disclosure:

- **System prompt**: Core behavior, tool descriptions, conventions. No codebase-specific knowledge front-loaded.
- **CLAUDE.md**: Loaded from the project directory, but it's the *user's* choice what goes in it. The model doesn't get a dump of the entire codebase structure.
- **Explore agent**: A specialized subagent for codebase exploration. Instead of front-loading "here's what every file does," Claude Code spawns an explorer that searches, reads, and synthesizes on demand.
- **WebFetch / WebSearch**: External knowledge is fetched when needed, not pre-cached in the prompt.
- **`claude-code-guide` agent**: Self-knowledge (slash commands, MCP setup, settings) lives in a specialized subagent, not the system prompt. The model only queries it when users ask about Claude Code itself.

**The convergence:** Both systems learned the same lesson — tool protocols should be conditionally injected based on what's active. Push does `if (sandbox) → inject sandbox tools`. Claude Code's tool set is fixed but guidance on *when* to use each tool is contextual.

**The divergence:** Push front-loads project instructions because its agents need context from message one (mobile UX — users expect instant responses). Claude Code can afford a "read the codebase as needed" approach because CLI users expect a brief exploration phase. The right strategy depends on latency tolerance.

**Relevance to Push:** The `claude-code-guide` pattern is worth considering. Push's system prompt carries the full `SANDBOX_TOOL_PROTOCOL` (~3-4KB of tool definitions). If models get better at tool use, you could shrink this to a compact reference and let the model look up detailed usage on demand. The risk: mid-tier models may not reliably self-serve from docs. The mitigation: progressive disclosure gated on model capability tier.

---

## 4. Tool Count Discipline

### Push's tool inventory

~30 tools total (19 GitHub + 11 sandbox + delegation + scratchpad + web search), but contextually filtered:
- Sandbox-only mode: ~11 sandbox tools + scratchpad + web search
- Repo mode without sandbox: ~19 GitHub tools + scratchpad + web search
- Full mode: everything

The `detectAllToolCalls()` / read-mutate split adds structural discipline: max 6 parallel reads, 1 trailing mutation per turn.

### Claude Code's tool inventory

~11 tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, Task (subagents), TodoWrite, AskUserQuestion, NotebookEdit, Skill.

**Key discipline:**
- **Subagents absorb complexity**: Instead of adding specialized tools (explore-codebase, run-tests, validate-build), Claude Code delegates to typed subagents via `Task`. The Explore agent has access to Read, Glob, Grep. The general-purpose agent has access to everything. This keeps the top-level tool count low while enabling specialization.
- **Edit over Write**: The Edit tool does surgical string replacement. Write does full-file overwrites. The guidance is explicit: prefer Edit for modifications, Write only for new files. This is analogous to Push's `sandbox_edit_file` (hashline ops) vs. `sandbox_write_file`.
- **Bash as escape hatch**: Anything that doesn't have a dedicated tool falls to Bash, but with strong guidance to prefer dedicated tools. This prevents tool proliferation — you don't need `run_tests`, `install_deps`, `check_types` as separate tools when `Bash("npm test")` works.

**The tradeoff Push faces:** 30 tools is high but contextually filtered to ~15. The question is whether filtering is enough, or whether models perform better with fewer tools and more general-purpose primitives. Claude Code's evidence: fewer tools + subagent delegation works well for strong models. But Push serves multiple providers including mid-tier models — those may need more specialized tools with narrower interfaces.

**A concrete suggestion:** Push's read-only GitHub tools (`fetch_pr`, `list_prs`, `list_commits`, `list_branches`, `list_commit_files`, `fetch_checks`, `get_workflow_runs`, `get_workflow_logs`) could potentially collapse into a smaller set with richer query parameters. `github_query(resource, filters)` instead of 8 separate tools. The model already knows what it wants — the tool boundaries are more about API design than capability boundaries. Worth testing whether mid-tier models handle parameterized queries as well as named tools.

---

## 5. "See Like an Agent" — Design Implications

This framing maps cleanly to specific decisions in both systems:

| Capability gap | Push's tool | Claude Code's tool | Notes |
|---|---|---|---|
| Can't see files | `sandbox_read_file` (with line ranges) | `Read` (with offset/limit) | Both learned: line ranges > whole files |
| Can't search | `sandbox_search` + `search_files` | `Grep` + `Glob` + Explore agent | Push has two (sandbox + GitHub); CC unifies |
| Can't edit reliably | `sandbox_edit_file` (hashline ops) | `Edit` (string replacement) | Different bet: content-hash vs. exact-match |
| Can't track progress | `CoderWorkingMemory` | `TodoWrite` | Push: agent-internal. CC: user-visible |
| Can't ask questions | `coder_checkpoint` (agent-to-agent) | `AskUserQuestion` (agent-to-user) | Different audiences |
| Can't delegate | `delegate_coder` | `Task` (typed subagents) | Push: single specialist. CC: multiple agent types |
| Can't verify work | `acceptanceCriteria[]` | Bash (run tests) | Push: structured. CC: ad-hoc |

**The hashline vs. string-replacement bet is worth noting.** Push's hashline edits use 7-char content hashes to anchor edits, eliminating line-number drift. Claude Code's Edit uses exact string matching — the edit fails if the old string isn't unique or doesn't match. Both solve the same problem (reliable edits despite stale context) but with different failure modes:
- Hashline: fails on hash collision (rare) or stale content (detectable). Requires the model to compute hashes.
- String replacement: fails on non-unique matches (common in repetitive code) or whitespace mismatches. Requires the model to reproduce exact content.

Neither is strictly better. Hashline is more robust for large files with repetitive patterns. String replacement is simpler for small, unique edits. If Push ever supports stronger models that can reliably reproduce exact content, string replacement might be worth offering as an alternative for simple cases.

---

## 6. What Push Could Borrow

1. **Dedicated `ask_user` tool** with structured options + automatic "Other". The `coder_checkpoint` pattern proves agent-initiated questions work; extending it to user-facing questions is natural.

2. **Subagent delegation for tool count reduction**. Instead of exposing all 19 GitHub tools to the Orchestrator, expose `delegate_github_reader(task_description)` that runs a sub-loop with the read-only GitHub tools. Keeps the Orchestrator's decision space smaller.

3. **User-visible progress tracking**. Push's `CoderWorkingMemory` is powerful but invisible. Making task progress visible (like Claude Code's `TodoWrite` renders in the UI) would improve the mobile UX — users could see what the Coder is doing without reading stream output.

4. **Conditional working memory**. Don't inject `[CODER_STATE]` on every tool result for short tasks. Gate it on: task has acceptance criteria, or round count > N, or context is approaching budget. Saves tokens and avoids the format-trap for simple tasks.

## 7. What Claude Code Could Borrow

1. **Acceptance criteria**. Push's `acceptanceCriteria[]` — shell commands that verify the task succeeded — is a pattern Claude Code lacks as structured tooling. Claude Code relies on the model deciding to run tests; Push makes verification explicit and machine-checkable. This is especially valuable for delegation.

2. **Read/mutate split enforcement**. Push's `detectAllToolCalls()` structurally prevents interleaving reads and writes in a single turn. Claude Code allows it (a single response can contain Edit + Read + Bash calls in any order). The structural guarantee simplifies reasoning about side effects.

3. **Error taxonomy**. Push's `ToolErrorType` enum with `retryable` boolean is more structured than Claude Code's tool error handling, which relies on the model interpreting error messages. A structured error taxonomy would help Claude Code make better retry decisions.

4. **Hashline edits for repetitive code**. Claude Code's string-replacement Edit fails on non-unique matches. A content-hash anchoring option would handle repetitive patterns more gracefully.

---

## Summary

The biggest pattern both systems are converging on: **tools should degrade gracefully as models improve**. The ideal tool is one that helps weak models and doesn't constrain strong ones. Push's working memory is a good example — helpful for mid-tier models, potentially limiting for frontier models. The solution isn't removing it but making it adaptive: inject it when the model needs it, skip it when it doesn't.

The second pattern: **progressive disclosure beats front-loading, but only if the model can self-serve reliably**. Claude Code's subagent architecture makes this work — the model delegates exploration to specialized agents. Push could achieve similar results by making tool protocols discoverable rather than always-injected.

The third pattern: **structured interaction beats prose, but only for decisions with bounded option spaces**. `AskUserQuestion` with 2-4 options works for "which approach?" questions. It doesn't work for "describe your requirements" — that's still prose. The key is knowing which is which.
