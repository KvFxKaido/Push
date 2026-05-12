# Diff and Annotation Envelope

Date: 2026-05-12
Status: **Draft** — design-in-motion; implementation requires a `ROADMAP.md` entry before commitments
Owner: Push
Related: `docs/decisions/Remote Sessions via pushd Relay.md`, `docs/decisions/Web and CLI Runtime Contract.md`, `docs/architecture.md`

## Context

Diff rendering shows up on every Push surface that touches change-review:

- Web: `app/src/components/cards/DiffPreviewCard.tsx`, `app/src/components/chat/hub-tabs/HubDiffTab.tsx`, `app/src/components/cards/CommitReviewCard.tsx`, `app/src/components/filebrowser/CommitPushSheet.tsx`. Today these consume a custom shape derived inline from `app/src/lib/diff-utils.ts` (`parseDiffStats`, `parseDiffIntoFiles`, `FileDiff`), and `DiffLine` does its own per-line `+/-` classification.
- CLI/TUI: Reviewer and Auditor produce diff-shaped output but the TUI renderer is bespoke and not aligned with the web shape.
- Roles: Reviewer (advisory branch-diff / last-commit / working-tree), Auditor (pre-commit SAFE/UNSAFE gate), Coder (file mutation evidence). All three want to surface inline annotations against the diff — review comments, audit findings, role provenance, CI annotations.

Two forcing functions push the question past "leave it alone":

1. **Remote sessions** (`Remote Sessions via pushd Relay.md`, Partially shipped). When a phone PWA/APK attaches to a `pushd` session whose daemon executes against a PC checkout, the diff has to travel as a stable envelope across the relay. The current shape is web-component-internal.
2. **Reviewer feedback round-trip.** PR-backed branch-diff reviews can be posted back to GitHub; that flow needs an annotation taxonomy that survives serialization, not just CSS classes on a `DiffLine`.

Two external projects scoped this problem and are useful as **inspiration only**:

