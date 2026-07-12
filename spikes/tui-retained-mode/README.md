# Spike: retained-mode TUI (panes / modals / mouse / rich layout)

Status: Spike (throwaway eval, 2026-07-11). **Not part of the build.** Branch: `spike/tui-retained-mode`.

## Why this exists

Push's TUI is hand-rolled ANSI — a document printer (scrollback + input + status,
per-entry cached). The requirement that reopened the renderer question is **real panes,
modals, mouse, and rich layout**, which is the textbook trigger for *retained mode*: you
can't cleanly bolt "draw a box over the middle, route a click to it, restore what's
underneath" onto an immediate-mode printer.

Two reference points bracket the design space, and they **converged** on the same answer:

- **OpenTUI** (`anomalyco/opentui`) — retained cell compositor with z-order layers +
  flexbox (Yoga), reached via a **native Zig core**. Panes/modals/mouse are first-class
  because geometry is retained and hit-testing is automatic.
- **Bubble Tea v2 + Lipgloss v2** (`charmbracelet`) — started as Elm/MVU + *string
  composition* (what Push does today), and in **v2 added a cell-based compositor with
  layers and z-order** (`lipgloss.NewLayer().X().Y().Z()`, see `reference/lipgloss-v2/`)
  precisely because string composition hit this exact wall.

When the two most serious TUI efforts independently land on "cell compositor with z-order
layers" for rich layout, the **architecture** question is effectively settled. What's left
is a Push-specific *how*, decomposed on three orthogonal axes (see below).

## The finding that decides adopt-vs-build

Run `opentui-spike/smoke.ts` on Node and Bun. Result on this machine (Node 22.22, Bun 1.3.11):

| Runtime | `@opentui/core` import | Yoga (layout) | Native Zig compositor |
|---|---|---|---|
| **Node 22** | ✅ 249 exports | ✅ `Node.create` present | ❌ **`OpenTUI native FFI is not available for this runtime yet`** |
| **Bun 1.3** | ✅ | ✅ | ✅ boots (alt-screen + SGR mouse enabled) |

**OpenTUI's compositor is Bun-only today (v0.4.3).** The error string says "…not available
for this runtime *yet*", so Node support is intended but unshipped. Push's CLI is Node
(`node --import tsx`).

Implications:

- **Adopting OpenTUI ⇒ adopting Bun** for the TUI surface (or waiting on their uncommitted
  Node FFI). That's a runtime-switch decision for `./push`, far bigger than the TUI itself.
- **Yoga runs on Node right now.** So the pure-TS path — "Bubble Tea v2 in TypeScript":
  MVU state + Yoga-WASM layout + a pure-TS cell compositor with z-order — is fully
  Node-viable and is the **only option that doesn't drag a Bun requirement into the CLI**.

## The three axes (don't conflate "OpenTUI vs Bubble Tea")

1. **State model** — Elm/MVU (Bubble Tea) vs React reconciler (OpenTUI) vs today's imperative
   loop. *Orthogonal to rendering.* BT v2 proves MVU rides on top of a compositor.
   Recommendation lean: **MVU** — `View = f(Model)` is snapshot-testable, no retained-scene
   desync bug class, and a turn maps onto it cleanly (messages mutate a model; `Cmd`s are
   async tool calls). Push already has the worked reference: crush
   (`docs/research/charmbracelet crush — Lessons for Push.md`).
2. **Layout algebra** — Lipgloss string-join (simple) vs **Yoga flexbox** (CSS-like, *matches
   web* → the cross-surface component prize). Yoga-WASM loads on Node (verified).
3. **Renderer** — string/line diff (BT v1, Ink) vs **cell compositor with layers** (BT v2,
   OpenTUI). The requirement forces this to *compositor*.

Smart Push pick borrows from both sides: **MVU + Yoga + pure-TS cell compositor.**

## The 2026-07-12 field survey (Rezi / vue-tui / Glyph)

Three more candidates surfaced after the OpenTUI finding; two earned runnable spikes
(vue-tui did not — Ink-lineage renderer, wheel-only mouse, no compositor: it fails the
requirement from the README alone). Findings on this machine (Node 22.22, WSL2):

