# Tool Render Payload — Cards Are Declared, Not Sniffed

Date: 2026-07-13
Status: **Current** — **Slices 0–2 shipped**: the shared `ToolCard` vocabulary lives in `lib/tool-cards.ts`; the kernel carries cards on `tool.execution_complete` without exposing them to the model; inline TUI, daemon-attached TUI, and `push attach` render the same bounded generic fallback. Daemon delivery is gated by `tool_cards_v1`, with cards stripped from legacy clients on both live and replay paths. Slices 3–5 (producers → narration parity → delete the sniffing) remain. Owner: Push runtime (shared `lib/` + both shells).

Related: [`Workspace State Events — Snapshot + Delta.md`](<Workspace State Events — Snapshot + Delta.md>) — the template this follows almost exactly (shared vocabulary in `lib/`, strict wire validators, capability-gated daemon producer, TUI + web consumers, drift tests). [`Structured Tool-Call Sourcing.md`](<Structured Tool-Call Sourcing.md>) — its complement: that doc structures the **model-facing** side of a tool exchange; this one structures the **render-facing** side. [`Agent Runtime Decisions.md`](<Agent Runtime Decisions.md>) §4 (roles are runtime labels; display vocabulary is separate) — the same "presentation is its own vocabulary" instinct, applied one level down.

## Motivation

The same tool call renders as a designed card in the web app and a JSON blob in the TUI. That is not a styling gap. The two surfaces are consuming **two different render contracts**, and only one of them is real.

The web has a typed contract: 29 `ChatCard` variants and a `CardRenderer` that dispatches on `card.type` through a component registry. The TUI has no contract at all — it **infers** presentation by inspecting model-facing text:

- `looksLikeUnifiedDiff(body)` (`cli/tui-framers.ts:139`) regex-sniffs `@@ -n,n +n,n @@` to guess whether a tool result is a diff.
- `summarizeToolArgs(args)` (`cli/tui-framers.ts:55`) guesses which argument matters by trying `command`, then `path`, then `file` — and dumps raw JSON when none match.

Push has **~68 tools**. A three-field heuristic cannot cover 68 tools, so the long tail renders as JSON. This is a structural ceiling, not a polish backlog: the renderer is missing the information it needs, and no amount of TUI work can synthesize it.

The instinct that "the structure is off compared to other tools" is correct, and it is measurable.

## Current state (verified in code, 2026-07-13)

The render payload **already exists**. It was never lifted into the contract.

| Site | What it proves |
|---|---|
| `app/src/types/index.ts:492` | `ChatCard` union — 29 typed variants (`pr`, `commit-list`, `diff-preview`, `audit-verdict`, `ci-status`, `test-results`, `type-check`, `coder-progress`, `workspace-patch`, …). **Web-only.** |
| `app/src/components/cards/CardRenderer.tsx` | Registry dispatch on `card.type`, with a tombstone row for unknown types so older persisted chats degrade gracefully. The consumer pattern is already right. |
| `app/src/lib/sandbox-tools.ts:989,1013,1063,…` | Tool results already carry `card: { type, data }`. The producer pattern is already right. |
| `lib/auditor-agent.ts:188` | `AuditResult = { verdict; card: AuditVerdictCardData }` — a typed card **already in shared `lib/`**. |
| `cli/tools.ts:2424` | Comment, verbatim: *"The core returns `{ text, card? }`. Surface text to the model."* The split is already named. |
| `cli/tui-framers.ts:530` | The TUI already renders one structured card (`EditDiff`) with a line-number gutter and tinted diff blocks. **The TUI can do this. It only ever gets one card.** |
| `lib/coder-agent.ts:843` | `CoderToolExecResult<TCard>` — the shared kernel is **already generic over a card** and already carries `resultText` (model) alongside `card?` (render). |
| `lib/coder-agent.ts:869` | The `editDiff` doc comment, verbatim: *"Forwarded verbatim onto the `tool.execution_complete` run event as `diff` so transcript surfaces can render the edit; **never enters the model-visible tool result**."* |
| `lib/coder-agent.ts:2191, 2271, 2715` | Three sites spread `{ diff: entry.editDiff }` onto `tool.execution_complete`. **No site ever spreads `card`.** |