- [`@pierre/diffs`](https://diffs.com/) — open-source diff/code renderer on Shiki, with unified/split layouts, char/word-level inline highlights, and a generic annotation framework for "line comments, CI job annotations, and other third-party content."
- [`modem-dev/hunk`](https://github.com/modem-dev/hunk) — terminal-side companion built on OpenTUI + Pierre diffs, explicitly framed around "review-first agent-authored changesets," with inline AI/agent annotations, watch mode, and Git/Jujutsu integration.

The directional question this doc settles: **do we adopt either as a library, or hand-roll our own envelope and treat both as design references?**

## Decision

Hand-roll the diff + annotation envelope in `lib/`. Renderers (web component, TUI component, future native) are swappable consumers of that envelope. `@pierre/diffs` and `modem-dev/hunk` are studied for design — annotation shape, layout modes, watch-mode for live agent runs, review-first interaction patterns — but their data models are not adopted.

The envelope is the asset. The renderer is replaceable.

## Why

**Fact:** the renderer is a one-surface concern (web vs TUI vs native); the envelope is a cross-surface contract. Per `Web and CLI Runtime Contract.md` and the cross-surface checklist in `CLAUDE.md` ("Web/CLI communication: one source of truth per vocabulary"), the envelope belongs in `lib/` with a drift-detector test from day one.

**Fact:** Push's annotation needs are specific in ways Pierre's generic "third-party content" framing doesn't capture: role provenance (which role emitted this — Reviewer, Auditor, Coder), audit verdict (SAFE/UNSAFE + rationale), sandbox/device identity (which surface produced the change — important once remote sessions land), and chat-session correlation (link an annotation back to the message that produced it).

**Inference:** if the envelope is borrowed, every Push-specific concern becomes an extension or workaround on someone else's shape, and remote-session migrations become library-version migrations.

**Decision:** own the envelope. Treat the libraries' visual and interaction primitives as design references, and pick or build renderers per surface as a separable concern.

## Scope of the envelope

In scope for the first cut:

- **File-level metadata** — path (old + new for renames), mode change, binary flag, similarity index for renames/copies, hunk count, line-count deltas.
- **Hunk-level metadata** — old/new line ranges, header context, function/symbol hint where the parser can extract one.
- **Line-level shape** — kind (`add` / `delete` / `context` / `noop`), old/new line numbers, content. Intra-line highlights as character or word ranges (inspiration: `@pierre/diffs` inline char/word highlighting).
- **Annotation surface** — annotations attach at file, hunk, or line scope, and carry:
  - `kind` (review-comment, audit-finding, role-note, ci-annotation, todo-marker, agent-trace)
  - `source` (role: Reviewer/Auditor/Coder/Explorer/Orchestrator; surface: web/cli/relay; device id when remote)
  - `severity` where applicable (info / warning / blocker — Auditor leans on this; Reviewer uses info/warning)
  - `correlationId` linking back to the run/turn/message that produced it
  - `body` (markdown) plus optional structured payload for tool-specific renderings
- **Streaming-friendly framing** — diff payloads can be large; the envelope should support chunked emission (file at a time, hunk at a time) without breaking strict-mode validation. Inspiration: Hunk's watch-mode auto-reload for live agent runs.

Explicitly **not** in scope for v1:

- Rendering options (layout mode, theme, line-wrap). Those are renderer concerns.
- Syntax highlighting tokens. The renderer asks Shiki (or its TUI equivalent) for those given the file path/extension; transporting them would bloat the envelope and freeze a highlighter choice in the protocol.
- Three-way / merge-conflict diffs. Push doesn't run local merges (`docs/architecture.md` — "Push **never** runs local `git merge`").

## Non-Goals

- Adopting `@pierre/diffs`'s annotation wire shape, or Hunk's OpenTUI runtime.
- Replacing the existing web `DiffPreviewCard` / `HubDiffTab` renderers wholesale. Migration is a separate decision once the envelope exists.
- Coupling Auditor or Reviewer prompts to a renderer's visual idiom. Behavior in code, not prompts (`CLAUDE.md`).
- Building a generic "third-party annotation plugin" surface. Push's annotation taxonomy is closed-set and lives in `lib/`.

## Implementation Rules

- Envelope types live in `lib/` (e.g., `lib/diff-envelope.ts`) and are consumed by both web and CLI/TUI renderers. App-side `app/src/lib/diff-utils.ts` becomes a renderer-side adapter, not the source of truth.
- Producer-side: Reviewer, Auditor, Coder all emit the same envelope shape. Surface-specific routing happens after.
- Add a drift-detector test in the same PR that introduces the envelope — pattern follows `cli/tests/protocol-drift.test.mjs` (strict-mode schema pins) and the canonical-schema test for `lib/protocol-schema.ts`.
- Streaming chunks must compose: a partial envelope (e.g., one file emitted, others pending) must validate as a typed partial, not as an opaque blob.
- Annotation `source` is required, not optional. Once remote sessions are wired, this is the field that makes "which device/role produced this" auditable.
- Renderer choice is per-surface and reversible. The web renderer could later swap to `@pierre/diffs` as a pure visual layer — but only by adapting from the envelope, never by leaking Pierre types upward.

## Open Questions

1. **Annotation taxonomy closure** — is the `kind` set above sufficient, or do CI annotations and review comments need finer-grained subtypes? Surveying the GitHub PR review comment + check-run annotation shapes would inform this.
2. **Streaming chunk boundaries** — file-at-a-time is the obvious unit, but Reviewer on large diffs may want hunk-level streaming. Where does the schema split between "valid partial" and "valid complete"?
3. **Correlation with `CorrelationContext Contract.md`** — annotation `source` and `correlationId` likely overlap with the existing CorrelationContext shape. Reuse vs. parallel-track decision.
4. **Renderer migration order** — does the web app keep its current `DiffLine` renderer and just consume the new envelope, or does this trigger a renderer rewrite? Default: keep the renderer; swap the data shape.
5. **TUI renderer** — does Push's CLI/TUI grow its own diff component, or pull Hunk in as a pure visual dependency (no OpenTUI runtime takeover)? Open until the envelope is concrete enough to evaluate.
6. **Persistence** — diff + annotations sometimes need to outlive the run (chat-history rehydrate, PR-back posting). Storage shape — full envelope vs. summary + on-demand re-derivation — is a follow-up.
7. **GitHub round-trip** — when Reviewer posts annotations back to a PR, which `kind`s round-trip cleanly, and which are Push-internal-only?

## Inspiration audit

What to study from each project, and what to explicitly leave behind.

**`@pierre/diffs`:**
- Study: annotation framework (per-line attachment, layered content), unified vs split layout, intra-line char/word highlights, Shiki theming integration patterns.
- Leave: Shadow DOM rendering (conflicts with Tailwind/shadcn theming surface in `docs/DESIGN.md`), the generic "third-party content" annotation shape.

**`modem-dev/hunk`:**
- Study: review-first interaction model for agent changesets, sidebar navigation across many files, watch mode for live agent runs, inline AI/agent annotation placement, keyboard/pager affordances.
- Leave: OpenTUI as a runtime (Push CLI already has a TUI), Hunk's wire/data shape, Jujutsu-specific integration.

## Relationship to Existing Decisions

- `Remote Sessions via pushd Relay.md` — this envelope is the natural extension to `push.runtime.v1` for review/diff payloads when phone surfaces attach to a remote `pushd` daemon. Adding it now means remote sessions don't have to invent a parallel vocabulary later.
- `Web and CLI Runtime Contract.md` — direct application of the boundary rule: envelope in `lib/`, renderers stay shell-local.
- `Streaming UI Deltas.md` — the streaming-chunk concern here rhymes with the `tool.execution_start` placeholder pattern: a typed partial that the client renders incrementally, then resolves on completion.
- `CorrelationContext Contract.md` — annotation `source` / `correlationId` should compose with rather than duplicate the correlation tags already defined there.

## Next Steps

This is Draft. Before implementation:

1. Confirm the annotation taxonomy against an audit of what Reviewer, Auditor, and the GitHub PR review API actually emit today.
2. Spike a `lib/diff-envelope.ts` type definition and a single producer/consumer pair (Reviewer → `DiffPreviewCard`) without changing the renderer.
3. Add a `ROADMAP.md` entry if/when this graduates from Draft.
