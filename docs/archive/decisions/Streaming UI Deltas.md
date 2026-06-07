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
mostly absent or stubbed. Treat this doc accordingly: the borrowed
`displayContent` / `iconName` / `approvalKey` field set comes from a shape the
production server clearly emits in `ToolUseBlockUpdateDelta.kt`, not from any
verification of how the official client consumes it. Push wires the same
fields onto its own existing `tool.execution_start` event rather than copying
the APK's parallel-event design.

## Problem

Push already renders rich, typed UI for tool output: 24+ discriminated
`ChatCard` variants in `app/src/types/index.ts:324-349`, lazy-loaded by
`app/src/components/cards/CardRenderer.tsx`. That part of the stack is mature.

What's missing is **mid-turn UI scaffolding**. Today, in foreground turns:

1. The agent decides to call a tool. `chat-send.ts` emits a
   `tool.execution_start` run event carrying `executionId` + `toolName` for
   the journal and hub console
   (`app/src/hooks/chat-send.ts:841, 1004, 1116, 1446`;
   shape in `lib/runtime-contract.ts:266`).
2. `chat-tool-execution.ts` runs the tool to completion and produces a
   `ToolExecutionResult` whose `card` is the typed `ChatCard` for the result.
3. `appendCardsToLatestToolCall` (`app/src/lib/chat-tool-messages.ts:230`)
   appends that card to the latest assistant tool-call message.
4. `MessageBubble` renders the cards via `CardRenderer`
   (`app/src/components/chat/MessageBubble.tsx:552`) — only at this point.

The card UI doesn't appear until step 3. For long-running tools (sandbox
commands, PR fetches, audits), the user sees a spinner or raw text where a
typed card skeleton — with the right icon, title, and approval affordance —
could be visible from the moment the tool is invoked.

This matters more on mobile, where perceived latency dominates and there's
less peripheral feedback (no separate panes, smaller status bar, no hover
hints).

## Proposal

Extend the existing `tool.execution_start` run event
(`lib/runtime-contract.ts:266`) with optional display-metadata fields. The
client appends a generic **`pending-tool` placeholder card** when it sees the
event, and replaces it with the real, fully-typed `ChatCard` when the tool
finishes via the existing `appendCardsToLatestToolCall` flow.

This is a strictly additive change to an event that already exists, already
carries `executionId` + `toolName`, and is already emitted at every
foreground tool-call site. No parallel event type, no new SSE channel, no
naming-scheme divergence from the rest of the run-event vocabulary.

### Event Extension

`tool.execution_start` today carries `round`, `executionId`, `toolName`,
and `toolSource`. Add four optional fields:

```typescript
{
  type: 'tool.execution_start';
  round: number;
  executionId: string;
  toolName: string;
  toolSource: string;
  // New, all optional. Emitters that can't supply meaningful metadata
  // simply omit them and the client falls back to today's post-hoc
  // rendering.
  displayContent?: string;     // human-readable subtitle (e.g. file path, URL)
  iconName?: string;           // mapped to an existing icon set
  approvalKey?: string;        // if present, scaffold the approval affordance
  approvalOptions?: string[];  // optional approval choices
}
```

Display metadata is decidable at dispatch from the call envelope alone
(tool name + args). Each instrumented tool gets a small
`getDisplayMetadata(args) → { iconName, displayContent, approvalKey }`
helper that runs at the existing emission sites in `chat-send.ts`.

### Wire Format

The event already serializes through `appendEvent` and `formatSseChunk` in
`coder-job-do.ts:910-985`. No SSE-format change. Example with display
fields populated:

```
event: tool.execution_start
data: {"type":"tool.execution_start","round":2,"executionId":"...","toolName":"sandbox_exec","toolSource":"agent","displayContent":"npm test","iconName":"terminal","approvalKey":"sandbox.exec"}
```

### Client Consumption

Add a foreground consumer for `tool.execution_start` that, when display
metadata is present, appends a `pending-tool` `ChatCard` to the latest
assistant tool-call message via the existing
`appendCardsToLatestToolCall` helper (`app/src/lib/chat-tool-messages.ts:230`).
The card carries `executionId` so the later swap can find it.

When the tool finishes, `chat-tool-execution.ts` already calls
`appendCardsToLatestToolCall` with the real, typed card. Extend that path
to first remove any `pending-tool` card with a matching `executionId` from
the target message before appending the real card. The update is a normal
immutable array operation — same shape as the existing
`upsertJobCardData` helper (`app/src/hooks/useBackgroundCoderJob.ts:234-244`)
which already spreads the card, message, and conversation. `MessageBubble`
renders cards with `key={i}` (`MessageBubble.tsx:552`), so React's normal
reconciliation handles the swap; no special re-render plumbing is needed.

The existing 24+ card components are unchanged. They never see a `pending`
state — the placeholder is a separate, dedicated component.

### Approval Affordance

