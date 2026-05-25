# Loop Detection — Near-Duplicate Layer

Status: Draft, added 2026-05-25

Borrows the `loop-guard` pattern from [Kodrack/Pi-forge](https://github.com/Kodrack/Pi-forge) (a constraint-enforcement layer for small quantized local LLMs running the Pi coding agent). Triggered by a pattern-mining pass over Pi-forge. This doc records what Push already does, the one real gap Pi-forge fills, and a design for closing it. No implementation commitment yet — needs a `ROADMAP.md` entry to graduate.

## TL;DR

Push already detects loops, but only on **exact** tool-call keys (`tool:JSON.stringify(args)`). A model that re-writes the same file with trivially different content each round (reordered object keys, a renamed local, whitespace, a one-line tweak that doesn't compile) produces a *different* key every round, so no breaker fires and the run spins until the round cap. Pi-forge's `loop-guard` catches exactly this with a **similarity** check (Jaccard over tokenized write content). The borrow is: add a near-duplicate layer on top of the existing exact-match breakers, give the breakers a **warn → block → compact** escalation ladder instead of the current binary abort, and **unify the CLI and web breakers** onto one `lib/` kernel (they have diverged into two implementations).

We are **not** porting Pi-forge's hard-blocking philosophy wholesale — its incremental-codegen scaffolding, thinking-length caps, and 65%-context steering compensate for failure modes of 35B-at-Q2 models that Push's frontier models and existing compaction already handle. Only the detection patterns are model-agnostic.

## What Push Already Has

Push has loop detection in **two divergent places**, both exact-match:

### 1. Shared tracker (web)
`lib/agent-loop-utils.ts` — `createMutationFailureTracker()` returns a `MutationFailureTracker` with three independent breakers:

- `recordFailure` / `isRepeatedFailure(key, limit)` — cumulative per-session count of failures on the same `(tool, args)` key.
- `recordCall` / `isRepeatedCall(key, limit)` — **consecutive** identical-call streak (resets when a different key intervenes). Docstring rationale (PR #602): re-reading a file after an edit is fine because the edit breaks the streak; re-reading the same dir four rounds straight with nothing between is a loop.
- `recordDelegationOutcome` / `isRepeatedDelegationFailure(agent, limit)` — cumulative non-`complete` delegation outcomes per agent (PR #603), keyed on agent not task text so a coder that keeps returning `incomplete` with varying briefs still trips.

Key derivation: `getToolInvocationKey(toolName, args)` = `` `${toolName}:${JSON.stringify(args)}` `` (`lib/agent-loop-utils.ts:118`).

Consumed by the web round loop: `app/src/hooks/chat-send-helpers.ts:716` `checkLoopBreaker(detected, tracker, round)` with `MAX_REPEATED_TOOL_CALLS = 3`. Tracker is created per run at `app/src/hooks/chat-round-loop.ts:295`. On trip, `checkLoopBreaker` returns `true` and the caller **hard-breaks the run** (binary: not-tripped → keep going; tripped → stop).

### 2. Ad-hoc breaker (CLI)
`cli/engine.ts:1645` — a *separate* `repeatedCalls: Map<string, number>` keyed on `JSON.stringify(toolCalls)` (the entire batch, not per-call), incremented every round and **never reset**. On `seen >= 3` (cumulative, not consecutive) it pushes a `tool_loop` TOOL_RESULT, emits a `TOOL_LOOP_DETECTED` error event, and **aborts the run** with `outcome: 'error'`.

This is drift: the CLI does not use the shared `MutationFailureTracker` at all, uses whole-batch keying instead of per-call, and uses cumulative-total instead of consecutive semantics. Per the CLAUDE.md "one source of truth per vocabulary" guardrail, this vocabulary should live once in `lib/` with a drift test.

### Coverage summary

| Loop shape | Web | CLI |
|---|---|---|
| Same call, exact args, consecutive | covered (`isRepeatedCall`) | covered (cumulative batch) |
| Same call, exact args, cumulative w/ gaps | covered (`isRepeatedFailure` on failures only) | covered (batch map) |
| Delegation returns `incomplete` repeatedly | covered (`isRepeatedDelegationFailure`) | not covered |
| **Same file rewritten with near-identical content** | **not covered** | **not covered** |
| **Same intent, paraphrased args each round** | **not covered** | **not covered** |
| Escalation gradient (warn before abort) | none (binary abort) | none (binary abort) |

## What Pi-forge's loop-guard Does

- **Write-loop**: tokenizes each write's content to a lowercase word set, computes Jaccard similarity `(|A∩B| / |A∪B|)` against previous writes **to the same path** within a sliding 10-call window. Different paths with similar content are ignored.
- **Escalation**: warn at 4 writes >0.85 similarity → block at 6 → force-compact after 3 blocks → "nuclear" double-compact → give up and tell the user.
- **Malformed-call counter**: separate counter for empty/missing-field calls, warn at 4, compact at 8.
- Default disabled (it's the backup for when LM Studio's repeat penalty is absent). Tunable thresholds in source.

The transferable core: **per-path content similarity over a sliding window**, plus a **graduated escalation ladder**.

## Design

### Decision: new `lib/loop-detection.ts`, composed alongside the existing tracker

Keep `MutationFailureTracker` as-is (exact-key, cheap, already consumed). Add a sibling pure module that holds the heavier per-path content window, and a single escalation policy both surfaces call. Rationale: the tracker is a small exact-key structure shared by read-only agent loops; bolting a content-retaining sliding window onto it would change its cost profile for every consumer. Composition keeps each piece single-purpose and lets the similarity layer be independently kill-switched.

```
lib/loop-detection.ts
  createSimilarityLoopDetector(opts?) -> SimilarityLoopDetector
    recordWrite(path: string, content: string): void      // tokenize + push into per-path window
    maxSimilarity(path: string, content: string): number   // best Jaccard vs window for that path (0..1), pre-write
    clear(): void

  evaluateLoopState(input): LoopVerdict                     // the shared escalation policy
```

- **Tokenization**: lowercase, split on `/[^a-z0-9_]+/`, drop empties, dedupe to a `Set<string>`. Cap token-set size (e.g. first 4,000 tokens) so a giant generated file can't blow memory. Jaccard on the sets.
- **Window**: per-path ring buffer of the last N (default 10) token-sets, matching Pi-forge. Keyed by normalized path.
- **`maxSimilarity`** is computed **pre-write** (before recording the current content) so the escalation can refuse to run a near-duplicate write the way `isRepeatedCall` is checked before execution.

### Escalation ladder (shared policy)

`evaluateLoopState` folds in the exact-match tracker verdicts and the similarity verdict and returns one of:

| Level | Trigger (defaults) | Action |
|---|---|---|
| `none` | below all thresholds | execute normally |
| `warn` | 1st time any breaker would trip, OR 4 same-path writes ≥0.85 similarity | **execute**, then inject a steering message ("you've repeated X; change approach or stop") |
| `block` | breaker still tripping after a warn was issued this run, OR 6 same-path writes ≥0.85 | **skip** the offending call, inject a `[LOOP_BLOCKED]` result, let the model try something else |
| `compact` | 3 blocks issued this run | force a context compaction next turn (see below), reset windows, inject the digest |
| `abort` | loop persists after a compact | terminate the run with the existing `TOOL_LOOP_DETECTED` outcome |

This replaces today's binary abort with a gradient: a model that loops once gets nudged and usually recovers; only a genuinely stuck run reaches `abort`. The current behavior (`MAX_REPEATED_TOOL_CALLS = 3` → break) becomes the `block`/`abort` tail of the same ladder, so we don't regress the existing safety property.

Thresholds live in one exported constants block in `lib/loop-detection.ts` (mirror the `MAX_REPEATED_TOOL_CALLS` co-location pattern):

```
SIMILARITY_THRESHOLD = 0.85
SIMILARITY_WINDOW     = 10
SIMILARITY_WARN_HITS  = 4
SIMILARITY_BLOCK_HITS = 6
BLOCKS_BEFORE_COMPACT = 3
```

### Integration points

Both surfaces already locate their breaker check at the right spot (after detection, before execution). The change is to route both through `evaluateLoopState` and to record writes into the similarity detector.

- **Web** — `app/src/hooks/chat-send-helpers.ts`: `checkLoopBreaker` becomes a thin adapter over `evaluateLoopState`. For each `sandbox_write_file` / `sandbox_edit_file` call in `detected`, compute `detector.maxSimilarity(path, content)` before execution; feed the result + tracker booleans into the policy. Return the `LoopVerdict` instead of a bare `boolean` so the caller can warn/block/compact rather than only break. Record writes via `detector.recordWrite` after execution (detector instance lives next to the tracker in `chat-round-loop.ts:295`).
- **CLI** — `cli/engine.ts`: **delete** the ad-hoc `repeatedCalls` map (line 706 / 1645) and adopt `createMutationFailureTracker()` + `createSimilarityLoopDetector()` + `evaluateLoopState`, matching the web semantics (per-call key, consecutive streak, similarity). This is the unification step. The existing `TOOL_LOOP_DETECTED` event/outcome is preserved for the `abort` level.
- **Coder** — `lib/coder-agent.ts` already keeps a `MutationFailureTracker` across rounds for its autonomous loop; add the similarity detector to the same scope and consult `evaluateLoopState` at the existing breaker check. Warn/block messages use `formatToolResultEnvelope` (`lib/tool-call-recovery.ts:93`) so they reach the model inside the trusted `[TOOL_RESULT]` boundary; `compact` sets the existing flag that makes the next `transformContextBeforeLLM` run `manageContext` (compaction is a between-turn operation — there is no in-turn compaction API).

### Steering message shape

```
[LOOP_DETECTED] You've written near-identical content to <path> N times
(>85% similar). The last attempt did not change the situation — its result
was: <one-line tail of the prior tool result>. Either change your approach,
read the current file state, or stop and report what's blocking you.
```

Wrapped via `formatToolResultEnvelope` and pushed as a `role: 'user'`, `isToolResult: true` message, identical to how parse-error and policy-inject corrections already reach the model.

### Gating / kill-switch

Add `system:loop-detection` to the capability vocabulary in `lib/capabilities.ts` (no new tool — a system capability checked in the policy), defaulting **on**. Honor a `PUSH_LOOP_DETECTION=0` env kill-switch in `evaluateLoopState` for fast disable, mirroring Pi-forge's `/piforge disable` toggle. The similarity layer specifically should be independently disable-able from the exact-match breakers so we can ship it dark and measure first.

## Test Plan

Per CLAUDE.md guardrail #3 (one canonical definition + a drift detector in the same PR):

- **Unit** — `lib/loop-detection.test.ts`: Jaccard math (identical → 1.0, disjoint → 0.0, known overlap), per-path isolation (similar content to different paths does not trip), window eviction past N, `maxSimilarity` is pre-write, and the full `evaluateLoopState` ladder (none → warn → block → compact → abort with the documented thresholds).
- **Drift** — extend `cli/tests/daemon-integration.test.mjs` / a focused test to assert the CLI and web both produce the same `LoopVerdict` for the same input sequence, so the two surfaces can't re-diverge.
- **Characterization** — a coder-loop test feeding the same near-duplicate write across rounds and asserting warn-then-block-then-compact ordering and that a *legitimate* iterative pattern (edit → re-read → edit) never trips.

## Scope / Non-Goals

- **In**: per-path content-similarity detection, escalation ladder, CLI/web unification onto a `lib/` kernel, kill-switch.
- **Out**: Pi-forge's incremental skeleton/one-TODO-per-turn codegen flow, thinking-length caps, the 65%-context "write state now" monitor (Push's compaction + `[USER_GOAL]` anchor already cover the degradation case), and the malformed-call counter (Push already handles malformed calls via `tool-call-recovery` with its own retry/abandon ladder — fold malformed counting into `evaluateLoopState` only if measurement shows a gap).

## Open Questions

1. **Default on or dark?** Recommend shipping the similarity layer disabled-by-default behind the capability, measuring false-positive rate on real runs (a model legitimately rewriting a file it just read), then flipping on. The exact-match unification can ship on immediately since it only refactors existing behavior.
2. **Edit vs write similarity.** `sandbox_edit_file` carries `old_string`/`new_string`, not whole-file content. Tokenize `new_string` for the window, or reconstruct? Start with `new_string` — it's where the repetition shows.
3. **Threshold tuning.** 0.85 is Pi-forge's number for Q2 models. Frontier models loop differently (more likely to paraphrase than byte-repeat); the warn/block hit counts may want to be lower. Defer to measurement.
