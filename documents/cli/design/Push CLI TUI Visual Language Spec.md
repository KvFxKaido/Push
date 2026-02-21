# Push CLI TUI Visual Language Spec (Phase 1)

Date: 2026-02-21  
Status: Proposed  
Owner: Push

## Intent

Define a terminal-native visual language for `push tui` that captures the same feel as modern coding CLIs (clean dark canvas, strong hierarchy, sparse accents) without trying to clone web UI cards.

## Fidelity Target

- Layout and information hierarchy: 90% parity with target references.
- Color and contrast feel: 85-95% parity on truecolor terminals.
- Exact typography and spacing parity: not guaranteed (terminal/font dependent).

## Terminal Capability Targets

- Tier 1 (recommended): truecolor + Unicode box drawing.
- Tier 2: 256-color + Unicode.
- Tier 3: 16-color + ASCII fallback.

The TUI must remain fully usable in all tiers.

## Design Tokens

## Source of Truth (Web App)

Use the existing web tokens first:

- `app/tailwind.config.js` for Push hex tokens (`push-*` colors).
- `app/src/index.css` for semantic HSL tokens (`--destructive`, `--ring`, etc.).
- `app/src/App.css` for gradient endpoints (when approximating panel fills).

Rule:
- If a token exists in web theme, TUI must use that value instead of inventing a new palette.

## Colors (Truecolor)

| Token | Web token | Hex | Usage |
|---|---|---|---|
| `bg.base` | `push-surface` | `#070a10` | App background |
| `bg.panel` | `push-surface-raised` | `#0c1018` | Header card, modal, tool pane background |
| `fg.primary` | `push-fg` | `#f5f7ff` | Main text |
| `fg.secondary` | `push-fg-secondary` | `#b4becf` | Secondary labels |
| `fg.muted` | `push-fg-muted` | `#8b96aa` | Muted labels/icons |
| `fg.dim` | `push-fg-dim` | `#667086` | De-emphasized hints |
| `border.default` | `push-edge` | `#1f2531` | Panel separators/borders |
| `border.hover` | `push-edge-hover` | `#2f3949` | Focus/hover border |
| `accent.primary` | `push-accent` | `#0070f3` | Primary interactive accent |
| `accent.secondary` | `push-sky` | `#38bdf8` | Focus rings/status glow |
| `accent.link` | `push-link` | `#5cb7ff` | Command hints/actions |
| `state.success` | utility `emerald-500` | `#10b981` | Success states |
| `state.warn` | utility `amber-400` | `#fbbf24` | Warning states |
| `state.error` | semantic `--destructive` (~red-500) | `#ef4444` | Error/deny states |

Gradient note:
- Terminal UIs cannot reliably render CSS gradients; use solid fills from the web token set.
- When approximating gradient-heavy surfaces, prefer `bg.panel` and `border.default`.

## ANSI Fallback Mapping

- `fg.primary` -> bright white
- `fg.secondary` -> white
- `fg.muted` -> bright black / gray
- `accent.primary` -> blue
- `accent.secondary` -> cyan
- `accent.link` -> bright cyan/blue
- `state.success` -> green
- `state.warn` -> yellow
- `state.error` -> red
- Borders -> dim gray

## Spacing

- Outer margin: 1 row, 2 columns.
- Panel padding: 1 row, 2 columns.
- Section gap: 1 blank row.
- Composer height: min 3 rows, max 7 rows.
- Tool pane width (when open): 34-40% of terminal width.

## Glyph Sets

Default (Unicode):
- Border: `┌ ┐ └ ┘ ─ │`
- Prompt marker: `›`
- Divider: `─`
- Status dot: `●`

ASCII fallback:
- Border: `+ - |`
- Prompt marker: `>`
- Divider: `-`
- Status dot: `*`

No emoji glyphs in Phase 1.

## Component Spec

## 1) Header Card

Purpose: identity + current runtime context.

Required lines:
- Product/agent line (provider/model family visible)
- `model:` line (value emphasized)
- `directory:` line
- Inline command hint (e.g. `/model`)

Style:
- Bordered panel using `bg.panel` + `border.default`.
- Header text in `fg.primary`; metadata labels in `fg.secondary`; command hints in `accent.link`.

## 2) Transcript Pane

Purpose: primary reading surface.

Rules:
- User messages prefixed with prompt marker in `accent.primary`.
- Assistant stream uses `fg.primary`.
- Thinking/status text uses `fg.dim`.
- Maintain stable wrapping; no horizontal scrolling for normal text.

## 3) Tool Activity Presentation

In transcript:
- Single-line tool call summary (`tool`, short args preview, elapsed time).
- Color by outcome: success/warn/error states.

In optional tool pane:
- Show recent call/result pairs with timestamps and short outcome labels.
- Keep last N items windowed (Phase 1 default: 200).

## 4) Approval Modal

Purpose: block run until explicit decision.

Rules:
- Centered bordered panel.
- Show `kind`, summary, and high-signal details (files changed, insertions/deletions when available).
- Explicit key hints:
  - Approve: `Ctrl+Y`
  - Deny: `Ctrl+N`
  - Close/cancel view: `Esc`

## 5) Footer Hint Bar

Purpose: persistent affordance map.

Left side:
- key hints (`? shortcuts`, `Ctrl+T tools`, `Ctrl+C cancel`)

Right side:
- context budget / run state summary (`100% context left`, `running`, `awaiting approval`)

## Motion and Rendering

- Token streaming should feel live, but avoid full-screen redraw flicker.
- Render loop should be batched/throttled (target <= 30 FPS).
- Cursor remains visible in composer only.
- No decorative animation in Phase 1.

## Accessibility and Contrast

- Keep primary text contrast high against `bg.base`.
- Never rely on color alone for critical state; include text labels (`ERROR`, `WARN`, `OK`).
- Provide `PUSH_TUI_THEME=high-contrast` override later (post-Phase 1).

## Copy Style

- Prefer short, operational labels.
- Use lowercase command hints (e.g. `/model`, `/provider`).
- Avoid marketing copy in run-time surfaces.

## Acceptance Criteria (Visual)

- Header card, transcript, and footer read correctly at 80x24 minimum terminal size.
- UI remains legible in truecolor and 256-color terminals.
- ASCII fallback renders without broken borders.
- Side-by-side screenshots preserve hierarchy and tone, even if font metrics differ.

## Out of Scope (Phase 1)

- Pixel-perfect clone of Codex/Claude screenshots.
- Web-card parity in terminal.
- Custom icon packs or rich media rendering.
