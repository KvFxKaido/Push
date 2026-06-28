# Native Function Calling — Additive to Text-Dispatch

**Status:** Current — shipped on the web lead for Cloudflare Workers AI (Kimi/GLM,
name-based), OpenRouter (capability-based), OpenCode Zen (name-based catalog
allowlist; both the OpenAI and Anthropic Go transports), Fireworks AI
(name-based catalog allowlist), and the validated OpenAI-compatible adapters:
OpenAI / Azure OpenAI (OpenAI-family model ids), Kilo Code
(curated catalog allowlist), direct Anthropic (curated catalog allowlist),
Google/Gemini (name-based curated allowlist), Google Vertex AI (name-based
curated allowlist), AWS Bedrock Claude ids (name-based), plus Ollama Cloud /
Nvidia NIM (models.dev capability-gated). The CLI lead and
daemon delegated Coder/Explorer now attach CLI-native scoped schemas behind a
CLI-local provider/model gate. Tracked in #1082.

**Date:** 2026-06-17

## Problem

Push's tool protocol is text-dispatch by design (see `CLAUDE.md` → Tool
protocol): tools are described in the system prompt and the model emits fenced
`{"tool","args"}` JSON, which `lib/tool-call-parsing.ts` scans out of the
content stream. That portability choice — it works on any cooperating model
without a provider-native function-calling API — is load-bearing and stays.

But the conversational **lead** running on heavy open-weight models via
Cloudflare Workers AI (GLM-5.2, Kimi K2.x) emits tool calls less reliably as
free-text JSON than it would through the provider's constrained function-calling
path. Those models' Workers AI model cards advertise native function calling;
Push wasn't using it (it never sent a `tools` array to any provider except the
OpenRouter web-search server tool).

## Decision

Add native function calling as a **purely additive** layer, not a replacement.

The unlock is that `lib/openai-sse-pump.ts` already accumulates native
`delta.tool_calls` and **flushes them as the same fenced JSON** the dispatcher
consumes. So whichever way a model answers — fenced JSON (text-dispatch) or a
native tool call — both converge at one dispatch path. Consequences:

- The system prompt and text-dispatch path are untouched; no "two instructions
  fighting." A model can use either route in the same turn.
- Non-capable models are unaffected — they simply never receive a `tools` array.
- Loose/best-effort parameter types are safe: executors already accept the
  model's free-form JSON on the text path, and nothing runs in strict mode.

### Pieces

- **Schema source of truth.** `lib/tool-function-schemas.ts` derives one OpenAI
  function schema per `ToolSpec` from the registry — param names + required from
  `protocolSignature`, types from a curated `PARAM_TYPES` map (then the
  `exampleJson` args, then `string`). Function `name` is the `publicName` so a
  flushed native call (`{"tool": <publicName>}`) passes `KNOWN_TOOL_NAMES` and
  resolves to canonical. The array is **complete** by construction (a partial
  list would tell the model those are its only tools); a completeness test pins
  one-to-one with the registry.
  CLI runs use `cli/tool-function-schemas.ts` instead: it parses the versioned
  `TOOL_PROTOCOL` / `READ_ONLY_TOOL_PROTOCOL` blocks so native schema names stay
  in the CLI executor namespace (`read_file`, `search_files`, `write_file`, ...)
  rather than the web registry namespace (`read`, `search`, ...). The CLI lead
  appends GitHub registry schemas only when the GitHub protocol block is actually
  advertised.
- **Neutral wire field.** `PushStreamRequest.tools?: ToolFunctionSchema[]` plus
  the `ToolFunctionSchema` type in `lib/provider-contract.ts`.
- **Cloudflare adapter.** The client (`app/src/lib/cloudflare-stream.ts`)
  serializes `tools` + `tool_choice: 'auto'` into the body; the Worker
  (`app/src/worker/worker-providers.ts`) validates and forwards them to
  `env.AI.run`.
- **OpenRouter adapter.** `app/src/lib/openrouter-stream.ts` serializes `tools` +
  `tool_choice: 'auto'` into the body, merging native function schemas with the
  `openrouter:web_search` server tool when both are active. It also sets
  `provider: { require_parameters: true }` (the same routing guard `response_format`
  uses) so OpenRouter can't route to an endpoint that silently drops the tools.
- **Zen adapter.** `app/src/lib/zen-stream.ts` serializes `tools` +
  `tool_choice: 'auto'` into the body (no routing guard — Zen has none). This
  covers the standard tier directly and the Go tier's OpenAI transport via the
  worker's legacy passthrough (`handleZenGoChat` forwards the validated body
  verbatim, and the guardrail validator preserves unknown fields). The shared
  `toOpenAIChat` serializer also gained `tools`/`tool_choice` for the Go neutral
  contract (currently dormant) and the CLI OpenAI-compat adapters. Anthropic-transport
  Go models (minimax/qwen) rebuild an Anthropic Messages body via
  `toAnthropicMessages`, which translates OpenAI-shaped schemas into Anthropic
  custom tools and normalizes `tool_use` blocks back to dispatcher JSON.
