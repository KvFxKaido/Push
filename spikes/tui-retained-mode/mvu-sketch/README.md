# MVU engine — core signatures (Option B design skeleton)

Status: Design sketch (spike/tui-retained-mode, 2026-07-11). Typechecks; not wired to a build.

The decision this encodes: **reconciler rejected.** The engine is "Bubble Tea v2 in
TypeScript" — MVU authoring on top, a pure-TS cell compositor with z-order layers
underneath, Yoga-WASM for layout (verified to run on Node in the OpenTUI smoke test). No
reconciler, no mutable widget tree. See `../README.md` for how we got here.

## Files

- `engine.ts` — the core contracts (types + interfaces + a couple of pure builders).
- `example-push.ts` — a Push-shaped app (panes + palette modal + agent stream + a tool-call
  `Cmd`) proving a coding turn maps onto MVU with zero retained widget state.
- `tsconfig.json` — strict; `npx tsc -p .` (or `--noEmit`) to check both files.

## The one idea: the retention budget

The whole "no reconciler" argument is a list of what persists between frames. Exactly five
things do; everything else is rebuilt from the model each frame:

1. the **model** (only `update` mutates it)
2. two **cell buffers** (front/back, for damage diffing — preallocated typed arrays)
3. the last frame's **HitMap** (so a mouse event can be told which node it hit)
4. active **subscriptions** (long-lived Msg sources, keyed)
5. a **cached layout** (a dirty-flagged perf cache, not state)

There is **no retained view tree**. `view(model)` returns a *fresh immutable `Node` tree*
each frame; the engine lays it out and rasterizes it to **cells**, then discards it. Diffing
happens at the cell level (damage), never at the node level. That is the exact line between
this and a reconciler: a reconciler diffs two node trees and mutates a retained one — here
there is nothing retained to mutate.

## The pipeline (per frame)

```
Msg ─▶ update(msg, model) ─▶ model' ─▶ view(model') ─▶ Node tree
                                                          │
                          Yoga layout (skipped if clean) ─▶ LaidOutNode (abs rects + z)
                                                          │
                    composite: rasterize → layers/z → diff ─▶ { damage, HitMap }
                                                          │
                              encode(damage) RLE → ANSI ─▶ stdout
```

Mouse works without a widget tree because the **compositor** owns geometry: it builds a
`HitMap` (cell → NodeId) each frame, and the runtime annotates the next mouse event's
`target` from it before handing it to `onInput`. So the app matches clicks on a `NodeId`,
never on coordinates.

## Two honest deviations from pure Elm

- **`onInput` adapter.** Pure Elm routes input via subscriptions; we give `Program` a small
  `onInput(event, model) -> Msg | null` so raw terminal input maps to app Msgs in one place
  and `update` only ever sees app Msgs. Pragmatic, more legible for a TUI.
- **`subscriptions(model)` diffed by key.** The runtime recomputes the sub list each update
  and starts/stops sources by `key`. That is a small effect-diff — of *effects*, by key, not
  a view tree — and it is the only per-source state the runtime keeps.

## The perf tax to respect

Naive immediate-mode re-runs `view` **and** full Yoga layout on every model change — every
keystroke, every streaming token. The fixes are dirty-flagged layout (re-layout only when
layout-affecting state changes) and damage-tracked cells (re-composite only changed cells).
Both are scoped, derived, throwable caches — not a reconciler, not mutable widget state.

## Open sub-questions (for when this becomes real, not now)

- Grapheme width: `Intl.Segmenter` + a width table; the emoji/East-Asian long tail is the
  perennial terminal tax and is ours regardless of renderer.
- Focus model: derived from the model (as in the example) vs a runtime focus-ring concept.
- Text as leaf vs. a richer inline-span model (Push already has inline markdown in the TUI).
