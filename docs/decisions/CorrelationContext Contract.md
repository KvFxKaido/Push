# CorrelationContext Contract

Date: 2026-04-14
Status: Draft, docs-and-types only (step 1 of the Architecture Remediation Plan)
Companion to: [`Architecture Remediation Plan — Defusing the Big Four.md`](./Architecture%20Remediation%20Plan%20%E2%80%94%20Defusing%20the%20Big%20Four.md), [`Web and CLI Runtime Contract.md`](./Web%20and%20CLI%20Runtime%20Contract.md)
Code: [`lib/correlation-context.ts`](../../lib/correlation-context.ts)

## Why this exists

Every review of Push's hot paths — `sandbox-tools.ts`, `useChat.ts`, `useAgentDelegation.ts`, the coder-agent kernel, the pushd daemon — has surfaced the same question in a different shape: **"when a tool call, delegation, or task-graph step fails, which run, chat, session, and tool call is it tied to, and can we follow it across the web/daemon/sandbox boundary?"**

Today the answer is "mostly yes, but reconstructed by hand in each call site." The correlation fields exist — they just live in seven different interfaces, under six different names, with subtle semantic drift between shells:

| Id | `MemoryScope` | `RUN_STARTED` | `SessionEvent` | `RunEvent` | `ToolExecutionStartEvent` | pushd envelope |
|---|---|---|---|---|---|---|
| `runId` | yes | yes | optional | — | — | optional |
| `chatId` | yes | yes | — | — | — | — |
| `sessionId` | — | — | required | — | — | required |
| `taskGraphId` | yes | — | — | implicit via `executionId` | — | — |
| `taskId` | yes | — | — | yes | — | — |
| `executionId` | — | — | — | yes | — | — |
| `toolCallId` | — | — | — | — | yes | — |
| surface (web/cli/daemon/sandbox) | — | — | — | — | — | — |

Each of those interfaces is correct for its own job. The problem is that there is no single shape to reach for when you want to *carry the intersection* across a subsystem boundary — across the hook → runtime → sandbox layer, or across web → daemon → CLI. Each caller ends up picking a subset, renaming a field or two, and hand-assembling an OTel span attribute bag.

This contract defines the missing single shape, so the tracing spine (step 3 of the remediation plan) has one target to extend against, and so the upcoming sandbox-tools verification extraction (step 4) has a place to thread correlation without inventing a new signature.

## What `CorrelationContext` is

`CorrelationContext` is a TypeScript `interface` in `lib/correlation-context.ts` whose fields are the eight canonical correlation tags the system already cares about:

- `surface` — `'web' | 'cli' | 'daemon' | 'sandbox'`
- `sessionId` — the pushd daemon session id (CLI only today)
- `chatId` — the user-visible conversation id
- `runId` — the id of one assistant turn sequence
- `taskGraphId` — the enclosing task-graph id, if any
- `taskId` — the task-node id within a task graph, if any
- `executionId` — the execution id shared by delegation, task-graph, and tool-execution events
- `toolCallId` — the id of a single tool invocation

All fields are optional. The object is passive: the value is whatever the nearest enclosing layer happened to know. The helpers `extendCorrelation` (copy-on-write merge) and `correlationToSpanAttributes` (OTel attribute bag) are the two pure operations every caller needs.

The file also exposes `CORRELATION_SPAN_ATTRIBUTE_KEYS` as the single source of truth for the attribute key names (`push.run_id`, `push.execution_id`, and so on). The `push.*` + `snake_case` convention matches `useAgentDelegation.ts:283` and `app/src/lib/tracing.ts:218`, so the tracing spine can roll forward without a rename.

## The hard rule

A `CorrelationContext` is **passive observability metadata only**. The fields on this object must not be used to:

1. alter tool call arguments or results,
2. alter prompt text or system-prompt composition,
3. alter pushd wire payloads beyond the existing envelope fields (`sessionId`, optional `runId`) that `cli/protocol-schema.ts` already defines,
4. alter sandbox commands, filesystem state, or workspace behavior,
5. gate branches in business logic (policy, permission, approval).

