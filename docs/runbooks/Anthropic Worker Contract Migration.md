# Anthropic Worker Contract Migration

Date: 2026-06-09
Status: **draft** (design-in-motion; needs roadmap promotion before implementation)
Owner: Push

This is the Phase 3 "risky part" called out in
[`Provider Request Normalization.md`](<Provider Request Normalization.md>): moving
the **web client ↔ Worker** contract for Anthropic chat off the OpenAI Chat
Completions shape. Phase 2 already did this for the CLI (in-process, zero
contract risk). The web path is harder because the OpenAI shape is a real
network contract between a long-lived browser client and an
atomically-deployed Cloudflare Worker — the two cannot change in lockstep.

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
`worker-providers.ts:959`), and Zen-Go-Anthropic (`:616`).

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

1. **`PushStreamRequestWire` type + neutral validator (lib, no behavior change).**
   Add the wire type and a `validateAndNormalizeWireRequest` beside the existing
   `validateAndNormalizeChatRequest`, sharing the clamping/model/token policy so
   the neutral path enforces the *same* `maxOutputTokens` ceiling and model
   checks. Unit-tested in isolation. Ships dormant.

2. **Worker dual-accept (ship FIRST).** In `handleAnthropicChat` (and the Vertex
   / Zen-Go siblings), branch on a discriminator: a top-level
   `"contract": "push.stream.v1"` field on the body. Present → parse with the
   neutral validator and serialize via `toAnthropicMessages`. Absent → today's
   `validateAndNormalizeChatRequest` → `buildAnthropicMessagesRequest`
   (unchanged). Emit a structured log per request tagging which contract was
   used (`worker_anthropic_contract: "legacy" | "neutral"`) so step 5 has data.
   A body field (not a header) is the discriminator because the validator parses
   the body anyway and intermediaries can strip headers. **Old clients are
   unaffected** — they send no discriminator and hit the legacy branch verbatim.

3. **Flip the client adapter (ship after step 2 is live).**
   `app/src/lib/anthropic-stream.ts` stops OpenAI-shaping and instead serializes
   `PushStreamRequestWire` with `contract: "push.stream.v1"`. New tabs now send
   neutral; old tabs still send legacy; the Worker handles both. The client keeps
   consuming OpenAI SSE (response axis unchanged).

4. **Bake.** Watch `worker_anthropic_contract` — legacy share decays toward zero
   as old tabs close. No code change; just telemetry.

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
- **Symmetric logs.** The `worker_anthropic_contract` line is emitted on *both*
  branches (legacy ↔ neutral), not just one — it's load-bearing for step 5.

## Scope boundaries

- **Response/SSE (Phase 3a)** — separate axis; out of scope here.
- **Vertex-Anthropic and Zen-Go-Anthropic** — same recipe, same dual-accept
  pattern, but follow as separate cuts after the direct path proves the shape.
- **Gemini / OpenAI** — get the same neutral wire once Anthropic lands; the
  provider-agnostic endpoint consolidation is the convergence point.

## References

- [`Provider Request Normalization.md`](<Provider Request Normalization.md>) — parent plan (Phase 3)
- `app/src/lib/anthropic-stream.ts` — web client adapter (the shaping seam)
- `app/src/worker/worker-providers.ts` — `handleAnthropicChat` + Vertex/Zen-Go siblings
- `app/src/lib/chat-request-guardrails.ts` — `validateAndNormalizeChatRequest` (token clamp, validation)
- `lib/openai-anthropic-bridge.ts` — `toAnthropicMessages` (Phase 2 serializer the Worker will call), `buildAnthropicMessagesRequest` (legacy branch)
- `lib/provider-contract.ts` — `PushStreamRequest` / `PushStreamEvent`
