# CLI Design

> Covers CLI/TUI presentation only. For the graphical app visual system, see [`../docs/DESIGN.md`](../docs/DESIGN.md).

## Overview

Push CLI uses a terminal-first presentation model built for keyboard-driven coding workflows. It prioritizes transcript readability, status clarity, diff legibility, and stable layout over decorative styling.

This document describes CLI/TUI-specific presentation guidance. It does not define the graphical app token system, Tailwind styles, or Radix/shadcn component usage.

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

## Diff and Review Presentation

Diffs are core CLI content and should remain legible in both wide and narrow terminals.

- additions should read as clearly positive changes
- removals should read as clearly negative changes
- hunk/context boundaries should be visually distinct from changed lines
- file headers should remain scannable when many files are present
- line wrapping should avoid making add/remove state ambiguous

## TUI Primitives

The full-screen TUI is composed from a small set of terminal-native primitives:

- **Panels** — bounded content areas with stable titles
- **Lists** — navigable collections with a clear active row
- **Tabs or segmented views** — small sets of mode or content switches
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

- [`../docs/architecture.md`](../docs/architecture.md) — shared architecture and operating model
- [`../docs/DESIGN.md`](../docs/DESIGN.md) — graphical app visual system
- [`README.md`](README.md) — CLI usage, commands, and operator-facing behavior