A correlation context is something you read, log, attach to an OTel span, and pass forward. It is never something you branch on. If a feature needs to branch on an id, that id belongs somewhere other than here — usually on the domain object itself (a `RunEvent`, a `MemoryScope`, a `SessionEvent` envelope).

This rule is what makes the refactor cheap. If any call site could influence behavior via a correlation field, the tracing pass would become a behavior-changing refactor with its own regression surface. The whole reason step 3 of the remediation plan can be "plug the leaks" rather than "build the topology" is that the leaks are allowed to be passive.

## Field semantics and containment

Fields follow one implicit containment order, loosest to tightest:

```
surface
  └── sessionId          (pushd daemon session, CLI-only)
        └── chatId       (user-visible conversation)
              └── runId  (one assistant turn sequence)
                    ├── taskGraphId
                    │     └── taskId
                    ├── executionId        (delegation, tool, task-graph exec)
                    │     └── toolCallId   (leaf tool invocation)
```

A caller that holds a tighter id should also hold its parents whenever possible. `extendCorrelation` exists to make that cheap: each layer adds what it knows without rewriting what the parent knew.

Three semantics are worth stating out loud because they have tripped up past code:

- **`sessionId` is the pushd daemon session, not the chat.** It is distinct from `chatId`. On web, `sessionId` is undefined today because the web shell does not go through pushd (see `Web and CLI Runtime Contract.md:202`). On CLI, a single pushd session can host many chats, so `chatId` is nested strictly inside `sessionId`, not the other way around. This matches the `SessionEvent` envelope in `cli/session-store.ts`.
- **`executionId` is not the same as `toolCallId`.** `executionId` is the id of the runtime *granule* that owns the work — a delegation, a task-graph node, a tool-execution round. `toolCallId` is the id of the specific tool call the model emitted, which is what the provider hands back in tool-result envelopes. One execution can dispatch many tool calls, so `toolCallId` is always "at or below" `executionId`. Today the codebase only carries `toolCallId` in `ToolExecutionStartEvent`; most call sites only know `executionId` because that is what the `RunEvent` union carries.
- **`executionId`, not `delegationId`.** The first draft of the Architecture Remediation Plan used the name `delegationId` for this field. The codebase has been using `executionId` since the `RunEvent` union landed (see `subagent.*` and `task_graph.*` arms in `lib/runtime-contract.ts`). We reconcile on the existing name so that span attributes, logs, and tests all line up without a synonym to translate. The plan doc has been annotated in place.

## What this module is not

- **Not a tracing span wrapper.** `withActiveSpan` and `setSpanAttributes` already live in `app/src/lib/tracing.ts`. This module defines the *shape of the correlation payload* those functions will carry; it does not replace them.
- **Not a runtime context injector.** Step 1 of the remediation plan is docs-and-types. Nothing in the kernel, the web hooks, or the CLI imports `lib/correlation-context.ts` yet. Step 3 (the tracing spine pass) is where call sites start consuming it.
- **Not a replacement for `MemoryScope` or `SessionEvent.runId`.** Those remain the authoritative, domain-specific identifier carriers for memory retrieval and wire envelopes. `CorrelationContext` is the shape we reach for when we want to carry those ids *across* subsystems without pulling in either dependency.
- **Not a free pass to add new branching on correlation ids.** The hard rule above is enforced by convention today; step 3 of the remediation plan is where we start encoding it as a lint rule.

## Relationship to existing types

The plan explicitly says to "build on the existing `app/src/lib/tracing.ts` (267 lines), not a new system." This contract honors that. `CorrelationContext` is not a new observability framework. It is a typed name for the data the existing tracing helpers already carry in ad-hoc attribute bags in `useAgentDelegation.ts:282-328`, `useAgentDelegation.ts:541-580`, `useAgentDelegation.ts:656-715`, and `useAgentDelegation.ts:808-844`.

When step 3 threads this through, the mechanical change at each call site is:

