# Shared stress list — the pass/fail rubric for any compositor candidate

The decision doc's vertical-slice step 4, expanded into a checklist that every
candidate (adopt *or* build) must be scored against — same cases, same
terminal, same order, so results are comparable. A candidate that can't be
*driven* through a case (missing API) scores ❌ for it; "undocumented" is not
a pass.

Score in the candidate's spike README as ✅ / ⚠️ (partial, note why) / ❌ /
`—` (not yet run).

## Cell / width correctness (the CellWidth contract)

1. **CJK overwrite** — paint `中`, then paint a narrow glyph onto its lead
   cell. The orphaned continuation cell must clear, not ghost.
2. **Wide clip at last column** — a wide glyph clipped at the right edge must
   paint a space, not bleed or wrap.
3. **ZWJ / combining collapse** — `👩‍👩‍👧‍👦` and `é` occupy one grapheme's cells;
   continuation cells inherit the lead's hit target.
4. **Mixed-width reflow on resize** — a line of alternating narrow/wide text
   survives a width change without split graphemes.

## Layering / damage

5. **Modal over content** — draw a centered box (with backdrop) over a busy
   scene; close it; the underlying cells must restore **without a full-screen
   clear** (watch the byte stream for `ESC[2J`).
6. **Transparency / partial backdrop** — a layer that dims but does not
   replace what's beneath.
7. **Z-order stack** — three overlapping layers; reorder; verify paint order
   and that damage is limited to the changed region.
8. **Occluded update** — mutate content *underneath* a modal; nothing visible
   changes until the modal closes, then the new content appears.

## Input / geometry

9. **Hit-testing** — click routes to the topmost layer at that cell; the
   occluded layer must not receive it. Continuation cell of a wide glyph hits
   the same target as its lead.
10. **Wheel + drag** — wheel scrolls the pane under the cursor (not the
    focused pane); drag on a divider resizes.
11. **Resize storm** — rapid SIGWINCH bursts; no torn frames, final layout
    matches final size.
12. **Cursor + selection** — a visible cursor tracks focus across layers;
    text selection (or an OSC52 copy path) survives an overlay open/close.

## Runtime / ops

13. **Headless story** — can CI drive it without a TTY (test renderer,
    deterministic snapshot output)?
14. **Teardown** — SIGINT mid-modal restores the terminal (no stuck alt
    screen, mouse tracking off, cursor visible).
15. **Perf floor** — full-screen transcript scroll at 80×24 and 200×60; the
    frame writes should shrink with damage, not stay O(screen).

## Scoreboard

| # | Case | OpenTUI (Bun) | Rezi | Glyph | Silvery | Pure-TS build |
|---|---|---|---|---|---|---|
| 1 | CJK overwrite | — | ✅ human-scored (Windows Terminal, 2026-07-12) | — | ✅ **driven** — pipeline overwrite repairs lead (" a中中") | — |
| 2 | wide clip | — | ✅ human-scored | — | ⚠ truncate path clean (`…`); raw-clip case not isolated | — |
| 3 | ZWJ/combining | — | ❌ **human-confirmed raster failure** — family emoji misaligns in a real terminal despite `measureTextCells`=2; measure and raster disagree | ✅ string-level (`ttyStringWidth`) | ✅ **human-scored (2026-07-12, Windows Terminal/WSL2)** — self-scoring border box: all 9 cluster classes aligned incl. ZWJ family + ZWJ+tone (the case Rezi failed); emission-side verified in driven run (full cluster in bytes, own VT self-consistent); default-config xterm-headless still splits clusters — keep as referee caveat, not a silvery defect | — |
| 4 | mixed reflow | — | ✅ human-scored (incl. resize wiggle) | — | — | — |
| 5 | modal restore | ✅ (panes.ts) | ✅ content restore correct w/ current state (full-clear-vs-damage byte check still open) | — | — | — |
| 6 | transparency | — | ❌ by design — `"dim"` fills a `░` pattern (`containers.js`), and the fill covers the **whole viewport**, not just the layers region; see-through dim doesn't exist. Bonus finding via this scene: `ui.center` **faults the app on first paint**, and a faulted app **exits silently** (`run()` resolves, exit 0, empty stderr) — minimal repro in `rezi-spike/probe-fault.mjs` | — | ✅ **driven** — `Backdrop fade` reads the finished buffer beneath, dims without replacing (OKLab blend, documented ANSI-16→dim degradation observed); best transparency surveyed | — |
| 7 | z-order stack | — | ❌ **source-confirmed + human-verified live** — paint renders layers children "in order (later = on top)" and never reads `zIndex`; `zIndex` only sorts the input-routing registry → doc contract unmet, paint/input stacking can disagree (scene 7: `x` restacks, `z` doesn't) | — | ⚠ restack repaints correctly, but paint z = tree order while hit z = manual `useHitRegion` param → **agreement by-convention** | — |
| 8 | occluded update | — | ✅ bg ticked behind modal, zero leak-through, current values on close | — | — | — |
| 9 | hit-testing | ✅ (click-to-focus) | ✅ **human-scored** — clicks route correctly incl. the continuation cell of a wide glyph; modal blocks clicks to lower layers | — (`useMouse` present) | ⚠ standalone `HitRegistry` correct (highest z wins); React-wired path + continuation-cell hit untested | — |
| 10 | wheel + drag | — | — | — | — | — |
| 11 | resize storm | — | — | — | — | — |
| 12 | cursor + selection | — | — | — | — | — |
| 13 | headless story | ❌ native needs Bun+TTY | ⚠️ native needs real TTY; `createTestRenderer` exists (unproven) | ✅ renders headless (but see #15) | ✅ **driven** — entire run headless on fake streams, Node 22, published dist (`engines>=18`); `renderString` + `VirtualTerminal` ship | ✅ by design |
| 14 | teardown | — | ⚠️ clean on `q`/probe-tty, **but a runtime fault exits silently** — no error surface at all (see #6) — an ops-visibility hole by Push's standards | ✅ observed (smoke) | ❌ **confirmed driven + live** — render fault: exception swallowed (message never surfaces), `run()` never settles; live TTY run exits via Node unsettled-top-level-await (code 13) with a diagnostic blaming the await, not the fault; error boundary is opt-in | — |
| 15 | perf floor | — | — | ⚠️ two identical full frames headless — verify diff engages on TTY | — | — |

Fill cells only from a driven run; update the candidate's spike README with
the run notes in the same change.
