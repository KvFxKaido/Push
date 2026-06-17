# Native Function Calling — Additive to Text-Dispatch

**Status:** Current — shipped for the Cloudflare Workers AI lead (Kimi/GLM). Other
providers and roles are deferred follow-ups, not yet promoted to `ROADMAP.md`.

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
- **Capability gate.** `providerModelSupportsNativeToolCalling(provider, model)`
  in `app/src/lib/model-catalog.ts` — name-based (Kimi/GLM) for Cloudflare,
  which has no models.dev metadata. Other providers return `false`.
- **Lead wiring.** `inline-coder-run.ts` attaches `getToolFunctionSchemas()`
  when the gate passes; the coder kernel (`lib/coder-agent.ts`) threads the new
  `nativeToolSchemas` option into each round's request.

## Scope / deferred

- **Other providers.** OpenAI/OpenRouter/Zen/etc. are function-calling-capable
  but stay text-dispatch only until native calling is validated per provider.
  The gate is the single switch.
- **Other roles.** Delegated Coder, Explorer, auditor/reviewer are unchanged
  (auditor/reviewer use `response_format` structured outputs, a separate
  mechanism — see `docs/runbooks/OpenRouter Capability Expansion.md`).
- **Conditional toolsets.** The `tools` array is the full registry today; if a
  surface wires only a subset of executors, narrowing the advertised set is a
  follow-up. The dispatcher already rejects/handles tools that aren't wired.
