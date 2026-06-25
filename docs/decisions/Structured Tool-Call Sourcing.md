# Structured Tool-Call Sourcing

Date: 2026-06-24
Status: **Current** — Slices 0-3 shipped. Producer sidecars map to
`LlmMessage.contentBlocks` for complete adjacent tool exchanges; Slice 3 removed
the duplicate serializer-local `contentParts` arms while keeping the permanent
plain-text fallback.
Slice 0 storage shape shipped in #1157; Slice 1 producer sidecars shipped in
#1158. Slice 2 is the producer flip: new complete tool exchanges reach
block-aware serializers as `contentBlocks`, while legacy/split exchanges keep
using the text fallback.

The next slice of the Anthropic-conceptual contract arc (see [`Provider Contract
— Anthropic-Conceptual Neutral Hub.md`](<Provider Contract — Anthropic-Conceptual Neutral Hub.md>)).
That migration flipped the producer so multimodal turns travel as structured
`contentBlocks`; it **deferred tool calls** because they round-trip as fenced
JSON *text* in `content`. This doc decides how to make tool calls structured **at
the source** while preserving that text-dispatch boundary. The final cleanup
(#1154 §3) removes duplicate rich-content serializer arms now that
`withRequestContentBlocks` owns request-level materialization; the generic text
fallback remains live.

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
through to the provider serializers (which already read it), and stop replaying
complete new tool exchanges as display-only text on block-aware routes.

## Current state (verified in code, 2026-06-25)

Tool calls remain **text at the model-facing boundary**. The structured target
types exist, transcript storage has additive `toolUses` / `toolResults`
sidecars, Slice 1 writes those sidecars from the parsed call + outcome, and
Slice 2 maps paired sidecars to `LlmMessage.contentBlocks` at request
materialization, and Slice 3 removes duplicate serializer-local `contentParts`
arms so rich-content normalization has one owner.

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
the optional structured sidecars. They remain durable replay data; the provider
wire reads them only after the request-level exchange invariant passes.

**Re-serialize.** `toLLMMessages` (`app/src/lib/orchestrator.ts`) maps
`ChatMessage[]` → provider-ready messages. Neutral/block-aware web transports
(direct Anthropic, Gemini, Zen Go, native Vertex) opt into `contentBlocks`; strict
OpenAI-shaped web transports stay text-only so Push-private fields do not leak
to upstreams. Shared CLI/Coder serializers run the same request-level
materializer via `lib/content-blocks.ts`.

**Serializer block path.** `LlmToolUseBlock` / `LlmToolResultBlock` +
`LlmMessage.contentBlocks` exist
(`lib/provider-contract.ts`), and all three serializers already **read** them:
`llmContentBlocksToAnthropic` (bridge), `flattenToolBearingBlocks`
(`openai-chat-serializer.ts`), and the Gemini bridge. Slice 2 maps transcript
sidecars (`toolUses` / `toolResults`) into `contentBlocks` for paired exchanges;
Slice 3 deletes the now-dead per-serializer `contentParts` alternatives.

**Correction — the request path never reconstructed tool blocks (verified
2026-06-24, Slice 2 review).** Earlier framing in this doc described the bridge
as "re-parsing fenced text back into `tool_use` / `tool_result` for the wire,"
and Slice 3 as "deleting that reconstruction." That is **inaccurate for the
request path.** `convertOpenAIContentToAnthropic` (the legacy text arm) emits
assistant tool-call content as a `{ type: 'text' }` block — the fenced JSON
verbatim; it never recovered `tool_use`. The bridge's tool-block code (`the ~48
tool refs`) lives almost entirely in the **streaming-response translator** (the
*other* direction: Anthropic-native `tool_use` → fenced text for the dispatcher).
Consequences: (a) Slice 2 is a real **behavior change** — Anthropic tool history
now travels as native `tool_use`/`tool_result` instead of as text — not a
near-identity flip; (b) Slice 3 has **no request-path reconstruction to delete**
(the payoff there shrinks to dead-code removal in the legacy arms, not bridge
thinning). The text-fallback for unpaired/malformed turns still matters. Anthropic
**permits** `tool_use`/`tool_result` history with no top-level `tools` definition
(relaxed 2025-02-27 release note), so Push's text-dispatch turns (no `req.tools`)
serialize without a 400.

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
   producer fills them, the structured arm carries complete new exchanges.
   OpenAI/Gemini downcast from the same blocks.

4. **Back-compat = per-exchange fallback, under one invariant.** Old transcripts
   (text-only) have no blocks → serializers take the legacy text arm, unchanged;
   new turns have blocks. No migration script, no transcript rewrite — but it is
   **not** "free": it is correct only under the **wholly-text-or-wholly-block
   exchange invariant** (Codex). See below — this is the load-bearing correctness
   point, not a footnote.

5. **Then thin (#1154 §3) — remove duplicate rich-content branches, not the text
   path.** Once `withRequestContentBlocks` owns request-level materialization, the
   serializers no longer need local `contentParts` arms. The **generic text
   fallback survives** — malformed turns, JSON repair, the Kimi reasoning-channel
   recovery, pre-migration transcripts, and non-adjacent exchanges will always
   emit text (Codex). So §3 removes dead branch duplication; it does not remove
   the text arm.

## Back-compat correctness — the exchange invariant (Codex review)

Anthropic rejects a request where a `tool_result.tool_use_id` has no matching
`tool_use.id` **earlier in the same request**. A part-migrated conversation
interleaves old (text) and new (block) exchanges in one `LlmMessage[]`, so the
dual-read is sound **only** under these rules:

- **Wholly-text-or-wholly-block per exchange.** A call and its result are written
  together in one round-loop iteration, so they share a migration state naturally.
  But the producer must enforce it: emit the structured block for a `tool_result`
  **only if** the matching `tool_use` is also a block. If either half lacks a
  block, **both** fall to the text arm (the provider sees the display/model text
  consistently, same as today). Never half a pair. This keeps every exchange internally
  id-consistent, so mixed exchanges in one request each validate independently.
- **Resume-across-deploy edge.** A run interrupted mid-exchange and resumed after
  this ships could pair a pre-flip `tool_use` (text) with a post-flip
  `tool_result` (block). The invariant above catches it: a `tool_result` whose
  `tool_use` isn't a block degrades the pair to text. Slice 2 pins this split
  case.
- **Orphan `tool_use` from early batch termination.** The reverse of the rule
  above, and just as load-bearing: a single assistant turn mints a `tool_use`
  block per *detected* call up front, but the mutation queue **short-circuits** on
  a denial or hard-failure (`lib/coder-agent.ts` — the queue `break`s so the model
  sees a consistent snapshot), so later queued calls get a `tool_use` block but
  **never a `tool_result`**. Slice 1 writes these unpaired `tool_use` blocks as
  shadow data harmlessly. But Anthropic rejects a `tool_use` with no following
  `tool_result` just as it rejects the inverse — so **Slice 2's request
  materializer prunes unpaired blocks on BOTH sides**: a `tool_use` with no
  matching `tool_result` degrades to the text arm exactly like a `tool_result`
  with no matching `tool_use`. Wholeness is enforced once, at the consumer, over
  the full `LlmMessage[]` — not per-producer-site. Slice 2 pins this
  early-termination case (batch with a denied/failed mutation mid-queue).
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
- ✅ **Slice 2 — `toLLMMessages` emits `contentBlocks`.** Map the sidecar to blocks
  so serializers receive them. Behind the existing block-preference in the
  serializers, so Anthropic now uses the structured arm for new turns; old turns
  fall back. **This is the producer flip** — request tests pin that tool turns
  avoid duplication and split/orphan exchanges stay on the text path.
- ✅ **Slice 3 — serializer cleanup (#1154 §3).** Delete the duplicate
  serializer-local `contentParts` arms now that request-level materialization
  routes rich multimodal/tool turns through `contentBlocks`. Keep the plain
  `content` fallback for text-only and degraded exchanges.

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
  a new drift pin for the structured fields; Slice 2 adds request golden tests
  for block-path emission, no duplicated tool calls, and split/orphan fallback.
- **CLI/web parity.** Both round loops must produce the sidecar (the CLI session
  store + `cli/engine.ts`), or the CLI regresses to text-only replay on the
  Anthropic path. Slice 1 covers both surfaces in the same PR (per the
  "one source of truth per vocabulary" checklist in CLAUDE.md).

## Risks / tradeoffs (accepted)

- **Two representations during the dual-read window.** Text + blocks coexist on
  new turns; they must agree. Mitigation: the block is *derived from* the same
  parse that drives the text, and a Slice-2 golden test pins agreement. Divergence
  is a producer bug, not a design hazard.
- **Transcript growth.** The structured sidecar duplicates the tool-call payload
  (small — `{ id, name, args }`). Acceptable; the result text dominates either way.
- **Thinning is narrow, not a text-path deletion.** §3 can't delete the text arm
  while malformed / pre-migration / non-cooperating turns travel it — so the
  payoff is "the serializers own fewer rich-content branches," not "the text path
  is gone." State that honestly.

## Out of scope

- **Skipping the text round-trip for native-tool providers** (emit structured
  straight from `delta.tool_calls` without the fenced-text detour) — a dispatch
  refork, separate optimization.
- **Web tool-dispatch convergence onto the shared kernel** (the existing
  [`Tool-Call Parser Convergence Gap.md`](<Tool-Call Parser Convergence Gap.md>)).
- **Multi-call assistant turns as multiple `tool_use` blocks on the wire** beyond
  what Push's per-turn budget emits today — revisit if the budget changes.

## Status flip plan

Promoted to **Current** with Slice 3: producer sidecars fill `contentBlocks`, the
block-aware serializers use the structured arm for complete adjacent tool turns,
golden request tests pin the no-duplication / text-fallback behavior, and the
serializers keep only `contentBlocks` plus the permanent plain-text fallback.
