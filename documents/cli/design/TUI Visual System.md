# Push CLI TUI Visual System

This document describes the visual design system, layout specifications, and interaction patterns of the Push CLI TUI.

It focuses on the **current shipped TUI**. Where a pattern is aspirational/future-facing, it is called out explicitly.

## Visual Design Philosophy

**Dense information display.** Terminal UIs are information-dense by nature. We embrace this with compact layouts and minimal whitespace.

**Color as semantic signal.** Colors have specific meanings:
- Blue (`accent.primary`) = Interactive elements, primary actions
- Cyan (`accent.secondary`) = User content, secondary actions  
- Green (`state.success`) = Success, completion, clean state
- Yellow (`state.warn`) = Warnings, active operations
- Red (`state.error`) = Errors, denials, requires attention

**Typography.** Monospace throughout. Bold for emphasis. Dim for secondary information.

## Color System

### Tokens (from tui-theme.mjs)

| Token | Hex | ANSI Fallback | Usage |
|-------|-----|---------------|-------|
| `bg.base` | `#070a10` | Black | Terminal background |
| `bg.panel` | `#0c1018` | Black | Modal backgrounds |
| `fg.primary` | `#f5f7ff` | Bright White | Primary text |
| `fg.secondary` | `#b4becf` | White | Body text |
| `fg.muted` | `#8b96aa` | Bright Black | Tertiary text |
| `fg.dim` | `#667086` | Bright Black | Disabled, hints |
| `border.default` | `#1f2531` | Dim | Box borders |
| `border.hover` | `#2f3949` | White | Active borders |
| `accent.primary` | `#0070f3` | Blue | Links, buttons |
| `accent.secondary` | `#38bdf8` | Cyan | User badges |
| `accent.link` | `#5cb7ff` | Bright Cyan | Highlights |
| `state.success` | `#10b981` | Green | OK status |
| `state.warn` | `#fbbf24` | Yellow | Warning status |
| `state.error` | `#ef4444` | Red | Error status |

### Color Tiers

The TUI supports four color tiers based on terminal capabilities:

1. **Truecolor (24-bit)** - `COLORTERM=truecolor|24bit`
2. **256-color** - `TERM` contains "256color"
3. **16-color ANSI** - Basic TTY fallback
4. **None** - `NO_COLOR` set

## Layout Specifications

### Screen Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Header (4 lines)                                                             │
│   ┌─ ⬡ Push ───────────────────────────────────────────────────────────────┐  │
│   │  ● idle  ollama · model  ~/cwd · branch                               │  │
│   └────────────────────────────────────────────────────────────────────────┘  │
│   session: sess_xxx  /model                                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ Transcript region (flexible height; optional right-side tool pane split)     │
│   [AI]  Summary / answer text…                             [TOOLS] 12         │
│   [AI]  ▸ JSON payload · 1 tool call · collapsed           → exec git status  │
│   [TOOL] ✓ exec 45ms                                        ✓ exec 45ms       │
│   [INFO] Context compacted                                                  │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ Composer (3-7 lines)                                                         │
│   ── message ───────────────────────────────────────────────────────────────  │
│   › Type your message here                                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ Footer (2 lines)                                                             │
│ main +2 │ ~/projects/Push │ 12 msgs · 4.2k                           ● LIVE │
│ Ctrl+T tools  Ctrl+O payloads  Ctrl+C cancel                         idle    │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Layout Computations

```javascript
// From tui-renderer.mjs
const headerHeight = 4;    // Product line, state, session hint
const footerHeight = 2;    // Status bar + keybind hints
const composerHeight = Math.max(3, Math.min(7, lines + 2));

// Transcript gets remaining space
transcriptHeight = composerTop - transcriptTop - 1;
```

### Margins

- Horizontal: 2 columns on each side
- Vertical: 1 row on each side
- Inter-pane gaps: 1 row/column

## Typography

### Text Styles

| Style | ANSI Code | Usage |
|-------|-----------|-------|
| Normal | - | Body text |
| Bold | `\x1b[1m` | Headers, emphasis |
| Dim | `\x1b[2m` | Secondary text |
| Inverse | `\x1b[7m` | Selected items |
| Underline | `\x1b[4m` | Links (rarely used) |

### Badges

