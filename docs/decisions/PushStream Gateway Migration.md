# PushStream Gateway Migration

Date: 2026-04-24 (last updated 2026-04-25)
Status: in_progress — provider side validated end-to-end, first agent-role migration (Auditor) landed

Companion to: `Architecture Remediation Plan — Defusing the Big Four.md`

## Context

Push originally streamed model output through `ProviderStreamFn` — a 12-positional-arg callback signature in `lib/provider-contract.ts` that conflated transport (provider HTTP), runtime (agent role context, prompt assembly, sandbox awareness), and lifecycle (timers, abort, telemetry) responsibilities. The signature had grown organically as new agent capabilities landed; runtime concerns leaked into the transport seam every time a new param was needed (`workspaceContext`, `hasSandbox`, `systemPromptOverride`, `scratchpadContent`, `onPreCompact`, `todoContent`).

The **PushStream gateway** is a parallel, async-iterable streaming contract that separates the two concerns:

- **Gateway side (`PushStream`)** is a function `(req: PushStreamRequest) => AsyncIterable<PushStreamEvent>`. Pure transport: takes a request, yields a normalized event stream. Per-provider implementations live next to their HTTP/SDK glue.
- **Runtime side** consumes events. Reasoning normalization, tool-call parsing, and the legacy callback shape are layered on top via composable transducers and `createProviderStreamAdapter`.

The migration is incremental. The adapter exists as a bridge so agent roles can keep their callback consumption while providers move under the new contract. Once the consumer side is also migrated (agent roles directly iterating PushStream events), the adapter becomes deletable.

## Phased plan

The plan was sketched in the original design conversation that produced PR #365. Nine phases, in order:

1. **Land the contract types and the adapter.** Establish `PushStreamEvent`, `PushStreamRequest`, `PushStream`, and `createProviderStreamAdapter` in `lib/provider-contract.ts`. Adapter bridges PushStream → legacy `ProviderStreamFn` so existing consumers keep working unchanged.

2. **Port one provider end-to-end.** Validate the contract against a real provider before doubling down. Cloudflare Workers AI was chosen because its `env.AI.run` SDK binding meant the Worker (not the client) was the gateway consumer — exercises a different shape of the abstraction than the client-side path.

3. **Add the reasoning transducer.** Lift `<think>...</think>` splitting out of the legacy callback parser into `normalizeReasoning`, a `(stream) => stream` transducer that any PushStream can compose. Includes a per-stream latch so hybrid providers (emit native `reasoning_content` AND inline `<think>` tags in the same stream) don't double-report reasoning.

4. **Port a second provider with adapter-level safety nets.** OpenRouter — high-traffic, OpenAI-shaped SSE, more variety than Cloudflare. Required adding timer machinery (`eventTimeoutMs` / `contentTimeoutMs` / `totalTimeoutMs`) and runtime-context passthrough to the adapter so adapted-path providers wouldn't regress from the legacy `streamSSEChatOnce` safety net.

5. **Close the telemetry gap.** Adapter-level OpenTelemetry span coverage so adapted providers emit `model.stream` spans with the same attribute vocabulary as the legacy path. `lib/` stays OTEL-free via a hook-based `AdapterTelemetry` interface; the app-side caller wires the real tracer.

6. **Migrate one agent role off the 12-arg callback.** The runtime-side proof of the contract. Validates that a consumer can iterate `PushStream` events directly instead of going through the adapter — surfaces contract gaps that aren't visible from the provider side.

7. **Extract shared helpers.** Once two PushStream implementations exist, deduplicate the SSE pump (currently inlined in both `cloudflareStream` and `openrouterStream`).

8. **Port more OpenAI-compatible providers** (Zen, Kilocode, OpenAdapter, Nvidia, Blackbox).

9. **Retire `createProviderStreamAdapter`.** Terminal step — only after every agent role is on PushStream.

## What's shipped