If `approvalKey` is present, the placeholder renders the approval row
immediately. This is the highest-value part of the change: today the user
sees nothing, then suddenly an approval modal/card appears once the tool
has done enough work to produce one. With the extended event, the
placeholder declares "this will need approval" from the moment it streams.

`approvalKey` is **purely a UI signal** — it does not pre-decide the
approval outcome. The actual gate evaluation still happens in
`app/src/lib/approval-gates.ts` during tool execution; the field only
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

Three things to know before implementing. The first two correct hypotheses
from earlier drafts of this doc that turned out to be wrong against the
actual code.

1. **The card *data* is what's unavailable at dispatch — not the
   `cardType`.** An earlier draft asserted that `cardType` itself wasn't
   knowable until the tool finished. That's incorrect for most tools —
   `sandbox_exec`, for example, always returns `{ type: 'sandbox' }`
   including on the error path (`app/src/lib/sandbox-tools.ts:383`). What
   *is* unavailable at dispatch is the card's `data` (stdout, exitCode,
   parsed PR metadata, etc.), which only exists post-execution. The
   placeholder card is still the right move, but for that reason: render
   generic UI from dispatch metadata, then swap to the typed card once
   data lands. (A small handful of tools genuinely vary their cardType by
   output — those can either always emit `pending-tool` first and let the
   real card replace it, or skip emitting display metadata.)

2. **`upsertJobCardData` is already immutable, and `CardRenderer` has no
   special keying.** An earlier draft warned that `CardRenderer` keyed off
   card identity and that `upsertJobCardData` mutated `data` in place.
   Neither holds: `upsertJobCardData`
   (`app/src/hooks/useBackgroundCoderJob.ts:234-244`) spreads `card`,
   `card.data`, the message, and the conversation; `MessageBubble`
   renders cards with `key={i}`
   (`app/src/components/chat/MessageBubble.tsx:552`); `CardRenderer` itself
   does no keying. The placeholder→real swap is therefore just a normal
   immutable array update — the same shape that already works for
   `coder-job` cards.

3. **First-wave instrumentation lives where `tool.execution_start` is
   already emitted.** Foreground emission sites are
   `app/src/hooks/chat-send.ts:841, 1004, 1116, 1446`; CLI sites are in
   `cli/engine.ts`. Each site already has the call envelope in scope when
   it builds the event, so attaching display metadata is a local change.
   No cross-package binding plumbing is required — that constraint from an
   earlier scoping pass turned out not to apply once the proposal settled
   on extending the existing run-event vocabulary instead of adding a
   parallel event.

## Open Questions

1. **Backpressure.** If `tool.execution_start` and the real card land in the
   same render pass (very fast tools), the placeholder/replace dance is
   wasted work. Worth measuring before deciding whether to skip the
   placeholder for tools that typically return in <100ms.
2. **Failure modes.** If `tool.execution_start` arrives but no matching
   complete event ever does (worker crash, stream cut), the placeholder
   needs a TTL or a turn-end cleanup hook so it doesn't sit pending
   forever.
3. **Tool coverage.** First-wave candidates are the slow tools with
   predictable display metadata: `sandbox_exec` (command + cwd),
   `fetch_pr` (owner/repo/number), audit verdicts (target). Fast/internal
   tools simply emit `tool.execution_start` without display fields and
   skip the placeholder.

## Migration Sketch

1. Add the optional `displayContent`, `iconName`, `approvalKey`,
   `approvalOptions` fields to `tool.execution_start` in
   `lib/runtime-contract.ts:266`. Glance at `lib/run-events.ts:15` for any
   field-level normalization. ~10 lines.
2. Add a `pending-tool` variant to the `ChatCard` discriminated union
   (`app/src/types/index.ts:324-349`) carrying `executionId`, `toolName`,
   and the optional display fields. Build a `PendingToolCard` component
   and register it with `CardRenderer`. ~80 lines incl. component.
3. Add a foreground consumer that, on `tool.execution_start` with display
   metadata, appends a `pending-tool` card via
   `appendCardsToLatestToolCall`. ~30 lines.
4. Extend `chat-tool-execution.ts` so the post-execution card append first
   removes any `pending-tool` whose `executionId` matches before
   appending the real card. ~20 lines.
5. Add `getDisplayMetadata(args)` helpers for the first-wave tools and
   pass the results to the existing `tool.execution_start` emission sites
   in `chat-send.ts:841, 1004, 1116, 1446`. ~10 lines per site.
6. Validate end-to-end with `sandbox_exec`. Roll out to remaining slow
   tools incrementally.

Estimated total: 2–4 hours of focused work. The earlier half-to-full-day
estimate assumed cross-package binding plumbing that turned out not to be
needed once the proposal settled on extending the existing run-event
vocabulary instead of adding a parallel event.

No wire-format breaking changes — older clients see the new fields as
no-ops and fall back to today's post-hoc behavior.
