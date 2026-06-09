# Provider Request Normalization

Date: 2026-06-09
Status: **draft** (Phases 1 & 2 shipped; Phase 3 needs roadmap promotion)
Owner: Push

## Why this exists

Push's runtime already has a neutral, internal request type — `PushStreamRequest`
in `lib/provider-contract.ts` (provider, model, messages, maxTokens, temperature,
topP, signed reasoning blocks, cache breakpoints, …). But the **wire** canonical
form is OpenAI Chat Completions. Every non-OpenAI provider takes the long way
around:

```
PushStreamRequest
   → OpenAI Chat Completions shape (OpenAIChatRequest)
       → per-provider request translator (buildAnthropicMessagesRequest / buildGeminiGenerateContentRequest)
           → native provider API (/v1/messages, :streamGenerateContent)
       ← native SSE
   ← re-emitted as OpenAI SSE (createAnthropicTranslatedStream / createGeminiTranslatedStream)
   ← parsed by the shared openAISSEPump
```

OpenAI itself is the one provider that skips the bridge — it passes through
because the canonical form *is* its form. For Anthropic and Gemini we pay a
double translation (request out, SSE back) purely to keep `openAISSEPump` as the
single reader. Worse: Push talks to OpenAI via `/v1/chat/completions`, the
*older* primitive — not `/v1/responses` — so the shape we've enshrined as
canonical is already legacy.

This is the "tiny haunted OpenRouter in your basement" failure mode: normalizing
to one provider's endpoint furniture instead of to the app's own intent. The
concrete cost shows up as **the adapter forwarding fields the target API has
since removed** — see the bug below.

## The bug that motivated writing this down

Anthropic removed `temperature`, `top_p`, and `top_k` on Opus 4.7 and later
(Opus 4.8 inherits the same surface). Non-default values return a **400**, not a
warning. Because OpenAI Chat Completions carries `temperature`/`top_p` as
first-class fields, `buildAnthropicMessagesRequest` forwarded them blindly with
no model guard:

- **Web / Worker** (`buildAnthropicMessagesRequest` at
  `lib/openai-anthropic-bridge.ts`): forwarded whatever the caller set.
- **CLI** (`cli/anthropic-stream.ts`): set `temperature: req.temperature ?? 0.1`
  on *every* request, so selecting `claude-opus-4-7` on the CLI 400s on every
  turn — a live failure, not a latent one.

A request shape that knew per-model capabilities would never emit those fields.
The OpenAI-canonical tax is what let the bug exist. Phase 1 (below) fixes it at
the single choke point; Phases 2–3 remove the tax that produced it.

## Target shape (the direction)

Keep `PushStreamRequest` as the one neutral intent. Replace the
"normalize-to-OpenAI-first" wire step with **direct serializers from the neutral
shape**, one per provider family:

```ts
toAnthropicMessages(request: PushStreamRequest): AnthropicMessagesBody
toOpenAIChat(request: PushStreamRequest): OpenAIChatBody       // today's passthrough, made explicit
toGeminiGenerateContent(request: PushStreamRequest): GeminiBody
// later, if/when we adopt the newer OpenAI primitive:
toOpenAIResponses(request: PushStreamRequest): OpenAIResponsesBody
```

Each serializer owns its provider's quirks instead of inheriting OpenAI's:
- **Anthropic**: `max_tokens` required; `anthropic-version` header; signed
  thinking-block round-trip (already handled well — preserve it verbatim);
  per-model sampling-param capability (the bug); mid-conversation `role: "system"`
  messages (Opus 4.7+, beta) instead of editing the cached system prefix.
- **Gemini**: `systemInstruction`, `model` role rename, `generationConfig`.
- **OpenAI**: stays the cheap passthrough — but as an *explicit* serializer, not
  the implicit baseline everything else detours through.

Model-capability knowledge (which sampling params a model accepts, max output
ceiling, thinking modes) belongs in a **shared capability table** consumed by the
serializers — not hand-forwarded per call site. `lib/capabilities.ts` is already
taken by the tool/role permission system, so this is a sibling: a
provider/model capability table near `lib/provider-models.ts`.

