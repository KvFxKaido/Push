# MVU engine — core signatures (Option B design skeleton)

Status: Design sketch (spike/tui-retained-mode, 2026-07-11; revised after Codex review).
Typechecks (`tsc -p .`, exit 0). Proves the **authoring surface**, not runtime semantics.

The decision this encodes: **reconciler rejected.** The engine is "Bubble Tea v2 in
TypeScript" — MVU authoring on top, a pure-TS cell compositor with z-order layers underneath,
Yoga-WASM for layout (verified to run on Node in the OpenTUI smoke test). No reconciler, no
mutable widget tree. See `../README.md` for how we got here.

## What is and isn't settled

Settled — the **renderer family**: a cell compositor with z-order layers is the right paradigm
for panes/modals/mouse. Two independent witnesses (OpenTUI; Charm's move to a Lipgloss v2
compositor) plus the fact that Push's own `createScreenBuffer` is already a damage-diffing
flush all point the same way.

**Not** settled — the **contracts**. The Codex review moved two of them (layout caching must be
node-free; effects need a lifecycle) and named a third (cell representation must encode wide
glyphs from the start). Those are now reflected below; the runtime semantics are still unproven.

## Files

- `engine.ts` — core contracts. `Cmd` is interpreted data with identity/keying; `view` returns
  an immutable `Node` tree; layout flattens it to a **node-free** `Frame` (paint list);
  `Compositor` does cells + z-layers + damage + `HitMap`.
- `example-push.ts` — a Push-shaped app (panes + palette modal + agent-stream `Sub` + a keyed
  tool-call `Cmd` + mouse-target→focus).
- `tsconfig.json` — strict; `npx tsc -p .`.

## The retention budget — categories, not a magic number

Between frames, three categories persist; the point is which is which, not the count.

- **Authoritative state** — the model. Only `update` writes it.
- **Derived caches** — reconstructible from the model, throwable, invalidated by key: the two
  cell buffers, layout **geometry** (rects by NodeId, keyed by a cheap layoutKey — the pattern
  `cli/tui.ts:2663` already uses), transcript/stream shaping (`cli/tui-stream-frame.ts` is
  exactly this), the last frame's hit map.
- **Live resources** — explicitly torn down: subscriptions, in-flight command controllers, the
  input decoder, the frame scheduler.

The invariant that makes this **not a reconciler**: no retained *view tree*. `view(model)`
returns a fresh `Node` tree; it's flattened to a node-free `Frame`, rasterized to cells, and
discarded. Diffing is cell-level (damage), never node-level. (The first draft violated this —
`LaidOutNode` retained `node: Node`, so caching it retained the "discarded" tree and could
repaint stale content. Fixed: the cache is geometry-only, `Frame` is node-free.)

## The pipeline (per frame)

```
Msg ─▶ update(msg, model) ─▶ model' ─▶ view(model') ─▶ Node tree (fresh, thrown away)
                                                          │
                       Yoga layout, geometry cached by key ─▶ Frame (node-free paint ops)
                                                          │
                    composite: rasterize → layers/z → diff ─▶ { damage, HitMap }
                                                          │
                              encode(damage) RLE → ANSI ─▶ stdout
```

Mouse works without a widget tree because the **compositor** owns geometry: it builds a
`HitMap` (cell → NodeId) each frame, and the runtime annotates the next mouse event's `target`
from it. The app matches clicks on a `NodeId`, never coordinates.

## Effect lifecycle (the second contract fix)

`Cmd` is interpreted data, not a bare promise, so the runtime can enforce a real policy:

- **Identity** — a `task` may carry a `key`.
- **Replacement** — a new same-key task aborts and replaces the in-flight one.
- **Late-result suppression** — a result from a superseded generation is dropped.
- **Error mapping** — a rejection maps through `onError`, never an unhandled rejection.
- **FIFO, non-reentrant** — one Msg fully applies before the next dequeues; no torn model.
- Cancellation happens ONLY via same-key replacement, explicit `Cmd.cancel(key)`, or `stop()`
  — **never** on an unrelated model change (which would abort a tool on every stream delta).

## Cell representation is compositor-core, not deferrable

Wide-cell continuation, `中 → a` (narrow over wide-lead clears the orphan), clipping at the last
column, ZWJ/combining clusters, transparency, equal-z stable ordering, cursor state, and
hit-target inheritance for continuation cells all determine the buffer representation. Encoded
via `CellWidth` from day one; reuse the existing width table (`cli/tui-renderer.ts:73`).

## What this sketch does NOT prove

It typechecks, so the authoring surface is expressible. `Cmd` and `createRuntime` are
declarations; streaming, cancellation, damage-restore, and wide-glyph handling are described,
not executed. Runtime semantics are unproven — that's what the slice below is for.

## Next: a Push-shaped vertical slice (Codex's plan, adopted)

Prove the compositor mechanic **inside the living TUI at the `createScreenBuffer` choke point**
(`cli/tui-renderer.ts:344`) — upgrade line-diff → cell-diff — not a simultaneous
renderer+Yoga+MVU+daemon rewrite. Build it as a **replaceable module with a paint-list input**
so the later Node/Yoga path is a new producer, not a compositor rewrite.

0. Decide the cell representation (incl. `CellWidth`) — prerequisite to painting anything.
1. Paint real styled assistant output into cells.
2. Layer one existing modal over it.
3. Close it and prove damage restores the underlying cells **without clearing the screen**.
4. Test wide glyphs, transparency, clipping, z-order, hit occlusion, resize, cursor, selection.
5. Preserve the current daemon, input, focus, transcript-cache, and layout machinery; adapt
   Push's existing input parser + focus stack into `onInput`, don't replace them.
6. Introduce `Node`/Yoga afterward; extract the full MVU reducer last.

## Still open (not pretended-solved)

- Grapheme width's long tail (emoji/ZWJ disagreements across terminals) — ours regardless.
- Focus as derived model state vs a runtime focus-ring.
- Text-as-leaf vs an inline-span model (Push already has inline markdown in the TUI).
