# How Codex CLI Handles Compacting

> Research compiled 2026-04-12

## Overview

Codex CLI's compacting is a two-path system that compresses conversation history when it approaches context window limits. The implementation lives in the Rust codebase (`codex-rs/core/src/compact.rs`, `compact_remote.rs`, `tasks/compact.rs`). The strategy is internally named **"Memento"** — like the film, the system writes a "note to self" to maintain continuity despite losing memory.

---

## 1. When Compacting Triggers

Compaction is triggered **purely by token count thresholds**, not message count.

### Threshold Calculation

```
auto_compact_limit = min(user_configured_limit, context_window * 90%)
```

For a model with 272K context, this is ~244K tokens. The effective context window is further scaled by 95% for safety, but the compact trigger uses the raw window size.

### Four Trigger Scenarios

| Trigger | When | What Happens |
|---------|------|--------------|
| **Pre-turn** | Before model sees a new user message | `run_pre_sampling_compact()` checks token count at start of every turn |
| **Mid-turn** | Between tool call iterations in an agentic loop | Fires when tokens exceed limit but model still has pending tool calls |
| **Model-switch** | User switches to a model with smaller context | Compacts using the *previous* model if current usage exceeds new limit |
| **Manual** | User types `/compact` | Immediate compaction on demand |

The key UX insight: **pre-turn compaction runs before the model sees the new message**, and **mid-turn compaction runs between tool call iterations** — never mid-thought. This is why it doesn't feel disorienting.

---

## 2. Two Compaction Paths

Codex chooses between local and remote compaction at runtime:

```rust
if provider.is_openai() {
    run_remote_compact_task(...)   // Server-side
} else {
    run_compact_task(...)          // Client-side LLM summary
}
```

### Path A: Remote Compaction (OpenAI models)

- Calls `POST /v1/responses/compact` — a dedicated server-side endpoint
- The server uses a **separate LLM** to produce a summary
- Summary is returned as an **AES-encrypted opaque blob** (`type=compaction` item)
- On the next turn, the server decrypts and prepends a handoff prompt
- Compression ratio is extreme: ~100K tokens -> ~700 tokens
- Not human-readable, not portable across providers, not debuggable

This is why it feels so fast — no extra client-side model call needed.

### Path B: Local Compaction (non-OpenAI providers)

Uses the model itself to generate a summary. The compaction prompt (`templates/compact/prompt.md`):

> You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.
>
> Include:
> - Current progress and key decisions made
> - Important context, constraints, or user preferences
> - What remains to be done (clear next steps)
> - Any critical data, examples, or references needed to continue
>
> Be concise, structured, and focused on helping the next LLM seamlessly continue the work.

The model's summary is then wrapped with a prefix (`templates/compact/summary_prefix.md`):

> Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work.

---

## 3. What Survives vs. What Gets Dropped

### Preserved

| Item | Details |
|------|---------|
| **System/developer instructions** | Old messages are dropped, but equivalent instructions are rebuilt fresh from current session state — so nothing structural is lost |
| **Recent user messages** | Up to 20,000 tokens, most-recent-first; oversized messages truncated |
| **Model-generated summary** | Injected as a user message with the handoff prefix |
| **Ghost snapshots** | Lightweight state receipts for `/undo` functionality |

### Dropped

| Item | Details |
|------|---------|
| **All assistant messages** | Completely removed |
| **All tool calls and outputs** | Shell commands, file reads, their results — all gone |
| **All reasoning items** | Internal chain-of-thought stripped |
| **Developer/system messages** | Original messages discarded (reconstructed from current session state in the Preserved section above) |
| **Previous compaction summaries** | Filtered out to prevent nested summary accumulation |
| **Images** | InputImage items are ignored |

### The Information Loss Problem

