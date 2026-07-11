# Vendored reference — Charm Lip Gloss v2 compositor

Read-only reference material for the retained-mode TUI spike. **Do not edit; do not import.**
These are the blueprint for a pure-TS cell compositor with z-order layers (Push "Option B").

- Source: [`charmbracelet/lipgloss`](https://github.com/charmbracelet/lipgloss)
- Commit: `10f9584edb197ddbbfc789081d33b6fadaea5742` (HEAD @ 2026-07-11)
- License: MIT (© Charmbracelet, Inc.)

Files:

| File | What to steal from it |
|---|---|
| `layer.go` | The `Layer` model: `X()/Y()/Z()` positioning + z-order stacking, child layers, hit region. This is the retained-geometry + z-order primitive. |
| `canvas.go` | The `Canvas` compositor: how layers composite cell-by-cell into one framebuffer with occlusion. |
| `example-canvas-main.go` | Minimal end-to-end: build layers, set z-order, render. The "hello world" of the compositor. |

Pairing: Lip Gloss v2 supplies the *compositor + layout algebra*; Bubble Tea v2 supplies the
*MVU state loop* on top. The Push port would swap Lipgloss's string-algebra layout for
Yoga-WASM (CSS-flexbox, matches web) while keeping the layer/z-order compositor shape.
