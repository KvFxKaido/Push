# Field Survey — Tianshu Runtime Ideas

**Status:** Reference — source-read survey of a third-party coding-agent runtime; no adoption
decision. Findings feed existing tracks (provider observability, tool-call recovery, context
packing, prompt assembly). The renderer (T9) verdict lives in
[`Retained-Mode TUI — MVU + Pure-TS Compositor.md`](Retained-Mode%20TUI%20—%20MVU%20+%20Pure-TS%20Compositor.md).

**Date:** 2026-07-12

## What was surveyed

`huiliyi37/Tianshu-Tui` (v2.18.0, ~1.8k TS files, 1:1 test ratio, Apache-2.0) — a
terminal coding-agent runtime tuned for DeepSeek V4's prefix cache. Not an adoption
candidate on any axis (competing product, 44 stars, heavy marketing vocabulary). Surveyed
as an idea mine; verdicts below are source-read with paths relative to its repo.

## Pillar verdicts

### 1. Prefix-cache discipline — substantive; the reason this doc exists

The README's "95–99% long-session cache hit rate" is mechanically coherent and *measured*,
not asserted. The mechanism, each piece source-verified:

- **Volatile quarantine.** Explicit prompt layout `[System][Tools][Volatile][User1][Asst1]`
  (`src/compact/constants.ts`) — volatile content sits in one slot *behind* the large
  static blocks, so churn invalidates from that slot onward, never the whole prefix.
- **Anchored compaction.** First 2 messages pinned across compaction
  (`CACHE_ANCHOR_MESSAGES`), last 4 kept (`KEEP_RECENT_MESSAGES`), so the prefix
  structure survives summarization.
- **Deterministic once-per-message Context Collapse** (`src/compact/context-collapse.ts`,
  `src/compact/micro.ts`). Old tool results rewrite to a semantic stub ("grep 'foo' →
  14 matches / 8 files") exactly once as they age past a turn threshold. The stub is a
  pure function of (tool, content) — age only gates *when*, never *what*; no timestamps,
  no randomness. Prefix invalidation is therefore stepwise and bounded to the recent
  tail — never rolling, never catastrophic. Credited by them to Claude Code's strategy.
- **Reasoning retained intact** on echo-requiring providers (DeepSeek, MiMo) — their
  comment: truncation savings are negligible once the prefix cache covers it, and
  incomplete reasoning degrades quality.
- **Measured, twice.** Per-turn `cacheRead`/`cacheCreation` from real API usage exposed
  to the *model itself* as a read-only `session-vitals` tool ("cite these numbers instead
  of guessing"); and a `CacheBehaviorLearner` (`src/cache/behavior-learner.ts`) that
  infers per-provider cache existence and exact-prefix-vs-partial matching from observed
  `(cacheRead, cacheCreation, prefixChanged)` tuples — empirical discovery instead of
  trusting provider docs.

### 2. "Cognitive Virtual Machine" — ~70% vocabulary, ~30% substance, substance misfiled

The branded layer (5 lifecycle phases, ~40 assembled hooks) is real plumbing whose entire
corrective surface is **appending advisory text** to the next request — no block, no
abort, no arg modification; a non-cooperating model ignores it at zero cost, and an
in-code comment admits it ("post-hoc detection; real interception requires a tool-layer
pre-execution gate"). Detection is string heuristics and behavioral counters, not
structural validation. The genuinely fail-closed enforcement (read-before-edit gate,
destructive-command gate, doom-loop fingerprint blocking, schema repair) lives *outside*
the CVM branding in a conventional pre-execution tool pipeline returning `is_error`
before execution. Their own doc describes the CVM candidly as "prompt-layer belief
injection"; its A/B evidence is n=5, one model. This split is Push's "behavior lives in
code, not prompts" doctrine observed in the wild — they built both halves and branded
the weak one.

### 3. Stigmergy memory — frecency, but defensibly placed

Per-file "pheromone" deposits (strength 0–1, 7-day half-life, exponential decay computed
at query time — `src/context/stigmergy.ts`) consumed at 0.2 weight in a repo file-graph
relevance blend (structural 1.0, co-edit 0.6, access-heat 0.3 —
`src/repo/meridian-behavior.ts`). Mechanically renamed frecency — but aimed at **file
relevance for context selection**, not fact-memory, which dodges the
reinforce-the-wrong-fact trap. Push's semantic retrieval + explicit event-driven
invalidation (`lib/context-memory*`) remains the stronger memory model; the only
transplant candidate is behavioral file-heat as a *tie-breaker* in context packing.

## Ranked Push-actionable list

1. **Audit Push's prompt assembly for prefix churn.** The CLI injects a workspace
   snapshot (git branch, **dirty files**, tree, manifest) alongside
   `[PROJECT_INSTRUCTIONS]`. If any volatile field sits ahead of conversation history,
   every file save busts the whole prefix on exact-prefix providers — and the Fireworks
   default is DeepSeek V4, the harshest miss penalty in the matrix. Cheap audit,
   recurring token savings. Fix shape if needed: Tianshu's volatile-quarantine layout.
2. **`session_vitals` read-only tool** — surface the #951 cache/token instrumentation to
   the lead agent so claims about its own context/cache state cite numbers. Honest
   surfaces, applied reflexively.
3. **Advisory expectations + adopted/ignored ledger** for tool-call-recovery nudges:
   every nudge carries a falsifiable "if adopted, observe X within N turns" predicate
   (`tool_appears` / `verify_attempted` / `file_touched`), reconciled post-turn, with
   shadow-holdout buckets. Converts "we nudge" into "we know which nudges work" and
   lets ineffective ones auto-decay. (Their standout runtime idea.)
4. **CacheBehaviorLearner** in the provider-observability track — auto-classify each
   backend's cache behavior empirically; pairs with the BYOK
   verify-empirically-not-by-code doctrine.
5. **Failure fingerprinting** (hash of top-N test-failure names; retry counter resets
   when the fingerprint *changes*) to distinguish blind retry from progressive
   debugging — applicable to the sequential-mutation budget.
6. **Verbatim-resend-passes friction** for destructive ops: first call blocks with a
   reason, an unchanged resend goes through — a deliberate-second-decision middle
   ground between hard deny and soft nudge.

## Method note

Claims were scored against source with file receipts, not READMEs; where a delegated
read missed its target it was redone by hand. The renderer steal list (fixed-height
dynamic viewport, CSI 2026 synchronized output, resize reflow reconciliation) is
recorded in the TUI decision doc with the other nine candidates.
