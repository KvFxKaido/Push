# Retained-Mode TUI — MVU + Pure-TS Compositor

**Status:** Draft — design-in-motion; needs roadmap promotion. Spike + design sketch complete
([`spikes/tui-retained-mode/`](../../spikes/tui-retained-mode/)); the implementation slice is
**not started**. Surface #3 (TUI) — sits behind mobile in priority.

**Date:** 2026-07-11

## Problem

Push's TUI is hand-rolled ANSI: an immediate-mode **document printer** (scrollback + input +
status, per-entry cached via `tui-transcript-cache.ts` / `tui-stream-frame.ts`). The next
requirement — **real panes, modals, mouse, and rich layout** — is the textbook trigger for
*retained mode*. You cannot cleanly bolt "draw a box over the middle, route a click to it,
restore what's underneath" onto an immediate-mode printer: overlays need z-ordered
compositing, and mouse needs retained geometry to hit-test against.

This reopens the earlier "don't adopt Ink/OpenTUI, hand-roll" call — which was correct **for
its requirement** (render a transcript) and does not bind this one.

## Options considered

1. **Adopt OpenTUI** (`anomalyco/opentui`) — retained cell compositor + Yoga + mouse, via a
   native Zig core. **Empirically ruled out for now:** on Node 22, `@opentui/core@0.4.3`
   imports and Yoga loads, but the compositor throws `"OpenTUI native FFI is not available for
   this runtime yet"` — it is **Bun-only today** (verified in `spikes/tui-retained-mode/opentui-spike/smoke.ts`;
   Bun boots, Node fails). Push's CLI is Node (`node --import tsx`), so adopting OpenTUI means
   adopting Bun for the TUI surface — a runtime-switch decision larger than the TUI itself.
2. **Adopt a pure-JS incumbent** (blessed lineage) — real windowing, but an aging/crufty API
   for a surface we want to feel modern. Also Ink (React + Yoga) has no z-order compositor and
   weak mouse — behind Bubble Tea v2 for this requirement.
3. **Build a pure-TS engine.** Chosen. See below.

## Decision

Build **"Bubble Tea v2, in TypeScript"**: **MVU** authoring on top, a **pure-TS cell
compositor with z-order layers** underneath, **Yoga-WASM** for layout (verified to load on
Node in the spike). **Reconciler rejected** — the app's taste call and the honest-surfaces
fit: `view = f(model)` is inspectable and testable; no implicit virtual-tree diffing.

The architecture is well-supported: two independent efforts converged on *cell compositor with
z-order layers* for rich layout — OpenTUI (via Zig) and Charm's move to a **Lipgloss v2**
cell compositor (`NewLayer().X().Y().Z()`, after string-composition hit the same wall). Push's
own `createScreenBuffer` is already a damage-diffing flush pointing the same direction. What
was **not** settled — the contracts — is what the design sketch and Codex review nailed down.

## Contracts (the load-bearing invariants)

Design skeleton: [`spikes/tui-retained-mode/mvu-sketch/`](../../spikes/tui-retained-mode/mvu-sketch/)
(`engine.ts` + `example-push.ts`, typechecked; proves the authoring surface, not runtime semantics).

- **No retained view tree.** `view(model)` returns a fresh immutable `Node` tree; it is
  flattened to a **node-free** paint list (`Frame`/`PaintOp`), rasterized to cells, and
  discarded. Diffing is cell-level (damage), never node-level. That is the line between this
  and a reconciler.
- **Retention budget = categories, not objects.** *Authoritative state:* the model (only
  `update` writes it). *Derived caches* (throwable, key-invalidated): cell buffers, layout
  **geometry** (rects by NodeId), transcript/stream shaping, hit map. *Live resources*
  (explicit teardown): subscriptions, in-flight command controllers, input decoder, scheduler.
- **Layout cache is node-free**, keyed by a cheap layoutKey — the pattern `cli/tui.ts`'s
  `layoutKey` already uses. (An earlier draft cached a `LaidOutNode` that held `node: Node` and
  would repaint stale content; removed.)
- **Effects have a lifecycle.** `Cmd` is interpreted data (`none | batch | task | cancel`), not
  a bare promise. A `task` carries a `key`: a same-key task **replaces** the in-flight one;
  late results from a superseded generation are **dropped**; rejections map via `onError`; Msgs
  process **FIFO, non-reentrant**. The **cancellation policy is app-owned** (keys), not
  engine-imposed — the engine must never cancel on an unrelated model change (that would abort a
  tool on every stream delta).
- **Cell representation is compositor-core.** Cells encode a `CellWidth`
  (`narrow | wide-lead | wide-cont`) from day one: narrow-over-wide clears the orphan (中 → a),
  clipping at the last column paints a space, ZWJ/combining collapse to one lead + continuations,
  continuation cells inherit their lead's hit target. Reuse `cli/tui-renderer.ts`'s `charWidth`.

## Grounding: the seams already in Push

The engine is an **upgrade at existing choke points**, not a greenfield renderer:

- `cli/tui-renderer.ts` `createScreenBuffer` — already a damage-diffing flush that deliberately
  does not clear absent rows. The slice upgrades it **line-diff → cell-diff**.
- `cli/tui.ts` `layoutKey` — the node-free geometry-cache precedent.
- `cli/tui-stream-frame.ts` / `tui-transcript-cache.ts` — legitimate derived caches (the
  settle-and-freeze "ScrollbackSurface" pattern).
- `cli/tui-renderer.ts` `charWidth` — the CJK/combining width table to reuse.

## Plan: a Push-shaped vertical slice (not a big-bang rewrite)

Prove the compositor mechanic **inside the living TUI** at the `createScreenBuffer` choke
point, as a **replaceable module with a paint-list input** so the later Node/Yoga path is a new
*producer*, not a compositor rewrite:

0. Decide the cell representation (incl. `CellWidth`) — prerequisite to painting anything.
1. Paint real styled assistant output into cells.
2. Layer one existing modal over it.
3. Close it and prove damage restores the underlying cells **without clearing the screen**.
4. Stress: wide glyphs, transparency, clipping, z-order, hit occlusion, resize, cursor, selection.
5. Preserve daemon, input, focus, transcript-cache, layout; **adapt** Push's input parser + focus
   stack into `onInput`, don't replace them.
6. Introduce `Node`/Yoga afterward; extract the full MVU reducer last.

## What is done vs open

- **Done:** the fork resolved (build, not adopt), the empirical Node-vs-Bun finding, the design
  sketch with tightened contracts, and this plan.
- **Open (not pretended-solved):** all runtime semantics (the sketch is declarations +
  descriptions), grapheme-width's cross-terminal long tail, focus-as-derived-state vs a runtime
  focus-ring, and text-as-leaf vs an inline-span model (Push already has inline markdown here).

## Pointers

- Spike + sketch: [`spikes/tui-retained-mode/`](../../spikes/tui-retained-mode/) (`README.md`,
  `opentui-spike/`, `mvu-sketch/`, `reference/lipgloss-v2/` — Charm's compositor blueprint).
- Prior TUI decisions this extends: the hand-rolled-ANSI / ScrollbackSurface direction; the
  render-cache and inline-markdown tracks.