The SSE side mirrors this: instead of re-emitting native events back into OpenAI
SSE for a single shared pump, each provider's translator emits the neutral
`PushStreamEvent` union directly. `provider-contract.ts` already defines that
union — the pump becomes one of several producers of it, not the sole reader.

## Sequencing (do not do this in one swing)

This is cross-surface (web + CLI both consume the bridge), so per CLAUDE.md's
new-feature checklist any new vocabulary needs a drift-detector test in the same
PR, and the scope resolver lives in `lib/` from day one.

**Phase 1 — stop the bleeding (shippable now, small).**
Add a shared `anthropicModelRejectsSamplingParams(model)` predicate and gate
`temperature`/`top_p` emission inside `buildAnthropicMessagesRequest`. Because
the CLI, Vertex, Zen-Go, and Worker-direct paths all build their wire body
through this function, the single fix covers every surface. Emit a structured
log on the strip (`anthropic_sampling_params_stripped`) so ops can see the guard
fire. Pin with a unit test in `lib/openai-anthropic-bridge.test.ts`. **✅ Shipped.**

**Phase 2 — direct Anthropic serializer. ✅ Shipped.**
`toAnthropicMessages(PushStreamRequest)` (in `lib/openai-anthropic-bridge.ts`)
builds the Anthropic body straight from the neutral request — system hoist,
message conversion, cache-control tagging, and request-field assembly in one
pass, with no OpenAI Chat Completions intermediate. The request-field tail
(max_tokens, stream, system flatten/array, the sampling gate, web search) is
single-sourced through a shared `assembleAnthropicBody` that both this and
`buildAnthropicMessagesRequest` call, so the two paths can only diverge on
message conversion. `cli/anthropic-stream.ts` now calls it directly (the CLI is
in-process, so adopting it there carries no client↔Worker contract risk; the
web client still POSTs OpenAI shape to the Worker — that's a Phase 3 contract
change). Equivalence with the old two-step path is pinned byte-for-byte by a
drift-test corpus in `lib/openai-anthropic-bridge.test.ts`, and the CLI adapter's
body-capture suite (`cli/tests/anthropic-stream.test.mjs`) is the independent
oracle for the cache-tagging edges.

**Phase 3 — native SSE → neutral events, then retire the OpenAI-canonical
assumption.**
Have `createAnthropicTranslatedStream` emit `PushStreamEvent` directly rather
than rebuilding OpenAI SSE chunks. Repeat Phases 2–3 for Gemini. Once no
provider depends on OpenAI-shape as an intermediate, delete the
re-emit-to-OpenAI step and make `toOpenAIChat` an explicit peer serializer.

## What NOT to change

- The signed thinking-block round-trip in `buildAnthropicMessagesRequest` /
  `createAnthropicTranslatedStream`. It's the one piece of the current bridge
  that's genuinely load-bearing and correct — extended thinking + tool use on
  Anthropic 400s on the second turn without it. Any serializer rewrite must
  carry it forward unchanged.
- Provider-managed state (OpenAI `previous_response_id` / conversation objects).
  Push owns its own deterministic loop, transcript packing, and tool state. The
  Anthropic "bring your own loop" model *is* Push's model — there's no reason to
  adopt provider-side conversation state, and doing so would add hidden state the
  runtime can't audit.

## References

- `lib/provider-contract.ts` — `PushStreamRequest`, `PushStreamEvent` (the neutral types)
- `lib/openai-anthropic-bridge.ts` — the current Anthropic translator (request + SSE)
- `lib/openai-gemini-bridge.ts` — the current Gemini translator
- `lib/openai-sse-pump.ts` — the shared OpenAI SSE reader
- `cli/anthropic-stream.ts` — CLI native-Anthropic adapter
- `app/src/worker/worker-providers.ts` — Worker proxy + Vertex/Zen-Go call sites
