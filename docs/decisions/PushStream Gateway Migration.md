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
| 7 | _this branch_ | 8 (first port) | 2026-04-25 | First OpenAI-compatible-catalog port — OpenCode Zen. `zenStream: PushStream` in `app/src/lib/zen-stream.ts` mirrors `openrouterStream`'s shape (same SSE parsing, reasoning channel normalization, native `delta.tool_calls` accumulation); branch differences vs. OpenRouter are endpoint (`getZenGoMode()` switch between `ZEN_GO_URLS.chat` and `PROVIDER_URLS.zen.chat`) and the absence of OpenRouter-specific body fields (`session_id`, `trace`, `reasoning`). `streamZenChat` now composes `normalizeReasoning(zenStream(req))` through `createProviderStreamAdapter` with the same telemetry hook OpenRouter uses. 18 unit tests in `zen-stream.test.ts` parallel the OpenRouter coverage. |

Provider side now well-validated:
- Three providers shipped (Cloudflare via direct iteration, OpenRouter + OpenCode Zen via the adapter).
- Reasoning channel normalization tested across both `<think>` tags and native `reasoning_content` / `reasoning` field renames.
- Timer machinery has parity with the legacy `streamSSEChatOnce` safety net.
- Telemetry attribute vocabulary preserved.
- Adapter handles upstream throws, timeouts, and external aborts cleanly.

## What's left

**Phase 7 — Extract a shared SSE pump.** Now has a third caller (`zenStream`) that duplicates the buffer + line-split + OpenAI-shape delta parsing from `openrouterStream` almost verbatim. The duplication is now concrete enough to justify extraction — the Zen port intentionally copied the pattern so the shape of what needs to be shared is visible. Next Phase 8 ports (Kilocode, OpenAdapter, Nvidia, Blackbox) should happen _after_ the pump extraction so they benefit from it rather than compounding the duplication.

**Phase 8 — Port the rest of the OpenAI-compatible catalog.** Kilocode, OpenAdapter, Nvidia, Blackbox remain on `streamProviderChat('<provider>', ...)`. Same mechanical shape as the Zen port. Deferred until Phase 7 lands the shared pump.

**Phase 9 — Retire `createProviderStreamAdapter`.** Gated on every agent role being migrated to PushStream consumption. The adapter exists exclusively to bridge legacy callback consumers; once nothing calls it, delete the function and its tests.

## Recommendation for next

**Phase 7 — extract the shared SSE pump.** The Zen port landed the third caller the extraction was waiting for: `zenStream` and `openrouterStream` now duplicate the buffer + line-split + OpenAI-shape delta parsing + native tool-call accumulation almost line-for-line. Before porting the remaining four (Kilocode, OpenAdapter, Nvidia, Blackbox), extract the pump so the rest of Phase 8 is additive config rather than copy-pasted parsers.

Remaining sub-steps, in order:

- Lift the common pump out of `openrouter-stream.ts` + `zen-stream.ts` into a shared helper (open question: lives in `lib/` with injected config, or app-side with shared provider primitives — see Open questions below).
- Rewrite both provider streams against the helper to prove the shape holds.
- Sweep Kilocode / OpenAdapter / Nvidia / Blackbox onto the helper — each should be ~50 lines of config + a thin wrapper.
- After the sweep, Phase 6-style agent migrations (Coder next) can proceed against a fully-native provider surface.

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

## Open questions

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
