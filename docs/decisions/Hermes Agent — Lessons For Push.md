# Hermes Agent — Lessons For Push

Date: 2026-05-16
Author: Claude (via Claude Code)
Status: Shipped — all three borrow items landed.
  - **Item 1** (cache breakpoint audit — `system + rolling 3`): shipped via PR #573 (2026-05-16). Includes `cache_control` preservation through `chat-request-guardrails` so the web side actually benefits in production.
  - **Item 2** (typed `SessionDigest` for compaction output + 85% gateway safety net): shipping in this PR. New `lib/session-digest.ts` primitive (type + render/parse round-trip + merge), two new transformer stages (`injectSessionDigestStage` + `safetyNetStage`) in `lib/context-transformer.ts`, wired into both web (`app/src/lib/orchestrator.ts`) and CLI (`cli/engine.ts`) main loops.
  - **Item 3** (skill frontmatter + auto-hide): shipped via PR #572 (2026-05-16).

---

## What this is

A research note on `NousResearch/hermes-agent` (Nous Research's open-source self-hosted agent) and what's worth borrowing for Push. Source material: the [hermes-agent README](https://github.com/NousResearch/hermes-agent) and the [community docs mirror](https://github.com/mudrii/hermes-agent-docs) covering architecture, agent-loop, context compression and caching, skill authoring, and trajectory format. The user-facing docs at `hermes-agent.nousresearch.com` returned 403 to unauthenticated fetch; the mirror is the next-best primary source.

Hermes is shaped around a self-improving agent loop (procedural skills, FTS5 session search, Honcho user modeling) running on a "one `AIAgent` class, multiple entry points" backbone. Push is shaped around **locked roles** (Orchestrator / Explorer / Coder / Reviewer / Auditor) with surface-specific coordinators and a typed sandbox-provider boundary. Those are different design choices, both load-bearing — most of Hermes's high-level shape **doesn't** transplant cleanly. What follows is the narrower set that does.

For each pattern: (a) what Hermes does, (b) Push's current state with file:line citations, (c) the load-bearing next step. Out-of-scope items at the bottom.

---

## 1. Cache breakpoint audit — adopt `system + rolling 3`

### Hermes

Hermes pins Anthropic's four `cache_control` breakpoints as `[system_prompt, last_3_non_system_messages]` (their `system_and_3` strategy). The system prompt is **frozen** for the session — compression appends notes only on the *first* compaction, never mutates the prefix. Claim is ~75% input-token reduction on multi-turn conversations. The mid-conversation cache invariant is: when only new turns are appended, the cached prefix doesn't shift; the rolling-3 window re-establishes after compression within 1–2 turns.

### Push today

Push uses **two** ephemeral breakpoints: system message and last user message.

- `cli/openai-stream.ts:108-137` — gates on `config.id === 'openrouter'` (only known Anthropic route in CLI), wraps system (index 0) and `cacheBreakpointIndex` in content-array form with `cache_control: { type: 'ephemeral' }`. Inline comment: "Mirrors `app/src/lib/orchestrator.ts:285-298` and 367-387".
- `lib/context-transformer.ts:260-272` — `cacheBreakpointIndex = findLastUserIndex(messages)` after compaction/distillation. The transformer enforces a documented invariant (lines 18–21): "If the transformed prefix changes between turns when only new messages were appended, the cache misses."
- `docs/decisions/pi-mono Agent Loop Review.md` — already flagged mid-stream working-memory re-injection as a cache-hit-rate hazard; verdict was to consolidate compaction into one LLM-boundary transform.

So Push has the invariant, has the gate, has one rolling breakpoint already (last user). The unused two slots are the cheap win.

### Load-bearing next step

Adopt `system_and_3` on the OpenRouter path:

1. Extend `cli/openai-stream.ts` to compute up to **3** breakpoint indices for the most recent non-system messages (last user + last assistant + last tool result, or whichever three fall in the tail), not just `findLastUserIndex`. Mirror the change in `app/src/lib/orchestrator.ts:285-298` / `367-387`.
2. Verify the four-breakpoint cap on each Anthropic-routed role agent (`coder-agent`, `explorer-agent`, `reviewer-agent`, `deep-reviewer-agent`, `auditor-agent`). Long-history roles benefit most.
3. Add a drift-detector test under `cli/tests/` that fails if `cache_control` markers exceed 4 or shift on an append-only turn — the invariant `context-transformer.ts:18-21` documents informally is exactly what a strict-mode test should pin.

Estimate: half a day plus the drift-detector test. No new modules. Low risk because the cache miss/hit is observable in provider logs.

---

## 2. Compaction summary schema — typed session digest

### Hermes

Hermes runs compression at two thresholds: per-agent at 50% context, gateway-level safety net at 85%. When it fires, middle turns collapse into a **structured summary** with a fixed schema: `goal`, `constraints`, `progress { done, in_progress, blocked }`, `decisions`, `relevant_files`, `next_steps`, `critical_context`. Subsequent compactions **update** the previous summary instead of regenerating, so information accumulates rather than churns.

### Push today

The structured pieces exist — they're not assembled into a single session digest.

- `lib/context-memory.ts:54-78` — `MemoryRecord` already carries `kind` ('fact' | 'finding' | 'decision' | 'task_outcome' | …), `summary` (≤400 char), `detail` (≤2000 char), `scope`, `source`, `relatedFiles`, `relatedSymbols`, `tags`, `freshness`. This is the strongest piece of the puzzle.
- `lib/context-summary.ts:30-55, 175-281` — `ContextSummaryMessage` + `extractSemanticSummaryLines()` pulls load-bearing lines (headers, bullets, "Status:"/"Files:" prefixes) and emits omission markers ("[N more X omitted from original Y-item list]") so the model knows it's reading a sampled tail.
- `lib/compaction-tiers.ts` — three tiers (drop old tool outputs / semantic compact via `compactMessage()` / drop oldest pairs); preserves system + recent 4 by default (`preserveTail ?? 4`).
- `docs/decisions/Context Memory and Retrieval Architecture.md` is the canonical design.

The gap: when compaction fires, there's no single "session summary" message produced with a fixed Hermes-shaped schema. Memory records and semantic line extraction are both there; nothing assembles them into one block addressed at the model's working context.

### Load-bearing next step

Define a typed `SessionDigest` in `lib/` and wire it as a compaction output, not a replacement for `MemoryRecord`:

1. New type in `lib/session-digest.ts` (or fold into `lib/context-summary.ts` if it's a thin extension): `{ goal, constraints[], progress: { done[], inProgress[], blocked[] }, decisions[], relevantFiles[], nextSteps[], criticalContext? }`. Caps per field mirror `MemoryRecord` (≤400 char summary, ≤2000 char detail).
2. Add a tier hook in `lib/compaction-tiers.ts` that, on tier-2 or tier-3 compaction, materializes a `SessionDigest` from existing `MemoryRecord` rows (filtered by current scope: `repoFullName + branch + chatId`) and renders it as a single system-or-context block injected near the head of the rolling tail. Subsequent compactions **merge** into the prior digest rather than re-emit — same pattern Hermes documents.
3. Add a 85% gateway safety net in the Worker / round-loop boundary. Today the per-agent threshold is the only line of defense; a second-tier net catches run-away rounds before the provider truncates.
4. Drift-detector test under `cli/tests/protocol-drift.test.mjs` strict-mode pin for the digest schema.

Estimate: 1–2 days. Touches `lib/context-memory*`, `lib/context-summary.ts`, `lib/compaction-tiers.ts`. Risk: making sure the digest doesn't double up with `MemoryRecord` retrieval — the digest is **derived** from records, not a parallel store.

---

## 3. Skill frontmatter + auto-hide

### Hermes

Hermes's `SKILL.md` carries YAML frontmatter declaring `requires_toolsets`, `requires_tools`, `platforms` (e.g. `[macos, linux]`), and `required_environment_variables`. Skills whose dependencies aren't met are **hidden from the system prompt, `skills_list()`, and slash-command autocomplete** — they don't surface at all. Compatible with the [agentskills.io](https://agentskills.io) open standard.

### Push today

Push skills are *plain Markdown with zero frontmatter*. They aren't woven into role-agent system prompts at all — they're slash commands that expand into a **user message**.

- `cli/skill-loader.ts` — `parseSkillFile()` (lines 65–99) reads the first `# Heading` as `description` and the body as `promptTemplate`. The `Skill` interface (lines 44–51) is `{ name, description, promptTemplate?, promptTemplateLoaded?, source, filePath }`. No `platforms`, no `requires_tools`, no frontmatter parser.
- `loadSkills()` (lines 161–179) scans `cli/skills/` (builtin, eager), `.claude/commands/` (recursive, lazy), `.push/skills/` (workspace, lazy). Precedence: builtin < claude < workspace.
- Consumers: `cli/cli.ts:1058, 3204` (skill list rendering), `cli/cli.ts:1096, 3358` (skill dispatch), `cli/tui.ts:2452, 4296-4297` (TUI). All call `loadSkills(cwd)` and render every entry unconditionally.
- `lib/capabilities.ts` already has the right vocabulary: `repo:read`, `repo:write`, `sandbox:exec`, `git:push`, `pr:write`, etc. — this is what `requires_capabilities` should be keyed against, not raw tool names.

The Push semantics are slightly different from Hermes: "auto-hide" here means **don't offer this slash command** in `/skills` or the completer, since skills produce user prompts rather than system-prompt entries. That's actually simpler and lower-risk than the Hermes case.

### Load-bearing next step

Extend `cli/skill-loader.ts` with optional frontmatter; filter at the consumer layer. Concrete shape:

1. Add a minimal frontmatter parser (no new dependency — skills only need three fields, keep it local):
   ```yaml
   ---
   description: Override the # heading
   requires_capabilities: [repo:write, sandbox:exec]
   platforms: [linux, macos]
   ---
   # Heading-still-acts-as-fallback-description
   …body…
   ```
   Parsed values live on `Skill` as optional fields. Skills without frontmatter behave exactly as today (backward compat).
2. Add `filterSkillsForEnvironment(skills, { platform, availableCapabilities })` in `cli/skill-loader.ts` returning the visible subset. Filtering is *additive*: a skill with no `requires_capabilities` is always visible; one declaring `[pr:write]` is hidden when the active role lacks that capability.
3. Wire the filter at three call sites: `cli/cli.ts:1058` (`/skills` list), `cli/cli.ts:3204` (headless `--skills`), `cli/tui.ts:2452` (TUI dropdown). The completer (`cli/completer.ts`, `cli/tui-completer.ts`) consumes `RESERVED_COMMANDS` — extend to also reject hidden-by-environment skills.
4. Extend `cli/tests/skill-loader.test.mjs` with cases for: frontmatter parsing, frontmatter-less backward compat, platform filtering, capability filtering, malformed frontmatter (skill should still load with no constraints — fail-open, not fail-closed, because the cost of missing a skill is higher than the cost of showing one that errors).
5. Document the frontmatter shape in `cli/skills/skill-creator.md` so the built-in skill-authoring template emits it.

Estimate: half a day. Self-contained to `cli/skill-loader.ts` + 4 consumer call sites + tests. Zero risk to chat/role pipeline. Lays groundwork for any future system-prompt inclusion of skills (a separate question).

---

## Out of scope — deliberately not borrowed

- **"One `AIAgent` class for all surfaces."** Hermes positions platform-agnostic core as a virtue (`run_agent.py` serves CLI, gateway, ACP, batch, API server). Push deliberately keeps shell-specific coordinators local (`hooks/chat-*`, `cli/engine.ts`) and locks **roles** instead of unifying agents. The role split is the better fit for coding work; don't flatten.
- **No SAFE/UNSAFE pre-commit gate.** Hermes has no Auditor-equivalent. Push's Auditor gate is a deliberate safety feature for an agent that writes to user repos. Keep it.
- **Provider fallback chain on transient errors.** Hermes falls through `fallback_providers` on 429/5xx/401/403. Push's "first send locks the Orchestrator provider/model" contract is intentionally stricter — silently swapping providers mid-chat would break delegation inheritance and reproducibility. If we ever add fallback, scope it to *retry the same provider*, not provider migration.
- **Honcho dialectic user modeling.** Push is repo/branch-scoped, not user-personalized. FTS5 over session history might marginally help `context-memory` retrieval, but Honcho-style user dialectic doesn't map.
- **Trajectory format for training data.** Interesting (standardized `<think>` tags, compact `<tool_call>{…}</tool_call>` XML-wrapped JSON, `tool_stats` normalized across the *full* registry to avoid HuggingFace dataset schema drift), but Push has no current eval or fine-tuning consumer. File for later if/when one appears — `cli/tests/protocol-drift.test.mjs` already pins envelope shape, so the marginal cost of a trajectory format on top is low.

---

## References

- [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) — README
- [mudrii/hermes-agent-docs](https://github.com/mudrii/hermes-agent-docs) — community mirror; pages used: `developer-guide/architecture.md`, `developer-guide/agent-loop.md`, `developer-guide/context-compression-and-caching.md`, `developer-guide/creating-skills.md`, `developer-guide/trajectory-format.md`
- [Hermes Agent: Self-Improving AI Agent vs OpenClaw — turingpost](https://www.turingpost.com/p/hermes)
- Related Push decisions: `pi-mono Agent Loop Review.md`, `Context Memory and Retrieval Architecture.md`, `Claude Code In-App Patterns — Lessons For Push.md`