- **Capability gate.** `providerModelSupportsNativeToolCalling(provider, model)`
  in `app/src/lib/model-catalog.ts` — name-based (Kimi/GLM) for Cloudflare, which
  has no models.dev metadata; capability-based for OpenRouter (the model's
  models.dev `toolCall` flag, via `getModelCapabilities`), mirroring the
  structured-output gate. `getModelCapabilities` resolves `:nitro` / `:free`
  routing suffixes to the base id (an `openRouterBaseId` fallback added
  alongside this — without it every routed variant resolved to empty
  capabilities, silently losing reasoning / structured-output / native-tool
  gating). **Zen is name-based** against the curated catalog union
  (`ZEN_NATIVE_TOOL_CALLING_MODELS` = `ZEN_MODELS` ∪ `ZEN_GO_MODELS`): its default
  `big-pickle` is a proprietary id absent from models.dev and the `opencode`
  block's `tool_call` coverage is unverifiable, so capability-gating would
  silently leave native FC off; the curated catalog is the allowlist. Fireworks
  and Kilo Code have similar curated allowlists where the
  gateway catalog is hand-maintained; Ollama Cloud / Nvidia NIM also
  honor models.dev capability metadata when present. Direct OpenAI and Azure
  OpenAI enable native tools for OpenAI-family model ids (`gpt-4*` / `gpt-5*`).
  Google Vertex AI is enabled from `VERTEX_MODEL_OPTIONS`, and AWS Bedrock is
  enabled for Claude 3+ / Claude 4-style Anthropic model ids routed through the
  OpenAI-compatible proxy. Other providers return `false`.
- **Lead and role wiring.** `inline-coder-run.ts` attaches web registry schemas
  when the gate passes; the coder kernel (`lib/coder-agent.ts`) threads the
  `nativeToolSchemas` option into each round's request. CLI lead wiring attaches
  the full CLI schema set, plus GitHub schemas when GitHub tools are advertised.
  Daemon delegated Coder gets the full CLI schema set; daemon Explorer gets the
  read-only CLI schema set through `lib/explorer-agent.ts`.

## Scope / out of scope

The #1082 follow-ups are covered for Vertex, Bedrock, CLI lead, delegated
Coder/Explorer, and scoped toolsets.

- **Other providers.** The gate is the single switch. OpenRouter
  (capability-based), OpenCode Zen (name-based), Fireworks AI (name-based; single
  OpenAI-compatible endpoint, `tools` straight through `fireworks-stream.ts`),
  direct Anthropic (name-based against the curated direct-provider catalog;
  `anthropic-stream.ts` carries neutral `tools`, and `toAnthropicMessages`
  translates them to Anthropic custom tools), and the validated
  OpenAI-compatible adapters are enabled on the web lead — Zen
  across both transports: the OpenAI-transport models (standard tier + Go) carry
  `tools` straight through `toOpenAIChat`, and
  the **Anthropic-transport** Go models (minimax/qwen) translate OpenAI tool
  schemas to Anthropic's custom-tool shape in `toAnthropicMessages` and turn the
  model's `tool_use` blocks back into the dispatcher's fenced JSON via
  `createAnthropicTranslatedStream` (web) / `anthropicEventStream` (CLI).
  Google/Gemini direct provider is enabled by the curated `GOOGLE_MODELS`
  allowlist: `gemini-stream.ts` carries neutral `tools`, `toGeminiGenerateContent`
  maps them to Gemini `functionDeclarations`, and
  `createGeminiTranslatedStream` / `geminiEventStream` turn Gemini `functionCall`
  parts back into the dispatcher's fenced JSON. Google Vertex AI is enabled by
  the curated `VERTEX_MODEL_OPTIONS` allowlist: `vertex-stream.ts` carries
  neutral `tools`, Gemini-on-Vertex forwards them through the OpenAI-compatible
  endpoint, and Claude-on-Vertex translates them through the Anthropic custom-tool
  bridge. AWS Bedrock is enabled for Claude-style Anthropic model ids through
  the OpenAI-compatible request body. CLI OpenAI-compatible, direct Anthropic,
  and direct Gemini streams serialize the same neutral `tools` field once the
  CLI-local gate passes.
  Gemini-on-Vertex does NOT route through the Gemini `functionDeclarations`
  bridge, so it doesn't inherit that bridge's two guards directly: (1) the
  grounding/function-calling combo is dropped at the Vertex `appendVertexGoogleSearchTool`
  chokepoint instead — Gemini rejects `googleSearch` + function tools together on
  2.5 models (Gemini-3-only Preview), so when native function tools are present
  grounding is skipped, mirroring the direct-Gemini fix; (2) empty-OBJECT schema
  rejection (Gemini 400s on a parameterless OBJECT) is handled by Vertex's
  OpenAI-compatible layer translating standard OpenAI tools — a first-run
  watch-item if a no-arg tool ever 400s a Vertex Gemini request.
