# Cloudflare Agents SDK — Evaluation for Push

> Research compiled 2026-06-17

## Question

Should Push adopt more of [Cloudflare's Agents SDK](https://developers.cloudflare.com/agents/runtime/agents-api/)
(the `agents` npm package, `0.16.2` at time of writing) — in particular its
`Agent` base class, `this.schedule()` scheduling API, and durable-execution
fibers (`runFiber()` / `stash()` / `keepAlive()`)?

**Conclusion: no, not for the existing worker Durable Objects.** Push already
uses the Cloudflare primitives the SDK sits on top of (Workers, Durable Objects,
the `@cloudflare/sandbox` container DO, SQLite-in-DO, alarms, WebSockets). The
SDK's value-adds are things the worker DOs have already built — with better
portability and testability than the SDK would give back. Retrofitting them onto
`Agent` is a net regression. See the live contract in
[`../decisions/Platform, Sessions, and Sandbox Decisions.md`](<../decisions/Platform, Sessions, and Sandbox Decisions.md>)
§12.

This note records the evidence so the question doesn't get re-opened from scratch.

## What the Agents SDK provides

The `agents` package exposes a server-side `Agent` class (extends `Server` /
partyserver, which is itself a Durable Object) plus a client-side SDK
(`AgentClient`, `useAgent`, `useAgentChat`). Key server primitives:

| Feature | Methods | Notes |
|---|---|---|
| State | `setState()`, `onStateChanged()`, `initialState`, `this.state` | Auto-persisted to a `cf_agents_state` SQL table; broadcasts to connected clients. |
| SQL | `this.sql` template tag | Thin sync wrapper over `this.ctx.storage.sql`. |
| Scheduling | `schedule()`, `scheduleEvery()`, `getScheduleById()`, `listSchedules()` | Backed by a `cf_agents_schedules` table; **the SDK owns the DO `alarm()` handler** to dispatch them. |
| Durable execution | `runFiber()`, `startFiber()`, `stash()`, `onFiberRecovered()`, `keepAlive()`, `keepAliveWhile()` | Resume an execution across DO eviction without hand-managing checkpoints. `keepAlive()` is `@experimental`. |
| WebSockets | `onConnect()`, `onMessage()`, `onClose()`, `broadcast()` | Hibernatable. |
| HTTP/SSE | `onRequest()` | Routed via `routeAgentRequest(request, env)`. |
| Chat | `AIChatAgent` / `onChatMessage` (`@cloudflare/ai-chat`) | Opinionated chat loop on AI-SDK `streamText` + `UIMessage`; client `useAgentChat`. |
| MCP | `this.mcp`, `waitForMcpConnections` | MCP client connection management with hibernation-aware reconnection. |

**Hard constraint:** every one of these is an instance method on `Agent`. There
is no à-la-carte import — you get them only by `class Foo extends Agent`, which
transitively pulls `partyserver` and the `cloudflare:workers` ambient module.

## Current Cloudflare usage in Push (inventory)

Push is already deeply on the platform. Worker entry `app/worker.ts` routes ~65
endpoints + prefixes. Durable Objects:

- **`Sandbox`** — re-exported from `@cloudflare/sandbox` (0.8.11). This *is* the
  agents-adjacent container primitive; Push uses it as its default sandbox
  backend (`worker-cf-sandbox.ts`).
- **`CoderJob`** (`coder-job-do.ts`) — background Coder agent jobs. SQLite state
  (migration v2), SSE with `Last-Event-ID` replay, a multiplexed wall-clock
  `alarm()` backstop, durable checkpoint/resume, orphan sweep.
- **`PrReviewJob`** (`pr-review-job-do.ts`) — webhook-triggered advisory PR
  reviews. SQLite (v4), HMAC dedupe, recovery alarms.
- **`RunHost`** (`run-host-do.ts`) — Durable Runs "Adopt-on-Silence". KV-style
  DO storage, an `alarm()` **state-machine dispatcher**, adoption loop.
- **`RelaySessionDO`** (`relay-do.ts`) — per-session WS relay, in-memory ring
  buffer.

Plus KV (`SNAPSHOT_INDEX`, `SANDBOX_TOKENS`, `ARTIFACTS`, `CHAT_LIBRARY`), R2
(`SNAPSHOTS`), Workers AI (`AI`, BGE embeddings), Rate Limiting, Analytics
Engine (`PROVIDER_STATS`), Workers Traces, and a daily cron.

Neither `agents` nor `partyserver` is a dependency today.

## Why retrofitting the existing DOs is a net regression

### 1. It fights a deliberate base-class decision

`coder-job-do.ts` explicitly does **not** extend even the lightweight
`cloudflare:workers` `DurableObject` base class — it keeps plain `ctx` / `env`
fields so the DO type-checks without pulling ambient-module declarations into
the app tsconfig's `types` array (see the constructor comment). `Agent` is a far
heavier base than the one this file went out of its way to avoid.

### 2. The SDK scheduler would commandeer `alarm()`, which is doing irreplaceable work

`this.schedule()` is only reachable by subclassing `Agent`, and the SDK's
scheduler **owns the DO `alarm()`** to dispatch its `cf_agents_schedules` table.
But the worker DOs' `alarm()` handlers are not simple one-shot timers:

- **`CoderJob.alarm()`** fans a *single* singleton alarm out across *all*
  concurrent jobs' wall-clock deadlines, with idempotent terminal-claim races
  against `runLoop` and `/cancel` (`markTerminal` is the arbiter).
- **`RunHost.alarm()`** is a **state-machine dispatcher** — `watched` → silence
  detector, `adoptable` → adoption retry, `adopted` → watchdog — where every
  decision is already factored into pure, backend-neutral, unit-tested functions
  in `lib/run-host-adoption` (`decideAdoption`, `decideAdoptedAlarm`).

Adopting the SDK scheduler means replacing tested pure decision logic with an
opaque, Cloudflare-coupled black box, and re-deriving the multiplexing the
existing handlers already do.

### 3. Durable-execution fibers don't remove the actual complexity

`RunHost`'s "adopt-on-silence" *looks* like durable execution, but its
checkpoints are the **client's conversation transcript** (`RunCheckpointV1`),
which is semantically different from an execution-stack snapshot. `runFiber()` /
`stash()` would replace manual *capture calls*, but the hard part here is the
reclaim / supersede / approval-gate race semantics (register-always-wins,
one-way `adoptable`, pre/post-flip re-checks) — which fibers do not address.

### 4. It breaks the pluggable-backend principle

The shared runtime in `lib/` is intentionally backend-neutral; Cloudflare and
Modal are siblings behind `SandboxProvider`
(Platform Decisions §4). The Agents SDK is Cloudflare-only and pulls Cloudflare
specifics up into worker-layer logic that currently delegates its decisions to
neutral `lib/` functions.

### 5. The chat-loop pieces collide head-on with Push's runtime

`AIChatAgent` / `onChatMessage` / `useAgentChat` assume AI-SDK `streamText` and
Cloudflare's `UIMessage` format. Push's entire tool/runtime contract lives in
`lib/` (`tool-protocol.ts`, `tool-dispatch.ts`, `openai-sse-pump.ts`,
`tool-call-recovery.ts`, the per-turn tool budget, multi-provider routing across
~15 providers). Adopting `AIChatAgent` means abandoning that, and it can't run on
the CLI/Android surfaces, breaking "every surface targets the same single lead."

## What the SDK already gives Push, and what it would take to want more

Push already gets the SDK's foundation through `@cloudflare/sandbox` (a
container Durable Object). The remaining SDK features are either already built
by hand (scheduling, durable resume, state persistence, SSE/WS) or collide with
`lib/` (the chat loop).

Revisit **only** if one of these changes:

- **A greenfield Cloudflare-only surface** appears with no `lib/`-neutrality or
  CLI/Android requirement — where starting on `Agent` costs nothing because
  there's no hand-rolled equivalent to migrate and no second backend to serve.
- **Server-pushed state sync to browsers** (`setState` → `useAgent`) becomes a
  product requirement big enough to justify a web-only state path *and* the
  relay/ring-buffer machinery it would replace becomes a maintenance burden.
- **MCP client fan-out** grows to many concurrent servers where the SDK's
  `this.mcp` hibernation-aware reconnection (`waitForMcpConnections`) clearly
  beats Push's own MCP wiring.

None of these holds today.

## Sources

- Agents API reference and changelogs via the Cloudflare docs MCP server
  (`developers.cloudflare.com/agents/*`), 2026-06-17. The public docs URL 403s
  direct fetch; method names verified against the docs index.
- `agents` package version `0.16.2` (`npm view agents version`).
- Codebase inventory: `app/worker.ts`, `app/src/worker/coder-job-do.ts`,
  `app/src/worker/run-host-do.ts`, `wrangler.jsonc`.
