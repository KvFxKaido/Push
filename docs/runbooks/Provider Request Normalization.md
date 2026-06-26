# Provider Request Normalization

Date: 2026-06-09
Status: **in progress** — Phases 1–2, the `toOpenAIChat` peer serializer, and
Phase 3a (CLI direct SSE→events, Anthropic + Gemini) shipped. The Phase 3
**request** axis shipped for Anthropic, Gemini, and Vertex-native (Zen-Go
client flip pending) — see
[`Anthropic Worker Contract Migration.md`](<Anthropic Worker Contract Migration.md>)
for the per-provider wire-status table. The remaining work is the **web
response axis** (the Worker still re-emits OpenAI SSE) and the long proxy tail.
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
  `lib/anthropic-bridge.ts`): forwarded whatever the caller set.
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
fire. Pin with a unit test in `lib/anthropic-bridge.test.ts`. **✅ Shipped.**

**Phase 2 — direct Anthropic serializer. ✅ Shipped.**
`toAnthropicMessages(PushStreamRequest)` (in `lib/anthropic-bridge.ts`)
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
drift-test corpus in `lib/anthropic-bridge.test.ts`, and the CLI adapter's
body-capture suite (`cli/tests/anthropic-stream.test.mjs`) is the independent
oracle for the cache-tagging edges.

*Multimodal follow-up (✅ shipped).* `LlmMessage` gained an additive optional
`contentParts` field (`string | text/image parts`; `content` stays the text
string every existing reader uses, so zero ripple). `toAnthropicMessages`
serializes `contentParts` when present — preserving text + image content
(base64 `data:` URLs → base64 source, `http(s)` URLs → url source) and tagging
the last text part for cache breakpoints. Crucially it **fails loudly** (throws)
on an unsupported or malformed part rather than silently dropping it, the way
the legacy OpenAI-shape converter does. This is the prerequisite that lets the
neutral wire carry the web transcript's existing multimodal payloads — without
it, the Worker request-contract migration (below) would have dropped images.

**Phase 3 — two axes, then retire the OpenAI-canonical assumption.**
- *Request contract (web).* Move the web client↔Worker request body off OpenAI
  shape onto the neutral wire so the Worker serializes via `toAnthropicMessages`
  (Phase 2) instead of `buildAnthropicMessagesRequest`. This is the risky part —
  it's a network contract between a long-lived browser client and an
  atomically-deployed Worker — so it has its own plan:
  [`Anthropic Worker Contract Migration.md`](<Anthropic Worker Contract Migration.md>).
- *Response contract (SSE). ✅ Phase 3a shipped (CLI).* `anthropicEventStream`
  (in `lib/anthropic-bridge.ts`) parses Anthropic SSE **directly** into
  `PushStreamEvent`s — no OpenAI-SSE intermediate. `cli/anthropic-stream.ts` now
  consumes it, dropping the old `createAnthropicTranslatedStream → openAISSEPump`
  serialize-then-reparse round-trip. A drift-test corpus pins it event-for-event
  against that legacy path. The **web Worker still uses
  `createAnthropicTranslatedStream`** to emit OpenAI SSE over its response wire —
  that wire is the client↔Worker response contract, so flipping it has the same
  rolling-deploy risk as the request contract and lands with the response-axis
  half of the Worker-contract migration (at which point `createAnthropicTranslatedStream`
  is rebuilt on `anthropicEventStream` or retired). Until then both coexist,
  guarded by the drift test.

Repeat both for Gemini. Once no provider depends on OpenAI-shape as an
intermediate, delete the re-emit-to-OpenAI step and make `toOpenAIChat` an
explicit peer serializer.

## Gemini parity — Phases 2 + 3a ✅ shipped (Phase 1 N/A)