From a real session analysis (GitHub issue #14589):
- Tool results: **79.3% of content** — 0% survives compaction
- After first compaction: only **13.7%** of original content remains
- After second compaction: only **6.9%** remains
- Critical facts like file paths, exact patches, and regression tests are lost

This creates a **cascading re-read loop**: compaction drops tool outputs -> agent re-reads files -> fills context again -> triggers another compaction.

---

## 4. Why It Feels Seamless (UX Design Decisions)

### a) Handoff framing, not memory loss
The summary prefix tells the model it's receiving work from "another language model" and should "build on the work already done." This frames compaction as a clean relay race handoff rather than amnesia.

### b) User messages survive
Up to 20K tokens of what the user actually typed is preserved verbatim. The model retains awareness of what was asked for.

### c) System context rebuilt fresh
Environment info (cwd, date, timezone), AGENTS.md content, and developer instructions are re-injected from current session state — not carried from the old history. Nothing structural is lost.

### d) Natural boundary timing
Pre-turn compaction runs *before* the model sees the new message. Mid-turn compaction runs *between* tool call iterations. The model never has context yanked mid-thought.

### e) Session reset after compaction
The client calls `reset_websocket_session()` and `advance_window_generation()` so the provider doesn't try to use stale cached KV state from before compaction.

### f) Minimal UI disruption
The TUI shows a simple "Context compacted" info line. The summary text is not shown to the user. No disruptive modals or warnings.

### g) Graceful degradation
If the compaction prompt itself exceeds the context window, the system progressively trims the oldest history items one by one and retries.

---

## 5. Known Problems

| Issue | Description |
|-------|-------------|
| **Compaction loops** | Agent re-reads files post-compaction, fills context, triggers re-compaction (issues #14120, #8481) |
| **Context amnesia** | Model forgets completed tasks after compaction (issues #5957, #8602) |
| **Progressive degradation** | After 2-3 compactions, all reasoning from earlier rounds disappears |
| **Tool output blindness** | 79% of useful content (tool results) is structurally filtered out before summarization |
| **Hangs** | Compaction stalls indefinitely at low context percentages (issues #14342, #14425) |

A community-proposed mitigation (issue #14347) suggests adding a **cumulative history instruction** to the compaction prompt:

> If this conversation already contains a compacted summary from a previous compaction, extract its key historical thread (what was done, key decisions and WHY, outcomes, direction) and include it as a cumulative Historical Context section at the top of your new summary.

This was shown to sustain 5+ sequential compactions with preserved decision coherence at ~50 extra prompt tokens.

---

## 6. Comparison: Codex CLI vs. Claude Code

| Aspect | Codex CLI | Claude Code |
|--------|-----------|-------------|
| **Trigger** | 90% of context window | ~95% of 200K window (~190K) |
| **Mechanism** | Server-side encrypted blob (OpenAI) or client-side LLM summary | Model-generated human-readable summary |
| **Speed** | Very fast (server-side, no extra model call) | Slower (requires model call for summarization) |
| **Transparency** | Opaque encrypted blob, not inspectable | Human-readable, inspectable |
| **Portability** | Encrypted blob only works with OpenAI API | Provider-agnostic |
| **User messages preserved** | Up to 20K tokens | Yes (varies) |
| **Tool outputs** | Completely dropped | Dropped but summarized |
| **Customizable** | Custom prompt file, threshold config | Via CLAUDE.md instructions |

---

## 7. Takeaways for Push

Key design principles worth considering:

1. **Timing matters more than technique** — compacting at natural turn boundaries (pre-turn or between tool calls) prevents disorientation far more than any summarization quality improvement.

2. **The handoff framing is clever** — telling the model "another LLM started this, here's their summary" avoids the uncanny valley of partial memory. It's a clean mental model.

3. **Rebuilding system context fresh** rather than carrying it through compaction avoids drift and stale instructions.

4. **Preserving user messages verbatim** (up to a budget) is critical — the model needs to know what was actually asked, not just a summary of it.

5. **Server-side compaction is the speed secret** — Codex's "fast" feeling comes from offloading to a dedicated endpoint, not from a better algorithm. For non-OpenAI providers, it's a normal (slower) LLM call.

6. **Tool output loss is the Achilles' heel** — the biggest unsolved problem. Any compaction strategy should consider how to preserve critical tool results (file contents, error messages, test output) rather than structurally filtering them out. A lightweight mitigation: preserve a **tool call log** (tool names and arguments without full output) so the model retains a map of explored paths and avoids re-reading files it already visited.

7. **Cumulative summaries** can mitigate progressive degradation across multiple compaction cycles at minimal token cost.

---

## Sources

- [Codex CLI source: `codex-rs/core/src/compact.rs`](https://github.com/openai/codex)
- [Codex CLI source: `codex-rs/core/src/compact_remote.rs`](https://github.com/openai/codex)
- [Codex CLI source: `codex-rs/core/src/codex.rs`](https://github.com/openai/codex)
- [Compaction | OpenAI API Docs](https://developers.openai.com/api/docs/guides/compaction)
- [Compact a Response | OpenAI API Reference](https://developers.openai.com/api/reference/resources/responses/methods/compact)
- [Unrolling the Codex Agent Loop | OpenAI Blog](https://openai.com/index/unrolling-the-codex-agent-loop/)
- [GitHub Issue #14589: Compaction silently discards all tool outputs](https://github.com/openai/codex/issues/14589)
- [GitHub Issue #14347: Extend compaction prompt for multi-compaction resilience](https://github.com/openai/codex/issues/14347)
- [GitHub Issue #16812: Context compaction regression in v0.118](https://github.com/openai/codex/issues/16812)
- [Context Compaction Research (badlogic gist)](https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f)
- [How Codex Solves the Compaction Problem (Tony Lee)](https://tonylee.im/en/blog/codex-compaction-encrypted-summary-session-handover/)
- [Investigating How Codex Context Compaction Works (Simon Zhou)](https://simzhou.com/en/posts/2026/how-codex-compacts-context/)
- [FlashCompact: Every Context Compaction Method Compared (Morph)](https://www.morphllm.com/flashcompact)