```ts
// before
attributes: {
  'push.agent.role': 'explorer',
  'push.execution_id': executionId,
  'push.provider': lockedProviderForChat,
  // ...
},

// after
attributes: {
  ...correlationToSpanAttributes(correlation),
  'push.agent.role': 'explorer',
  'push.provider': lockedProviderForChat,
  // ...
},
```

That is the whole refactor at each site. No signature changes to the hooks, no new indirection, no new layer of types between the caller and the OTel SDK. This is the small surface area the plan's council review was asking for when it said "tracing must be passive."

## What lands in step 1 (this PR)

- `lib/correlation-context.ts` — the interface, span-attribute-key table, and pure helpers (`extendCorrelation`, `correlationToSpanAttributes`, `hasAnyCorrelation`, `hasRunCorrelation`).
- `lib/correlation-context.test.ts` — 14 tests pinning the shape, the merge semantics, the attribute-key mapping, the empty-context behaviour, and a runtime companion test that fails if a new field is added to the interface without updating `CORRELATION_FIELD_NAMES`.
- This decision doc.

No call site imports the new module. The typecheck passes (`npm run typecheck`), the new tests pass (`npx vitest run lib/correlation-context.test.ts`), and nothing else in the repo changes shape.

## What does not land in step 1

- **No propagation.** `useChat.ts`, `useAgentDelegation.ts`, `coder-agent.ts`, the sandbox-tools dispatcher, and the pushd envelope emitter are all untouched. Step 3 is where that happens.
- **No lint rule.** The hard rule above is enforced by convention this round. Step 3 is where the "no branching on correlation fields" constraint becomes machine-checkable — likely as a targeted ESLint/`tsc-strict` rule scoped to `lib/correlation-context.ts` imports.
- **No changes to `MemoryScope`, `RunEvent`, `ToolExecutionStartEvent`, or the pushd envelope.** Those remain their own domain-specific types. Step 4 may revisit whether `MemoryScope` should be built from a `CorrelationContext` at its edges; that decision is out of scope here.
- **No sandbox-surface implementation.** `surface: 'sandbox'` is declared but no code captures a correlation context inside the sandbox boundary yet. That is a future tracing-spine concern — declaring the enum now means we do not have to rev the type when we get there.

## Follow-ups

- Step 2 (characterization tests) will start consuming `CORRELATION_SPAN_ATTRIBUTE_KEYS` to assert exact attribute names on spans produced by the sandbox verification family (`sandbox_run_tests`, `sandbox_check_types`). This is the earliest point where the contract gets exercised.
- Step 3 (the tracing spine pass) is the first code that imports `CorrelationContext` and threads it through the hot paths. The containment rule from the plan's sequencing section applies: if a propagation would require changing the public signature of `useChat.ts` or `useAgentDelegation.ts`, stop and extract a helper before continuing.
- If the tracing spine pass surfaces a field that does not fit the existing eight — for example a future `workerId` on Cloudflare — add it here first, in a separate PR, with a doc amendment.

## Provenance

Written on 2026-04-14 as step 1 of the Architecture Remediation Plan. The field list, span-attribute convention, and containment order are grounded in direct reads of:

- `lib/runtime-contract.ts` — `MemoryScope` (line 163), `RunEvent` arms for `subagent.*` and `task_graph.*` (line 268 onward)
- `lib/run-engine-contract.ts` — `RUN_STARTED.runId` / `RUN_STARTED.chatId` (line 14)
- `lib/tool-execution-runtime.ts` — `ToolExecutionStartEvent.toolCallId` (line 38)
- `cli/protocol-schema.ts` — `SessionEvent` envelope fields (lines 108–165)
- `app/src/hooks/useAgentDelegation.ts` — existing `push.*` span attribute call sites (lines 279–844)
- `app/src/lib/tracing.ts` — `withActiveSpan` (line 229), `push.cancelled` convention (line 218)

The decision to reconcile `delegationId` → `executionId` is a change from the original plan text and is noted in the plan doc in the same PR that introduces this contract.
