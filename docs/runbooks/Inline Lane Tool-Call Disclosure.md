# Inline Lane — Per-Turn Tool-Call Disclosure

Date: 2026-06-12
Status: **Shipped** — Part 1 (kernel emits `tool.execution_complete`,
`lib/coder-agent.ts`) and Part 2 (the inline lane synthesizes the
`isToolCall`/`isToolResult` pairs via `insertSyntheticToolPairs`,
`app/src/hooks/chat-send-inline.ts`) both landed. The "Plan" section below is
retained as the as-built record.
Owner: Push

## Problem

The old web Orchestrator transcript rendered a per-turn collapsible **"› Used a
tool"** disclosure: a single grouped row you expand to see the turn's tool calls
(names, durations, errors, and any tool-produced cards). The inline foreground
lane (`app/src/hooks/chat-send-inline.ts`) lost it — an inline turn streams the
answer into one placeholder and attaches the kernel's flat `result.cards` to the
final message, with no collapsible. The coder kernel executes tools *internally*
and never produces the per-tool `ChatMessage` pairs the disclosure renders from.

Goal: bring the collapsible back for inline turns, reusing the existing
`ToolCallSummary` UI (no new components).

## The UI contract (what we render into)

- **`app/src/components/chat/ToolCallSummary.tsx`** — the collapsible. Per tool
  it reads `toolMeta.{toolName, durationMs, isError}` and `callMsg.cards`
  (filtered, excluding `sandbox-state`).
- **`app/src/components/chat/tool-call-utils.ts`** —
  - `groupChatMessages()` (lines ~79-110): collapses **consecutive** pairs of
    `{role:'assistant', isToolCall:true}` immediately followed by
    `{role:'user', isToolResult:true}` into one `{type:'toolGroup', items}`
    segment. Orphan results are dropped.
  - `buildSummaryLine()` (lines ~48-73): "Used N tools" / "Ran a command" from
    `toolMeta.toolName` counts.
- Render site: `app/src/components/chat/transcript/segment-view.tsx:42`.
- Reusable builders: `app/src/lib/chat-tool-messages.ts` —
  `buildToolResultMessage` (synthetic `isToolResult` user msg, ~195),
  `markLastAssistantToolCall` (~208), `appendCardsToLatestToolCall` (~230),
  plus `buildToolMeta`.
- `ChatMessage` fields: `isToolCall`, `isToolResult`, `toolMeta` (ToolMeta:
  `{toolName, source, provider?, durationMs, isError?, triggeredBy}`), `cards`
  (`app/src/types/index.ts`).

## Key finding (corrects a first-pass assumption)

The coder kernel **does not emit per-tool run-events today**.
`tool.execution_start` / `tool.execution_complete` are emitted only by the
Orchestrator web loop (`app/src/hooks/chat-single-tool-execution.ts`,
`chat-batched-execution.ts`) and `cli/engine.ts` — **not** `lib/coder-agent.ts`.
The inline lane wires `onRunEvent → ctx.appendRunEvent`
(`chat-send-inline.ts:557`) but only receives `assistant.prompt_snapshot`. So
there is **no per-tool stream to render from yet**.

The data *does* exist inside the kernel: each tool runs through `toolExec` and
its card is collected into `allCards` at `lib/coder-agent.ts` ~1198 (parallel
reads `entry.card`), ~1243 (mutation `mutResult.card`), ~1599 (single
`result.card`). The event type already exists in `lib/protocol-schema.ts`
(`tool.execution_complete` → `validateToolResult`).

## Plan (3 parts)

### Part 1 — Kernel emits per-tool events (`lib/coder-agent.ts`, shared, additive)

Wrap each `toolExec` invocation (the three sites above) to time it and emit:

```
callbacks.onRunEvent?.({
  type: 'tool.execution_complete',
  round, executionId, toolName, toolSource,
  durationMs, isError, preview,
})
```

- Additive + gated on `onRunEvent` presence. The Orchestrator path runs its own
  loop (no double-emit); kernel-based paths (inline lane, background CoderJob DO,
  daemon task-graph node) currently emit nothing per-tool here, so this is
  net-new — also a free observability win for the DO/daemon.
- **Full tier:** include the per-tool `card` on the event (available right at the
  emit site) so the disclosure can render it inline. v1 tier omits it.
- Keep the existing flat `result.cards` return unchanged.

### Part 2 — Inline lane synthesizes the disclosure (`chat-send-inline.ts`)

Capture the `tool.execution_complete` events during the run (tee off the
`onRunEvent` wiring at line 557, or read them back from runState). At completion,
in/around `completeAssistantMessage` (line ~717), synthesize the consecutive
`isToolCall`/`isToolResult` pairs (reuse `chat-tool-messages.ts` builders) and
insert them into `conv.messages` **immediately before** the final summary
message. `groupChatMessages` then renders `[collapsible "Used N tools"] +
[answer]` — the screenshot-2 layout, no new UI.

- **v1:** tool list only (name/duration/error). `result.cards` stay on the final
  message as today.
- **Full:** the per-tool card from the event rides on the synthesized `callMsg`
  (`appendCardsToLatestToolCall`), rendering inside the disclosure like the old
  path; drop those cards from the final message to avoid duplication.

### Part 3 — Safety checks (verification, mostly no new code)

- Synthetic pairs are **display-only**. Resume/adoption uses the kernel
  transcript (`checkpointRefs.apiMessages = state.messages` via the lane's
  `onCheckpoint`), not `conv.messages` — so checkpoints are unaffected. Confirm
  the synthetic messages are inserted *after* the final `flushCheckpoint`, or are
  otherwise excluded from any checkpoint capture.
- Confirm synthetic `isToolCall`/`isToolResult` messages are excluded from the
  **next** turn's model context. `buildInlineTurnPreamble` already filters
  `!isToolCall && !isToolResult` (verified). Re-check the persisted-conversation
  reload path renders them (good) but never re-feeds them to the model.
- Live vs post-run: v1 inserts at completion (collapsible "pops in" above the
  answer). A later pass could insert progressively as events arrive for a live
  feel, but that complicates streaming-placeholder positioning — defer.

## Tests

- `lib/coder-agent.test.ts`: `runCoderAgent` emits one `tool.execution_complete`
  per executed tool with `{toolName, durationMs, isError}` (and `card` in Full).
- `app/src/hooks/chat-send-inline.test.ts`: N captured tool events → N
  consecutive `isToolCall`/`isToolResult` pairs inserted before the final
  message; `groupChatMessages` over the result yields one `toolGroup` + the
  answer text segment.

## Scope decision

- **v1** — kernel event (no card) + lane synthesis. Restores the collapsible
  "Used N tools" fast; cards stay on the final message.
- **Full** — + per-tool `card` on the event, rendered inside the disclosure.
  Closest to the old screenshot. One extra event field + plumbing.

This plan reuses the existing `ToolCallSummary` rendering end-to-end; the only
new runtime surface is the kernel's per-tool event emission.
