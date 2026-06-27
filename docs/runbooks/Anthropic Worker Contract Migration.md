# Anthropic Worker Contract Migration

Date: 2026-06-09
Status: **in progress** — Step 0 (multimodal serializer), Steps 1–2 (wire type,
neutral validator, dual-accept on all four handlers), and **Step 3 for
Anthropic + Gemini + Vertex-native** (those web clients now send
`push.stream.v1`; the **Zen-Go client flip is the remaining Step-3 item**)
shipped, plus two post-flip fixes (#854 route-authoritative `provider` stamp,
#857 Zen-Go model-in-body). Step 4 (bake) is **running** — every dual-accept
handler logs `contract: "legacy" | "neutral"` on its request line; Step 5
(drop legacy) waits on that telemetry reading zero legacy.
Owner: Push

This is the Phase 3 "risky part" called out in
[`Provider Request Normalization.md`](<Provider Request Normalization.md>): moving
the **web client ↔ Worker** contract for Anthropic chat off the OpenAI Chat
Completions shape. Phase 2 already did this for the CLI (in-process, zero
contract risk). The web path is harder because the OpenAI shape is a real
network contract between a long-lived browser client and an
atomically-deployed Cloudflare Worker — the two cannot change in lockstep.

## Wire status by provider (as of #857)

The system currently runs three wire regimes. This table is the map — update it
whenever a client flips or a handler changes regime.

| Provider route | Web client → Worker (request) | Worker handler | Worker → client (response) | CLI |
|---|---|---|---|---|
| Anthropic `/api/anthropic/chat` | neutral `push.stream.v1` (#852) | dual-accept | OpenAI SSE (`createAnthropicTranslatedStream`) | neutral end-to-end (in-process, no wire) |
| Gemini `/api/google/chat` | neutral (#853) | dual-accept | OpenAI SSE (`createGeminiTranslatedStream`) | neutral end-to-end |
| Vertex `/api/vertex/chat` — native mode | neutral, both transports (#856) | dual-accept | OpenAI SSE | — |
| Vertex — legacy upstream-base mode | OpenAI shape | `handleLegacyVertexChat`, no dual-accept | OpenAI SSE | — |
| Zen-Go `/api/zen/go/chat` | **OpenAI shape — client flip pending** | dual-accept (#851, neutral branch dormant) | OpenAI SSE | — |
| OpenAI, OpenRouter, Ollama, NVIDIA, Kilo, Azure, Bedrock, Zen | OpenAI shape | `createStreamProxyHandler`, no dual-accept | OpenAI SSE | CLI OpenAI-compat path builds via `toOpenAIChat` |

The **response** column is uniformly OpenAI SSE on the web — the response-axis
migration (Phase 3a for the web Worker) has not started; only the CLI parses
provider SSE directly into neutral `PushStreamEvent`s.

## Current contract (what we're migrating)

The OpenAI Chat Completions JSON is the wire format in **both directions**:

**Request** — the client hand-shapes its `PushStreamRequest` into an OpenAI body
and POSTs it. `app/src/lib/anthropic-stream.ts:59`:

```ts
const body = {
  model: req.model,
  messages: llmMessages,
  stream: true,
  ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
  ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  ...(req.topP !== undefined ? { top_p: req.topP } : {}),
  ...(anthropicWebSearch ? { anthropic_web_search: true } : {}),
};
// POST PROVIDER_URLS.anthropic.chat  →  /api/anthropic/chat
```

**Worker** — `handleAnthropicChat` (`app/src/worker/worker-providers.ts:1274`)
validates the OpenAI shape (`validateAndNormalizeChatRequest`, which also clamps
`max_tokens` to the route's `maxOutputTokens` policy), calls
`buildAnthropicMessagesRequest(parsedRequest)` to translate to the native
`/v1/messages` body, injects `x-api-key` + `anthropic-version: 2023-06-01`, and
returns `createAnthropicTranslatedStream(upstream, model)`.

**Response** — the Worker translates Anthropic's native SSE back into **OpenAI
SSE** so the client's `openAISSEPump` can read it unchanged.

Three Worker endpoints share this exact recipe (`validateAndNormalizeChatRequest`
→ `buildAnthropicMessagesRequest` → `createAnthropicTranslatedStream`): direct
Anthropic, Vertex-Anthropic (`anthropicVersion: 'vertex-2023-10-16'`,
`app/src/worker/worker-providers.ts:959`), and Zen-Go-Anthropic
(`app/src/worker/worker-providers.ts:616`).

**Security seam (must be preserved):** the Anthropic API key never reaches the
browser — the Worker injects it. Any new contract keeps key injection and token
clamping Worker-side.

## Why this is the risky part

A Cloudflare Worker deploy is effectively atomic server-side, but **browser
clients are long-lived**. During and after a deploy:

- An open tab runs the **old client JS** and keeps POSTing the **old shape** to
  the **new Worker**.
- A freshly loaded tab runs the **new client** against the **new Worker**.

So the new Worker MUST accept the old shape for as long as old tabs survive
(realistically days). The two sides cannot flip together. This is the whole
reason Phase 2 stopped at the CLI and left this for a dedicated plan.

## Target contract

Send the **neutral request on the wire** and let the Worker serialize to the
provider with the Phase 2 `toAnthropicMessages` (and, later, `toGemini…`). The
wire body is the **serializable subset** of `PushStreamRequest` — explicitly
*not* `signal`, `onPreCompact`, `onSessionDigestEmitted`, or `workspaceContext`
(callbacks/abort/opaque runtime context never cross the wire). Define this as a
named `PushStreamRequestWire` type in `lib/` so client and Worker share one
definition and a drift test pins it (per the new-feature checklist in
`CLAUDE.md`).

### Prompt materialization stays client-side (the wire carries materialized messages)

A correction surfaced in review (#841): the web adapter does **not** send
`req.messages` raw. `anthropicStream` first runs
`toLLMMessages(req.messages, { workspaceContext, hasSandbox, systemPromptOverride,
scratchpadContent, todoContent, linkedLibraryContent, sessionDigestOptions, … })`,
which **materializes** repo/tool instructions, sandbox mode, scratchpad/todo/library
context, and the session digest into the `messages` that go over the wire (today's
OpenAI `messages` array *is* that `toLLMMessages` output). `toAnthropicMessages`
only serializes the messages it is handed — it rebuilds none of that.

So the wire carries the **materialized** `LlmMessage[]`, exactly as today — not raw
`req.messages` plus a `workspaceContext` for the Worker to re-materialize.
`workspaceContext`, `scratchpadContent`, `todoContent`, `linkedLibraryContent`, and
the session-digest inputs are **materialization inputs consumed client-side**;
like `signal` and the callbacks, they never cross the wire (true today, unchanged
here). The migration is therefore a pure **envelope reshape** — the OpenAI scalar
fields + Push-private sidecars (`max_tokens`/`temperature`/`top_p`,
`reasoning_blocks`, `anthropic_web_search`, manual `cache_control` tagging) become
neutral scalar fields (`maxTokens`/`temperature`/`topP`, `reasoningBlocks`,
`anthropicWebSearch`, `cacheBreakpointIndices`) around the **same** materialized
messages. Materialization is orthogonal and stays put.

**Consequence for `PushStreamRequestWire`:** its `messages` are already
materialized (the system prompt baked in by `toLLMMessages`), so it must **not**
also carry `systemPromptOverride` — passing both would double the system prompt
when `toAnthropicMessages` hoists it. The Worker calls `toAnthropicMessages(wire,
{ … })` with **no** `systemPromptOverride`. The reviewer's alternative — moving
`toLLMMessages` into the Worker — is **rejected**: it would drag `workspaceContext`,
sandbox state, and the memory stores server-side (the runtime context that is
deliberately client-resident) for no benefit to this migration.

Why neutral beats both today's OpenAI-shape and an Anthropic-native wire:

- **It carries Push's intent losslessly.** `cacheBreakpointIndices`,
  `anthropicWebSearch`, and `reasoningBlocks` are first-class on
  `PushStreamRequest`. Today the client flattens them into OpenAI-shape
  *sidecars* (`reasoning_blocks`, `anthropic_web_search`, manual
  `cache_control` tagging) and the Worker reconstructs them — a lossy,
  Push-private hack bolted onto someone else's schema. Neutral deletes that
  round-trip.
- **It's provider-general.** One neutral endpoint can dispatch to any provider
  serializer server-side, which is the end-state for Vertex/Zen-Go/Gemini/OpenAI
  too — versus an Anthropic-native wire that only solves one provider and pushes
  validation + key-adjacent shaping toward the client.
- **The key and token clamp stay Worker-side**, unchanged.

The response/SSE contract (OpenAI SSE → neutral `PushStreamEvent`) is a
**separate** axis — tracked as Phase 3a in the parent runbook and migratable
independently. This doc covers the **request** contract only; the Worker keeps
emitting OpenAI SSE until 3a lands, so `openAISSEPump` on the client is
untouched here.

## Migration sequence (safe under rolling deploys)

Each step is independently shippable and backward-compatible. **Worker changes
ship before client changes**, never the reverse.

0. **Multimodal serializer prerequisite (✅ shipped, separate PR).** Before any of
   this, `toAnthropicMessages` had to be able to carry the web transcript's
   **image** content — it previously consumed only string-content `LlmMessage`s.
   `LlmMessage` now has an additive optional `contentParts` (text/image) field and
   `toAnthropicMessages` serializes it, **failing loudly** on unsupported parts so
   images are never silently dropped. See the *Multimodal follow-up* note in
   [`Provider Request Normalization.md`](<Provider Request Normalization.md>). Without
   this, Step 2's neutral branch would have dropped images on picture chats.

1. **`PushStreamRequestWire` type + neutral validator (lib, no behavior change). ✅ Shipped.**
   `lib/provider-wire.ts` holds the `push.stream.v1` discriminator constant + the
   `PushStreamRequestWire` / `PushStreamWireMessage` types (neutral camelCase;
   no `id`/`timestamp`/`systemPromptOverride`). `validateAndNormalizeWireRequest`
   sits beside `validateAndNormalizeChatRequest` in
   `app/src/lib/chat-request-guardrails.ts`, sharing its policy (the same
   `maxOutputTokens` clamp, message/part caps) and helpers
   (`normalizeReasoningBlocks`, `pickCacheControl`). It normalizes the wire body
   into a `PushStreamRequest<LlmMessage>` — array `content` becomes
   `contentParts` (multimodal, per Step 0). Unit-tested in
   `chat-request-guardrails.test.ts`.

2. **Worker dual-accept. ✅ Shipped.** `handleAnthropicChat` peeks the body for
   `contract: "push.stream.v1"`: present → `validateAndNormalizeWireRequest` →
   `toAnthropicMessages` (a content part it can't represent maps to a **400**,
   not a 502); absent → today's `validateAndNormalizeChatRequest` →
   `buildAnthropicMessagesRequest`, unchanged. Both converge on
   `{ upstreamBody, model }` and the existing fetch/translate code (response stays
   OpenAI SSE — the response axis is unchanged here). A symmetric `request` log on
   both branches carries `contract: "legacy" | "neutral"` for step-5 telemetry.
   **Deployed clients are unaffected** — they send no discriminator and hit the
   legacy branch verbatim, so the neutral branch is dormant until the client flip.
   Verified by the handler suite in `worker-providers.test.ts` (neutral routing,
   multimodal, token clamp, loud-fail→400, and the unchanged legacy path); the
   live Worker/browser path is not exercisable from CI, but nothing reachable
   changes until a client sends the discriminator.

   **Shared dispatch + Google.** The peek+validator-selection is now
   `parseDualAcceptRequest` (in `chat-request-guardrails.ts`): it returns a
   discriminated `{ contractKind: 'neutral', request } | { contractKind:
   'legacy', parsed }`, and each handler does its own provider serialization off
   it (model-in-body vs model-in-URL, transport, loud-fail→400). `handleAnthropicChat`
   was re-pointed onto it (its tests prove no regression) and **`handleGoogleChat`
   now dual-accepts** too (neutral → `toGeminiGenerateContent`; the wire gained a
   `googleSearchGrounding` flag for native grounding). Both backward-compatible
   and dormant.

   **`emitModel: false` shipped, `handleZenGoChat` now dual-accepts.** The
   prerequisite — `toAnthropicMessages({ emitModel: false })`, which suppresses
   the top-level `model` while keeping the sampling-capability gate on the
   resolved model — landed, and Zen-Go was cut onto `parseDualAcceptRequest`
   across **both** transports: the anthropic transport (`minimax-*`/`qwen3.*`)
   serializes via `toAnthropicMessages({ emitModel: false })` to match its
   model-omitting `/v1/messages` body, and the OpenAI-compat transport
   (`glm-*`/`kimi-*`/etc.) serializes via `toOpenAIChat`. Legacy bodies still
   forward verbatim (`buildAnthropicMessagesRequest` / raw `bodyText`).
   Backward-compatible and dormant.

   **Vertex ✅ cut (both transports).** Same recipe: anthropic transport →
   `toAnthropicMessages({ emitModel: false, anthropicVersion: 'vertex-2023-10-16' })`,
   OpenAI-compat transport → `toOpenAIChat` + the `googleSearch` grounding
   injection (extracted into the shared `appendVertexGoogleSearchTool` so the
   legacy `translateVertexOpenApiBody` and the neutral branch inject identically).
   The native path is tested by partial-mocking `getGoogleAccessToken` (the only
   heavy dependency — JWT signing + OAuth) while running the real
   `getVertexNativeConfig` / service-account-header decode. **All four server
   handlers (Anthropic, Google, Zen-Go, Vertex) now dual-accept.**

3. **Flip the client adapter. ✅ Shipped for Anthropic + Gemini + Vertex (native).**
   `app/src/lib/anthropic-stream.ts` still runs `toLLMMessages` first (see
   "Prompt materialization stays client-side"), then serializes the neutral wire
   via the shared `toPushStreamWire` (`lib/provider-wire.ts`) — materialized
   `messages` + neutral scalars, `contract: "push.stream.v1"` — instead of an
   OpenAI-shaped body. New tabs send neutral; old tabs still send legacy; the
   Worker handles both. The client keeps consuming OpenAI SSE (response axis
   unchanged).

   **Pause-turn replay went neutral too.** The web-search `pause_turn`
   continuation used to append an inline `assistant_content_blocks` message; the
   raw Anthropic content[] (tool_use / web_search blocks) can't re-materialize as
   text, so the wire gained an opaque `replayAssistantTurns` passthrough field
   (validated shape-only). The Worker forwards it to `toAnthropicMessages`'
   `replayAssistantTurns` option, which appends the turns verbatim. Prefix-cache
   breakpoints are deliberately NOT sent on this path — the legacy body never
   carried them, so enabling web prefix caching stays a separate change.

   **`toPushStreamWire` is the single forward serializer** (the inverse of
   `validateAndNormalizeWireRequest`), pinned by a round-trip drift test.
   **`app/src/lib/gemini-stream.ts` now flips through it too** — same serializer,
   only the `googleSearchGrounding` flag differs (no pause-turn loop, that's
   Anthropic-specific). That cut also closed the sibling system-prompt gap
   defensively: `toGeminiGenerateContent` now reads `contentParts` for the system
   role (google isn't cacheable so it isn't a live bug like Anthropic's was, but
   it's the same asymmetry — fixed proactively).

   **`app/src/lib/vertex-stream.ts` flips conditionally.** Vertex carries both
   Claude and Gemini under one provider, and its **native** mode hits the
   dual-accept `handleVertexChat` — so native sends the neutral wire (both search
   flags ride along; the server picks the transport by model), with the
   pause-turn loop accumulating `replayAssistantTurns`. Its **legacy** mode
   (`X-Push-Upstream-Base`) falls through to `handleLegacyVertexChat`, which does
   NOT dual-accept, so legacy keeps the OpenAI-shape body. A test pins both
   sides (native → `push.stream.v1`, legacy → OpenAI shape).

   **Still pending in Step 3: the Zen-Go client.** `zenStream`
   (`app/src/lib/zen-stream.ts`) still builds the OpenAI-shape body for the Go
   endpoint; `handleZenGoChat`'s neutral branch (shipped in #851) is dormant
   until that flip.

   **Post-flip fixes (both shipped).** #854: the neutral validator stamps the
   **route-authoritative** `provider` from `ChatRequestPolicy.provider` — the
   body's optional `provider` field is never trusted (it exists only for the
   future provider-agnostic endpoint). #857: the Zen-Go anthropic transport
   **must** emit `model` in the body — unlike Vertex (model rides the URL path),
   Zen-Go's `/v1/messages` is one fixed shared URL, so a model-less body can't
   be dispatched upstream. The earlier "model is out-of-band on anthropic
   transports" assumption was Vertex-only.

4. **Bake (running now).** Each dual-accept handler emits a `request` log line
   carrying `contract: "legacy" | "neutral"` (plus `route` and `model`). Watch
   the legacy share decay toward zero as old tabs close. No code change; just
   telemetry.

5. **Drop legacy (ship once legacy ≈ 0).** Remove the legacy branch + the
   OpenAI-shape path for this endpoint; the client OpenAI-shaping is already gone
   (step 3). `buildAnthropicMessagesRequest` stays only for any remaining
   internal callers; if none, it and the OpenAI-detour test scaffolding retire
   with it.

**Endpoint shape:** keep the provider-specific path `/api/anthropic/chat` for
this cut (least blast radius). A later, optional consolidation to a single
provider-agnostic `/api/chat/stream` carrying `provider` in the neutral body is
the natural end-state once Gemini/OpenAI are on neutral too — call it out, don't
do it here.

## Risks & review-checklist guards

Mapped to the recurring defect classes in `CLAUDE.md` → PR self-review:

- **Auth seam.** Key injection stays Worker-side on both branches — trace one
  allowed (key present → upstream) and one denied (key missing → the existing
  `keyMissingError`) path through the neutral branch, and confirm the neutral
  validator can't smuggle a body field that bypasses key injection.
- **Token clamp.** The neutral validator MUST apply the same `maxOutputTokens`
  ceiling as `validateAndNormalizeChatRequest` (route passes `12_288` for
  Anthropic). A neutral body with a huge `maxTokens` is a regression vector if
  the clamp is forgotten — pin it with a test.
- **HTTP status classification.** The neutral validator returns the same
  `{ status, error }` discrimination (400 malformed vs 401 no key vs 413 too
  large) — don't collapse to a generic 400.
- **Error-formatting.** Upstream Anthropic error bodies must not be forwarded
  verbatim to the browser any more than they are today — reuse the existing wrap.
- **Discriminator spoofing / drift.** `contract: "push.stream.v1"` is a single
  versioned constant in `lib/`; the drift-detector test pins the wire type so a
  field added to `PushStreamRequest` doesn't silently fail validation on the
  Worker.
- **Symmetric logs.** The `request` line (with `contract: "legacy" | "neutral"`)
  is emitted on *both* branches, not just one — it's load-bearing for step 5.

## Scope boundaries

- **Response/SSE (Phase 3a)** — separate axis; out of scope here. The web
  Worker still emits OpenAI SSE on every route (see the wire-status table).
- **Zen-Go** — server ✅ cut (both transports); **client flip pending**.
  **Vertex** — ✅ cut end-to-end in native mode (both transports).
- **Gemini** — ✅ cut end-to-end (server #849, client #853). **OpenAI** and the
  other `createStreamProxyHandler` providers have no dual-accept yet; the
  provider-agnostic endpoint consolidation is the convergence point.

## References

- [`Provider Request Normalization.md`](<Provider Request Normalization.md>) — parent plan (Phase 3)
- `app/src/lib/anthropic-stream.ts` — web client adapter (the shaping seam)
- `app/src/worker/worker-providers.ts` — `handleAnthropicChat` + Vertex/Zen-Go siblings
- `app/src/lib/chat-request-guardrails.ts` — `validateAndNormalizeChatRequest` (token clamp, validation)
- `lib/anthropic-bridge.ts` — `toAnthropicMessages` (Phase 2 serializer the Worker will call), `buildAnthropicMessagesRequest` (legacy branch)
- `lib/provider-contract.ts` — `PushStreamRequest` / `PushStreamEvent`
