# pi-mono Agent Loop Review

Comparative analysis of [badlogic/pi-mono `packages/agent`](https://github.com/badlogic/pi-mono/tree/main/packages/agent) against Push's harness. Triggered by an April 2026 social-media claim that pi-mono has "the simplest, most efficient harness token-wise. Highest cache hit rate, lowest tokens per session, least bugs." This document records what's actually true, what we already do, and what's worth porting.

## What pi-mono/agent Actually Is

A small (~2000 LOC, 5 files) TypeScript package: `agent.ts`, `agent-loop.ts`, `types.ts`, `proxy.ts`, `index.ts`. Two-tier API:

- **Low-level `agentLoop` / `agentLoopContinue`**: pure functions over `Context = { systemPrompt, messages, tools }`. Streaming, MCP-style async tool execution, hooks.
- **High-level `Agent` class**: wraps the loop, adds steering/follow-up queues, lifecycle events, an `ActiveRun` barrier preventing concurrent prompts.

Three architectural disciplines explain the tweet's claims:

1. **Append-only context** — `messages` array is mutated only by `.push()`. The exact prefix is sent every turn → maximum prompt-cache reuse.
2. **Single transformation seam** — only `transformContext` may mutate context, and only at the LLM boundary (`AgentMessage[] → transformContext → convertToLlm → Message[] → LLM`). All compaction, filtering, UI-message stripping happens there.
3. **Errors-as-data** — `StreamFn` never throws; failures land as `stopReason: "error" | "aborted"` events. Hook failures coerce into `isError: true` tool results. The loop has almost no `try/catch`.

## Architecture Comparison

### Message History & Cache Behavior

| | pi-mono | Push |
|---|---|---|
| **Mutation pattern** | Append-only `messages.push(...)` everywhere | Append-only canonical, but working memory re-injected mid-conversation when context pressure > ~60% |
| **System prompt** | Separate `systemPrompt` field, never inlined | Cached via `cache_control: { type: 'ephemeral' }` on OpenRouter (`app/src/lib/orchestrator.ts:100+`) |
| **Filtering** | `convertToLlm` strips UI-only `AgentMessage` types at LLM boundary | `filterModelVisibleMessages()` strips `visibleToModel: false` at send time |
| **Compaction seam** | Single `transformContext` hook | Multiple paths (working-memory injection, filtering, sectioned-prompt rebuilds) |

**Verdict**: pi-mono's discipline is the explanation for "highest cache hit rate." Mid-stream working-memory re-injection breaks the cached prefix on Anthropic and OpenRouter. We should consolidate compaction + filtering into one transform-at-LLM-boundary step and stop in-place edits of the canonical transcript.

### Parallel Tool Execution

| | pi-mono | Push |
|---|---|---|
| **Strategy** | Two-phase: sequential preflight → `Promise.all` of thunks → emit results in source order | Reads-parallel → mutations-sequential-fail-fast → ≤1 trailing side-effect (`cli/engine.ts:1089-1270`, `app/src/hooks/chat-send.ts:817`) |
| **Order preservation** | Index-stable thunk array; `tool_execution_end` fires in completion order, `tool_result` messages in source order | Textual offset sort across fenced + bare-object scan phases (`lib/tool-dispatch.ts:128-130`) |
| **Per-tool override** | `executionMode: "sequential"` forces whole batch sequential | Phase classification (read/mutation/side-effect) determined per tool |
| **Termination** | `terminate: true` only stops loop if **all** results in batch set it | Single tool can short-circuit |

**Verdict**: pi-mono's two-phase pattern is ~50 LOC and cleaner than our parallel-reads sub-case. The phase machine (reads → mutations → side-effect) is a Push-specific safety property and should stay — but the *thunk-array-preserves-source-order* trick is worth lifting inside the parallel-reads phase. The `terminate` consensus rule is a cheap robustness win.

### Hooks & Lifecycle

| | pi-mono | Push |
|---|---|---|
| **Before-tool** | `beforeToolCall` returns `{ block, reason }`; runs after schema validation | `TurnPolicyRegistry.beforeToolExec()` → `{ action: 'deny' }` (`lib/turn-policy.ts`) |
| **After-tool** | `afterToolCall` may override only `content \| details \| isError \| terminate` — no deep merge | `evaluateAfterTool` records ledger + verification artifacts |
| **Failure handling** | Hook throw → coerced to error tool result, loop continues | Mixed; some paths surface exceptions |
| **Persistence barrier** | Per-event listener await with abort signal — DB writes settle before next turn | Tracing spans wrap tool exec; no explicit "persist before next turn" gate |

**Verdict**: Our `TurnPolicyRegistry` already has the right shape. Worth adopting the field-bounded override list (prevents hooks from quietly mutating arbitrary state) and the listener-barrier pattern for sidecar persistence races.

### Steering & Follow-up

| | pi-mono | Push |
|---|---|---|
| **Queues** | Two: `steeringQueue` (drained at top of loop + after every `turn_end`), `followUpQueue` (drained only when inner loop would terminate) | `QueuedFollowUp` on conversation (`app/src/hooks/usePendingSteer.ts`) + checkpoint system (`useChatCheckpoint.ts`) |
| **Drain modes** | `one-at-a-time` (default) vs `all` | Single-message follow-up per run completion |
| **Concurrency guard** | `Agent.prompt()` throws if `activeRun` exists; only `steer()` / `followUp()` allowed | Implicit through React state |
| **Resume validation** | `continue()` validates last message role before resuming | No equivalent guard |

**Verdict**: Modeling steering and follow-up as two queues with deterministic drain points would simplify `useChat.ts:1089-1111`. The last-message-role check on resume eliminates a class of provider-400 bugs and is trivial to add.

### Streaming Proxy / Wire Format

| | pi-mono | Push |
|---|---|---|
| **Wire shape** | `ProxyAssistantMessageEvent` omits the heavy `partial: AssistantMessage` field; sends only `{ contentIndex, delta }` | Full event objects across the boundary |
| **Reconstruction** | Client maintains single `partial` object, mutates and reattaches on receive (`proxy.ts:121-137, 238-367`) | N/A |
| **Streaming JSON parse for tool args** | Yes (`parseStreamingJson`) — partial args available mid-stream | Provider-dependent |
| **Options serialization** | Hand-picked allowlist; no signals or functions cross the wire | N/A |

**Verdict**: Push has an `app/` ↔ Cloudflare Worker split that's exactly the use case. Adopting this wire format would meaningfully cut bandwidth on mobile — which is the whole point of Push.

### Stream Contract

| | pi-mono | Push |
|---|---|---|
| **Throws** | Never. Errors → in-stream `error` event with `stopReason` | Mixed; `iterate-chat-stream.ts` layers timeouts via `onError` callback |
| **Loop try/catch surface** | Minimal — error reflects into data model | Larger — exception paths in CLI engine and web hook |

**Verdict**: A future refactor of `runAssistantLoop` (`cli/engine.ts:389+`) and `useChat.ts` should lift the never-throw stream contract. It's the single change with the biggest readability payoff.

## Where We Already Match or Diverge Deliberately

- `visibleToModel: false` filtering ≈ pi-mono's `AgentMessage` vs LLM `Message` split. Same idea, different name.
- Reads-then-mutations with fail-fast on mutations is **more opinionated** than pi-mono's flat parallel-by-default. Keep it — it's a Push-specific safety property, not a bug.
- Multi-provider routing (`orchestrator-provider-routing.ts`) exceeds pi-mono's scope. pi-mono has one stream function, plumbed through.
- MCP integration: pi-mono has first-class async tool support; our MCP wiring is currently pull-only (`mcp/github-server/`).

## What's Not Worth Borrowing

- **Two-tier API split** as a *structure*. Our equivalents (`engine.ts`, `useChat.ts`) are larger because they handle multi-provider routing, telemetry, checkpoints, capability ledgers, drift detection — concerns pi-mono doesn't have. A split for its own sake doesn't help; consolidating mutation seams does.
- **The `Agent` class barrier**. Our concurrency model lives in React state and run sessions; we don't have the multi-prompt confusion the barrier prevents.
- **`cacheRetention` as a proxy option**. Our cache control is provider-specific and already wired in `orchestrator.ts`.

## Suggested Priority

1. **Stop mid-conversation working-memory re-injection.** Move all rewrites into one transform-at-boundary step. Cache hit rate win, immediate token savings on long sessions.
2. **Source-order thunk pattern inside the parallel-reads phase.** ~50 LOC, eliminates a class of ordering bugs without touching our phase machine.
3. **Proxy event-stripping wire format between Worker and app.** Bandwidth win, mobile-relevant.
4. **Tighten steering/follow-up to two queues with named drain points.** Simplifies `useChat.ts`.
5. **Adopt `terminate` consensus rule and last-message-role validation on resume.** Cheap robustness wins.
6. **Lift the never-throw `StreamFn` contract** in the next loop refactor.

## References

pi-mono source (key files):
- `packages/agent/src/agent-loop.ts:155-234` — `runLoop`, the main loop
- `packages/agent/src/agent-loop.ts:412-471` — `executeToolCallsParallel`, two-phase pattern
- `packages/agent/src/agent-loop.ts:517-649` — `prepareToolCall` + `finalizeExecutedToolCall`, hook plumbing
- `packages/agent/src/agent.ts:113-144` — `PendingMessageQueue`
- `packages/agent/src/agent.ts:410-436` — `createLoopConfig`, queue→callback bridge
- `packages/agent/src/types.ts:103-224` — `AgentLoopConfig` public surface
- `packages/agent/src/proxy.ts:36-57, 238-367` — wire format + reconstruction

Push counterparts:
- `cli/engine.ts:389+` — `runAssistantLoop`, primary CLI loop
- `app/src/hooks/useChat.ts:738-1150` — `sendMessage` orchestrator
- `lib/tool-dispatch.ts:136-200` — shared tool detection
- `app/src/lib/orchestrator.ts:100+` — provider-aware cache control
- `lib/turn-policy.ts` — hook surface
- `app/src/hooks/usePendingSteer.ts` — current follow-up queue
- `app/src/lib/iterate-chat-stream.ts` — stream timer machinery
