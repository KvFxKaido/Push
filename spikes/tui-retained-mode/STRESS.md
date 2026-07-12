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

| # | Case | OpenTUI (Bun) | Rezi | Glyph | Pure-TS build |
|---|---|---|---|---|---|
| 1 | CJK overwrite | — | — | — | — |
| 2 | wide clip | — | — | — | — |
| 3 | ZWJ/combining | — | ✅ string-level (`measureTextCells`) | ✅ string-level (`ttyStringWidth`) | — |
| 4 | mixed reflow | — | — | — | — |
| 5 | modal restore | ✅ (panes.ts) | — | — | — |
| 6 | transparency | — | — | — | — |
| 7 | z-order stack | — | — | — | — |
| 8 | occluded update | — | — | — | — |
| 9 | hit-testing | ✅ (click-to-focus) | — (API present: `hitTestLayers`) | — (`useMouse` present) | — |
| 10 | wheel + drag | — | — | — | — |
| 11 | resize storm | — | — | — | — |
| 12 | cursor + selection | — | — | — | — |
| 13 | headless story | ❌ native needs Bun+TTY | ⚠️ native needs real TTY; `createTestRenderer` exists (unproven) | ✅ renders headless (but see #15) | ✅ by design |
| 14 | teardown | — | ✅ observed (probe-tty) | ✅ observed (smoke) | — |
| 15 | perf floor | — | — | ⚠️ two identical full frames headless — verify diff engages on TTY | — |

Fill cells only from a driven run; update the candidate's spike README with
the run notes in the same change.
