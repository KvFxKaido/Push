# Push Protocol V1 (PMP) — Anthropic-Conceptual Neutral Provider Contract

Status: **Current**, added 2026-06-24, producer flips landed 2026-06-25, native tool-call dispatch landed 2026-06-25 (#1162/#1163), capability profile resolver and residual request-shape follow-through landed 2026-06-25 (#1164). The Anthropic-conceptual block model is defined, all three serializers (OpenAI / Anthropic / Gemini) consume it, and `lib/content-blocks.ts` materializes `contentBlocks` for multimodal turns plus complete, adjacent tool exchanges in production. Plain-text turns and degraded tool exchanges (legacy, malformed, split, or non-adjacent) keep their `content` string / `reasoningBlocks` sidecar; that text fallback is still live by design.

## Push Protocol V1 (PMP) — the named thesis

What the migration below has been building, said plainly so it can be committed to as a thing, not a vibe:

> **Push normalizes every model interaction into one Push-owned, Anthropic-*shaped* canonical protocol — typed content blocks, `tool_use` / `tool_result` blocks, and a provider-neutral event stream. Anthropic is the design muse and closest existing dialect; it is not the constitution. `anthropic.messages.create` is a downcast target like any other, not the contract.**

The protocol is the types in `lib/provider-contract.ts` (`LlmMessage`, `LlmContentBlock`, `LlmToolUseBlock`, `LlmToolResultBlock`, `PushStreamEvent`, `NativeToolCall`). Provider APIs are **border crossings**: a provider's native shape does not exist past its adapter. `toPush()` is the stream translators (`anthropicEventStream` / `geminiEventStream` / `openAISSEPump` → `PushStreamEvent`); `fromPush()` is the three serializers. The litmus: the same normalized transcript replays through Anthropic, OpenAI, and Gemini without the rest of Push knowing who produced it — which it now largely does, with capability-dependent forks (a native-tool model gets `tool_use` blocks; a text-dispatch model gets fenced text), not a single byte-identical wire.

### Load-bearing principles (the parts that are easy to get wrong)

1. **Two protocols, not one — keep them separate.** PMP is the **model wire**: what crosses a provider border (`LlmMessage` / `contentBlocks` / `PushStreamEvent`). It is *not* the **work ledger**: `ChatMessage` + cards + role-display phases + the file-awareness / working-memory state, which is what the UI and runtime track. `toLLMMessages` is the seam between them. Push's genuinely-Push concepts — phases, file refs with freshness, diff/commit/diagnostic artifacts — are the secret sauce, but they live in the **ledger**, never as content blocks on the provider request. The moment a `phase` or `artifact` block rides the wire, every adapter has to learn to ignore it and a UI concern has leaked into model I/O. Resist merging the two unions.
2. **Capability profiles decide degradation, not scattered provider-name checks.** `resolvePushCapabilityProfile(provider, model, route)` is now the request/stream-path seam for native tool calling, structured output, OpenAI-family wire transport, content blocks, reasoning-block replay, multimodal support, and context tier. Provider metadata lives underneath the resolver where it belongs, but callers should read the profile instead of re-deriving those gates locally. OpenRouter's `openaiWire` defaults models to `responses`: a full-roster probe showed the `/responses` beta serves essentially every live model with native fidelity (structured output enforced, tool calls, and its documented reasoning-event families), so the hand-curated seed allowlist was capability-obsolete. Replay-dependent DeepSeek/Kimi routes remain on Chat Completions until Push can persist their encrypted Responses reasoning items; dropping the existing plain `reasoning_content` sidecar would break multi-round tool use. The endpoint is still beta, so the Responses request path runs **responses-first with a chat fallback** (`streamResponsesWithChatFallback`, wired on all three lanes): a model that fails before producing output degrades to Chat Completions rather than failing the turn. Discoverable metadata can still force `chat` if a catalog ever advertises the split.
3. **The text-dispatch tier is permanent, not transitional.** "Everything capable becomes blocks; everything else stays text." Non-cooperating models emit fenced JSON in `content` and Push parses it forever (`lib/tool-call-parsing.ts` + recovery). Degraded/malformed/non-adjacent tool exchanges deliberately fall back to text. PMP is capability-tiered by design, not a single shape.
4. **Provider features get *promoted*, not quarantined.** A `providerMeta` / `native` escape hatch is right for diagnostics and replay, but history says interesting affordances do not stay quarantined — signed thinking (`reasoning_block`), `pause_turn`, server-tool web search, and native tool calls all got promoted into the core contract as first-class. Budget for that as the ongoing maintenance tax of being the customs office, not a rare event.

### What's left

The protocol exists and is live. The scattered capability gates now route through `PushCapabilityProfile`, the residual OpenAI-shaped request producers have been retired (`contentBlocks` carry Anthropic-shaped images, `ToolFunctionSchema` is flat/custom-tool-shaped), and `ResponseFormatSpec` remains the neutral `{ name, schema }` contract. Anthropic Messages now prefers native `output_config.format` on supported Claude models and keeps the forced-tool fallback for older/non-Claude Anthropic-transport routes. What remains is ongoing provider-border maintenance, not another contract flip.

## Context

At the start of this migration, the neutral provider contract (`lib/provider-contract.ts` — `PushStreamRequest` / `PushStreamEvent` / `LlmMessage`) was structurally its own type, but several **input sub-types were OpenAI-shaped**:

- `ToolFunctionSchema` was OpenAI's nested `{ type: 'function', function: { … } }`.
- `LlmContentPart` used OpenAI's `image_url: { url }` image shape.
- Structured output was modeled on OpenAI `response_format`, though the durable neutral contract is just `{ name, schema, strict? }`.

Before this migration, OpenAI was the canonical shape: the OpenAI-compatible serializer (`toOpenAIChat`) was close to a passthrough, and the **Anthropic / Gemini bridges translated** — but the Anthropic bridge in particular had to **upcast** richer concepts the contract couldn't natively express. The tells:

- Structured output on Anthropic was originally **faked** as a forced tool (`STRUCTURED_OUTPUT_TOOL_NAME`) because Anthropic had no native JSON-output API when the bridge was written. Modern Claude routes now use `output_config.format`; the forced tool remains the fallback.
- Signed reasoning (`reasoning_block`) and `pause_turn` were **bolted onto** an OpenAI-shaped envelope as the contract discovered it was conceptually poorer than the richest provider it serves.
- `toAnthropicMessages` carried the request and response translation burden for content blocks, signed thinking, structured output, pause turns, and native Anthropic tool-use responses.

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
4. ✅ **Anthropic bridge reads blocks** (#1150) — the native block direction; `is_error` preserved.
5. ✅ **Gemini bridge reads blocks** (#1151, #1152) — text/image/thinking, then `functionCall`/`functionResponse` with id correlation.
6. ✅ **Producer flip** — `lib/content-blocks.ts` (`deriveContentBlocks` / `withContentBlocks`) materializes `contentBlocks` for multimodal turns at the three serializer front-doors, so the block path is **live in production** (byte-identical to the legacy `contentParts` path).
7. ✅ **Structured tool-call sourcing** (#1154 §1, #1157-#1159) — round loops persist parsed tool calls/results as sidecars; complete adjacent exchanges materialize as native `tool_use` / `tool_result` blocks on neutral/block-aware requests.
8. ✅ **Serializer cleanup** (#1154 §3) — after request-level materialization became the single rich-content producer, the serializers dropped their duplicate local `contentParts` branches and kept only `contentBlocks` plus the permanent plain-text fallback.

> Note: the later #1164 follow-through kept `ResponseFormatSpec` neutral and modernized only the Anthropic implementation: native `output_config.format` where supported, forced-tool fallback where not.

## Intentionally out of scope (not part of this migration)

- **Plain-text / fallback tool turns stay on `content` / `reasoningBlocks`.** Routing plain strings through blocks would array-ify a string the legacy path emits verbatim, with no benefit. Malformed, split, legacy, and non-adjacent tool exchanges also deliberately degrade to text, because native tool blocks require stricter pairing/adjacency than the text-dispatch boundary.
- ✅ **Native dispatch convergence — shipped (#1162/#1163).** Native-tool providers now surface a structured `native_tool_call` event and dispatch via `detectNativeToolCalls`, skipping the fenced-text round-trip. The text-dispatch boundary is untouched and stays the path for non-cooperating models (additive, gated on native calls arriving).
- ✅ **`cache_control` → neutral marker — shipped (#1154 §2).** The inline `{ type: 'ephemeral' }` literal is centralized as the `CacheControl` type + `EPHEMERAL_CACHE_CONTROL` value in `provider-contract.ts`; every contract type and serializer references the single source (pinned by `provider-contract.test.ts`). No behavior change.
- **Full text-path deletion.** The serializer cleanup removed duplicate `contentParts` branches, but the plain-`content` fallback is permanent for text-only and degraded exchanges.
