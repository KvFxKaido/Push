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
start, before the tool result is available. The client renders a card skeleton
from the delta and fills in the result payload when the matching
`tool_use_result` event arrives.

### Delta Envelope

Borrowing the shape verified in the decompiled APK
(`ToolUseBlockUpdateDelta.kt`):

```typescript
interface ToolUseDelta {
  toolUseId: string;          // correlates with later result event
  cardType: ChatCard['type']; // which CardRenderer component to scaffold
  displayContent?: string;    // human-readable subtitle (e.g., file path, URL)
  iconName?: string;          // mapped to an existing icon set
  approvalKey?: string;       // if present, scaffold the approval affordance
  approvalOptions?: string[]; // optional approval choices ("approve", "deny", "edit")
  integrationName?: string;   // for third-party tool branding (later)
}
```

All fields except `toolUseId` and `cardType` are optional — a tool that has
nothing meaningful to scaffold simply doesn't emit a delta and falls back to
today's post-hoc rendering.

### Wire Format

Reuse the existing SSE channel in
`app/src/worker/coder-job-do.ts`. Add one event type:

```
event: tool_use_delta
data: {"toolUseId":"...","cardType":"diff-preview","displayContent":"app/src/foo.ts","iconName":"file-diff"}
```

Followed later (potentially seconds later, after the tool returns) by the
existing tool-result-bearing event that `parseSseBlock` already handles.

### Client Consumption

In `useBackgroundCoderJob.ts`, extend the parser to handle `tool_use_delta`:

1. On delta, insert a placeholder `ChatCard` keyed by `toolUseId` with a
   `pending: true` flag and the delta's display fields.
2. `CardRenderer` renders the card component normally, but the component
   reads `pending` and renders its skeleton state with the supplied icon /
   subtitle / approval affordance visible.
3. On the matching tool result, replace the placeholder's `data` with the
   real payload and clear `pending`. The component re-renders with full
   content. No remount.

Each card component decides what its skeleton looks like — most already have
some loading state; this just gives them metadata to populate it with from the
first frame.

### Approval Affordance

If `approvalKey` is present in the delta, render the approval row immediately.
This is the highest-value part of the change: today the user sees nothing,
then suddenly an approval modal/card appears once the tool has done enough
work to produce one. With deltas, the card declares "this will need approval"
from the moment it streams.

The actual approval handler stays where it is in
`app/src/lib/approval-gates.ts` — the delta is purely a UI signal.

## What's Out of Scope

- **Re-architecting the card layer.** The 24+ `ChatCard` types and
  `CardRenderer` lazy-load model are working well. Don't touch them beyond
  letting components read a `pending` flag.
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

## Open Questions

1. **Tool coverage.** Which tools are worth emitting deltas for first? The
   highest-leverage candidates are the slow ones with predictable display
   metadata: `sandbox_exec` (command + cwd), `fetch_pr` (owner/repo/number),
   `read_file` (path), audit verdicts (target). Internal/fast tools probably
   skip deltas.
2. **Backpressure.** If a delta and result land in the same SSE flush, the
   placeholder/replace dance is wasted work. Worth measuring before deciding
   whether to skip the delta when the tool returns synchronously.
3. **Failure modes.** If a delta arrives but no matching result ever does
   (worker crash, stream cut), the placeholder needs a TTL or a job-level
   cleanup hook so it doesn't sit pending forever.

## Migration Sketch

1. Add the `ToolUseDelta` type and SSE event constant alongside existing
   stream event types.
2. Worker: emit `tool_use_delta` from the tool-dispatch entry point, before
   `await`ing tool execution. One tool wired first (likely `sandbox_exec`)
   to validate the round-trip end-to-end.
3. Client: extend `parseSseBlock` consumer to insert/replace placeholder
   cards by `toolUseId`.
4. Update one card component (e.g., `SandboxStateCard` or a new generic
   `PendingToolCard`) to render the skeleton from delta metadata.
5. Roll out to remaining slow tools incrementally.

No wire-format breaking changes — clients on older builds ignore the unknown
event and fall back to today's post-hoc behavior.