- **Shared gate, single source.** The name-based gate decisions (the OpenAI /
  Bedrock model-id shapes and the curated Vertex set) live once in
  `lib/native-tool-gate.ts` (data from `lib/provider-models.ts`), imported by both
  the web gate (`model-catalog.ts`) and the CLI gate (`cli/native-tool-gate.ts`).
  A web↔CLI drift test in `model-catalog.test.ts` pins parity for the name-based
  providers; capability-based providers (OpenRouter / Ollama / Nvidia via
  models.dev) stay surface-specific by necessity (the CLI has no models.dev cache).
- **Other roles.** Auditor/reviewer are unchanged (they use `response_format`
  structured outputs, a separate mechanism — see
  `docs/runbooks/OpenRouter Capability Expansion.md`).
- **Conditional toolsets.** Native schema sets are scoped to the runnable
  surface: web lead uses source-scoped registry schemas; CLI lead uses the full
  CLI protocol plus conditional GitHub schemas; delegated Coder uses the full CLI
  protocol; delegated Explorer uses the read-only CLI protocol.

## Addendum (2026-06-27) — native tool-result delivery on Ollama Cloud

The original wiring made models *emit* calls natively but still fed prior tool
**results** back as `role: 'user'` `[TOOL_RESULT]` text on the OpenAI-compat web
adapters, which assemble their own body (via `toLLMMessages`) and forward it raw
rather than routing through `toOpenAIChat`. A tool-capable model then sees its
own results as untrusted user-injected data rather than tool output — the
provenance-confusion failure mode (a weak model distrusting the envelope and
fabricating reality instead).

Fixed for the two legacy raw-forward web adapters — **Ollama Cloud** and
**OpenRouter**. When native FC is active, the adapter passes
`emitContentBlocks: true` to `toLLMMessages` (running the kernel's already-paired
tool sidecars through the whole-request adjacency pass in
`materializeToolContentBlocks`), then expands only the tool-bearing turns via the
new `expandToolMessagesForOpenAICompat` (`lib/openai-chat-serializer.ts`) —
reusing the same `flattenToolBearingBlocks` the neutral path uses. Assistant tool
turns become `tool_calls[]`; each result becomes a standalone
`{ role: 'tool', tool_call_id }`. Non-tool turns and unpaired/non-adjacent tool
exchanges pass through verbatim (graceful degradation to the text arm), so the
change is byte-identical to before when native FC is off.

The gate is the presence of function schemas (`req.tools`), NOT OpenRouter's
`openrouter:web_search` server tool — web search alone doesn't put the model in
native-FC mode. Other OpenAI-compat adapters that already route through
`toOpenAIChat` (Vertex Gemini, Zen-Go, CLI OpenAI-compat) get this flatten for
free and need no change.

Two seams the first cut missed (caught in #1219 review):

1. **Worker proxy normalizer.** These adapters proxy their client-built body
   through `validateAndNormalizeChatRequest` (`chat-request-guardrails.ts`), which
   rebuilds each message and previously kept only `role`/`content`/reasoning
   fields — silently dropping `tool_calls` (assistant) and `tool_call_id` (tool
   role). So the expanded messages arrived malformed upstream (an assistant turn
   with no calls + a dangling `role: 'tool'`). The normalizer now shape-validates
   and preserves both fields (`normalizeToolCalls`, fail-closed: a malformed
   `tool_calls` 400s rather than forwarding a half-stripped exchange). Providers
   on the neutral path are unaffected — the Worker builds their tool messages
   server-side via `toOpenAIChat`, after validation. `'tool'` was already an
   allowed role.
2. **contentBlocks leak on passthrough.** `expandToolMessagesForOpenAICompat`
   now downcasts non-tool `contentBlocks` (multimodal/attachment turns) to OpenAI
   content parts and drops the Push-private `contentBlocks` field, instead of
   forwarding it verbatim. A blunt strip would lose images that live only in
   `contentBlocks`, so it mirrors `toOpenAIChat`'s non-tool branch.

3. **Gemini `thoughtSignature` round-trip on the OpenAI-compat path.** Once native
   tool calls were live, an OpenAI-compat upstream fronting a **Gemini** model
   (Ollama Cloud serving Gemini) 400s on the follow-up turn — "Function call is
   missing a thought_signature in functionCall parts" — because Gemini requires
   the signed-reasoning token it emitted on the `functionCall` to be replayed. The
   signature was already captured (`openai-sse-pump.ts` → `NativeToolCall` →
   `LlmToolUseBlock.thoughtSignature`) and replayed on the **Gemini-native**
   serializer (`gemini-bridge.ts`), but the OpenAI-compat flatten dropped it.
   Carried it through end-to-end as the OpenAI-compat peer of the native path,
   emitted by `flattenToolBearingBlocks` and preserved by the proxy normalizer's
   `normalizeToolCalls`. Compat upstreams disagree on the **shape** — some use a
   top-level `tool_calls[].thoughtSignature` sibling (what `openai-sse-pump`
   historically observed), Google's compat surface uses an
   `extra_content.google.thought_signature` envelope and ignores unknown
   top-level fields (#1220 Codex P1). Rather than bet on one, Push reads EITHER on
   capture and emits BOTH on replay; the unused field is ignored. The dual-shape
   read/emit lives in `lib/gemini-thought-signature.ts`, shared by the pump,
   serializer, and normalizer. Absent for every non-Gemini upstream.