`toGeminiGenerateContent(PushStreamRequest)` (in `lib/gemini-bridge.ts`)
builds the `:generateContent` body straight from the neutral request —
`systemInstruction` hoist, `user`/`model` role rename, multimodal `contentParts`
(text + base64 image, **failing loudly** on a part it can't represent), and the
`user`-first padding + `generationConfig` assembly. A shared `assembleGeminiBody`
single-sources the request-field tail so it and `buildGeminiGenerateContentRequest`
can only diverge on message conversion.

**Phase 3a:** `geminiEventStream` parses the Gemini SSE stream **directly into
neutral `PushStreamEvent`s** (text-only — no reasoning blocks or pause_turn;
`stripTemplateTokens` applied for pump-parity). `cli/gemini-stream.ts` now
consumes `toGeminiGenerateContent` for the request **and** `geminiEventStream` for
the response, dropping both the OpenAI-shape request round-trip and the
`createGeminiTranslatedStream → openAISSEPump` response round-trip. The web Worker
keeps `createGeminiTranslatedStream` for its OpenAI-SSE response wire until the
response-contract migration. Pinned by drift corpora (request-side string-content
equivalence + response-side event-for-event equivalence with the legacy path),
multimodal tests, and the unchanged CLI body-capture suite.

**Phase 1 is a no-op for Gemini.** The Anthropic Phase 1 fixed Opus 4.7+
*removing* `temperature`/`top_p` (a 400). Gemini accepts `temperature`/`topP`/
`topK` across gemini-2.5 / gemini-3.x — there is no sampling-param removal, so
there's no capability gate to add. Gemini also has no inline prompt-cache markers
(its explicit-cache API is a separate endpoint), so `cacheBreakpointIndices` are
ignored, same as the legacy bridge.

## `toOpenAIChat` — the OpenAI peer serializer ✅ shipped

`toOpenAIChat(PushStreamRequest)` (in `lib/openai-chat-serializer.ts`) is the
third peer alongside `toAnthropicMessages` / `toGeminiGenerateContent`: it builds
an OpenAI Chat Completions body straight from the neutral request. OpenAI is
mostly identity — roles map 1:1 and `LlmContentPart` already *is* the OpenAI
`image_url` content-part shape — so the work is the explicit choices:
`reasoningBlocks` are dropped (the Push-private sidecar is OpenAI-compat-unsafe);
images pass through as `image_url` with **no** per-URL loud-fail (OpenAI accepts
data + http natively — only an unknown part type throws); and `cache_control`
tagging is gated behind `tagCacheBreakpoints` (OpenRouter→Anthropic routing only).

`cli/openai-stream.ts` now builds its `baseBody` via `toOpenAIChat` (passing
`tagCacheBreakpoints: config.id === 'openrouter'`), replacing ~80 lines of
hand-rolled message/cache building and gaining multimodal support for free; the
OpenRouter extras (`session_id`, `openrouter:web_search`, broadcast) still wrap
the base body. The CLI provider suite is the behavior oracle.

This unblocked the **Vertex / Zen-Go** dual-accept cut (✅ both shipped): their
non-anthropic transports are OpenAI-compat (not Gemini-native), so their
neutral branch serializes via `toOpenAIChat`. The `toAnthropicMessages`
`emitModel: false` option shipped with it — but note the model-location split
that #857 corrected: only **Vertex** carries the model out-of-band (in the URL
path), so only Vertex passes `emitModel: false`. **Zen-Go**'s `/v1/messages` is
one fixed shared URL — the model must ride the body on both its branches, or
upstream dispatch fails on every anthropic-transport model.

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
- `lib/anthropic-bridge.ts` — the current Anthropic translator (request + SSE)
- `lib/gemini-bridge.ts` — the current Gemini translator
- `lib/openai-sse-pump.ts` — the shared OpenAI SSE reader
- `cli/anthropic-stream.ts` — CLI native-Anthropic adapter
- `app/src/worker/worker-providers.ts` — Worker proxy + Vertex/Zen-Go call sites
