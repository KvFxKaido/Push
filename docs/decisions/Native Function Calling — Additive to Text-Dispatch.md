# Native Function Calling — Additive to Text-Dispatch

**Status:** Current — shipped on the web lead for Cloudflare Workers AI (Kimi/GLM,
name-based), OpenRouter (capability-based), OpenCode Zen (name-based catalog
allowlist; both the OpenAI and Anthropic Go transports), Fireworks AI
(name-based catalog allowlist), and the validated OpenAI-compatible adapters:
OpenAI / Azure OpenAI (OpenAI-family model ids), Kilo Code / OpenAdapter
(curated catalog allowlists), direct Anthropic (curated catalog allowlist),
plus Ollama Cloud / Nvidia NIM / Blackbox AI (models.dev capability-gated).
Bedrock, Google/Gemini, Vertex, and the CLI lead are deferred follow-ups, not yet promoted to
`ROADMAP.md` — tracked in #1082.

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
  Go models (minimax/qwen) rebuild an Anthropic Messages body that doesn't forward
  the OpenAI `tools` array, so they fall back to text-dispatch.
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
  silently leave native FC off; the curated catalog is the allowlist. Fireworks,
  Kilo Code, OpenAdapter, and Blackbox have similar curated allowlists where the
  gateway catalog is hand-maintained; Ollama Cloud / Nvidia NIM / Blackbox also
  honor models.dev capability metadata when present. Direct OpenAI and Azure
  OpenAI enable native tools for OpenAI-family model ids (`gpt-4*` / `gpt-5*`).
  Other providers return `false`.
- **Lead wiring.** `inline-coder-run.ts` attaches `getToolFunctionSchemas()`
  when the gate passes; the coder kernel (`lib/coder-agent.ts`) threads the new
  `nativeToolSchemas` option into each round's request. Provider-agnostic — once
  the gate returns `true` for a provider/model, the lead attaches schemas and the
  provider's adapter serializes them.

## Scope / deferred

The deferred follow-ups below are tracked in #1082 (Gemini / Vertex / Bedrock
gates, the CLI lead, delegated Coder/Explorer, and conditional
toolsets). Flip the Status line and the relevant bullet here as each lands.

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
  `createAnthropicTranslatedStream` (web) / `anthropicEventStream` (CLI). The CLI
  OpenAI-compat adapter (`cli/openai-stream.ts`) is a separate follow-up — its
  lead doesn't attach `nativeToolSchemas` yet, so it stays text-dispatch (the
  shared `toOpenAIChat` already serializes `tools` once a CLI gate lands).
- **Other roles.** Delegated Coder, Explorer, auditor/reviewer are unchanged
  (auditor/reviewer use `response_format` structured outputs, a separate
  mechanism — see `docs/runbooks/OpenRouter Capability Expansion.md`).
- **Conditional toolsets.** The `tools` array is the full registry today; if a
  surface wires only a subset of executors, narrowing the advertised set is a
  follow-up. The dispatcher already rejects/handles tools that aren't wired.
