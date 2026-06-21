# DeepSeek-Reasonix — Prefix-Cache Stability Review for Push

> Research compiled 2026-06-21

## Question

[DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix) is a terminal
AI coding agent whose entire design philosophy is *"engineered around
prefix-cache stability — leave it running."* Is there anything Push should borrow
from it? In particular: does Push keep its system-prompt **prefix byte-stable
across turns** so DeepSeek/Kimi-class automatic prefix caching (and Anthropic
cached prefixes) actually reuse the large stable blocks?

**Conclusion: borrow one idea — order prompt sections stable-first, volatile-last
— and Push gets most of Reasonix's cache benefit with infrastructure it already
has.** Push already has the hard parts (a `volatile` flag per section, snapshot
diffing, cost telemetry, an explicit "keep the prefix byte-stable" design goal in
the context transform). The gap is narrow and concrete: section **layout order is
by priority, and the `volatile` flag does not influence it**, so three volatile
sections sort *ahead* of the largest stable blocks and invalidate them from the
cache every turn. Reasonix's secondary ideas (BM25 retrieval, archive-on-forget,
user-turn rewind) are smaller, lower-priority borrows noted at the end.

This note records the audit so the question doesn't get re-opened from scratch.
It is research, not an operating decision — the live contract for memory/prompt
packing is [`../decisions/Agent Runtime Decisions.md`](<../decisions/Agent Runtime Decisions.md>)
§5–6.

## What Reasonix does (the borrowable model)

From its `main-v2` docs (`REASONIX.md`, `SESSION_MEMORY_RETRIEVAL.md`,
`CHECKPOINTS.md`):

- **The cache-stable prefix is never mutated mid-session.** Base prompt + tools +
  memory index are assembled once at session start; all per-turn changes "ride
  the turn tail" through a single `control.Compose` seam.
- **Memory folds into the prefix once, after the base prompt.** Mid-session memory
  edits are injected only as *transient turn-tail notes*, and become part of the
  stable prefix on the **next** session — never spliced into the current prefix.
- **The cached prefix is treated as a versioned artifact.** PRs touching
  cache-sensitive paths carry a cache-impact annotation; system-prompt changes
  need explicit reviewer sign-off.
- Secondary: **BM25 lexical retrieval** (tuned for code, commands, error phrases,
  filenames) with a `KeepTopRelativeScore` relative floor of `0.15`;
  **archive-on-forget** invalidation (`forget` moves a memory to
  `.archive/<UTC ts>-<name>.md`, excluded from recall but auditable); **one
  checkpoint per user turn** with a `Rewind` API scoped Code / Conversation /
  Both.

## Where Push already stands (audit, 2026-06-21)

Push is closer to this than Reasonix's framing would suggest, and ahead in places:

- **The design goal is already stated and enforced for the message tail.** The
  boundary transform in `app/src/lib/orchestrator.ts:593` exists specifically to
  "[keep] the prefix sent to the LLM byte-stable across turns when only new
  messages were appended (cache hit rate)." Per-turn dynamic context (Coder
  `[CODER_STATE]` deltas, `[RETRIEVED_*]` blocks, session digests, file-awareness
  ledger) is appended as **trailing messages**, not spliced into the system
  prefix — exactly Reasonix's "ride the turn tail."
- **Sections already carry a `volatile` flag.** `lib/system-prompt-builder.ts:33`
  marks each section `volatile: true|false`, and the builder is **deterministic**
  — `build()` sorts by priority and joins (`system-prompt-builder.ts:124`); no
  `Date.now()`, `Math.random()`, or unsorted `Object.keys`/`Set` iteration
  reaches the prompt text.
- **Stability is already observable.** `snapshot()` / `diffSnapshots()`
  (`system-prompt-builder.ts:137`) emit per-section hashes, the web path captures
  a `prompt_snapshot` diff every turn (`orchestrator.ts:532`), and
  `lib/prompt-cost-telemetry.ts` reports system-prompt / GitHub-protocol /
  project-instructions byte+token cost per turn. The instrumentation to *measure*
  cache-prefix churn is already wired.
- **Reasonix's secondary ideas are partly already shipped.** Push's context memory
  is scoped by durable repo/branch/chat identity with summary-default packing and
  a deterministic expand/grep kernel (Agent Runtime Decisions §5). Push is also
  **ahead** on the reasoning-vs-content channel: `lib/tool-call-recovery.ts` plus
  the "parser scans `content`, not reasoning" boundary handle tool calls buried in
  the reasoning channel — Reasonix documents no equivalent.

