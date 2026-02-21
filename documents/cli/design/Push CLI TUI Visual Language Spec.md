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

## Colors (Truecolor)

| Token | Hex | Usage |
|---|---|---|
| `bg.base` | `#0b0d10` | App background |
| `bg.panel` | `#11151b` | Header card, modal, tool pane background |
| `fg.primary` | `#e8ecf2` | Main text |
| `fg.muted` | `#a1a9b5` | Secondary labels |
| `fg.dim` | `#6f7885` | De-emphasized hints |
| `border.default` | `#303846` | Panel separators/borders |
| `accent.cyan` | `#43e7e7` | Commands, active shortcut hints |
| `accent.violet` | `#a7b3ff` | Brand/prompt accents |
| `state.success` | `#62d881` | Success states |
| `state.warn` | `#e5c76b` | Warning states |
| `state.error` | `#ff7b8f` | Error/deny states |

## ANSI Fallback Mapping

- `fg.primary` -> bright white
- `fg.muted` -> bright black / gray
- `accent.cyan` -> cyan
- `accent.violet` -> blue or magenta
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
- Header text in `fg.primary`; metadata labels in `fg.muted`; command hints in `accent.cyan`.

## 2) Transcript Pane

Purpose: primary reading surface.

Rules:
- User messages prefixed with prompt marker in `accent.violet`.
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
