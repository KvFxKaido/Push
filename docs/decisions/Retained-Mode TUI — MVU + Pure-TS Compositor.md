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
>
> Late addition, source-read 2026-07-12: **terminui** (`ahmadawais/terminui`, v0.3.1) —
> Ratatui-in-TS, pure-functional immediate mode (re-render + double-buffer diff per frame).
> Ruled out by contract at source level, no spike needed (~1.9k lines core, 15 commits):
> **no z-order compositing, no mouse/hit-testing anywhere in the source** (the `Backend`
> interface has no input surface at all), and the README's "CJK and fullwidth rendered
> correctly" claim is falsified in `core/buffer.ts` — `charWidth` is a hardcoded CJK range
> table with **no emoji ranges** (all of 0x1F000–0x1FAFF measures width 1), iteration is
> per-code-point so ZWJ/VS16 sequences shatter (worse than Rezi's raster fail), and there's
> no continuation-cell repair on overwrite. The published library also ships **no TTY
> backend** — only a test backend; the one live example hand-rolls its own ANSI backend
> in-file. Layout is a two-pass greedy splitter (not cassowary), nothing for the reference
> shelf. Fifth independent convergence on cell buffer + damage diff, and that's all it adds.
>
> Late addition, source-read 2026-07-12: **pi-tui** (`@oh-my-pi/pi-tui`, inside
> `can1357/oh-my-pi` — a 17k-star coding agent forked from badlogic/pi-mono, Mario Zechner
> credited; ~14.8k lines TS in the package, v16.4.6). **Ruled out as adopt, promoted to
> first reference for the scrollback seam.** Not adoptable: hard Bun coupling
> (`engines.bun>=1.3.14`, ships raw `.ts` as its entry, `Bun.stringWidth` load-bearing in
> the width hot path with no Node fallback — swapping in their napi width engine is
> plausible but means maintaining a fork), text slice/wrap/truncate route through a Rust
> natives package (napi-rs, so Node-*loadable*), and it versions in lockstep with a
> competitor's 13k-commit / 521-release monorepo. Architecturally it is **line-based, not
> cell-based**: components render `string[]`, the engine diffs rows; overlays are
> line-splice composites with focus-level (not paint-level) input occlusion and
> line-granular hit-testing — it would fail the rubric's transparency / cell z-order /
> cell-hit cases by design. **Why it still matters more than Lipgloss v2 for one axis:**
> its core renderer doc (`docs/tui-core-renderer.md`) is a production war journal for
> exactly the seam this doc's plan inherits from the ScrollbackSurface direction — an
> **append-only native-scrollback contract** (committed-rows ledger, byte-stable vs
> durable commit ends, committed-prefix audit, "the renderer cannot observe the terminal's
> scroll position; ConPTY's probe lies" as the load-bearing axiom, an explicit
> accepted-tradeoffs section). None of the alt-screen compositor candidates even address
> this. Steal list: the commit-ledger contract for the transcript↔live-window boundary;
> `LoopWatchdog` (always-on event-loop lag probe that names the blocking phase — the
> symmetric-logs doctrine as running code); its width-edge-case vectors (Hangul
> Compatibility Jamo override, OSC 66 text-sizing scaling, OSC-payload stripping, tab
> expansion) as test cases for step 0's `CellWidth`; DECCARA rectangular-fill optimization
> + capability probing; overlay-scoped mouse reporting (enabled only while a fullscreen
> overlay is up). Fault posture is compatible with this repo's doctrine — ~2 `try` blocks
> in the 4k-line core, the one bare catch scoped and commented (faults propagate loudly;
> inference, not exhaustively traced). **Upstream check, same day:** the fork verdict does
> **not** transfer to regular pi (`badlogic/pi-mono` `packages/tui`) — upstream is
> Node-native (`engines: node>=22.19`, compiled `dist`, deps = `get-east-asian-width` +
> `marked` only; no Bun APIs, no Rust natives, ~7.4k lines). It is ruled out on the shared
> architectural ground alone: same line-based `render(width): string[]` model, **no mouse
> at all** (only escape recognition in `stdin-buffer.ts`), and none of the fork's
> append-only commit ledger — the scrollback war journal is fork-added. If the line-based
> lane is ever re-scored, upstream is the chassis to evaluate, not the fork. Two upstream
> steals: the pure-JS width model (`Intl.Segmenter` graphemes + `get-east-asian-width`) as
> the Node-native `CellWidth` measurement reference, and `test/virtual-terminal.ts` —
> differential-render assertions against **`@xterm/headless`** — the pattern that makes
> the stress rubric's raster cases (ZWJ misalignment class) CI-testable instead of
> human-scored; adopt for the build's own regression suite.
>
> Late addition, source-read 2026-07-12: **Storm** (`orchetron/storm`, v0.2.0, 43 commits,
> ~385 stars) — the closest paper-match yet to this doc's substrate (pure-TS cell
> compositor, typed-array buffer, damage diff, flexbox/grid layout, Node-native,
> `Intl.Segmenter` graphemes, "terminal as display server"). Ruled out at source on the
> two contract classes this rubric was built around. (1) **Measurement/raster split:**
> `stringWidth` is grapheme-segmented, but the buffer stores one `Uint32` codepoint per
> cell — `writeString` iterates codepoints and skips zero-width (ZWJ dropped: a family
> emoji lays out as 2 cols but rasters as 4 glyphs / 8 cols), `setCellDirect` truncates a
> cluster to its first codepoint, and the `Grapheme` interface whose comment claims
> "per-grapheme cell placement" has **zero consumers**. Rezi's raster failure, reproduced.
> (2) **Paint/input z-split:** overlays paint zIndex-sorted into the single buffer, but
> `hitTest` is a flat smallest-area scan over the measure map with no z/overlay awareness —
> an occluded element under a modal wins the hit. Also: `react-reconciler` is a hard
> dependency (authoring model rejected with Glyph), it is alt-screen-native (1049), and the
> README inflates ("97 components" vs 5 component + 3 widget files in-tree). Fault posture
> is fine (uncaughtException → restore + loud exit 1). **Steal two things for the build:**
> the typed-array structure-of-arrays cell buffer (separate code/fg/bg/attr planes,
> damage rect + per-row damage column ranges — a concrete, well-executed shape for step 0)
> and **DECSTBM scroll-region-assisted diffing** (hardware-scroll unchanged content,
> repaint only the seam, with an honest comment about when the optimization is invalid).
> Sixth independent convergence on cell buffer + damage diff.
>
> Late addition, source-read 2026-07-12 (agent-assisted): **T9** (the custom renderer inside
> `huiliyi37/Tianshu-Tui`, a coding-agent runtime; ~25k lines under `src/tui/`). Ruled out
> on architecture without controversy — line-based `string[]` rows with wrap-aware row
> diffing, **no mouse at all** (source comment says so verbatim), no cells — and its README
> honestly claims none of that, a first for this survey. Same normal-screen append-only
> scrollback philosophy as pi-tui (alt-screen 1049 reserved for overlays; "content entering
> scrollback may not be erased or redrawn" as a stated invariant) but without the fork's
> commit-audit machinery. One real seam: input cursor steps by `Intl.Segmenter` grapheme
> while width reasons per-codepoint via `string-width` — the models disagree. Fault posture
> weak: flush-path errors swallowed to stderr, dozens of direct `renderLive()` call sites
> propagate uncaught, no crash-time terminal restore. **Three steals for the current
> renderer, pre-compositor:** (1) **fixed-height dynamic viewport** — pad/truncate the
> streaming region to an exact display-row budget so the input box never jitters vertically
> mid-stream (`padDynamicRegion`); (2) **CSI 2026 synchronized-output** around every flush —
> tear-free frames, silently ignored where unsupported; (3) **resize reflow reconciliation**
> — recompute previous-frame row heights at the *new* width before relative cursor-up, so
> old-frame fragments don't leak into scrollback (check `cli/tui-renderer.ts` for this bug
> class), plus diff-disable for one frame after resize.
>
> Late addition, source-read 2026-07-12: **Silvery** (`beorn/silvery`, v0.21.x, 23 stars /
> 3.3k commits — single-author labor of love grown from a real multi-pane workspace app;
> MIT, pure TS, zero native deps, Node-family runtime with a `node>=24` floor for native
> type-stripping — likely soft under tsx, verify). **FIRST CANDIDATE TO SURVIVE THE SOURCE
> READ — stress run required before this note means anything.** It implements the two
> contracts all ten predecessors failed: (1) grapheme↔cell — `Cell.char` is an explicit
> grapheme string (cluster-capable), `wide`/`continuation` flags match this doc's CellWidth
> verbatim, the write path segments via `Intl.Segmenter` + string-width with an LRU width
> cache, and continuation repair on overwrite is **bidirectional with comments citing the
> exact failure mode** (orphaned lead → space; orphaned continuation → cleared); storage is
> packed flag-ints + a parallel grapheme array — Storm's SoA layout with cluster-capable
> chars. (2) paint↔input — a dedicated React-free `hit-registry-core` where **highest
> zIndex wins** (not smallest-area). It also engages the third boundary: a frozen-scrollback
> ring (ANSI snapshots + plain-text rows, searchable) — settle-and-freeze, though *emulated*
> scrollback with its own selection layer, not pi-tui's native-scrollback bet. Claims
> nobody else made: alpha blending across layers, inline/virtual-inline viewport modes, an
> Ink compat layer (918/931 tests), a DOM adapter (curious for the remote-session surface).
> **Open risks, in stress-run order:** (a) real-terminal ZWJ raster — Rezi passed the
> source read here and failed live; (b) paint/input z agreement is **by-convention**
> (`useHitRegion` takes a manually-supplied zIndex; paint order comes from the tree) — a
> stress scene must prove the built-in overlays wire both consistently; (c) fault posture
> unverified (no crash-restore handler found in ag-term); (d) React authoring — rejected
> for Push, so the question is substrate separability: cores are deliberately React-free
> per-module, but `ag-term`'s package deps include `ag-react`; (e) app vocabulary leaks
> into the framework core (`HitTarget: "fold-toggle" | "column-header" | cardIndex`);
> (f) bus factor. Run `STRESS.md` before any re-litigation of build-vs-adopt.
>
> **Driven run, same day** (`silvery-spike/`, 9✅/3❌, published npm dist on Node 22 —
> the monorepo's Node-24 floor is dev-only, `engines>=18` ships): the substrate claims
> **survive driving** — CJK continuation repair, restack damage, and read-beneath
> `Backdrop` transparency (OKLab blend, documented ANSI-16→dim degradation; the best
> transparency surveyed, vs Rezi's `░` replace) all pass through the real pipeline on
> fake TTY streams, and the whole run doubles as the headless story (scene 13 ✅).
> ZWJ (scene 3): silvery's emission is correct and self-consistent; the default-config
> `@xterm/headless` referee splits the cluster — cross-terminal raster divergence, human
> pass pending (and a warning that applies equally to the build's own future output).
> Two real wounds: **scene 14 ❌ — a render-phase fault produces a silent zombie**
> (no stderr, `run()` never settles, no teardown/cursor restore; error boundary is
> opt-in) — the no-silent-paths contract violated as shipped, same class that helped
> kill Rezi; and the paint/input z **by-convention** finding confirmed structurally
> (paint = tree order, hit z = manual param). Verdict unchanged: reference-vs-substrate
> question stays open pending the human raster pass and whether the fault default is
> fixable upstream — both wounds are also candidates for precise upstream issues.
>
> **Human pass, same day (Windows Terminal/WSL2): scene 3 raster PASSED** — the
> self-scoring border box (`human-raster.mjs`) aligned all nine cluster classes,
> including ZWJ family and ZWJ+tone, the exact case Rezi failed human scoring on.
> Scene 14 refined live (`human-fault.mjs`): not an infinite hang — the exception is
> swallowed, `run()` never settles, and the process dies through Node's
> unsettled-top-level-await path (exit 13) blaming the harness's `await` rather than
> the fault; ❌ stands, precisely characterized and upstream-fixable. **Silvery is now
> the first candidate to clear every contract it has been scored against**; the open
> items are the two upstream issues (fault surface, z-agreement by-construction), the
> untested scenes (4/5/8/10–12/15, React-wired hit path), and the standing React
> authoring rejection — which frames any adopt case as *substrate-adopt with an MVU
> authoring layer*, not framework-adopt. File the upstream issues before re-litigating
> build-vs-adopt.

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