| # | PR | Phase | Landed | Summary |
|---|---|---|---|---|
| 1 | [#365](https://github.com/KvFxKaido/Push/pull/365) | 1 | 2026-04-21 | Add `PushStream` types + `createProviderStreamAdapter` + 11 unit tests. Adapter bridges PushStream → legacy `ProviderStreamFn`. |
| 2 | [#366](https://github.com/KvFxKaido/Push/pull/366) | 2 | 2026-04-22 | First provider — Cloudflare Workers AI. `cloudflareStream: PushStream` consumes `env.AI.run`; `handleCloudflareChat` iterates the stream directly (Worker is the consumer). Bypasses the adapter because tuning params didn't flow through it; that revealed `tool_call_delta` would need to land later if hybrid models showed up. |
| 3 | [#369](https://github.com/KvFxKaido/Push/pull/369) | 3 | 2026-04-22 | `normalizeReasoning` transducer in `lib/reasoning-tokens.ts`. Splits inline `<think>...</think>` out of `text_delta` into `reasoning_delta` + `reasoning_end` events. Per-stream `nativeSeen` latch prevents double-reporting when a hybrid provider emits both channels. |
| 4 | [#384](https://github.com/KvFxKaido/Push/pull/384) | 4 | 2026-04-24 | Adapter timer machinery (`eventTimeoutMs` / `contentTimeoutMs` / `totalTimeoutMs` collapsed from legacy connect/idle/progress/stall/total to three reasons the adapter can actually observe), runtime-context passthrough on `PushStreamRequest`, OpenRouter port via `openrouterStream` + `createProviderStreamAdapter`. Required follow-up commits on adapter content-timer arming, `<think>` wiring through `normalizeReasoning`, and native `delta.tool_calls` accumulation/flush. |
| 5 | [#385](https://github.com/KvFxKaido/Push/pull/385) | 5 | 2026-04-24 | Adapter-level OpenTelemetry telemetry hook. `lib/` stays OTEL-free; the app exposes an `AdapterTelemetry` shape that the adapter calls with `wrap(ctx, run)` and the caller implements with `tracer.startActiveSpan`. Attribute names mirror the legacy `streamSSEChatOnce` span exactly so dashboards keyed on `push.provider`/`push.model`/`push.stream.chunk_count`/`push.usage.*` keep working. Includes single-Error-instance handling on timeout, `hasSandbox`/`workspaceMode` start-context fields, and a wrap-failure fallback so a broken tracer can't break the `ProviderStreamFn` contract. |
| 6 | _this branch_ | 6 | 2026-04-25 | First agent-role migration — Auditor. Replaces the `streamFn?: ProviderStreamFn` option with `stream?: PushStream<LlmMessage>` on both `runAuditor` and `runAuditorEvaluation`, iterates events via a new `iteratePushStreamText` helper in `lib/stream-utils.ts` (activity-reset idle timeout; `text_delta` accumulation; `reasoning_*` ignored). Adds the reverse bridge `providerStreamFnToPushStream` in `lib/provider-contract.ts` so providers without a native PushStream still work (legacy callbacks → events). App-side wrapper caches the bridged PushStream per underlying `streamFn` so the Auditor's coalescing key (`auditCoalesceKey`) keeps deduping concurrent identical audits. |

Provider side now well-validated:
- Two providers shipped (Cloudflare via direct iteration, OpenRouter via the adapter).
- Reasoning channel normalization tested across both `<think>` tags and native `reasoning_content` / `reasoning` field renames.
- Timer machinery has parity with the legacy `streamSSEChatOnce` safety net.
- Telemetry attribute vocabulary preserved.
- Adapter handles upstream throws, timeouts, and external aborts cleanly.

## What's left

**Phase 7 — Extract a shared SSE pump.** Justified once Phase 6 surfaces the contract's consumer needs and a third provider port is on the horizon. `cloudflareStream` parses `env.AI.run` chunks; `openrouterStream` parses standard OpenAI SSE. Both currently duplicate buffer + line-split + JSON.parse logic. The right time to extract is when there's a third caller pulling for it — not before. Phase 6's Auditor migration didn't add a third caller (it consumes events without parsing wire bytes), so the pressure for extraction hasn't appeared yet.

**Phase 8 — Port the rest of the OpenAI-compatible catalog.** Zen, Kilocode, OpenAdapter, Nvidia, Blackbox all use `streamProviderChat('<provider>', ...)` today and would adopt `openrouterStream`'s shape with provider-specific config swaps (URL, body transforms, auth). Mechanical work that becomes obvious once the SSE pump is shared.

**Phase 9 — Retire `createProviderStreamAdapter`.** Gated on every agent role being migrated to PushStream consumption. The adapter exists exclusively to bridge legacy callback consumers; once nothing calls it, delete the function and its tests.

## Recommendation for next

**Phase 8 — port more OpenAI-compatible providers.** Reasoning:

- Auditor (Phase 6) validated event-iteration on the consumer side: a `PushStream<LlmMessage>` with `text_delta` accumulation + `done` termination is enough for a JSON-shaped agent role. The contract didn't grow new variants. Reasoning events flowed through unchanged. No surprises.
- The reverse bridge `providerStreamFnToPushStream` makes it cheap to migrate the remaining agent roles (Coder/Orchestrator/Reviewer) since they can iterate events against any provider, native PushStream or otherwise.
- Phase 7 (shared SSE pump) hasn't grown a third caller yet, so extraction would still be premature.
- More provider ports give Phase 7 the third caller it needs and validate that the next agent-role migration (Coder is the natural follow-up) doesn't bottleneck on missing native PushStream impls.

**Why not Coder migration next.** Coder has working memory, tool calls, and abort orchestration that the Auditor doesn't exercise — a bigger surface than is comfortable to attack right after the first consumer-side proof. Better to widen the provider base first.

**Why not Phase 7 first.** Two callers still isn't a lot of duplication, and the Auditor migration didn't add a third. Phase 8 will.

## Decisions captured along the way

- **Event union over message union.** `PushStreamEvent` is a discriminated union of small variants (`text_delta`, `reasoning_delta`, `reasoning_end`, `done`) rather than a richer "message" type. Lets transducers compose without reaching into payload internals.

- **`reasoning_end` as a distinct event, not a flag.** Adding a structural variant kept content vs. structural progress distinguishable in the timer machinery (Phase 4 fix #1) without complicating the `text_delta` / `reasoning_delta` shapes.

- **Adapter timer model collapses 5 → 3.** Legacy `streamSSEChatOnce` has connect/idle/progress/stall/total. The adapter sees parsed events, not raw bytes — connect/idle/progress all manifest as "no event arrived" and were merged into a single `eventTimeoutMs`. `contentTimeoutMs` maps to stall; `totalTimeoutMs` is wall clock. Recorded in #384.

- **`lib/` stays OpenTelemetry-free.** The telemetry hook (`AdapterTelemetry`) is dependency-free in the contract; the app-side caller wires the actual tracer. Same pattern preserves `lib/`'s ability to run in CLI without pulling OTEL.

- **Per-stream native-reasoning latch in `normalizeReasoning`.** Once a stream emits any native `reasoning_delta`, subsequent `text_delta` events bypass `<think>` parsing for the rest of that stream. Forward-compatible with hybrid providers; landed in #369.

- **Cloudflare Worker bypasses the adapter.** `handleCloudflareChat` iterates `cloudflareStream` directly, while OpenRouter's `streamOpenRouterChat` builds the adapter. Reason: Cloudflare's Worker is the gateway consumer (uses `env.AI.run`), while OpenRouter goes through `/api/openrouter/chat` proxy and the *client* is the consumer. Different shapes; the adapter is for the client-side legacy-callback case.

- **Single Error instance on timeout (Phase 5 fix #2).** Telemetry's `terminalError` and the caller's `onError` receive the same Error object. Matters for stack-trace inspection and identity checks downstream.

- **Wrap-failure fallback (Phase 5 fix #5).** If `telemetry.wrap` rejects before invoking `run`, the adapter falls back to running without telemetry so a broken tracer can't break the `ProviderStreamFn` contract. `runEntered` sentinel distinguishes pre-run from post-run rejections; post-run rejections are swallowed (stream already settled).

- **Reverse bridge in Phase 6 (`providerStreamFnToPushStream`).** During the staged migration, agent roles that consume PushStream events still need to talk to providers that haven't been ported off `ProviderStreamFn` yet. Rather than dual-wiring each consumer (native PushStream vs. legacy callback path), the Auditor migration added a single bridge in `lib/provider-contract.ts` that wraps any `ProviderStreamFn` as a `PushStream`. The bridge is the symmetric inverse of `createProviderStreamAdapter` — once Phase 8 finishes and every provider has a native PushStream, both bridges become deletable together with Phase 9.

- **PushStream caching by streamFn identity (Auditor wrapper).** The app-side `resolveAuditorPushStream` caches the bridged PushStream in a `WeakMap` keyed by the underlying `streamFn` so successive `runAuditor` calls for the same provider see the same `PushStream` object. The `auditCoalesceKey` uses stream identity to dedupe concurrent identical audits; without the cache, a fresh wrapper per call would defeat coalescing.

## Open questions

- **Should `tool_call_delta` become a first-class event?** Today native `delta.tool_calls` accumulation lives inside `openrouterStream` and flushes as synthetic `text_delta` (fenced JSON) on `finish_reason` / `[DONE]`. If hybrid providers emit native tool calls during long argument streams, the adapter's `contentTimeoutMs` would trip during accumulation since text_delta only fires on flush. Live workaround: providers' `contentTimeoutMs` is generous (60s default). Real fix: a `tool_call_delta` event that resets the content timer. Wait until it bites in practice before adding the variant.

- **`PushStreamEvent.done.finishReason` enum coverage.** Currently `'stop' | 'length' | 'tool_calls' | 'aborted' | 'unknown'`. Some providers emit `'content_filter'`, `'function_call'`, `'end_turn'`. Not currently a problem because `openrouterStream` and `cloudflareStream` map their own native reasons into the union. Will become a problem if more providers want richer reasons.

- **Should the SSE pump live in `lib/` or app-side?** Phase 7 question. `lib/` can be CLI-callable; app-side is Web-only. Cloudflare's `cloudflareStream` is app-side because the Worker binding is Web-only anyway. OpenRouter's `openrouterStream` is app-side because it depends on `getOpenRouterKey` from `@/hooks/`. A shared pump in `lib/` would have to be config-injectable.

- **CLI consumption.** The CLI has its own provider streaming code today (`cli/provider.ts`). PushStream lives in `lib/` precisely so CLI can adopt it, but no CLI work has been done yet. Probably waits until at least Phase 6 lands so we know the consumer side is real.

## Out of scope (deliberately)

- Native function-calling tool support beyond the text-fenced JSON convention Push uses today.
- Multi-modal input handling on `LlmMessage` (currently text-only; `ChatMessage` handles attachments at the runtime layer).
- Replacing the `ProviderStreamFn` legacy shape outright. It stays until every consumer migrates.
- CLI-side migration. Tracked separately under "Selective CLI Adoption of Shared Runtime" in `ROADMAP.md`.

## Cross-references

- Original sketch lived in conversation, not in repo. Phase 1 PR (#365) carries the canonical type definitions and design rationale in its body.
- Companion to `Architecture Remediation Plan — Defusing the Big Four.md`. The Big Four plan handles dispatcher / coordinator decomposition; this doc handles transport contract migration.
- The 12-arg `ProviderStreamFn` shape lives in `lib/provider-contract.ts` next to the new contract for now. Comparison is one file open away.