So: 29 card types on web, **3** card producers reachable from shared `lib/`, and a TUI that sniffs text for everything else.

### The decisive detail

**The contract this doc proposes already exists — for exactly one field.**

`editDiff` is a typed, structured, render-only payload that rides the `tool.execution_complete` run event and is explicitly forbidden from reaching the model. That is precisely the `{ text, card? }` split, already built, already load-bearing, already documented in `lib/coder-agent.ts:869`.

Meanwhile `card?: TCard` is *collected* by the kernel and then **dropped** — no site forwards it onto a run event. And `TCard` is a bare type parameter (`CoderAgentOptions<TCall, TCard>`: *"the kernel never inspects either type internally — it only forwards calls to `toolExec` and collects the returned cards"*), so there is no shared card vocabulary for a non-web shell to consume even if one arrived.

That narrows the work considerably. This is not "introduce a render payload." It is:

1. **Generalize** the proven `editDiff → diff` forwarding to `card`.
2. **Concretize** `TCard` into a shared `ToolCard` union in `lib/` so a second shell can type it.

The hard part — proving that a render-only payload can ride the run-event stream without leaking to the model — has already shipped.

`ChatCard` living in `app/src/types/` is a direct violation of a rule Push already wrote down (`CLAUDE.md`, Shared runtime in root `lib/`):

> *"Cross-surface semantics live here and are consumed by both web and CLI. Don't re-implement them per surface — promote a per-surface helper into `lib/` the moment a second surface needs it."*

The render payload **is** cross-surface semantics. A second surface needed it a long time ago.

## The thesis

**Presentation is declared by the tool, never inferred from its output.**

A tool result has two audiences, and they are not the same object:

- `text` — what the **model** reads. Prose, truncated, token-budgeted.
- `card` — what the **user** sees. Typed, structured, and **never sent to the model**.

Once `card` is part of the shared contract, both shells dispatch on `card.type` and *cannot disagree*, because there is one vocabulary. The sniffing helpers stop being load-bearing and get deleted.

This is not adopting a foreign pattern. It is finishing the one already half-built, on the correct side of the `lib/` boundary.

## Field evidence

All three reference agents enforce this split. None of them inspects a string to decide what it is.

| | Model-facing | Render-facing (model never sees it) |
|---|---|---|
| **OpenCode** (`sst/opencode`) | `ToolState.output` — the only field serialized into model messages | `metadata` — diff, LSP diagnostics, live stdout, exit code. v2 renames it `structured` and adds it to the **running** state, making live progress a first-class field |
| **Pi** (`earendil-works/pi`) | `content` on the tool result | `details` — explicitly not sent to the model. The `ToolDefinition` itself carries `renderCall()` / `renderResult()`, so **the tool ships its own renderer** — and the *same* renderer drives the TUI, the HTML export, and every RPC client |
| **Codex CLI** | `response_item` stream | `event_msg` stream. Transient `exec` output deltas are streamed and **discarded**; `patch_apply_end` is **persisted** — the durable log keeps what changed the world |

Two structural lessons worth taking beyond the payload itself:

1. **Pi's renderer-on-the-tool** is the strongest version: one definition serves every surface, and adding a tool cannot leave a surface behind. Push's `CardRenderer` registry is the same idea reached from the consumer side — but the *producer* side (which card a tool emits) is still ad hoc.
2. **Codex's durability split** — persist what changed the world, discard transient reads — is a policy Push should make explicit rather than accidental.

## Decision

### 1. The card vocabulary moves to `lib/`