## The gap: volatile sections sort ahead of the big stable blocks

`SECTION_CONFIG` in `lib/system-prompt-builder.ts:33` lays sections out **by
priority only** — the `volatile` flag feeds telemetry, not layout:

| priority | section | volatile | approx size |
|---|---|---|---|
| 0 | identity | stable | small |
| 10 | voice | stable | small |
| 15 | safety | stable | small |
| **20** | **user_context** | **volatile** | small |
| **25** | **capabilities** | **volatile** | small |
| **30** | **environment** | **volatile** | small — *git branch + dirty files* |
| 40 | tool_instructions | stable | **large** |
| 45 | github_tool_instructions | stable | **large** |
| 50 | delegation | stable | medium |
| 60 | guidelines | stable | medium |
| 70+ | project_context, library_context, memory, … | volatile | varies |

Because a prefix cache survives only up to the **first changed byte**, and
`environment` (priority 30) carries git branch + dirty-file status
(`cli/workspace-context.ts:99`) — which flips the moment any file is edited — the
cached prefix is invalidated **from priority 30 onward every turn**. That
discards exactly the largest stable blocks: the tool protocol (40), GitHub
protocol (45), delegation (50), and guidelines (60). The small volatile sections
at 20–30 are paying the cache cost of every big stable block behind them.

The web path compounds this by wrapping the *entire* system message in a single
`cache_control: { type: 'ephemeral' }` marker (`orchestrator.ts:577`) — one
breakpoint covering both stable and volatile content, so there is no stable
sub-prefix for Anthropic to retain either.

## Recommendation

**Primary (high value, low risk): order sections stable-first, volatile-last.**
The `volatile` flag already exists; make it (not raw priority) the primary sort
key in `SystemPromptBuilder.build()`, so all `volatile: false` sections form one
contiguous byte-prefix followed by the volatile tail. Within each band, keep the
current priority ordering. This moves `user_context` / `capabilities` /
`environment` *behind* the large tool/GitHub/delegation/guidelines blocks, so the
expensive stable bytes become a cacheable prefix that survives a git-status flip.

This is a layout change, not a semantics change — the same bytes reach the model,
just reordered — so the risk surface is prompt-quality regression (some models
weight early-prompt context more), gated by the existing `prompt_snapshot` /
`prompt_composition_cost` telemetry and the prompt-builder tests. Worth confirming
no section *depends on* appearing before tool instructions before flipping the
sort.

**Secondary (only if the primary lands and a measured cache problem persists):**

1. **A real stable/volatile cache breakpoint on the web path.** Once stable
   sections are contiguous, place the Anthropic `cache_control` marker at the
   stable/volatile boundary instead of around the whole message
   (`orchestrator.ts:577`), and confirm DeepSeek/Kimi automatic caching sees the
   same contiguous prefix.
2. **Promote `environment` git-status churn out of the prefix.** If dirty-file
   status doesn't need to be in the system prompt at all, moving it to the turn
   tail (Reasonix-style) removes the most frequent invalidator outright.

**Smaller borrows, separately:** BM25-style lexical retrieval scoring and the
`archive-on-forget` invalidation pattern (move to a timestamped `.archive/`,
excluded from recall but auditable) are clean, low-risk fits for
`lib/context-memory-retrieval.ts` / `lib/context-memory-invalidation.ts` — but
they are independent of the cache work and lower priority.

## Revisit / non-goals

- **Don't adopt Reasonix's "single Controller behind all frontends" wholesale.**
  Push deliberately keeps shell-specific coordinators local (`cli/engine.ts`,
  `app/src/hooks/chat-*`) with shared contracts in `lib/`; that's the §10
  convergence target, and one God-controller is the thing it's avoiding.
- **Don't import the "cache-impact annotation required on every PR" process**
  unless the layout fix lands and cache stability becomes a tracked metric worth
  gating on. The telemetry already exists to measure it first.

## Sources

- DeepSeek-Reasonix `main-v2` docs via WebFetch, 2026-06-21: `README.md`,
  `REASONIX.md`, `docs/SESSION_MEMORY_RETRIEVAL.md`, `docs/CHECKPOINTS.md`,
  `docs/REASONING_LANGUAGE.md`.
- Push codebase audit, 2026-06-21: `lib/system-prompt-builder.ts:33,124,137`,
  `app/src/lib/orchestrator.ts:532,577,593`, `cli/workspace-context.ts:99`,
  `lib/prompt-cost-telemetry.ts`, `cli/lead-turn.ts:315`.
