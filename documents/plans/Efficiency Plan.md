# Push Efficiency Plan

## Status
- Last updated: 2026-02-22
- State: Partially shipped — Priority 1 complete, Priority 2 architecture simplified (prompt-engineered only), follow-up optimization pending
- Scope: CLI + Web app — both share the same architectural patterns

## Implementation Status Snapshot (2026-02-21)

- [x] Priority 1 shipped: CLI context trimming is active (`cli/context-manager.mjs`, integrated in `cli/engine.mjs`).
- [x] Priority 2 shipped (core): all tools are prompt-engineered (native function-calling removed).
- [x] Priority 2 shipped (visibility): malformed-call diagnostics are tracked by provider/model and surfaced in Settings.
- [x] Priority 3 decision unchanged: keep hashline edit safety.

## Context

Push is model-agnostic by design. The current tool protocol (prompt-engineered JSON blocks, regex detection, hashline-anchored edits) is the lowest-common-denominator approach that works across all OpenAI-compatible SSE backends (Ollama, Mistral, OpenRouter). This plan identifies the real efficiency costs of that approach and lays out a path to reclaim performance without sacrificing portability.

## Principles

1. Portability is a feature, not a bug — but it shouldn't cost more than it has to.
2. Capability detection > lowest common denominator. Probe what the provider supports, use the best path available.
3. Fix what breaks sessions before optimizing what slows them.
4. The sandbox boundary (Modal HTTP API) is decoupled from tool detection — changes to how tools are detected don't require sandbox changes.

---

## Priority 1 — Context Trimming (CLI)

**Status (2026-02-21):** Shipped

**Problem:** The CLI re-sends the entire message history every round. At 8 rounds with 2-3 tool calls each, that's 16-24 tool result messages plus the ~13KB system prompt. No trimming, no summarization. When the history exceeds the provider's context window, the session fails with a cryptic 400 error.

**Impact:** This is the only gap that **breaks sessions**. Everything else is overhead; this is a wall.

**Current state:**
- `engine.mjs` tracks `contextChars` but does nothing with it
- The web app already has rolling-window trimming in `orchestrator.ts` (summarize old tool-heavy messages, drop oldest pairs, keep tool call/result pairs together)
- The CLI has zero equivalent

**Approach:**
- Port the web app's token-budget context management to the CLI
- Estimate tokens at ~3.5 chars/token (same heuristic as web app)
- Trim strategy: summarize old tool-heavy messages first, then drop oldest message pairs
- Preserve invariants: keep tool call/result pairs together, keep the system prompt + first user message pinned
- Surface context budget in the `[meta]` envelope (already tracked, just not acted on)

**What changes:**
- `cli/engine.mjs` — add trimming pass before each `streamCompletion()` call
- No sandbox changes, no provider changes

---

## Priority 2 — Prompt-Engineered Tool-Loop Efficiency (Unified Path)

**Status (2026-02-22):** Architecture simplification shipped (native function-calling removed); optimization follow-up pending

**Problem:** Prompt-engineered tools still cost ~15-20% token overhead:
- ~800 char `TOOL_PROTOCOL` prompt in every system message
- Model wastes tokens on markdown fencing around every tool call
- Malformed calls happen (tracked by `tool-call-metrics.mjs` / `tool-call-metrics.ts`)
- Prompt assembly mistakes (duplicate protocol injection, wrong-role protocol leakage) can create regressions

**Current state:**
- Both CLI (`tools.mjs`) and web app (`tool-dispatch.ts`) use prompt-engineered JSON tool calls detected from accumulated text
- Tool results are injected as `role: "user"` messages wrapped in `[TOOL_RESULT]...[/TOOL_RESULT]`
- The codebase no longer uses provider-native function-calling request schemas or `delta.tool_calls` parsing in the web app

**Optimization focus (without changing tool mode):**
- Keep protocol injection role-scoped (Orchestrator vs Coder vs Auditor) to avoid prompt leakage
- Eliminate duplicate protocol blocks in shared prompt pipelines
- Reduce prompt verbosity where possible (compact wording, no redundant examples)
- Improve malformed-call recovery and diagnostics to reduce retry rounds
- Continue context trimming and result compaction improvements for tool-heavy sessions

**What changes:**
- `app/src/lib/orchestrator.ts` — shared prompt assembly guardrails (override prompt pass-through, role-scoped protocol injection)
- `app/src/lib/tool-dispatch.ts` — continue improving malformed-call recovery, detection accuracy, and multi-tool dispatch efficiency
- `app/src/hooks/useChat.ts` / `cli/engine.mjs` — reduce round churn via better retry feedback and context trimming
- `cli/provider.mjs` / web streaming paths — keep SSE parsing focused on `delta.content` and reasoning tokens
- No sandbox changes (`sandbox-client.ts`, `sandbox-tools.ts`, Modal, Worker — all untouched)

**Historical note (superseded):** An earlier dual-mode native function-calling plan existed, but production was simplified to a unified prompt-engineered path on 2026-02-22. Keep that design discussion in git history only.

---

## Priority 3 — Hashline: Keep, Don't Change

**Status (2026-02-21):** Decision accepted, no implementation changes required

**Current overhead:** ~10% token overhead per file read (7-char hash + line number + delimiters per line).

**Why keep it:**
- Eliminates line-number drift entirely (insertions don't break queued edit references)
- Fails loudly on stale content (hash mismatch), unlike string matching which can silently match the wrong occurrence
- On mobile (Push's primary surface), users can't easily intervene when edits go wrong — safety matters more than token savings
- The overhead is real (~2KB for a 200-line file) but bounded and predictable

**Why not switch to string matching:**
- String matching saves ~1 round per targeted fix (skip the read), but search results often don't provide enough context for confident edits anyway
- Duplicate string occurrences cause silent wrong-location edits
- `expected_version` catches file-level staleness but not line-level drift

**Decision:** Accept the 10% overhead as the cost of edit safety on a mobile-first agent. Revisit only if token costs become a measurable bottleneck in real sessions.

---

## Not Prioritized (Tracked)

### Workspace snapshot overhead
The system prompt includes ~13KB of static context (snapshot + project instructions + memory). This is sent once per session and doesn't grow. The cost is real but fixed — not a scaling problem.

### Temperature tuning
CLI hardcodes `temperature: 0.1`. Good for deterministic tool use, potentially too conservative for exploration phases. Could vary by task type but adds complexity for marginal gain. Defer.

### Token counting
CLI uses character count (`contextChars`) as a proxy. Real token counting requires a tokenizer (provider-specific). Character-based estimation at ~3.5 chars/token is good enough for budget management. Defer real tokenization unless estimation causes visible problems.

---

## Implementation Order

1. [x] **Context trimming (CLI)** — shipped.
2. [~] **Prompt-engineered tool-loop efficiency** — unified prompt-engineered path shipped; continue incremental prompt/trim/retry optimizations.
3. [x] **Hashline** — no action needed; continue monitoring token costs in real sessions.
