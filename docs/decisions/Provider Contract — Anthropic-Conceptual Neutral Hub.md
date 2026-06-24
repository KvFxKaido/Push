# Provider Contract — Anthropic-Conceptual Neutral Hub

Status: **Draft**, added 2026-06-24. Needs a `ROADMAP.md` entry to graduate past Phase 1. Direction-setting; implemented incrementally (main stays green every slice).

## Context

The neutral provider contract (`lib/provider-contract.ts` — `PushStreamRequest` / `PushStreamEvent` / `LlmMessage`) is structurally its own type, but its **input sub-types are OpenAI-shaped**:

- `ToolFunctionSchema` is OpenAI's nested `{ type: 'function', function: { … } }`.
- `LlmContentPart` uses OpenAI's `image_url: { url }` image shape.
- Structured output is modeled on OpenAI `response_format`.

Because OpenAI is the canonical shape, the OpenAI-compatible serializer (`toOpenAIChat`) is a near-identity passthrough, and the **Anthropic / Gemini bridges translate** — but the Anthropic bridge in particular has to **upcast**: it reconstructs richer concepts the contract can't natively express. The tells:

- Structured output on Anthropic is **faked** as a forced tool (`STRUCTURED_OUTPUT_TOOL_NAME`) because the contract has no native JSON-constraint Anthropic understands.
- Signed reasoning (`reasoning_block`) and `pause_turn` were **bolted onto** an OpenAI-shaped envelope as the contract discovered it was conceptually poorer than the richest provider it serves.
- `toAnthropicMessages` is ~1.4k lines, much of it reconstructing structure (content blocks, `tool_use`/`tool_result`, signed thinking) from a flat OpenAI-shaped source.

Upcasting (inventing a richer capability from a poorer shape) is fragile; downcasting (dropping/flattening from a richer shape) is safe. The contract currently makes the **richest** provider upcast.

## Decision

Migrate the neutral contract toward an **Anthropic-conceptual block model** as the canonical interchange:

- Messages carry **typed content blocks** (`text`, `image`, `thinking`, `tool_use`, `tool_result`) rather than a flat string + OpenAI content parts.
- Images use the **Anthropic-canonical** `source` shape (`{ type: 'base64', media_type, data }` / `{ type: 'url', url }`), not OpenAI `image_url`.
- Structured output, signed reasoning, and tool calls/results become **native fields/blocks**, not bolt-ons or fakes.

Every serializer — **including the OpenAI one** — then becomes a peer that **downcasts** from the rich hub. The Anthropic bridge thins toward identity; `toOpenAIChat` grows the flattening logic (blocks → `content` + `tool_calls` + `role: tool`). Total translation complexity is expected to drop, and — more importantly — no serializer fabricates capabilities anymore.

### Why (and why now-ish)

- **Downcast > upcast.** Losing detail for a poorer provider is mechanical and safe; inventing detail for a richer one is where the bugs and fakes live.
- **Claude-centric product.** Push's defaults and lead agent are Claude. Modeling the hub on the frontier provider means new Claude capabilities land natively instead of as the next bolt-on.
- **Honest framing:** the sole maintainer/user reaches Claude *sparingly, through OpenAI-compatible adapters*, so this is **not** a token-cost optimization — it's a design-stability bet, pursued deliberately (and, candidly, because it's the interesting and better-structured design).

### Non-goals

- **Not** making the Anthropic *wire* path the cheap/identity path. The OpenAI-compatible wire stays first-class — it's the path real traffic (Claude-via-adapter included) travels. This is about the contract's **conceptual model**, not which provider gets zero-translation.
- **Not** a big-bang. No long-lived broken branch. Every slice ships green.
- **Not** a third "fully neutral" shape — that would tax all paths. We adopt the richest *real* dialect's conceptual model.

## Slice plan (green at every step)

Each slice is independently shippable, behind the additive-field pattern already used for `contentParts` / `reasoningBlocks` (adapters prefer the new field, fall back to the old one). The producer that emits blocks in production is flipped **last**, after every serializer handles every block variant.

1. **Block vocabulary + additive field** *(this slice)* — add `LlmContentBlock` (`text`, `image` in Anthropic-canonical shape) and `contentBlocks?` on `LlmMessage`; wire `toOpenAIChat` to downcast it (image block → `image_url`). No production producer yet; exercised by tests. Demonstrates the downcast direction on the easy case.
2. **`thinking` block** — extend the union; Anthropic bridge reads it natively, OpenAI/Gemini drop it. Folds `reasoningBlocks` toward the unified block stream.
3. **Native structured output** — express the JSON constraint natively for Anthropic (delete the forced-tool fake), map to `response_format` for OpenAI-compat.
4. **`tool_use` / `tool_result` blocks** — define them; Anthropic bridge near-identity, Gemini maps to `functionCall`/`functionResponse`.
5. **OpenAI downcast of tool blocks** *(the boss fight)* — flatten interleaved blocks into OpenAI's split `content` + `tool_calls[]` + `role: tool` representation, ordering-correct. Scheduled here, once the contract has settled — not first.
6. **Flip the producer + thin the bridge** — context materialization emits blocks in production; delete the now-dead upcast code from `toAnthropicMessages`; lift `cache_control` into a neutral marker; doc-honesty pass; promote this doc to **Current**.

## Status / graduation

Phase 1 (slice 1) lands as a standalone change. Slices 2–6 each need their own review; promoting past slice 1 needs a `ROADMAP.md` entry per this folder's convention. Until then this is design-in-motion, not a commitment.
