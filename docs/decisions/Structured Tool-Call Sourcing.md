# Structured Tool-Call Sourcing

Date: 2026-06-24
Status: **Draft** — implementation is proceeding in slices for issue #1154 §1.
Slice 0 storage shape shipped in #1157; Slice 1 writes producer sidecars in this
branch. Slice 2 (mapping sidecars to `LlmMessage.contentBlocks`) is not yet
implemented, so the provider wire still uses the text fallback.

The next slice of the Anthropic-conceptual contract arc (see [`Provider Contract
— Anthropic-Conceptual Neutral Hub.md`](<Provider Contract — Anthropic-Conceptual Neutral Hub.md>)).
That migration flipped the producer so multimodal turns travel as structured
`contentBlocks`; it **deferred tool calls** because they round-trip as fenced
JSON *text* in `content`. This doc decides how to make tool calls structured **at
the source** so the richest provider (Anthropic) stops re-parsing text back into
`tool_use` / `tool_result`. Completing it unlocks the bridge-thinning payoff
(#1154 §3) — the legacy serializer arms become dead code.

## The thesis (and why it isn't "rip out the text path")

The tool protocol is **deliberately text-form**: any model can emit
```` ```json {"tool":"…","args":{…}} ``` ```` in its `content` stream, and
`lib/tool-call-parsing.ts` repairs the usual LLM garbling (trailing commas,
single quotes, Python literals, truncation). That robustness is load-bearing for
non-cooperating models and is **not** what we're removing (CLAUDE.md: "Tool calls
normalize to the same text-dispatch path"). Even OpenAI-native `tool_calls` and
Anthropic's native `tool_use` are **converged back to fenced text**
(`lib/openai-sse-pump.ts` `formatNativeToolCallFenced`; the Anthropic streaming
translator does the mirror) so one dispatch path serves every provider.

So the thesis is narrower: the text path stays the **model-facing boundary**, but
the round loop already **parses that text into structure to execute it** and
already **has the result** — then throws the structure away and persists *text*.
The migration is to **persist the structure it already computed** (a `tool_use`
block from the parsed call, a `tool_result` block from the outcome), carry it
through to the provider serializers (which already read it), and let the Anthropic
bridge stop reconstructing what the round loop knew all along.

## Current state (verified in code, 2026-06-25)

Tool calls remain **text at the model-facing boundary**. The structured target
types exist, transcript storage has additive `toolUses` / `toolResults`
sidecars, and Slice 1 writes those sidecars from the parsed call + outcome. The
wire flip has **not** happened yet: no path maps the sidecars to
`LlmMessage.contentBlocks`.

**Emit → parse.** Models emit fenced/bare JSON in `content`;
`detectToolFromText` / the `lib/tool-dispatch.ts` kernel scan **content only**
(never reasoning tokens) and parse to a flat `{ tool, args }`
(`tool-call-parsing.ts:551`, `tool-dispatch.ts:174-189`). Native `tool_calls` →
fenced text at `openai-sse-pump.ts:85`. The Kimi reasoning-channel buried-call
recovery (`tool-call-recovery.ts`) also assumes text.

**Execute → store.** The web round loop (`app/src/hooks/chat-round-loop.ts` →
`chat-send.ts` `processAssistantTurn` → `chat-single-tool-execution.ts` /
`chat-batched-execution.ts`) and the shared Coder kernel (`lib/coder-agent.ts`,
used by CLI lead turns) run the parsed call, then write:
- `toolUses` on the assistant tool-call turn, linked by a minted `toolu_*` id.
- `toolResults` on the synthetic result/denial message, using the same id.
- The legacy display/model text remains: fenced JSON in `content` and the
  `[TOOL_RESULT …]` envelope.

**Storage shape.** `ChatMessage` (`app/src/types/index.ts`), CLI `Message`
(`cli/context-manager.ts`), shared `CoderLoopMessage`, and run checkpoints carry
the optional structured sidecars. They are shadow data only until Slice 2.

**Re-serialize.** `toLLMMessages` (`app/src/lib/orchestrator.ts:292`) maps
`ChatMessage[]` → `LlmMessage[]`, populating `content` / `contentParts` but does
not yet translate `toolUses` / `toolResults` into `contentBlocks`. Until Slice 2,
serializers still see the legacy text form for tool turns.

**Already serializer-ready (producer sidecar only).** `LlmToolUseBlock` /
`LlmToolResultBlock` + `LlmMessage.contentBlocks` exist
(`lib/provider-contract.ts:79-101`), and all three serializers already **read**
them: `llmContentBlocksToAnthropic` (bridge), `flattenToolBearingBlocks`
(`openai-chat-serializer.ts:212`), and the Gemini bridge. Slice 1 now writes the
transcript sidecars (`toolUses` / `toolResults`), but Slice 2 has not mapped
those sidecars into `contentBlocks` yet.

**Drift pins.** `cli/tests/protocol-drift.test.mjs` pins the `tool_call` event
envelope as a flat `{ toolName, args }` (text-derived); `daemon-integration.test.mjs`
pins prompt-vs-capability sync.

## Decision: persist the parse, dual-read, then thin

Structured tool blocks become a **producer-fed sidecar**, additive and back-compat
by construction — the same shape the `reasoningBlocks` → `contentBlocks` work
already established. The model-facing text path is untouched.

1. **The round loop is the producer.** At the point it has the parsed call (to
   execute) and the outcome, attach the structured blocks to the transcript: a
   `tool_use` block on the assistant turn (`{ id, name: tool, input: args }`,
   minting a stable `id`), and a `tool_result` block on the result message
   (`{ tool_use_id, content, is_error }`). The text representation stays for
   display + the parser boundary; the structure rides alongside.

2. **`toLLMMessages` maps the sidecar to `contentBlocks`.** When a `ChatMessage`
   carries structured tool data, emit `LlmMessage.contentBlocks` (text + the
   tool block); otherwise emit `content` as today. The CLI session→`LlmMessage`
   path mirrors it.

3. **The serializers already prefer blocks** when present (verified). So once the
   producer fills them, Anthropic stops re-parsing — the structured arm carries
   the turn. OpenAI/Gemini downcast from the same blocks.

4. **Back-compat = per-exchange fallback, under one invariant.** Old transcripts
   (text-only) have no blocks → serializers take the legacy text arm, unchanged;
   new turns have blocks. No migration script, no transcript rewrite — but it is
   **not** "free": it is correct only under the **wholly-text-or-wholly-block
   exchange invariant** (Codex). See below — this is the load-bearing correctness
   point, not a footnote.

5. **Then thin (#1154 §3) — provider-specific reparsing, not the text path.** The
   payoff is deleting the Anthropic bridge's *reconstruction* of `tool_use` /
   `tool_result` from fenced text, gated on **observed coverage**: add temporary
   logging (block-path vs text-fallback vs mismatch) and only thin once production
   shows new tool turns travel blocks. The **generic text fallback survives** —
   malformed turns, JSON repair, the Kimi reasoning-channel recovery, and
   pre-migration transcripts will always emit text (Codex). So §3 thins the
   bridge's tool-block reconstruction toward near-identity; it does not remove the
   text arm.

## Back-compat correctness — the exchange invariant (Codex review)

Anthropic rejects a request where a `tool_result.tool_use_id` has no matching
`tool_use.id` **earlier in the same request**. A part-migrated conversation
interleaves old (text) and new (block) exchanges in one `LlmMessage[]`, so the
dual-read is sound **only** under these rules:

- **Wholly-text-or-wholly-block per exchange.** A call and its result are written
  together in one round-loop iteration, so they share a migration state naturally.
  But the producer must enforce it: emit the structured block for a `tool_result`
  **only if** the matching `tool_use` is also a block. If either half lacks a
  block, **both** fall to the text arm (the bridge re-parses the pair consistently,
  same as today). Never half a pair. This keeps every exchange internally
  id-consistent, so mixed exchanges in one request each validate independently.
- **Resume-across-deploy edge.** A run interrupted mid-exchange and resumed after
  this ships could pair a pre-flip `tool_use` (text) with a post-flip
  `tool_result` (block). The invariant above catches it: a `tool_result` whose
  `tool_use` isn't a block degrades the pair to text. Slice 2's golden test must
  include this split case.
- **Pair-aware context trimming.** Context compaction must never drop a `tool_use`
  while keeping its `tool_result` (an orphan result Anthropic rejects). This is a
  *pre-existing* requirement for the text form; the block path must preserve it —
  trim by exchange, not by individual message.
- **No duplication.** `toLLMMessages` must not emit a turn's call BOTH as a
  structured block AND as raw fenced JSON left in `content` — the serializer would
  send the call twice. When blocks are present for a turn, the text representation
  of the *call* is dropped from what the serializer sees (the serializers' existing
  "prefer blocks" branch). Pinned by a serializer test, not trusted.
- **The sidecar is canonical for replay.** The display `content` text may be raw
  model output (prose-wrapped JSON, a repaired call, or Kimi reasoning-recovered
  content); the structured block is built from the *parse* that actually executed.
  On re-serialization the block wins — `content` text is authoritative only for
  the UI render, never for the provider wire.

## Slices (each independently shippable + validated)

Mirrors the contract migration's vocabulary → producer → dual-read → flip →
delete shape:

- ✅ **Slice 0 — vocabulary + storage shape.** Add the structured tool fields to
  `ChatMessage` (and the CLI session message) — the exact shape decided below.
  Pure additive types + a drift test; no behavior change. *(Vocabulary half is
  partly done: `LlmToolUseBlock` / `LlmToolResultBlock` already exist.)*
- ✅ **Slice 1 — producer writes blocks.** `markLastAssistantToolCall` /
  `buildToolResultMessage` (web) + the CLI equivalents populate the structured
  fields from the already-parsed call + outcome. Still text-primary; blocks are a
  shadow nobody reads yet (like `reasoningBlocks` pre-flip).
- **Slice 2 — `toLLMMessages` emits `contentBlocks`.** Map the sidecar to blocks
  so serializers receive them. Behind the existing block-preference in the
  serializers, so Anthropic now uses the structured arm for new turns; old turns
  fall back. **This is the producer flip** — measure that tool turns round-trip
  identically (golden-transcript diff against the text path).
- **Slice 3 — bridge thinning (#1154 §3).** Delete the legacy reconstruction arms
  once the cutover criteria hold. The reward, not separable work.

## Hard problems + decisions

- **Storage shape — must be plural (Codex).** A single assistant turn can carry
  **multiple** tool calls (the per-turn budget allows a batch of pure file
  mutations), each needing its own `id` and its own matched result. So a singular
  `toolUse?: LlmToolUseBlock` is under-modeled. Two options for Slice 0:
  - **(a) Plural typed sidecars:** `toolUses?: LlmToolUseBlock[]` on the assistant
    turn, `toolResults?: LlmToolResultBlock[]` on the result message(s). Minimal,
    mirrors `toolMeta`, easy back-compat. **Leaning (a).**
  - **(b) Full `contentBlocks` on `ChatMessage`** (parity with `LlmMessage`).
    More uniform long-term but a bigger transcript + UI surface now. Deferred —
    (a) is the smaller reversible step; promote only if a second consumer needs it.
  Confirm the exact batched-call cardinality (how the round loop pairs N calls to
  N results across one or several result messages) before fixing the field arity.
- **The `id` ↔ `tool_use_id` linkage.** Anthropic requires the `tool_result` to
  reference the `tool_use.id`. Today nothing mints an id (text has none). The
  producer mints one on the assistant turn and threads it to the result message —
  the round loop already pairs call↔result, so the id is a new field on that
  existing pairing, not new bookkeeping.
- **Native convergence stays.** No change to `openai-sse-pump` /the Anthropic
  translator: they keep emitting fenced text for the round loop + UI + parser. The
  structured block is built from the round loop's **existing parse**, not a second
  parse. (A later optimization could skip the text round-trip for native-tool
  providers, but that's out of scope — it would fork the dispatch path.)
- **Parser + recovery are untouched.** `tool-call-parsing.ts` /
  `tool-call-recovery.ts` remain the model-facing boundary for non-cooperating
  models. The migration is downstream of the parse, so the Kimi reasoning-channel
  recovery and the JSON-repair passes are unaffected.
- **Malformed turns.** `isMalformed` turns never parsed → no structured block →
  they take the text arm forever. The thinning (Slice 3) must keep a path for
  malformed/legacy text turns, OR scope the text-arm deletion to *parseable* tool
  turns. (This is why §3 is "thin," not "delete the text path entirely.")
- **Drift tests.** The `tool_call` event envelope pin stays (the event is still
  flat `{ toolName, args }` — UI/log surface, not the storage block). Slice 0 adds
  a new drift pin for the structured fields; Slice 2 adds a golden round-trip
  test (block path vs text path produce the same Anthropic/OpenAI wire).
- **CLI/web parity.** Both round loops must produce the sidecar (the CLI session
  store + `cli/engine.ts`), or the CLI regresses to text-only re-parsing on the
  Anthropic path. Slice 1 covers both surfaces in the same PR (per the
  "one source of truth per vocabulary" checklist in CLAUDE.md).

## Risks / tradeoffs (accepted)

- **Two representations during the dual-read window.** Text + blocks coexist on
  new turns; they must agree. Mitigation: the block is *derived from* the same
  parse that drives the text, and a Slice-2 golden test pins agreement. Divergence
  is a producer bug, not a design hazard.
- **Transcript growth.** The structured sidecar duplicates the tool-call payload
  (small — `{ id, name, args }`). Acceptable; the result text dominates either way.
- **Thinning is gated, not free.** §3 can't delete the text arm while malformed /
  pre-migration / non-cooperating turns travel it — so the payoff is "the bridge
  reconstructs far less," not "the text path is gone." State that honestly.

## Out of scope

- **Skipping the text round-trip for native-tool providers** (emit structured
  straight from `delta.tool_calls` without the fenced-text detour) — a dispatch
  refork, separate optimization.
- **Web tool-dispatch convergence onto the shared kernel** (the existing
  [`Tool-Call Parser Convergence Gap.md`](<Tool-Call Parser Convergence Gap.md>)).
- **Multi-call assistant turns as multiple `tool_use` blocks on the wire** beyond
  what Push's per-turn budget emits today — revisit if the budget changes.

## Status flip plan

Promote to **Current** when Slice 2 ships (producer fills `contentBlocks`, the
Anthropic bridge uses the structured arm for new tool turns) and a golden
round-trip test proves wire-identity with the text path. Flip the
`Provider Contract` doc's §3 note and #1154 §1 when Slice 3 lands the bridge
thinning.