| Gate | **Rezi** (`@rezi-ui/core` 0.1.0-beta.2) | **Glyph** (`@semos-labs/glyph` 0.2.10) |
|---|---|---|
| Loads on Node | ✅ N-API prebuilt (`linux-x64-gnu.node`) — **the OpenTUI disqualifier does not apply** | ✅ pure TS — but **React 19 only**: the `^18` half of its peer range crashes at import (react-reconciler@0.31 reads React 19 internals) |
| Native engine boot | ✅ in a real terminal (id ≥ 0 + caps: mouse, bracketed paste, focus events, OSC52, scroll region, cursor shaping). Headless → `ERR_PLATFORM`; dumb PTY (`script`) → boots, gets no DA answers, bails. CI story = their `createTestRenderer` (unproven) | n/a (no native) — renders headless fine, clean teardown |
| Width contract (string level) | ✅ 中=2, 👍=2, ZWJ family=2, combining=1 (`measureTextCells`, versioned) | ✅ same, via `ttyStringWidth` (string-width v7) |
| Mouse | ✅ full (caps report + `hitTestLayers`) | ✅ **undocumented but real** — `useMouse` export; render() enables SGR 1000/1003/1006 with button/wheel/mousedown handling |
| Layers/modals | ✅ `pushLayer`/`popLayer`/`useModalStack`/layer registry | Portal/DialogHost exist; mechanics unverified |
| Yellow flags | native C core; solo-ish org; beta | painted two identical full frames for one static scene headless — damage diff may not engage off-TTY; 51 stars |

Both must still earn adoption through `STRESS.md` — string-level width ≠ framebuffer
rasterization correctness (cases 1–4), and neither has been driven through the
modal-restore / occlusion / resize cases. The survey's meta-finding stands either way:
every serious candidate (OpenTUI, Lipgloss v2, Rezi, Glyph) independently converged on
*cell buffer + damage diffing*, which is the decision doc's architecture.

## What's in here

- `opentui-spike/` — runnable OpenTUI eval (**Bun only**, per the finding).
  - `smoke.ts` — the native-load gate. `bun smoke.ts` (pass) vs `npx tsx smoke.ts` (fails on Node).
  - `panes.ts` — two panes (flex row) + status bar + **command-palette modal overlay**
    (z-order backdrop + centered box) + **click-to-focus** (automatic mouse hit-testing) +
    keyboard scroll. `bun panes.ts` to drive it; `SPIKE_SELFTEST=1 bun panes.ts` build-checks.
- `rezi-spike/` — runnable Rezi eval (`npm install` then `npm run smoke:node`).
  - `smoke.ts` — N-API load gate + CellWidth contract probes (all pass on Node 22).
  - `probe-tty.mjs` — run inside a real terminal for the full engine boot + caps report
    (`script -qec` is not enough: the engine needs DA/capability *answers*).
- `glyph-spike/` — runnable Glyph eval (`npm install` then `npm run smoke:node`).
  - `smoke.ts` — import gate (React 19 required), width contract, headless
    render/unmount, and the undocumented-mouse finding.
- `STRESS.md` — the shared 15-case rubric (cells, layers, input, ops) every candidate
  and the pure-TS build get scored against. Scoreboard lives there.
- `reference/lipgloss-v2/` — Charm's cell compositor blueprint (`layer.go`, `canvas.go`,
  `example-canvas-main.go`). This is the design reference for the pure-TS "Option B" —
  read it for the layer/z-order/canvas API to mirror. See `reference/lipgloss-v2/SOURCE.md`.

## How to drive the OpenTUI spike

```bash
cd opentui-spike && npm install     # pulls @opentui/core + @opentui/core-linux-x64 prebuilt
bun smoke.ts                        # expect: NATIVE CORE LOADED on bun
bun panes.ts                        # click panes to focus, `p` = palette, ↑/↓ scroll, q quit
```

Then feel axis #1: does the reconciler-free imperative scene feel right, or do you want MVU
on top? That answer routes adopt-Bun-OpenTUI vs build-Node-pure-TS.

## Recommendation (for the decision, not this branch)

- Architecture (cell compositor + z-order) is settled by two witnesses — don't re-litigate.
- OpenTUI is **not** a cheap adopt for Push while it's Bun-only + Node is our CLI runtime.
- The Node-clean, web-unifying, owned path is **"Bubble Tea v2 in TypeScript"** (MVU +
  Yoga-WASM + pure-TS compositor), with `reference/lipgloss-v2/` as the compositor blueprint.
- **Opportunity cost, stated once:** this is surface #3; mobile is #1. The spike is cheap
  and de-risks the call. The *build* is a quarter — make that call after feeling the spike,
  and don't let a great architecture problem quietly outrank mobile.
