# Vision Fallback for Non-Vision Models

Date: 2026-07-02
Status: **Draft** — spec only; implementation not started. Decision contract
tracked as §17 in [`Agent Runtime Decisions.md`](<../decisions/Agent Runtime Decisions.md>).
Owner: Push

## Why this exists

When the chat-locked model can't read images, Push currently refuses the send:
`validateComposerAttachments` (`app/src/hooks/useWorkspaceChatComposerController.ts`)
toasts an error when an image attachment meets
`getVisionCapabilitySupport === 'unsupported'`, and the capability awareness
block (`app/src/lib/model-capabilities.ts`, `buildModelCapabilityAwarenessBlock`)
tells the model to admit it can't see. That's honest, but it makes image
attachments unusable on text-only models (DeepSeek direct, most Ollama/NVIDIA
models, several OpenRouter picks) — on a mobile-first product where "screenshot
the error and paste it" is the dominant attachment gesture.

The fix is a **vision fallback**: route image attachments through a
vision-capable model that describes/OCRs them, and inject the description as
labeled text next to the attachment. The chat lock is not changed and the lead
model is not swapped — this is a runtime preprocessing capability, the same
shape as the Auditor's sidecar call, not a second brain.

Notably, **this does not require Modal or any GPU hosting**. Model inference
never runs in the sandbox; the sandbox backends (Cloudflare container / Modal)
only execute code. A vision fallback is one more provider call from the Worker,
and the zero-config default is already provisioned: `wrangler.jsonc` carries the
native Workers AI binding (`"ai": { "binding": "AI", "remote": true }`) and the
`cloudflare` provider path (`cloudflareStream` in
`app/src/worker/worker-providers.ts`) already calls `env.AI.run` with AI
Gateway routing.

## What Cloudflare offers (surveyed 2026-07-02)

Workers AI pricing: **$0.011 per 1,000 Neurons**, with **10,000 Neurons/day
free on both Free and Paid Workers plans** (resets 00:00 UTC). A single
describe/OCR call is one image plus a few hundred output tokens — fractions of
a cent, and typical usage sits inside the free allocation. AI Gateway
(caching/analytics) is already wired into the provider path, so fallback calls
inherit it.

Vision-capable models in the catalog, ranked for this use:

| Model | Notes |
|---|---|
| `@cf/meta/llama-4-scout-17b-16e-instruct` | Natively multimodal MoE, 131k context, function calling, $0.27/M in / $0.85/M out. **Recommended default** — no onboarding quirks, strong OCR/UI understanding. |
| `@cf/google/gemma-4-26b-a4b-it` | Vision + thinking + function calling, 256k context. Newer; solid alternate default. |
| `@cf/google/gemma-3-12b-it` | Multimodal, 128k context. Already matches the existing vision regex (`gemma[- ]?3`) in `model-capabilities.ts`. |
| Mistral Small 3.1 24B | Vision, 128k context. |
| `@cf/meta/llama-3.2-11b-vision-instruct` | Vision-tuned, but requires a one-time Meta license handshake (first request must send `"prompt": "agree"`) — disqualifying for a zero-config default. |
| `@cf/llava-hf/llava-1.5-7b-hf` | Beta, image-to-text only, takes a raw byte-array `image` input instead of `messages` — different wire shape, skip. |

**Wire-format caveat (spike item):** older vision models take a separate
`image` parameter (bytes); newer ones accept multipart `messages`. Workers AI
also exposes an OpenAI-compatible `/v1/chat/completions` endpoint. Push's
`cloudflareStream` passes `m.content` through to `env.AI.run` untouched, so
multipart content parts already survive the handler — the spike must verify
that Scout/Gemma accept an OpenAI-style `image_url` part with a `data:` URL via
the binding, or normalize to whatever the binding wants at that boundary.

## Design

### Trigger

Fallback runs only when the resolved chat model's `visionInput` is
`'unsupported'` (`getModelCapabilitySupport`, `app/src/lib/model-capabilities.ts`).
`'unknown'` keeps today's pass-through-with-hedged-notice behavior — the model
may well see the image, and preempting it would downgrade capable models.
`'supported'` is untouched.

### Vision model resolution

Ordered:

1. **User setting** — new sticky selection mirroring the Reviewer's advisory
   pattern (`app/src/lib/settings-store.ts`): `visionFallback.provider` +
   `visionFallback.modelByProvider`. Independent of the chat lock, like
   `reviewerAdvisory*`.
2. **Zero-config default (web/cloud)** — provider `cloudflare`, model
   `@cf/meta/llama-4-scout-17b-16e-instruct`, via the existing `AI` binding.
   Default catalog + fallback constants follow the `pr-review-config.ts` shape
   (`PR_REVIEW_MODEL_CATALOG` / `PR_REVIEW_DEFAULT_MODELS`).
3. **Unresolvable** (e.g. self-hosted deploy without the AI binding, no
   setting) — behave exactly as today: composer warning, honest awareness
   block. The feature degrades to the status quo, never worse.

### Sidecar call