Badges are styled labels with background colors:

```javascript
function makeBadge(theme, label, { fg, bg, bold }) {
    return theme.styleFgBg(fg, bg, ` ${label} `);
}

// Usage:
makeBadge(theme, 'AI', { fg: 'bg.base', bg: 'accent.primary' })
// → Blue background, dark foreground
```

Badge types:
- `AI` - Assistant messages (blue background)
- `YOU` - User messages (cyan background)
- `TOOL` - Tool calls (gray background)
- `INFO` - Status messages (gray background)
- `ERR` - Errors (red background)
- `WARN` - Warnings (yellow background)
- `THINK` - Reasoning (gray background)

## Interaction Patterns

### Keybinding Conventions

**Navigation:**
- `↑/↓` or `j/k` - Navigate lists
- `Enter` - Select/confirm
- `Esc` - Cancel/close
- `1-9` - Quick select (lists)

**Global:**
- `Ctrl+C` - Cancel run / Exit
- `Ctrl+T` - Toggle tool pane
- `Ctrl+O` - Payload inspector
- `Ctrl+G` - Reasoning modal
- `Ctrl+P` - Provider switcher
- `Ctrl+L` - Clear viewport

**Composer:**
- `Enter` - Send message
- `Alt+Enter` - New line
- `↑/↓` - Input history (single-line mode)
- `Ctrl+A/E` - Start/end of line
- `Ctrl+U` - Kill to line start
- `Ctrl+K` - Kill to line end
- `Ctrl+W` - Kill word backward

**Approval Modal:**
- `y` - Approve
- `n` - Deny
- `a` - Always approve (this pattern)
- `Esc` - Deny

### Modal Patterns

All modals follow consistent patterns:

1. **Centered box** with border
2. **Title** in bold at top
3. **Scrollable list** for items
4. **Cursor indicator** (› or prompt char)
5. **Footer hints** for available actions
6. **Esc to close** (universal)

Example (Resume Modal):
```
┌─ Resume Session ──────────────────────────────────────────────────┐
│                                                                   │
│   /filter: oll          ← filter input (when active)              │
│   ─────────────────────────────────────────────────────────────   │
│  › 1. Project Setup        ← cursor position                      │
│      ollama/qwen · 2m ago                                       │
│   2. Bug Fix                                                      │
│      mistral/medium · 1h ago                                      │
│                                                                   │
│  ─────────────────────────────────────────────────────────────    │
│  ID: sess_abc123                                                  │
│  Path: ~/projects/Push                                            │
│  Model: ollama/qwen                                               │
│                                                                   │
│  ─────────────────────────────────────────────────────────────    │
│  ↑↓ nav │ Enter resume │ / filter │ R rename │ D delete │ Esc     │
└───────────────────────────────────────────────────────────────────┘
```

## Status Bar Design

### Status Bar (Line 1)

Sections are visually grouped; separators/icons may vary by terminal/glyph availability.

```
main +2 │ ~/path │ 8 msgs · 2.1k        ● LIVE
```

| Section | Format | Example |
|---------|--------|---------|
| Git | `branch +{dirty}` | `main +3` |
| Path | `{shortened}` | `~/projects/Push` |
| Context | `{msgs} msgs · {tokens}tk` | `8 msgs · 2.1k` |
| Live | `● LIVE` (when streaming) | `● LIVE` |

Note: `tui-status.mjs` supports optional glyph icons (branch/folder), but current theme glyph sets do not define them, so the shipped display is text-first.

### Keybind Hints (Line 2)

Context-sensitive hints on the left, state indicator on the right:

```
Ctrl+T tools │ Ctrl+O payloads │ Ctrl+C cancel          idle
```

State indicators:
- `idle` (green) - Ready for input
- `running` (yellow) - Assistant working
- `awaiting approval` (red) - Needs user confirmation
- `awaiting answer` (blue) - Question modal open

## Transcript Formatting

### Entry Types

**User entry:**
```
[YOU] What is the best way to handle errors?
```

**Assistant entry:**
```
[AI] There are several approaches to error handling...
     Second line of wrapped text...
```

**Tool call (transcript row):**
```
[TOOL] ✓ exec 45ms
```

Or when pending:
```
[TOOL] … exec
```

