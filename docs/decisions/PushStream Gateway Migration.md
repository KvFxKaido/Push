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
| 6 | [#389](https://github.com/KvFxKaido/Push/pull/389) | 6 | 2026-04-25 | First agent-role migration — Auditor. Replaces the `streamFn?: ProviderStreamFn` option with `stream?: PushStream<LlmMessage>` on both `runAuditor` and `runAuditorEvaluation`, iterates events via a new `iteratePushStreamText` helper in `lib/stream-utils.ts` (activity-reset idle timeout; `text_delta` accumulation; `reasoning_*` ignored). Adds the reverse bridge `providerStreamFnToPushStream` in `lib/provider-contract.ts` so providers without a native PushStream still work (legacy callbacks → events). App-side wrapper caches the bridged PushStream per underlying `streamFn` so the Auditor's coalescing key (`auditCoalesceKey`) keeps deduping concurrent identical audits. |
| 7 | [#390](https://github.com/KvFxKaido/Push/pull/390) | 8 (first port) | 2026-04-25 | First OpenAI-compatible-catalog port — OpenCode Zen. `zenStream: PushStream` in `app/src/lib/zen-stream.ts` mirrors `openrouterStream`'s shape (same SSE parsing, reasoning channel normalization, native `delta.tool_calls` accumulation); branch differences vs. OpenRouter are endpoint (`getZenGoMode()` switch between `ZEN_GO_URLS.chat` and `PROVIDER_URLS.zen.chat`) and the absence of OpenRouter-specific body fields (`session_id`, `trace`, `reasoning`). `streamZenChat` now composes `normalizeReasoning(zenStream(req))` through `createProviderStreamAdapter` with the same telemetry hook OpenRouter uses. 18 unit tests in `zen-stream.test.ts` parallel the OpenRouter coverage. PR #390 review also added a `tool_call_delta` event variant to `PushStreamEvent` (yielded per native `delta.tool_calls` fragment) so the adapter's `contentTimeoutMs` doesn't trip during long tool-arg buffering. |
| 8 | [#391](https://github.com/KvFxKaido/Push/pull/391) | 8 (second port) | 2026-04-25 | Second catalog port — Kilo Code. `kilocodeStream: PushStream` in `app/src/lib/kilocode-stream.ts` mirrors the Zen pattern with one fewer branch (no Go-mode endpoint switch — Kilo Code has a single `PROVIDER_URLS.kilocode.chat` endpoint). `streamKilocodeChat` now composes `normalizeReasoning(kilocodeStream(req))` through `createProviderStreamAdapter` with the same telemetry hook. 19 unit tests parallel the Zen coverage. The intentional duplication across three OpenAI-compatible streams (OpenRouter + Zen + Kilocode) is the on-ramp for Phase 7's shared SSE pump extraction. |
| 9 | _this branch_ | 7 | 2026-04-25 | Shared SSE pump extracted to `lib/openai-sse-pump.ts`. `openAISSEPump({ body, signal, isKnownToolName? })` owns the OpenAI-compatible SSE wire shape (`data:` framing, `[DONE]` sentinel, `choices[0].delta` parsing, native `delta.tool_calls` accumulation/flush, usage capture, `finish_reason` mapping, abort + reader release). The pure helpers (`mapOpenAIFinishReason`, `mapOpenAIUsage`, `stripTemplateTokens`) move with it. App-side knowledge — `KNOWN_TOOL_NAMES` — is injected via the `isKnownToolName` predicate rather than imported, so `lib/` stays free of app dependencies and the pump is callable from CLI. `openrouterStream` / `zenStream` / `kilocodeStream` shrink to: build body → fetch → error check → `yield* openAISSEPump({ body: response.body, signal, isKnownToolName })` (~95 lines down from ~280). 33 unit tests cover fragmented SSE chunks, multiple `data:` lines per chunk, `[DONE]` spacings, `usage` on intermediate vs. finish frames, both reasoning field names plus the precedence rule, native `tool_calls` indexed accumulation across parallel calls, predicate-driven unknown-tool dropping (with and without a predicate), abort cancellation + reader release, malformed JSON skipping, malformed-args fenced shell, and missing-name warning paths. The 54 existing provider-stream tests keep passing unchanged. |

Provider side now well-validated:
- Four providers shipped (Cloudflare via direct iteration, OpenRouter + OpenCode Zen + Kilo Code via the adapter).
- Reasoning channel normalization tested across both `<think>` tags and native `reasoning_content` / `reasoning` field renames.
- Timer machinery has parity with the legacy `streamSSEChatOnce` safety net.
- Telemetry attribute vocabulary preserved.
- Adapter handles upstream throws, timeouts, and external aborts cleanly.
- OpenAI-compatible SSE parsing consolidated into a single `lib/`-side pump shared across all three adapter-routed providers; remaining Phase 8 ports become additive config + a thin wrapper.

## What's left

**Phase 8 — Port the rest of the OpenAI-compatible catalog.** OpenAdapter, Nvidia, Blackbox remain on `streamProviderChat('<provider>', ...)`. With the shared pump in place, each port is now a ~95-line file that builds the request body, fetches, error-checks, then `yield* openAISSEPump({ ... })`.

**Phase 9 — Retire `createProviderStreamAdapter`.** Gated on every agent role being migrated to PushStream consumption. The adapter exists exclusively to bridge legacy callback consumers; once nothing calls it, delete the function and its tests.

## Recommendation for next

**Resume Phase 8 — port OpenAdapter, Nvidia, Blackbox onto `openAISSEPump`.** The shared pump landed in this branch and the three existing adapter-routed providers (OpenRouter / Zen / Kilocode) all delegate to it. Remaining ports should each be a thin wrapper of the same shape: build body → fetch → error check → `yield* openAISSEPump({ body, signal, isKnownToolName })`. After that, Phase 6-style agent migrations (Coder next) can proceed against a fully-native provider surface.

Remaining sub-steps, in order:

- Port OpenAdapter / Nvidia / Blackbox using the same wrapper shape as the post-Phase-7 OpenRouter / Zen / Kilocode files.
- Migrate the next agent role (Coder) off the legacy `ProviderStreamFn` shape, using the Auditor migration (Phase 6) as the template.
- Once every agent role has migrated and every provider has a native PushStream, retire `createProviderStreamAdapter` and `providerStreamFnToPushStream` together (Phase 9).

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

- **`tool_call_delta` as a content-progress signal (Phase 8 follow-up to PR #390 review).** Native `delta.tool_calls` accumulation buffers fragments inside the provider stream and only flushes as a fenced-JSON `text_delta` on `finish_reason` / `[DONE]`. While buffering, the adapter saw no events and could trip `contentTimeoutMs` during long tool-arg payloads — a regression vs. the legacy `streamSSEChatOnce` path which treated tool-call frames as activity. Added `{ type: 'tool_call_delta' }` as a structural variant the adapter treats as content progress (resets `contentTimeoutMs`); both `openrouterStream` and `zenStream` yield one per fragment. The deferred-fix posture in the original Open questions was inverted because the Phase 8 codex review surfaced the regression preemptively rather than waiting for it to bite in practice.

- **PushStream caching by streamFn identity (Auditor wrapper).** The app-side `resolveAuditorPushStream` caches the bridged PushStream in a `WeakMap` keyed by the underlying `streamFn` so successive `runAuditor` calls for the same provider see the same `PushStream` object. The `auditCoalesceKey` uses stream identity to dedupe concurrent identical audits; without the cache, a fresh wrapper per call would defeat coalescing.

- **Shared SSE pump lives in `lib/`, app knowledge is injected (Phase 7).** `openAISSEPump` lives at `lib/openai-sse-pump.ts` rather than app-side. The pump is pure SSE-shape parsing and has no app-side imports: the only app-/runtime-specific input — the known-tool-names registry — flows in via an `isKnownToolName?: (name: string) => boolean` predicate. Choosing `lib/` over app-side closes the long-standing "Should the SSE pump live in `lib/` or app-side?" open question on the side of CLI-readiness: when `cli/provider.ts` migrates to PushStream, the pump is already callable without a second extraction. The cost was one extra config field on each adapter call site. Provider adapters keep ownership of fetch, endpoint URL, auth, body construction, provider-specific body extensions (OpenRouter's `reasoning` / `session_id` / `trace`, Zen's Go-mode URL switch), prompt assembly via `toLLMMessages`, and error mapping — the pump only sees a parsed response body and yields events.

## Open questions

- **`PushStreamEvent.done.finishReason` enum coverage.** Currently `'stop' | 'length' | 'tool_calls' | 'aborted' | 'unknown'`. Some providers emit `'content_filter'`, `'function_call'`, `'end_turn'`. Not currently a problem because `openrouterStream` and `cloudflareStream` map their own native reasons into the union. Will become a problem if more providers want richer reasons.

- **CLI consumption.** The CLI has its own provider streaming code today (`cli/provider.ts`). PushStream and now the shared `openAISSEPump` both live in `lib/` precisely so CLI can adopt them, but no CLI work has been done yet. Probably waits until at least one more agent role (Coder) migrates to PushStream consumption so we know the runtime-side shape is settled.

## Out of scope (deliberately)

- Native function-calling tool support beyond the text-fenced JSON convention Push uses today.
- Multi-modal input handling on `LlmMessage` (currently text-only; `ChatMessage` handles attachments at the runtime layer).
- Replacing the `ProviderStreamFn` legacy shape outright. It stays until every consumer migrates.
- CLI-side migration. Tracked separately under "Selective CLI Adoption of Shared Runtime" in `ROADMAP.md`.

## Cross-references

- Original sketch lived in conversation, not in repo. Phase 1 PR (#365) carries the canonical type definitions and design rationale in its body.
- Companion to `Architecture Remediation Plan — Defusing the Big Four.md`. The Big Four plan handles dispatcher / coordinator decomposition; this doc handles transport contract migration.
- The 12-arg `ProviderStreamFn` shape lives in `lib/provider-contract.ts` next to the new contract for now. Comparison is one file open away.