New shared kernel `lib/vision-fallback.ts`, following the Auditor/Reviewer
sidecar pattern: it takes an injected `stream: PushStream<LlmMessage>` plus
provider/model ids, builds one user message per image (image content part +
a fixed describe/OCR instruction: transcribe all visible text verbatim,
describe layout/UI state, note anything anomalous), and consumes it via
`iteratePushStreamText`. The web binding supplies
`getProviderPushStream(visionProvider)` (`app/src/lib/orchestrator-provider-routing.ts`).
Keeping the kernel in `lib/` with an injected stream keeps it testable without
a provider and lets the CLI adopt it if it ever grows an image-ingestion path
(today it has none — `cli/pushd.ts` deliberately drops multimodal content to
the text channel, so the CLI surface is out of scope).

Images go to the vision model as-is via `imageUrlToSource`
(`lib/content-blocks.ts`) for base64/mime extraction where the wire needs it.

### Injection point and shape

Both lanes already meet at `mergeInitialUserContentParts`
(`app/src/lib/attachment-content-parts.ts`) — inline
(`app/src/hooks/chat-send-inline.ts`) and background DO
(`app/src/worker/coder-job-do.ts`). The fallback slots in as an async step in
that shared helper's callers (a new `resolveAttachmentContentParts` wrapper in
`attachment-content-parts.ts`), so the two lanes stay symmetric by
construction rather than by parallel edits.

For each image, instead of the `image_url` part, inject the labeled-text shape
already established by `buildPriorTurnAttachmentParts`:

```
[Image: <filename> — described by <vision model id>; the current model cannot
view images directly. Description follows:]
<description text>
```

If the sidecar call fails, inject an honest placeholder
(`[Image: <filename> — attached, but could not be described]`) and continue
the send — the fallback fails open to today's behavior, never blocks a send it
already accepted, and never silently drops an attachment.

### Description caching

Describe each attachment **once**. The description is stored alongside the
attachment (an optional `description` field on `AttachmentData`, stamped with
the describing model id) so prior-turn re-injection
(`buildPriorTurnAttachmentParts`) reuses it instead of re-calling the vision
model every turn. Re-describe only if the fallback model selection changes and
the user re-sends.

### Honesty invariants

- `visionInput` stays `'unsupported'` and `PushCapabilityProfile.multimodal`
  stays `false` — the fallback does not upgrade the model's declared
  capabilities anywhere.
- `buildModelCapabilityAwarenessBlock` gains a fourth branch: images present +
  fallback active → "image attachments are described by `<model>`; you are
  reading a description, not the image. Say so if asked about visual detail
  the description doesn't carry."
- The composer gate stops blocking when a fallback resolves; the
  `getVisionCapabilityNotice` copy becomes "images will be described by
  `<model>`" instead of a hard refusal.
- Descriptions are derived from user-supplied images, but OCR'd text is
  upstream content: apply the same delimiter-escaping used for project
  instructions before injection so an image containing prompt-shaped text
  can't fake a runtime block boundary.

### Structured logs

Per the symmetric-logs convention, one line per branch at the resolution +
describe seam (worker surface → `console.log`):

- `vision_fallback_described` ↔ `vision_fallback_failed` ↔
  `vision_fallback_unconfigured` (unresolvable, degraded to status quo),
  with `{ provider, model, attachmentCount, durationMs }` context.

### Non-goals (v1)

- **No model-callable tool.** v1 is preprocessing only; the lead cannot
  re-query the image. A `describe_image` tool (lead asks the vision model a
  targeted question — "what's the exact error text in this screenshot?") is
  the natural v2, and *that* change registers in `lib/capabilities.ts` +
  tool-schema drift tests. Preprocessing does not.
- **No CLI surface.** No image ingestion exists there today.
- **No Modal/GPU hosting.** Self-hosting an open-weights vision model buys
  nothing over the API call and adds cold starts, GPU billing, and model ops.
- **No auto-scan of other configured providers.** Resolution is setting →
  zero-config default → degrade. Guessing "some other configured provider has
  vision" silently routes user images to a provider they didn't pick for this
  job; the setting exists for exactly that choice.

## Phasing

1. **Spike** — verify the Workers AI binding wire format for image input on
   Scout and Gemma 3/4 (multipart `image_url` `data:` URL vs `image` bytes),
   and that `cloudflareStream` needs no change beyond possible normalization.
2. **Kernel** — `lib/vision-fallback.ts` + tests (injected stream, fixture
   descriptions; covers failure → placeholder, multi-image, caching reuse).
3. **Web wiring** — resolver (settings keys + cloudflare default), the
   `resolveAttachmentContentParts` seam in `attachment-content-parts.ts`, both
   lane call sites, composer-gate change, awareness-block branch, structured
   logs. One PR, in-band with its logs and the doc-status flip.
4. **Settings UI** — vision-fallback picker, mirroring the Reviewer advisory
   picker.
5. **Capability metadata** — ensure the chosen `@cf/` defaults report
   `visionInput: 'supported'` (extend the `model-capabilities.ts` regex row or
   declared metadata in `lib/model-metadata.ts`) so the picker can filter to
   vision-capable models.
6. **v2 (separate decision)** — `describe_image` as a governed tool.
