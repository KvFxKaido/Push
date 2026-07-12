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
3. **Adopt Rezi** (`rezi-ui`, added 2026-07-12; **stress-run complete — ruled out**) — TS API
   over a native C cell engine ("Zireael") via N-API prebuilds that load on Node 22, so the
   OpenTUI disqualifier does not apply. Was the strongest adopt candidate on paper; the driven
   `STRESS.md` run (source-verified + human-scored, `spikes/tui-retained-mode/rezi-spike/`)
   settled it: **mouse/hit-testing is genuinely excellent** (wide-glyph continuation cells hit
   correctly, modals block lower layers) and modal restore/occlusion pass — but it **fails the
   CellWidth contract at raster** (ZWJ family misaligns in a real terminal while
   `measureTextCells` says 2), **paint ignores `zIndex`** (child order only; `zIndex` sorts the
   input registry → paint and input stacking can disagree, contradicting its own prop docs),
   "dim" is a whole-viewport `░` pattern replace (no transparency), `ui.center` **faults the
   engine on first paint**, and a faulted app **exits silently** (`run()` resolves, exit 0,
   empty stderr) — an ops-visibility hole that contradicts this repo's symmetric-logs doctrine
   on its own. The failures land precisely on this doc's pre-written contracts (CellWidth
   day-one; explicit z-order layers; no silent paths).
4. **Adopt vue-tui** (`vuejs-ai/vue-tui`, added 2026-07-12) — Vue 3 renderer in the Ink
   lineage (its own credits: Ink's component model, yoga layout, rendering pipeline). Ruled
   out for this requirement on architecture: wheel-only mouse, no z-order compositor — option
   2's ceiling with a different authoring layer. Also a second view framework (app is React).
   Its PTY-based "visual development feedback loop" guide for agents is worth stealing as a
   practice regardless.
5. **Adopt Glyph** (`semos-labs/glyph`, added 2026-07-12) — React reconciler over a **pure-TS
   double-buffered cell framebuffer with character-level damage diffing** — the closest
   external implementation of this doc's own substrate (verified working headless on Node,
   `spikes/tui-retained-mode/glyph-spike/`; mouse support exists despite being undocumented).
   Costs: React 19 hard requirement (its React 18 peer claim crashes at import), reconciler
   authoring model (rejected below), ~51 stars, damage diff unverified on TTY. Kept as a
   **reference implementation to read** while building — MIT, same substrate — more than an
   adopt candidate.
6. **Build a pure-TS engine.** Chosen. See below.

> **2026-07-12 survey note (updated same day, stress run complete):** options 3–5 came from a
> one-day field survey after this doc was first written. (a) Every serious candidate —
> OpenTUI, Lipgloss v2, Rezi, Glyph — independently converged on *cell buffer + damage diff*,
> confirming the architecture bet. (b) Rezi briefly weakened the "no viable adopt on Node"
> premise — then the `STRESS.md` run restored the build decision on *empirical* grounds
> (raster width failure, zIndex paint/input split, engine fault + silent death; see option 3).
> The build is no longer justified by "nothing else runs on Node" but by "the one thing that
> does fails the contracts this doc wrote down in advance." Rezi remains the reference for
> input routing (its hit-testing is the best surveyed); Glyph and Lipgloss v2 remain the
> compositor references. The rubric stays: any future candidate — and the build itself —
> gets scored against the same 15 cases.
>
> Late addition, same survey: **giggles** (`zion-off/giggles`) — Ink lineage, so ruled out as
> a renderer without a spike (same ceiling as option 4). Steal two designs from it though:
> **terminal handoff/reclaim** (suspend the TUI cleanly for `$EDITOR`/`less`/interactive git,
> reclaim on exit — needs no compositor, actionable on the current renderer; tracked as a TUI
> backlog issue) and its **scoped keybinding registry** (focus scopes/traps with bindings that
> travel with the focused subtree — a reference for slice step 5's "adapt Push's input parser
> + focus stack into `onInput`").
>
> **Re-litigated 2026-07-12, verdict holds.** The giggles adopt case was reopened same-day and
> survives on two grounds: (a) confirmed built **on** Ink (not merely Ink-lineage) — no
> compositor, no z-order layers, no mouse hit-testing, so it fails this doc's load-bearing
> requirement statically; (b) the "nobody has cracked pure-TS-on-Node" worry misreads the field
> — the architecture ships in Go (Lipgloss v2), Python (Textual), C (Notcurses), Zig (OpenTUI),
> and Glyph proves the substrate in pure TS on Node. The gap is absence-of-attempts, not failed
> attempts. Adopting giggles is coherent only if the mouse+overlay requirement is dropped first
> (amend this doc, then re-score); otherwise the choice is build-now vs defer-and-steal. The
> handoff steal shipped as the `/editor` terminal handoff (`cli/tui-handoff.ts`, issue #1423).

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
  Plus, from the 2026-07-12 survey: **run Rezi through `STRESS.md` before committing to the
  build's step 0** — it is the one candidate whose success would change this decision, and the
  rubric exists precisely so that call is empirical rather than re-litigated.

## Pointers

- Spike + sketch: [`spikes/tui-retained-mode/`](../../spikes/tui-retained-mode/) (`README.md`,
  `opentui-spike/`, `mvu-sketch/`, `reference/lipgloss-v2/` — Charm's compositor blueprint).
- Prior TUI decisions this extends: the hand-rolled-ANSI / ScrollbackSurface direction; the
  render-cache and inline-markdown tracks.
