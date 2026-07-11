# CLI Design

> Covers CLI/TUI presentation only. For the graphical app visual system, see [`../DESIGN.md`](../DESIGN.md).

## Overview

Push CLI uses a terminal-first presentation model built for keyboard-driven coding workflows. It prioritizes transcript readability, status clarity, diff legibility, and stable layout over decorative styling.

This document describes CLI/TUI-specific presentation guidance. It does not define the graphical app token system, Tailwind styles, or Base UI/shadcn component usage.

## Design Principles

- **Clarity over decoration** — content should read cleanly in long terminal sessions
- **Transcript-first hierarchy** — assistant output, tool activity, and diffs should dominate over chrome
- **Keyboard-first interaction** — every primary action should be legible and navigable without pointer affordances
- **Stable layout under resize** — panels and summaries should degrade predictably in constrained terminals
- **Color is supportive, not exclusive** — state should remain understandable with limited color support
- **Dense, not cramped** — high information density is good; visual noise is not

## Information Hierarchy

### Primary content

Use the strongest emphasis for:

- live transcript content
- current input area
- active diff content
- focused panel title or active mode label

### Secondary content

Use reduced emphasis for:

- timestamps
- file paths
- secondary metadata
- inactive panel labels
- contextual hints

### Muted chrome

Use the lowest emphasis for:

- borders made from box characters or separators
- passive status text
- placeholder copy
- non-critical helper text

## Terminal Color and Emphasis Semantics

Color semantics should stay consistent across CLI surfaces even when exact terminal colors vary by environment.

- **Accent** — active selection, current mode, focused affordances
- **Success** — completed tasks, safe/healthy state, passing checks
- **Warning** — cautions, partial completion, blocked next steps
- **Error** — failed commands, broken state, rejected actions
- **Muted** — inactive labels, low-priority metadata, separators

When possible, pair color with a second signal:

- symbol or prefix
- wording
- focus marker
- positional consistency

## Themes and Color Tiers

Presentation adapts to terminal capability rather than assuming one environment.

- **Color tiers** — truecolor (24-bit), 256-color, 16-color ANSI, and `none`. The tier is detected from `COLORTERM` / `TERM`, forced to `none` by `NO_COLOR`, and to truecolor by `FORCE_COLOR`.
- **Glyph sets** — a Unicode set with an ASCII fallback (box characters, markers, arrows), chosen by locale/terminal detection.
- **Named themes** — default, neon, metallic, mono, solarized, and forest. Themes restyle tokens, not semantics: accent / success / warning / error / muted keep their meaning across all of them.

## Line-lead Markers

Transcript and status lines lead with a single-glyph marker so role and state read before the text does. The marker is the symbol half of the color-plus-symbol pairing above, so it must carry meaning on its own.

- **Message bullet** (`•`) — user and assistant turns, and errors/warnings (recolored, not reshaped)
- **Agent meta marker** (`⬡`) — the lead's non-message lines: the activity row, `thinking`, `sources`, and passive status text. Dim by default; it groups "what the agent is doing" apart from the conversation.
- **Run-state dot** (`●`) — the header status indicator; becomes a spinner frame while running and takes success / warning / error color by run state.

Markers degrade: a non-Unicode terminal falls back to an ASCII equivalent (`*`), and meaning never rests on glyph shape alone — color, wording, or position carries it too.

## Diff and Review Presentation

Diffs are core CLI content and should remain legible in both wide and narrow terminals.

- additions should read as clearly positive changes
- removals should read as clearly negative changes
- hunk/context boundaries should be visually distinct from changed lines
- file headers should remain scannable when many files are present
- line wrapping should avoid making add/remove state ambiguous

**Gutter rendering.** Fenced diffs render with a colored left gutter bar rather than relying on the leading `+`/`-` character:

- additions and removals carry a green / red gutter bar, and the leading marker char is dropped so the change reads as a block instead of a column of punctuation
- hunk headers take an accent gutter; file headers and context lines stay muted
- a `diff · +A -B` summary leads the block
- the gutter holds a fixed column — lines truncate rather than wrap, so add/remove state never goes ambiguous mid-wrap (full text stays reachable via copy)
- degrades: the bar is `▌` in Unicode and `|` in ASCII; with no color the gutter falls back to the literal `+` / `-` / space marker so state survives without color

## TUI Primitives

The full-screen TUI is composed from a small set of terminal-native primitives:

- **Panels** — bounded content areas with stable titles
- **Lists** — navigable collections with a clear active row
- **Toggleable side pane** — an optional panel (e.g. the tool feed) shown beside the transcript
- **Status bar** — compact session, workspace, or mode summary
- **Input region** — persistent compose surface with strong focus treatment
- **Modal overlays** — blocking input flows that temporarily take priority
- **Badges / compact status markers** — small labels for state, mode, or count summaries

These primitives should privilege readability and predictability over ornamental framing.

## Interaction States

CLI/TUI presentation should make these states immediately visible:

- **Focused** — current keyboard target
- **Selected** — chosen item in a list or navigation set
- **Active** — current mode, tab, or ongoing operation
- **Streaming** — assistant output or tool activity in progress
- **Pending** — awaiting completion, confirmation, or background work
- **Blocked** — action unavailable due to policy, missing state, or guardrails
- **Disabled** — visible but intentionally unavailable

Focus and selection should not rely on color alone.

## Motion

Motion is used sparingly, to signal activity rather than to decorate.

- **Spinners** — the running indicator cycles a one-cell frame. Five variants (braille, orbit, breathe, pulse, helix) plus a static `off` fallback.
- **Reduced motion** — `PUSH_REDUCED_MOTION` / `REDUCED_MOTION` forces the static dot; no meaning ever depends on animation.
- Animation is never the sole carrier of state — it pairs with a glyph, color, or wording.

## Layout Behavior

### Wide terminals

Prefer side-by-side layouts only when each pane remains meaningfully readable.

### Narrow terminals

Prefer stacked or simplified layouts. Preserve the transcript, current input, and essential status before secondary panels.

### Overflow strategy

- truncate low-priority metadata before primary content
- keep file paths and labels compact but recognizable
- avoid wrapping that makes panel ownership or diff state unclear
- preserve cursor/focus visibility even when content is clipped

## Accessibility and Legibility

- maintain strong contrast in dark terminal themes
- do not assume perfect ANSI support or identical color rendering everywhere
- use color plus text/symbol redundancy for critical states
- avoid motion-dependent meaning; any animation should be minimal and optional in effect
- keep focused and selected states obvious in monochrome or reduced-color environments

## Relationship to Shared Docs

Use this file for terminal presentation guidance.

Use shared docs for cross-surface truths:

- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — shared architecture and operating model
- [`../DESIGN.md`](../DESIGN.md) — graphical app visual system
- [`README.md`](README.md) — CLI usage, commands, and operator-facing behavior
