# Tool Render Payload — Cards Are Declared, Not Sniffed

Date: 2026-07-13
Status: **Draft** — design in motion; needs roadmap promotion before implementation. Owner: Push runtime (shared `lib/` + both shells).

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

So: 29 card types on web, **3** card producers reachable from shared `lib/`, and a TUI that sniffs text for everything else.

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

### 6. Gate the daemon on a capability, and pin it with a drift test

The daemon emits cards only when the client advertises `tool_cards_v1`, exactly as `cli/pushd.ts:2262` gates workspace-state events on `workspace_state_v1`. The vocabulary gets strict-mode validators in `lib/protocol-schema.ts` and a pin in `cli/tests/protocol-drift.test.mjs`, per the cross-surface checklist in `CLAUDE.md`:

> *"Any new tool, event, or envelope type needs a single canonical definition **and a drift-detector test in the same PR**."*

Without the drift test, web and TUI re-diverge in a month and we are back here.

## Slices (each independently shippable)

- **Slice 0 — Vocabulary.** Move `ChatCard` → `lib/tool-cards.ts`; web re-exports. Zero behavior change. Adds strict validators + the drift-test pin. Provable by: web renders identically, `typecheck:all` green.
- **Slice 1 — Contract.** Formalize `{ text, card? }` on the shared tool result. Add the load-bearing test: **no card field ever reaches an `LlmMessage`.**
- **Slice 2 — Daemon transport.** Emit cards over the pushd wire behind `tool_cards_v1`. TUI advertises the cap and receives typed cards; renders them with the generic typed fallback. The JSON-dump path stops being reachable for card-bearing tools.
- **Slice 3 — Producers.** Walk the tool catalog and attach cards, highest-traffic first (`sandbox_exec`, file writes/edits, test/typecheck, commit/push, delegation). Each tool that gains a card immediately improves both surfaces.
- **Slice 4 — Delete the sniffing.** Remove `looksLikeUnifiedDiff` and the arg-guessing fallback once no path depends on them. This slice is the acceptance criterion for the whole track.

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
- **The `commentary` / `final_answer` phase on assistant text** (Codex's answer to the narration-collapse problem that #1252 tried to infer and #1254 reverted). Closely related — it is the same "declare, don't infer" principle applied to prose instead of tool output — but it is a distinct contract change and deserves its own doc.
