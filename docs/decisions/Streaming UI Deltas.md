# Streaming UI Deltas

Design note for streaming typed UI scaffolding from Worker to client mid-tool-execution, instead of attaching display cards post-hoc once the tool returns.

## Source and Sourcing Caveat

This proposal was prompted by a research summary on
[`MartinPSDev/Claudio`](https://github.com/MartinPSDev/Claudio), a third-party
reverse-engineering project that reconstructs source from the decompiled Claude
Android APK. The repo is **not affiliated with Anthropic**, its README states it
likely will not compile, and many UI files are stubs with `TODO` viewmodels.

The reliable signal from that repo is API/model **shapes** (decompiled directly
from the production APK bytecode). Anything portrayed as runtime UI behavior
in the reverse-engineer should not be cited as evidence of how Anthropic's app
actually behaves — the Compose composables that would render those shapes are
mostly absent or stubbed. Treat this doc accordingly: the delta envelope is
borrowed because it's a sensible shape the production server clearly emits, not
because we can verify how the official client consumes it.

## Problem

Push already renders rich, typed UI for tool output: 24+ discriminated
`ChatCard` variants in `app/src/types/index.ts:324-349`, lazy-loaded by
`app/src/components/cards/CardRenderer.tsx`. That part of the stack is mature.

What's missing is **mid-turn UI scaffolding**. Today:

1. Worker dispatches a tool call.
2. Tool runs to completion in the sandbox.
3. Worker emits the tool result as a JSON payload bundled with the assistant
   message.
4. Client parses the payload via `parseSseBlock` in
   `app/src/hooks/useBackgroundCoderJob.ts:140-160` and only then constructs
   the `ChatCard` for `CardRenderer` to render.

The card UI doesn't appear until step 4. For long-running tools (sandbox
commands, PR fetches, audits), the user sees a spinner or raw text where a
typed card skeleton — with the right icon, title, and approval affordance —
could be visible from the moment the tool is invoked.

This matters more on mobile, where perceived latency dominates and there's
less peripheral feedback (no separate panes, smaller status bar, no hover
hints).

## Proposal

Add a `tool_use_delta` SSE event that ships **display metadata** on tool-call
start, before the tool result is available. The client renders a single
generic **`pending-tool` placeholder card** populated from the delta, then
swaps it for the real, fully-typed `ChatCard` when the matching tool result
arrives.

### Delta Envelope

Borrowing the shape verified in the decompiled APK
(`ToolUseBlockUpdateDelta.kt`), with one deliberate omission (see Scoping
Notes for why `cardType` is dropped):

```typescript
interface ToolUseDelta {
  toolUseId: string;          // correlates with later result event
  toolName: string;           // e.g. "sandbox_exec", "fetch_pr"
  displayContent?: string;    // human-readable subtitle (e.g., file path, URL)
  iconName?: string;          // mapped to an existing icon set
  approvalKey?: string;       // if present, scaffold the approval affordance
  approvalOptions?: string[]; // optional approval choices ("approve", "deny", "edit")
  integrationName?: string;   // for third-party tool branding (later)
}
```

All fields except `toolUseId` and `toolName` are optional. A tool that has
nothing meaningful to scaffold simply doesn't emit a delta and falls back to
today's post-hoc rendering.

### Wire Format

Reuse the existing SSE channel in
`app/src/worker/coder-job-do.ts` (events flow through `appendEvent` at
`coder-job-do.ts:910-931` and serialize via `formatSseChunk` at
`coder-job-do.ts:983-985`). Add one new event type to `RunEventInput` in
`@push/lib/runtime-contract`:

```
event: tool_use_delta
data: {"toolUseId":"...","toolName":"sandbox_exec","displayContent":"npm test","iconName":"terminal","approvalKey":"sandbox.exec"}
```

Followed later (potentially seconds later, after the tool returns) by the
existing tool-result-bearing event that `parseSseBlock` already handles.

### Client Consumption

In `useBackgroundCoderJob.ts`, extend `dispatchServerEvent` (lines 305-427)
with a new case for `tool_use_delta`:

1. On delta, append a new `pending-tool` `ChatCard` to the message's `cards`
   array. Store the `toolUseId` on the card so the later result can find it.
2. `CardRenderer` renders the dedicated `PendingToolCard` component, which
   shows the icon, tool name, subtitle, and (if `approvalKey` is set) the
   approval affordance from the first frame.
3. On the matching tool result, **replace the entire card object** in the
   array with the real, typed `ChatCard` for that tool. Do not mutate
   `card.data` in place — `CardRenderer` keys off card identity, not data
   identity, so an in-place mutation will not re-render (`CardRenderer.tsx`
   lines 244-275). Use a new sibling helper to `upsertJobCardData`
   (`useBackgroundCoderJob.ts:225-247`) that performs the swap.

The existing 24+ card components are unchanged. They never see a `pending`
state — the placeholder is a separate, dedicated component.

### Approval Affordance

If `approvalKey` is present in the delta, the placeholder renders the
approval row immediately. This is the highest-value part of the change:
today the user sees nothing, then suddenly an approval modal/card appears
once the tool has done enough work to produce one. With deltas, the
placeholder declares "this will need approval" from the moment it streams.

