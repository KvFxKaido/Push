# OpenRouter Capability Expansion

Date: 2026-06-15
Status: **in progress** — Phase 1 (native structured outputs) shipping; Phases
2–6 are roadmap-tracked follow-ups, not yet promoted to `ROADMAP.md`.
Owner: Push

## Why this exists

Push's OpenRouter integration covers the basics well but uses a fraction of the
OpenRouter API surface. The wire body assembled in
`app/src/lib/openrouter-stream.ts` (web) and the OpenAI-compat path in
`cli/openai-stream.ts` → `lib/openai-chat-serializer.ts` (CLI) currently send:

- the `:nitro` throughput-routing suffix baked into default model IDs
  (`lib/provider-models.ts`),
- `reasoning: { effort }` gated by `openRouterModelSupportsReasoning`,
- the `openrouter:web_search` server tool (native grounded search), correctly
  suppressing Push's prompt-engineered `web_search` so the two don't collide,
- `session_id` + `trace` for broadcast/observability,
- `HTTP-Referer` / `X-Title` app-attribution headers (`worker-providers.ts`),
- catalog + capability metadata via `/api/v1/models` and models.dev.

That leaves a set of OpenRouter features with **zero references anywhere in the
repo** (verified by grep, 2026-06-15) that map cleanly onto things Push already
does the hard way. This runbook is the inventory + the sequencing.

## Gap inventory (ranked by fit for a coding agent)

1. **Provider routing preferences (`provider` object).** Today Push only uses
   the `:nitro` suffix. The full `provider` field unlocks:
   - `require_parameters: true` — only route to providers that actually honor
     the params Push sends (tool calls, reasoning). Silently-dropped params are
     a real failure mode for a tool-driven agent.
   - `data_collection: "deny"` / `zdr: true` — enforce zero-retention providers;
     the privacy story for a tool that touches private repos.
   - `sort: "price" | "throughput" | "latency"`, `order`, `only`, `ignore` —
     explicit cost/speed control instead of one hardcoded `:nitro`.
   - `quantizations` — avoid heavily-quantized endpoints for code accuracy.

2. **Model-fallback array (`models: [...]`).** Push sends a single `model`.
   OpenRouter natively fails over to the next model on rate-limit/outage. Cheap
   resilience for background coder jobs.

3. **Usage accounting (`usage: { include: true }`) + `/api/v1/generation`.**
   Nothing tracks per-generation cost/credits. Surfacing real spend pairs with
   the existing observability surfaces (`docs/runbooks/Provider Stats Endpoint.md`).

4. **Native structured outputs (`response_format: { json_schema }`).** *This
   runbook's Phase 1.* Several role kernels (auditor verdict + evaluation,
   reviewer) prompt for JSON and read it back with `parseStructured`
   (`lib/structured-output.ts`) — a strip-fence + repair + zod-validate dance
   that is post-hoc and best-effort. OpenRouter (and the OpenAI-compat routes)
   can constrain generation **server-side** against a JSON Schema so the model
   emits conforming JSON in the first place. This complements `parseStructured`
   (which stays as the validation backstop), it does not replace it.

5. **`transforms: ["middle-out"]`.** OpenRouter's server-side context
   compression on overflow — a backstop alongside Push's own `context-budget`.

6. **Native PDF/file input (`file-parser` plugin).** Push supports multi-image
   vision but not OpenRouter's native PDF parsing.

Lower-priority: prompt-cache propagation audit for OpenRouter→Anthropic routing
(`cache_control` is tagged by `toOpenAIChat` only when `tagCacheBreakpoints` is
set — confirm the web inline body isn't paying full price on cached prefixes),
and `seed` for reproducible eval runs (`scripts/eval/run-evals.ts`).

## Phase 1 — native structured outputs (in progress)

### Shape

OpenRouter speaks the OpenAI `response_format` field:

```json
"response_format": {
  "type": "json_schema",
  "json_schema": { "name": "auditor_verdict", "strict": true, "schema": { … } }
}
```

The neutral request carries this intent provider-agnostically; each adapter
that can honor it serializes it. Adapters that can't (Anthropic/Gemini native
serializers) ignore the field — Anthropic's structured-output mechanism is
tool-shaped and is out of scope here.

### Pieces

- **Neutral field.** `PushStreamRequest.responseFormat?: ResponseFormatSpec`
  (`lib/provider-contract.ts`), where `ResponseFormatSpec = { name; schema;
  strict? }` and `schema` is a JSON Schema object.
