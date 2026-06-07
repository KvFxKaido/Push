# External Resource Review — Harness Engineering & Ralph Loop

**Date:** 2026-04-02
**Sources:**
- [Harness engineering: leveraging Codex in an agent-first world | OpenAI](https://openai.com/index/harness-engineering/)
- [Unrolling the Codex agent loop | OpenAI](https://openai.com/index/unrolling-the-codex-agent-loop/)
- [Ralph Wiggum as a "software engineer" | ghuntley.com](https://ghuntley.com/ralph/)

---

## 1. OpenAI — Harness Engineering

OpenAI's Feb 2026 post describes a five-month experiment where a small team shipped ~1M lines of production code with no human-written source. Key findings relevant to Push:

### AGENTS.md as a Living Feedback Loop
- Treat AGENTS.md as a dynamic constraint system, not static docs.
- Update iteratively whenever agents encounter failures.
- Keep it as a "table of contents" — detailed knowledge lives in a structured `docs/` directory.
- **Push status:** CLAUDE.md already serves this role. Consider whether it's trying to be both TOC and encyclopedia.

### Architectural Guardrails via Linters/Structural Tests
- Strict dependency layers (Types → Config → Repo → Service → Runtime → UI) enforced through custom linters.
- Agents cannot violate modular boundaries.
- **Push status:** Role-based system exists but enforcement is mostly prompt-level. Could benefit from structural enforcement (e.g., Explorer can't call write tools at the type level, not just prompt level).

### Agent-to-Agent Review Loops
- PRs go through a loop: Codex self-reviews, requests agent reviews, iterates until all reviewers are satisfied.
- Pushed almost all review effort to agent-to-agent over time.
- **Push status:** Reviewer + Auditor roles exist but are on-demand. Could be wired into an automated pre-merge loop.

### Application Legibility for Agents
- Per-worktree booting so agents can launch isolated instances.
- CDP integration for DOM snapshots, screenshot capture, browser navigation.
- **Push status:** Sandbox execution exists. CDP integration could enhance verification.

### Core Insight
> "Progress was slow until they stopped focusing on the model and started building the tools, feedback loops, and scaffolding."

More capable models make harness engineering *more* important, not less. LangChain validated this: same model, different harness → jumped from Top 30 to Top 5 on Terminal Bench 2.0.

---

## 2. ghuntley.com — The Ralph Loop

Geoffrey Huntley's autonomous coding methodology. A bash loop that feeds AI output (errors and all) back into itself until convergence.

### Fresh Context Per Iteration
- Clear context each loop to keep the LLM in its "smart zone."
- File-based memory (specs, plan, agents file) persists learnings across iterations.
- **Push status:** Resumable sessions exist. Context resets on phase transition exist in heavy harness profile. Ralph argues for more aggressive intentional clearing with structured state files.

### Primary Context as Scheduler, Not Worker
- "Don't allocate expensive work to the primary context window — spawn subagents."
- The orchestrator should schedule, not do.
- **Push status:** Orchestrator → Explorer/Coder delegation validates this. Push could go further — Orchestrator should almost never read files or write code directly.

### Backpressure via Tests/Types/Lints
- Create automated rejection signals so bad work gets caught mechanically.
- Tests, typechecks, lints, builds as automatic gates after mutations.
- **Push status:** Auditor is a safety gate but runs at the end. No mechanical backpressure runs automatically *during* Coder work after each mutation. **This is the key gap to address.**

### Planning Mode vs Building Mode Separation
- Gap analysis (specs vs code) → prioritized TODO list, then separate building passes.
- **Push status:** Planner pre-pass exists (`plannerRequired` in harness settings). Could be formalized further.

### Spec-First Porting
- Compress behavior into language-agnostic Markdown specs rather than maintaining parallel implementations.
- **Push status:** Less directly relevant but interesting for multi-backend AI support.

---

## 3. Actionable Takeaways

| Priority | What | Where It Fits | Status |
|----------|------|---------------|--------|
| **1** | Add mechanical backpressure — auto typecheck/lint/test after Coder mutations | `coder-policy.ts` / `turn-policy.ts` | **Implementing** |
| **2** | Wire Reviewer + Auditor into automated pre-merge loop | Agent pipeline / delegation hook | Planned |
| **3** | Treat CLAUDE.md as living feedback loop — TOC pointing into `docs/` | Repo structure | Planned |

### Backpressure Implementation Plan

The existing `afterToolExec` hook in `coder-policy.ts` only tracks mutation *failures*. The gap: after a successful mutation, nothing automatically validates the change. The Coder must voluntarily run `sandbox_exec` to typecheck/lint.

**Approach:** Add a new `afterToolExec` hook that, after N successful file mutations, injects a policy message requiring the Coder to run verification commands before continuing with more mutations. This creates mechanical backpressure without blocking individual tool calls.

The verification-policy system (`verification-policy.ts`) already defines command-type rules (typecheck, test) with presets. The backpressure hook should leverage these existing rules rather than hardcoding commands.

**Key design decisions:**
- Trigger after every 3-5 successful mutations (configurable)
- Inject a policy message, don't auto-execute (keeps the Coder in control of sandbox)
- Respect the active verification policy's command rules
- Reset counter after verification commands are observed in `sandbox_exec`
- Don't trigger during verification phases (already read-only gated)