The delta's `approvalKey` is **purely a UI signal** — it does not pre-decide
the approval outcome. The actual gate evaluation still happens in
`app/src/lib/approval-gates.ts` during tool execution; the delta only
declares that approval *may* be needed so the affordance can render early.

## What's Out of Scope

- **Re-architecting the card layer.** The 24+ `ChatCard` types and
  `CardRenderer` lazy-load model are working well. The only addition is one
  new `pending-tool` variant + its renderer; existing card components are
  unchanged.
- **Generic block-level streaming for prose.** Assistant text and `ThinkingBlock`
  already stream fine. This proposal is specifically about *tool-call* UI.
- **Mobile-only delivery.** Web and CLI both consume the same SSE; CLI can
  ignore unknown events and continue working unchanged.
- **MCP Host work.** The original research conflated this with capability
  fabrication; treat it as a separate, unrelated topic.
- **Custom byte-level SSE parsing.** The browser's `ReadableStream` +
  `TextDecoder` path in `useBackgroundCoderJob.ts` is appropriate for a web
  bundle. The Okio-based parsing in the decompiled APK is a native-Android
  concern with no equivalent benefit here.

## Scoping Notes

A scoping pass against the current code surfaced three constraints that
shaped the design above. Recording them here so a future implementer doesn't
re-derive them from scratch.

1. **`cardType` is not knowable at dispatch time.** The original draft of
   this doc shipped `cardType: ChatCard['type']` in the delta. In practice,
   tools decide which card variant to emit *based on their output shape* —
   e.g. `sandbox_exec` doesn't know whether it'll produce a `sandbox` card
   vs. something else until after it runs (`app/src/lib/sandbox-tools.ts`
   around line 383; same pattern for `diff-preview` in
   `sandbox-git-release-handlers.ts`). Asking each tool to pre-declare a
   speculative `cardType` would either lie when execution disagrees, or
   require a contract change across every tool. The placeholder approach
   sidesteps this: the delta describes *what's about to run*, not *what the
   result will look like*.

2. **No single tool-dispatch chokepoint in the worker.** Tool invocation is
   not a `coder-job-do.ts`-local `await tool(...)` site. Dispatch lives
   inside `@push/lib/coder-agent-bindings`, called from
   `coder-job-do.ts:648` via `runCoderAgentLib` after `buildCoderToolExec`
   constructs the executor (line 636). Emitting the delta requires
   plumbing through the binding layer — either by wrapping the executor
   before it's passed to the agent, or by adding a `before-tool-call` hook
   to the executor contract. This is a cross-package change, not a
   localized worker edit.

3. **`CardRenderer` does not re-render on `card.data` mutation.** The
   renderer (`app/src/components/cards/CardRenderer.tsx:244-275`) keys off
   the `card` object identity, not its `data` field. The existing
   `upsertJobCardData` helper (`useBackgroundCoderJob.ts:225-247`) mutates
   `data` in place, which works for `CoderJobCardData` only because that
   path also reassigns the card. The placeholder→real swap must replace
   the whole card object in the array, not patch `card.data`.

## Open Questions

1. **Backpressure.** If a delta and result land in the same SSE flush, the
   placeholder/replace dance is wasted work. Worth measuring before deciding
   whether to skip the delta when the tool returns synchronously.
2. **Failure modes.** If a delta arrives but no matching result ever does
   (worker crash, stream cut), the placeholder needs a TTL or a job-level
   cleanup hook so it doesn't sit pending forever.
3. **Tool coverage.** First-wave candidates are the slow tools with
   predictable display metadata: `sandbox_exec` (command + cwd), `fetch_pr`
   (owner/repo/number), audit verdicts (target). Fast/internal tools
   probably skip deltas to avoid the backpressure issue above.

## Migration Sketch

1. Add `ToolUseDelta` to `@push/lib/runtime-contract` as a new variant of
   `RunEventInput`. ~40 lines.
2. Add a `pending-tool` variant to the `ChatCard` discriminated union
   (`app/src/types/index.ts:324-349`) carrying `toolUseId`, `toolName`,
   and the optional display fields. Build a `PendingToolCard` component
   and register it with `CardRenderer`. ~80 lines incl. component.
3. Plumb a `beforeToolCall(meta) → emit delta` hook through
   `@push/lib/coder-agent-bindings` so the worker can fire the delta
   without each tool needing to know about SSE. ~30-50 lines, plus
   contract change in the bindings package.
4. Worker: wire the hook in `coder-job-do.ts` to call `appendEvent` with
   the new variant. ~15-20 lines.
5. Client: add a `tool_use_delta` case to `dispatchServerEvent`
   (`useBackgroundCoderJob.ts:305-427`) that appends a `pending-tool`
   card; add a sibling helper to `upsertJobCardData` that replaces the
   whole card object on tool result. ~80-120 lines.
6. Wire up one tool first (`sandbox_exec`) end-to-end to validate. Roll
   out to remaining slow tools incrementally.

Estimated total: half day to full day of focused work, dominated by the
binding-layer plumbing in step 3 and the placeholder/replace state
management in step 5. Not a single-session change.

No wire-format breaking changes — clients on older builds ignore the unknown
event and fall back to today's post-hoc behavior.