`lib/tool-cards.ts` becomes the single canonical definition of the `ToolCard` union and its per-variant data shapes. `app/src/types/index.ts` re-exports it; it does not define it. This mirrors `lib/capabilities.ts` ("extend here, not per-surface") and `lib/role-display.ts` (single source of truth for user-facing labels).

### 2. The tool-result contract carries it

The shared tool result becomes `{ text, card? }` — the shape `cli/tools.ts:2424` already describes. `text` is the model's; `card` is the user's. **A card is never serialized into an LLM message.** That invariant gets a test, not a comment.

### 3. Cards are produced by tools, consumed by shells

A tool declares its card. Neither shell decides what a tool "probably" returned. Producers live with the tool (shared `lib/` where the tool core is shared); consumers are the web `CardRenderer` and a new TUI card renderer.

### 4. The TUI dispatches on `card.type` and drops the heuristics

`looksLikeUnifiedDiff` and the `command`/`path`/`file` guess in `summarizeToolArgs` are deleted once the payload is typed. The `EditDiff` renderer at `cli/tui-framers.ts:530` becomes the *first* member of a card renderer family rather than a one-off — it is already the proof the TUI can render typed cards well.

Not every card needs a bespoke TUI treatment on day one. A **generic typed fallback** (title + key/value rows, derived from the card's declared shape) is strictly better than a JSON dump, because it is driven by structure rather than a guess.

### 5. Unknown cards degrade, they do not crash

Both shells keep the web's tombstone behavior: an unrecognized `card.type` renders a visible, inert placeholder. This is what lets the vocabulary evolve without breaking persisted chats — and it is why a *typed* union with a tombstone beats an untyped blob.

### 6. Cards are emitted by the **kernel**, on the run event — not by the daemon

The daemon is **not** the producer. It is one transport among several.

There is a non-daemon path: the inline/local TUI calls `runAssistantTurn(..., { emit: onEvent })` directly (`cli/silvery/controller.ts:1713`), bypassing pushd entirely. If cards were emitted only as a capability-gated daemon message, **attached daemon clients would get cards while inline TUI runs silently dropped them** — reintroducing the exact two-contract split this doc exists to kill, just along a different seam.

So: `card` rides `tool.execution_complete` from the shared kernel, exactly as `diff` already does (`lib/coder-agent.ts:2191, 2271, 2715`). Every run-event consumer — inline TUI, daemon clients, web — receives it from one producer.

The daemon then **strips or forwards** per client capability (`tool_cards_v1`), the same way `cli/pushd.ts:2262` gates workspace-state events on `workspace_state_v1`. Capability gating is a property of the *transport*, not of the *payload*.

(Caught in review of this doc — the original draft put emission in the daemon and would have shipped the bug it was written to prevent.)

### 7. Narration (`tool_prose`) is the same payload, and rides the same rails

Assistant **narration** — the prose a model streams before its tool calls — is a render-only payload with exactly the properties this doc describes: typed, structured, shown to the user, and **never sent back to the model**. It is not a separate problem. It is the second instance of this one.

Its history is confusing enough to be worth stating plainly, because the record has already misled once:

| PR | What happened |
|---|---|
| **#1252** | Per-round inline narration exposed |
| **#1254** | **Reverted** — intermediate text was too variable across the fleet (deepseek-v4 rendered *"The user wants a recent-activity overview. I'll fetch commits…"* as a user-facing bubble) |
| **#1294** | **Shipped anyway**, and correctly: narration survives as settled, display-only `kind: 'tool_prose'` messages (`visibleToModel: false`), interleaved `prose → tool group → prose → tool group → final answer` |

**Narration is not collapsed today. It is live on web.** Any note claiming otherwise predates #1294.

And it is stranded on exactly the same side of the boundary as the cards:

| | narration |
|---|---|
| **Web** | typed `tool_prose` messages; `visibleToModel: false` drops them from the context transformer, checkpoint capture, and the inline seed filter |
| **CLI/TUI** | **nothing.** `tool_prose` does not appear anywhere in `cli/` |

The splitting logic is stranded too, and split across two files — both web-only, neither reachable from `lib/` or `cli/`:

- `stripToolCallPayload` — `app/src/lib/message-content.ts:127`
- `splitVisibleContent` — `app/src/hooks/chat-send-inline.ts:218`. Note this one lives in a **React hook**, which is more surface-bound than `app/src/lib/` and cannot be lifted by a re-export; it has to be extracted.
- `looksLikeToolCall` — `app/src/lib/message-content.ts:115`. **A third text-sniffing heuristic, same species as `looksLikeUnifiedDiff`.**

So narration folds into this track rather than getting its own: move the prose-splitting into `lib/`, carry the narration payload on the run-event stream from the kernel (same rails as `card`, same `visibleToModel: false` invariant the kernel already enforces for `editDiff`), and render it on both shells.

### 8. Rejected: a model-declared `phase` on assistant text

Codex CLI stamps every assistant message with a `phase` — `commentary` or `final_answer` (measured: 1,119 vs 70 across 25 sessions). The model *declares* whether it is narrating or answering, and the UI renders accordingly. It is a genuinely elegant answer to a problem Push has fought, and it was the original motivation for this section.

**We are not adopting it.** It violates a rule Push already holds (`CLAUDE.md`, *Behavior lives in code, not prompts*):

> *"Prompts are guidance for cooperating models — not a control plane. Test: if a non-cooperating model could break it, the fix belongs in code."*

A `phase` the model must emit correctly **is** a prompt-level control plane, and a non-cooperating model breaks it silently — the UI simply mislabels prose. Codex can lean on it because it ships one model family. Push routes a fleet, and the #1254 revert is the evidence: the model that leaked third-person reasoning into a user-facing bubble is exactly the model you would be trusting to self-label.

Push's mechanism is **structural, not declarative** — narration is identified by *position* (the prose prefix preceding a tool call in a round), which is model-independent and cannot be broken by an uncooperative provider. That is the more robust design for a multi-provider runtime, and it is already in place.

Recorded here so it is not re-litigated: the idea is good, the constraint is ours, and the answer is no. What Codex actually validates is the *invariant* — narration and answer are different things and must be typed differently — which Push already satisfies via `kind: 'tool_prose'`.

The residual problem from #1254 — narration *content quality* (filler, third-person reasoning leak) — is a **rendering-affordance question**, not a protocol one: commentary rendered as dim, inline, collapsible status makes filler tolerable, whereas a full user-facing bubble does not. Out of scope here; it belongs to design, not the contract.

### 9. Pin the vocabulary with a drift test

The vocabulary gets strict-mode validators in `lib/protocol-schema.ts` and a pin in `cli/tests/protocol-drift.test.mjs`, per the cross-surface checklist in `CLAUDE.md`:

> *"Any new tool, event, or envelope type needs a single canonical definition **and a drift-detector test in the same PR**."*

Without the drift test, web and TUI re-diverge in a month and we are back here.

## Slices (each independently shippable)

- **Slice 0 — Vocabulary.** Move `ChatCard` → `lib/tool-cards.ts`; web re-exports; `TCard` in `CoderAgentOptions` narrows from a bare type parameter to the shared `ToolCard`. Zero behavior change. Adds strict validators + the drift-test pin. Provable by: web renders identically, `typecheck:all` green.
- **Slice 1 — Kernel emission.** Spread `card` onto `tool.execution_complete` at the three sites that already spread `diff` (`lib/coder-agent.ts:2191, 2271, 2715`). This is the whole mechanism, and it is a handful of lines because `editDiff` already proved the path. Add the load-bearing test: **no card field ever reaches an `LlmMessage`.**
- **Slice 2 — Consumers.** TUI reads `card` off the run event (inline **and** daemon-attached — one producer, so both work for free) and renders via a generic typed fallback: title + key/value rows derived from the card's declared shape. The daemon strips cards for clients that don't advertise `tool_cards_v1`. The JSON-dump path stops being reachable for card-bearing tools.
- **Slice 3 — Producers.** Walk the tool catalog and attach cards, highest-traffic first (`sandbox_exec`, file writes/edits, test/typecheck, commit/push, delegation). Each tool that gains a card immediately improves every surface.
- **Slice 4 — Narration parity.** Promote the prose-splitting into `lib/`: `stripToolCallPayload` (`app/src/lib/message-content.ts:127`) is a straight move, but `splitVisibleContent` (`app/src/hooks/chat-send-inline.ts:218`) must be **extracted from a React hook** first — it cannot be re-exported in place. Then carry the narration payload on the run-event stream from the kernel and render `tool_prose` in the TUI. Web behavior unchanged; it stops *owning* the vocabulary, that's all. (Independent of Slices 1–3; sequenced last only because the card path proves the rails first.)
- **Slice 5 — Delete the sniffing.** Remove `looksLikeUnifiedDiff`, `looksLikeToolCall`, and the arg-guessing fallback once no path depends on them. **This slice is the acceptance criterion for the whole track:** when nothing in either shell has to guess what it is rendering, the contract is real.

## Hard problems + decisions

**Does the card duplicate the text?** Often, partially — a diff card and the diff text say the same thing. Decision: **the card is authoritative for the user, the text for the model, and they are allowed to differ.** The text can be aggressively truncated for tokens precisely *because* the card carries the full structure for the human. This is the payoff, not a wart. (`Agent Runtime Decisions.md` §13 tool-output compaction is the other half of this: compact hard for the model, render richly for the user.)

**Do we persist cards?** Yes for anything that changed the world (patches, commits, pushes, audit verdicts); live-only is acceptable for transient progress (streaming stdout). This is Codex's split, made explicit. Persisted cards are what let a resumed chat re-render its history without re-running tools — and the web already relies on this.

**Do cards go to the model, ever?** No. If the model needs the information, it belongs in `text`. Any pressure to "just let the model see the card" is a signal that `text` is under-specified for that tool — fix `text`.

**Does the tool own its renderer (Pi) or just its data (OpenCode)?** **Data, not renderer.** Push has three shells (web, TUI, APK) with genuinely different primitives (React vs ANSI cells); a shared `renderCall()` cannot serve both without a lowest-common-denominator abstraction we would immediately fight. OpenCode's model — tool emits typed data, each shell renders it — is the right fit. Pi's renderer-on-the-tool works because its shells all render ANSI. Noted as a deliberate divergence.

## Risks / tradeoffs (accepted)

- **Slice 3 is long-tail work** across ~68 tools. Mitigated by the generic typed fallback: a tool without a bespoke card still renders structurally, so the tail is an improvement curve rather than a cliff.
- **Two vocabularies during migration.** Slice 0 is a pure move, and the drift test lands with it, so the window where web and CLI can disagree is one PR wide.
- **Card churn breaks persisted chats.** Mitigated by the tombstone (already the web's behavior) plus versioned wire validation.

## Out of scope

- **Tool-call scheduling.** The per-turn budget (`lib/tool-call-grouping.ts` — contiguous reads → mutations → one trailing side-effect) is a *separate* concern with separate invariants, and it is **not** what makes the UI feel wrong. It has real questions (a per-path mutation queue would be strictly more permissive than the batch rule, and a read emitted after a write could be *scheduled* rather than *rejected*), but they are orthogonal to this doc and should not ride along with it.
- **Narration content quality** — filler and third-person reasoning leak (the #1254 complaint). A rendering-affordance question (dim/inline/collapsible commentary), not a contract question. Design owns it; see §8.
- **A model-declared `phase` on assistant text.** Not deferred — **decided against**, in §8. It is a prompt-level control plane, and Push's rule is that a non-cooperating model must not be able to break the runtime. Recorded so it is not re-proposed.