Or on error:
```
[TOOL] ✗ exec 120ms
```

**Tool pane rows (optional side pane):**
```
→ exec git status --short
  ✓ exec 45ms
```

**Status:**
```
[INFO] Context compacted (12 → 8 messages)
```

**Verdict:**
```
  ✓ APPROVED exec   (or)   ✗ DENIED exec
```

### Markdown-like Rendering (Shipped)

Assistant messages support basic formatting:

````markdown
# Heading 1        → Bold blue
## Heading 2       → Bold blue

- Bullet point     → Indented with marker
1. Numbered        → Indented with number

> Quote            → Dim text

Inline code spans are not specially styled yet (render as normal text).

```fenced code```  → Gray header, code body

```json { "tool": ... } ```
→ Collapsed into a compact "JSON payload" block in the transcript, with per-block expand/collapse via payload inspector mode

---                ──────────────────────── (divider)
````

## Animation & Feedback

### Progress Indicators

No progress bars (unknown duration). The current shipped TUI uses:
- Status badges / state labels
- `streaming...` composer label during active runs
- `● LIVE` footer indicator while assistant text is streaming
- Modal loading text (for async modal content such as resume picker)

### Bell Character

Terminal bell (`\x07`) on:
- Run completion
- Errors
- Approval needed
- Payload inspector open with no payload blocks (no-op feedback)

## Responsive Behavior

### Minimum Terminal Size

- Minimum: 60x16 (cols x rows)
- Below minimum: Show centered "Terminal too small" message

### Resize Handling

```javascript
process.stdout.on('resize', () => {
    tuiState.dirty.add('all');
    scheduler.flush();
});
```

Layouts are recomputed on resize, no persistent state lost.

### Small Screen Adaptations

- Modal width capped at `min(92, cols - 8)`
- Text truncated with ellipsis (…)
- Long paths shortened (`~/projects/Push` vs full path)

## Accessibility Considerations

### Color Independence

All semantic information is conveyed through:
- Text content (✓ vs ✗)
- Position (cursor indicator)
- Typography (bold vs dim)

Colors enhance but are not required for understanding.

### High Contrast Support

- `NO_COLOR` environment variable disables all colors
- Sufficient contrast in default theme

### Keyboard-Only Navigation

- All features accessible via keyboard
- No mouse-required interactions
- Consistent keybinding patterns

## Glyph Reference

### Unicode Mode (default)

| Glyph | Unicode | Usage |
|-------|---------|-------|
| Corner TL | `┌` U+250C | Box corners |
| Corner TR | `┐` U+2510 | Box corners |
| Corner BL | `└` U+2514 | Box corners |
| Corner BR | `┘` U+2518 | Box corners |
| Horizontal | `─` U+2500 | Borders, dividers |
| Vertical | `│` U+2502 | Borders |
| Prompt | `›` U+203A | Input prompt |
| Ellipsis | `…` U+2026 | Truncation |
| Arrow | `→` U+2192 | Tool call direction |
| Check | `✓` U+2713 | Success |
| Cross | `✗` U+2717 | Error |
| Status dot | `●` U+25CF | Live indicator |

### ASCII Fallback

When Unicode not available (LANG without UTF-8):
- `+` for corners
- `-` for horizontal
- `\|` for vertical
- `>` for prompt
- `->` for arrows
- `ok` / `x` for check/cross marks

## File Organization

```
cli/
├── tui.mjs              # Main TUI entry point (~3,750 lines)
├── tui-renderer.mjs     # Rendering primitives (~430 lines)
├── tui-theme.mjs        # Design tokens (~220 lines)
├── tui-input.mjs        # Input handling (~430 lines)
├── tui-status.mjs       # Status bar (~270 lines)
├── tui-fuzzy.mjs        # Fuzzy filtering (~150 lines)
├── tui-completer.mjs    # Tab completion (~280 lines)
└── tests/
    ├── tui-input.test.mjs
    ├── tui-renderer.test.mjs
    └── tui-theme.test.mjs
```

## References

- **Visual Language Spec:** `documents/cli/design/Push CLI TUI Visual Language Spec.md`
- **Architecture:** `documents/cli/design/TUI Architecture.md`
- **Tailwind Config:** `app/tailwind.config.js` (color source of truth)