- **Wire builder (single source).** `toOpenAIResponseFormat(spec)` in
  `lib/openai-chat-serializer.ts` produces the `response_format` payload. Both
  `toOpenAIChat` (CLI + OpenAI-compat) and the web `openrouter-stream.ts` inline
  body call it, so the wire shape has one definition.
- **Routing guard.** The web OpenRouter body also sets
  `provider: { require_parameters: true }` whenever `response_format` is
  present. Without it OpenRouter may route to an endpoint that doesn't support
  structured outputs and silently ignores the field, dropping the constraint
  back to prompt-only JSON despite the model advertising support — a targeted
  slice of the Phase 2 provider-routing work, pulled forward because it's the
  load-bearing companion to structured outputs.
- **zod → strict JSON Schema.** `zodToStrictJsonSchema(schema)` in
  `lib/structured-output.ts` runs `z.toJSONSchema` (zod 4) then normalizes for
  strict mode: recursively adds `additionalProperties: false` + a full
  `required` array to every object, and strips the `$schema` / `default`
  keywords that OpenAI/OpenRouter strict mode rejects. This keeps the zod schema
  the single source of truth — the same `AuditorVerdictSchema` that
  `parseStructured` validates against also generates the wire schema.
- **Capability gate.** `ResolvedModelCapabilities.structuredOutput` +
  `openRouterModelSupportsStructuredOutput(modelId)` in
  `app/src/lib/model-catalog.ts`, resolved from the
  `structured_outputs` entry in the model's `supported_parameters`
  (already parsed into `ModelsDevOpenRouterMetadata.structuredOutput`).
- **Role-kernel wiring.** Each kernel owns its zod schema and the derived
  `response_format`, attaching it only when the caller passes
  `supportsStructuredOutput: true`. Wired so far: the auditor **verdict** and
  **evaluation** gates (`lib/auditor-agent.ts`) and the advisory **reviewer**
  (`lib/reviewer-agent.ts`). The web wrappers
  (`app/src/lib/auditor-agent.ts`, `app/src/lib/reviewer-agent.ts`) compute
  support from the catalog, gated to OpenRouter. A shared
  `applyStructuredOutput` helper (`lib/structured-output.ts`) returns the
  request fragment and emits the symmetric attach ↔ skip structured log.
- **Optional fields.** `zodToStrictJsonSchema` classifies each property from
  zod's `io: 'input'` output — `required`-listed or `default`-carrying
  (`.catch()`/`.default()`) fields stay required and non-nullable; a genuinely
  `.optional()` field (the reviewer's `comments[].line`) is modeled as
  `nullable`, the OpenAI/OpenRouter strict-mode idiom for "may be omitted".

### Why the kernel doesn't compute the capability itself

`model-catalog.ts` is a web-surface module (localStorage-backed cache); shared
`lib/` can't import it. So the surface that has the catalog decides support and
passes a boolean down — the kernel stays provider/catalog-agnostic and just
forwards the schema. This is the same injection shape the auditor already uses
for runtime-context and memory resolvers.

### Deliberately deferred within Phase 1

- **Deep reviewer** (`lib/deep-reviewer-agent.ts`, the autonomous PR reviewer).
  It shares `ReviewerResponseSchema`, so the schema + wire builder are ready,
  but it runs server-side in the PR-review DO where credentials are env-keyed
  and there is no client `Authorization` — the capability gate there is the
  server-side engine-capability path, not the localStorage catalog. Left as a
  follow-up so the server gate isn't half-wired.
- **CLI auditor/reviewer wiring.** `toOpenAIChat` already emits `response_format`
  when `responseFormat` is set, so the CLI path is *plumbed*; the CLI callers
  (`cli/auditor-gate-memory.ts`) just don't pass `supportsStructuredOutput` yet
  (defaults off → no behavior change). One-line follow-up once the CLI catalog
  exposes the capability.

## References

- `lib/provider-contract.ts` — `PushStreamRequest`, the neutral request type
- `lib/openai-chat-serializer.ts` — `toOpenAIChat`, the OpenAI-compat wire home
- `lib/structured-output.ts` — `parseStructured` (post-hoc) + the new strict
  JSON-Schema normalizer
- `app/src/lib/openrouter-stream.ts` — web OpenRouter adapter (inline body)
- `app/src/lib/model-catalog.ts` — capability resolution from models.dev metadata
- `lib/auditor-agent.ts` — the verdict/evaluation kernels
- OpenRouter docs: structured outputs, provider routing, web search server tools
