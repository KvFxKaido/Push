# Provider Contract — Anthropic-Conceptual Neutral Hub

Status: **Current**, added 2026-06-24, producer flip landed 2026-06-25. The Anthropic-conceptual block model is defined, all three serializers (OpenAI / Anthropic / Gemini) consume it, and the producer materializes `contentBlocks` for multimodal turns in production (`lib/content-blocks.ts`), so the block path is live. Intentionally scoped: plain-text and fenced-tool-call turns keep their `content` string / `reasoningBlocks` sidecar — routing those through blocks would array-ify a string the legacy path emits verbatim, with no benefit. Sourcing tool calls as structured `tool_use`/`tool_result` blocks (rather than fenced text) is a separate, larger feature, tracked below — not part of this migration.

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

## Slice plan (shipped)

Each slice shipped independently, behind the additive-field pattern already used for `contentParts` / `reasoningBlocks` (adapters prefer the new field, fall back to the old one). The producer flip landed last, after every serializer handled every block variant.

1. ✅ **Block vocabulary + additive field** (#1147) — `LlmContentBlock` (`text`, `image` Anthropic-canonical) + `contentBlocks?` on `LlmMessage`; `toOpenAIChat` downcast.
2. ✅ **`thinking` block** (#1148) — reused `ReasoningBlock` verbatim; OpenAI drops it.
3. ✅ **`tool_use` / `tool_result` blocks + OpenAI flatten** (#1149) — the boss fight: one neutral message → `content` + `tool_calls[]` + `role: tool`.
4. ✅ **Anthropic bridge reads blocks** (#1150) — the near-identity direction; `is_error` preserved.
5. ✅ **Gemini bridge reads blocks** (#1151, #1152) — text/image/thinking, then `functionCall`/`functionResponse` with id correlation.
6. ✅ **Producer flip** — `lib/content-blocks.ts` (`deriveContentBlocks` / `withContentBlocks`) materializes `contentBlocks` for multimodal turns at the three serializer front-doors, so the block path is **live in production** (byte-identical to the legacy `contentParts` path).

> Note: slice "native structured output" from the original plan was dropped — `ResponseFormatSpec` is already neutral and Anthropic's forced-tool is idiomatic, not a fake.

## Intentionally out of scope (not part of this migration)

- **Plain-text / fenced-tool-call turns stay on `content` / `reasoningBlocks`.** Routing them through blocks would array-ify a string the legacy path emits verbatim, with no benefit — so the flip is scoped to multimodal turns. The serializers keep their legacy string path for these (not dead code).
- **Structured tool-call sourcing.** Tool calls round-trip as fenced JSON *text* in `content` today (the tool protocol). Emitting them as structured `tool_use`/`tool_result` blocks — which is what would let the Anthropic bridge shed its tool reconstruction — is a separate feature touching the round loop and transcript storage, not this contract refactor.
- ✅ **`cache_control` → neutral marker — shipped (#1154 §2).** The inline `{ type: 'ephemeral' }` literal is centralized as the `CacheControl` type + `EPHEMERAL_CACHE_CONTROL` value in `provider-contract.ts`; every contract type and serializer references the single source (pinned by `provider-contract.test.ts`). No behavior change.
- **Full bridge thinning** (deleting the legacy `contentParts` / plain-`content` branches) — still a follow-up, hard-gated on the structured-tool-call work above (those turns still legitimately travel the legacy arms).
