# Design

## Overview

Dark-only, mobile-first interface for a developer productivity tool.
High information density, minimal visual noise, careful motion timing.
Built on Tailwind CSS + shadcn/ui (New York style) on Base UI primitives (migrated from Radix in #1411).
This document defines the visual system for the graphical app surfaces — tokens, components, motion, and the product voice the copy on those surfaces follows. CLI/TUI presentation is documented separately and may follow shared semantic intent without matching these exact tokens or components.

## Voice & content

Push copy is calm, declarative, and developer-direct. It assumes you ship code and does not hype. This governs everything a surface *says* — labels, microcopy, empty states, marketing. The agent's user-facing role/phase **labels** are a separate concern owned by `lib/role-display.ts`; don't hand-spell them here or anywhere.

### Voice

- Second person, lowercase verbs: "Resume work or jump into a repo." "Switch context." "Browse All Repos."
- Direct verbs over noun phrases: `New Sandbox`, not "Create a new sandbox session." `Save` / `Download` / `Copy All`.
- Short and real. Hero copy is one sentence. Confidence without swagger — the brand's warmest adjectives are "calm", "real", "anchored". No "lightning fast" / "magical" / "delightful".
- "you", never "I" / "we". The chat agent narrates without personification — a working-state line is `role + ellipsis verb` ("Exploring…", "Editing…"), with the role/phase label resolved through `lib/role-display.ts`.
- No exclamation marks. No non-actionable questions — "Ready to ship?" → "Open on branch."
- No emoji anywhere in product copy. Status is iconography + colored dots, never an emoji.

### Casing

| Form          | Use                                                                                  |
| ------------- | ------------------------------------------------------------------------------------ |
| Title Case    | page / sheet titles, primary actions — `Workspace`, `New Sandbox`, `Browse All Repos` |
| Sentence case | descriptions, microcopy, body text                                                   |
| UPPERCASE     | section micro-labels in panels — `AGENT CONSOLE`, `RECENT REPOS` (the `HUB_TAG_CLASS` register) |
| lowercase     | branch names, commands, identifiers — `main`, `pnpm install`, `--task`                |

### Mechanics

- Em dash with spaces is the house clause separator: "Ephemeral workspace — write code, run commands…". It also qualifies labels: `Sandbox · ephemeral`, `Push · main`.
- Numbers as digits, always: `2h ago`, `10 recent commits`. UI time is relative: `1h ago`, `11d ago`.
- Path-style attribution in chat bylines: `Push / main · 1m ago` (slash + middot).

Reference copy: launcher hero "Push — Resume work or jump into a repo."; sandbox empty state "Ephemeral workspace — write code, run commands, and prototype ideas from scratch."; chat placeholder "Ask about code…"; agent trace "Fetching from GitHub…".

## Colors

Tokens below are Tailwind theme extensions. Use them with the appropriate utility prefix: `text-push-fg`, `bg-push-surface`, `border-push-edge`, `shadow-push-card`, etc.

### Text Hierarchy (bright to dim)

| Token              | Hex       | Use                          |
| ------------------ | --------- | ---------------------------- |
| `push-fg`          | `#f5f7ff` | Primary text                 |
| `push-fg-secondary`| `#b4becf` | Secondary text, labels       |
| `push-fg-soft`     | `#d7deeb` | Softened primary text (chat/library panels) |
| `push-fg-muted`    | `#8b96aa` | Muted text, subtle icons     |
| `push-fg-faint`    | `#7c879b` | Fainter muted text (chat/library panels) |
| `push-fg-dim`      | `#667086` | Very dim text                |
| `push-fg-dimmest`  | `#505971` | Disabled / placeholder text (line numbers, empty-state hints) |

### Surfaces (light to dark)

| Token                 | Hex       | Use                          |
| --------------------- | --------- | ---------------------------- |
| `push-surface`        | `#000000` | Base page background (AMOLED pure black) |
| `push-surface-raised` | `#14171f` | Elevated panels, cards       |
| `push-surface-hover`  | `#0d1119` | Hover background             |
| `push-surface-active` | `#111624` | Pressed state, badge fills   |
| `push-surface-inset`  | `#000000` | Recessed areas (editor, inputs) — flush black, defined by border |

### Borders

| Token              | Hex       | Use                          |
| ------------------ | --------- | ---------------------------- |
| `push-edge-subtle` | `#242c39` | Dividers, input borders      |
| `push-edge`        | `#2b3340` | Primary border               |
| `push-edge-hover`  | `#2f3949` | Hover border                 |
| `push-edge-focus`  | `#3d5579` | Focus / active input border  |

### Accent & Interactive

The accent is **Sky**, two-tier. Light Sky (`#7dd3fc`) is the airy identity color — accent text, icons, links, the ambient glow, the **focus ring** (`--ring`), and tinted button fills. Deep Sky lives in the shadcn `--primary` var (`200 98% 39%` / `#0284c7`) for the few solid indicators (switch/checkbox) that need white-on-color contrast. There are **no solid Sky button fills** — the `Button` `default` variant is a tinted outline (`border-push-accent/40 bg-push-accent/10 text-push-accent`).

**Focus ring vs. focus border are different tokens, on purpose.** The 3px focus *ring* (buttons, shadcn primitives) is light Sky via `--ring` (`199 95% 74%` ≈ `#7dd3fc`). The input *border* that lights on focus is mid Sky `push-sky` (`#38bdf8`, applied as `focus:border-push-sky/50`) — a darker, lower-glow tone that reads as a state change on the field edge without competing with the ring's bloom. Don't reach for `push-sky` for a ring or `push-accent` for a focus border.

| Token        | Hex       | Use                              |
| ------------ | --------- | -------------------------------- |
| `push-accent`| `#7dd3fc` | Sky accent — text, icons, tinted CTAs, focus rings (`--ring`), glow |
| `push-sky`   | `#38bdf8` | Mid sky — input **focus border** (`focus:border-push-sky/50`), mid-sky icons, status dots |
| `push-link`  | `#7dd3fc` | Links, interactive text actions  |
| `push-link-hover` | `#bae6fd` | Brighter sky on hover        |
| `push-violet`| `#c4b5fd` | Chat / conversation accent       |
| `--primary` (HSL) | `#0284c7` | Deep sky — solid shadcn indicators (white-on-color) |

### Status

| Token                       | Hex       | Use                                    |
| --------------------------- | --------- | -------------------------------------- |
| `push-status-success`       | `#22c55e` | Success state                          |
| `push-status-success-soft`  | `#4ade80` | Lighter success / added text on dark   |
| `push-status-success-bg`    | `#173523` | Success tint background (e.g. hover)   |
| `push-status-error`         | `#ef4444` | Error state                            |
| `push-status-error-soft`    | `#f87171` | Lighter error / removed text on dark   |
| `push-status-warning`       | `#f59e0b` | Warning state                          |

### Gradients

- **Card:** `linear-gradient(180deg, #11151d 0%, #0b0f16 100%)`
- **Panel:** `linear-gradient(180deg, #05070b 0%, #020306 100%)`
- **Input:** `linear-gradient(180deg, #0a0d13 0%, #04060a 100%)`
- **User bubble:** border `#313b49`, fill `linear-gradient(180deg, #1e2733 0%, #17202b 100%)`

### Status Surfaces

Dark status-tint gradients for success/warning/error/info panels. Defined once as `--push-surface-*` CSS vars in `app/src/index.css` (the single source for the raw colors); consume via `[background-image:var(--push-surface-*)]` or the `CARD_HEADER_BG_*` class constants in `lib/utils.ts`. Pair with a matching `border-{emerald|yellow|red}-500/20` and `text-*-300`. Don't inline new status gradients — extend the var set.

| Var                              | Treatment                                  | Use                                  |
| -------------------------------- | ------------------------------------------ | ------------------------------------ |
| `--push-surface-success`         | faint `0.18→0.34`                          | success panels / banners             |
| `--push-surface-warning`         | faint `0.18→0.34`                          | warning panels / banners             |
| `--push-surface-error`           | faint `0.18→0.34`                          | error panels / banners               |
| `--push-surface-info`            | faint `0.18→0.34`                          | info panels / banners                |
| `--push-surface-success-strong`  | prominent `~0.78`                          | emphasized success panel/control     |
| `--push-surface-error-strong`    | prominent `~0.72`                          | emphasized error panel / danger CTA  |
| `--push-surface-error-solid`     | near-opaque `0.96`                         | error state on an interactive control|
| `--push-warning-bright-rgb`      | amber-400 channels (`251 191 36`)          | RelayModeChip replay-flash keyframe  |

### Repo Theme Accent (dynamic override)

Applied via `data-repo-theme='active'` on `:root`. Default values:

- Accent: `#7dd3fc` (Sky fallback; active value set per-repo at runtime)
- Soft: `rgba(125, 211, 252, 0.1)`
- Border: `rgba(125, 211, 252, 0.38)`
- Glow: `rgba(125, 211, 252, 0.45)`

### Ambient backgrounds (chat surface)

Every ambient chat background (`ChatBackgroundGlow`) composes the same three
pieces so the chrome stays legible and the variants stay consistent. **Any new
background style we add follows this standard** — don't paint a texture edge to
edge:

1. **Top-bar wash** (`ChatGlowTopBarWash`) — the soft accent gradient blobs
   behind the app bar. This is both the whole `gradient` identity and the
   legibility wash for textured variants.
2. **Top-bar clear** (`BACKGROUND_TOPBAR_CLEAR_MASK`) — a *textured* background
   (the `dotted` dot field; any future grid / aurora / scanline) is masked so
   dense texture never sits directly under the app-bar chrome (repo name, tab
   pills, icons). The texture fades in below the bar over ~5→12rem; the wash
   shows through the cleared strip.
3. **Bottom fade** (`ChatGlowBottomFade`) — fades the background into black
   toward the composer so the message area and input stay legible.

The `gradient` variant is wash + bottom fade (no texture, so no mask). The
`dotted` variant is wash + masked dot field + bottom fade. The `ripple` variant
is wash + masked cell-grid ripple + bottom fade (`BackgroundRippleEffect`,
rendered non-interactive behind chat content, with an entrance ripple from the
center). The blobs read `--push-glow-strong` / `--push-glow-soft`; textured
layers read their own accent triple (e.g. `--push-glow-dot` /
`--push-glow-dot-glow` for dots, `--push-ripple-fill` / `--push-ripple-border` /
`--push-ripple-glow` for the ripple cells) so they can tint independently of the
wash.

## Typography

### Font Stacks

Families are defined once as CSS vars (`--font-sans`, `--font-display`, `--font-mono`) in `app/src/index.css` and exposed as Tailwind `font-sans` / `font-display` / `font-mono` utilities. Swap a face in the var and it propagates everywhere — don't hardcode font stacks in components.

- **Sans / Display:** `'IBM Plex Sans'`, then `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`
- **Mono:** `'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace`

IBM Plex Sans (weights 400/500/600/700) and JetBrains Mono (400/500/600) are loaded together in one Google Fonts request. IBM Plex was chosen for small-size legibility against the dense scale and an engineering-instrument character that isn't the Inter/Geist default. `display` is the same family for now; promoting it to a distinct display face is a one-var change.

### Scale

Body tiers stay dense (mobile-first). The **display tier** carries hierarchy at the top end — use `font-display` with these and let the negative tracking do the "designed" work.

| Token          | Size | Line Height | Tracking  | Use                          |
| -------------- | ---- | ----------- | --------- | ---------------------------- |
| `push-2xs`     | 10px | 14px        | —         | Micro labels, badges         |
| `push-xs`      | 11px | 16px        | —         | Labels, timestamps           |
| `push-sm`      | 12px | 16px        | —         | Secondary body text          |
| `push-base`    | 13px | 18px        | —         | Primary body text            |
| `push-lg`      | 15px | 20px        | —         | Section headings             |
| `push-xl`      | 18px | 24px        | -0.01em   | Large headings, dialog titles|
| `push-2xl`     | 24px | 30px        | -0.015em  | Screen titles, empty states  |
| `push-display` | 32px | 38px        | -0.02em   | Hero / welcome moments       |

## Spacing & Radius

### Border Radius

Base `--radius` is `0.625rem` (10px).

| Token | Value | Use                      |
| ----- | ----- | ------------------------ |
| `xl`  | 14px  | Cards, dialogs           |
| `lg`  | 10px  | Large containers         |
| `md`  | 8px   | Buttons, inputs          |
| `sm`  | 6px   | Small elements           |
| `xs`  | 4px   | Tight corners, badges    |

### Common Spacing

4px, 6px, 8px (small gaps), 12px (medium), 16px (card padding), 24px (sections).
Standard Tailwind gap classes: `gap-2`, `gap-4`, `gap-6`.

## Shadows

Two distinct shadow families, kept separate on purpose:

1. **Overlay shadows** (`push-sm` … `push-xl`, `push-card*`) float dialogs, popovers, dropdowns and floating cards *off the page*. They are not used to distinguish in-page surface layers.
2. **Neumorphic depth** (`push-inset*`, `push-raised*`, `push-glass`) gives chrome and recessed surfaces tactile relief on the pure-black (AMOLED) canvas. This is the **surgical dark-neumorphism layer**: raised chrome lifts with a lit top edge and presses in on `:active`; recessed wells sink with an inset; the glass drawer shells get a single combined elevation + frosted edge. All depth shadows are **grayscale** (black ambient + a faint white sheen). On the `#000000` base the **white sheen carries the relief** — a black ambient shadow is invisible against black — so surface distinction leans on `push-surface-raised` (the lift is a color step, not only a shadow) plus the edge borders. Depth still introduces no hue.

Surface hierarchy for **dense content** (chat bubbles, diff/code cards, data tables) still comes from border + background contrast — those surfaces stay flat. Depth is reserved for *chrome* (hub buttons, pills, panels) and *recessed wells* (the hub inline input, the console log, nested inset panels). The split is the whole point: extruded chrome around flat, legible content. **One box-shadow per element** — never stack two `shadow-*` utilities (they collide; only one wins). When a surface needs more than one effect (e.g. a glass drawer wanting elevation *and* a frosted edge), fold them into a single combined token like `push-glass`.

| Token             | Value                                                               | Use                  |
| ----------------- | ------------------------------------------------------------------- | -------------------- |
| `push-sm`         | `0 2px 8px rgba(0,0,0,0.25)`                                       | Tooltips, small pops |
| `push-md`         | `0 8px 24px rgba(0,0,0,0.35)`                                      | Dropdowns, menus     |
| `push-lg`         | `0 14px 36px rgba(0,0,0,0.45)`                                     | Dialogs, modals      |
| `push-xl`         | `0 20px 48px rgba(0,0,0,0.55)`                                     | Full-screen overlays |
| `push-card`       | `0 4px 16px rgba(0,0,0,0.3), 0 1px 4px rgba(0,0,0,0.15)`          | Floating cards       |
| `push-card-hover` | `0 8px 28px rgba(0,0,0,0.4), 0 2px 6px rgba(0,0,0,0.2)`           | Card hover lift      |

### Neumorphic depth

| Token                | Treatment                                                        | Use                                                  |
| -------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| `push-raised`        | Soft drop + lit top inner edge (`white 0.04`)                   | Raised chrome at rest — hub buttons, pills, panels   |
| `push-raised-hover`  | Stronger drop + brighter top edge (`white 0.06`)               | Hover lift on raised chrome                          |
| `push-inset`         | Inset top shadow + faint inner ring                             | Recessed wells — hub input, console body, nested panels |
| `push-inset-strong`  | Deeper inset                                                    | Emphasized recess (reserved; deeper wells)           |
| `push-glass`         | Outer floating elevation + frosted inner edge, in one shadow   | Glass drawer shells (`RepoChatDrawer`, `WorkspaceHubSheet`) |

**Glass: the *class* is shadow-free, the *token* is the shadow.** These are two layers, not a contradiction. `HUB_GLASS_PANEL_CLASS` (the base utility — translucent gradient + `backdrop-blur-2xl` + a `border-white/[0.07]` frame) ships **without elevation** so a glass panel mid-page reads as frosting, not a floating slab. A *drawer shell* (`RepoChatDrawer`, `WorkspaceHubSheet`) is what floats, so it composes the base class **plus** the `push-glass` token to add the combined elevation + frosted edge. So: glass-the-class has no shadow; glass-that-floats does, via the one `push-glass` token. Don't stack `push-glass` onto a glass surface that isn't a floating shell.

Buttons press in on `:active` by swapping `shadow-push-raised` → `shadow-push-inset` (wired into `HUB_MATERIAL_INTERACTIVE_CLASS`). Don't compose two `shadow-*` utilities on one element — they collide on source order; pick raised **or** inset per surface. Raw shadow values live once in `tailwind.config.js`; consume the `shadow-push-*` token classes, never inline rgba.

**Focus-visible on raised chrome.** A raised surface's lit top edge and soft drop shadow would swallow a same-size ring drawn flush against the element, so neumorphic chrome separates the focus ring from the shadow with an **offset**: `:focus-visible` adds the 3px light-Sky ring (`ring-ring/50`) plus a `ring-offset-2` in the surface's own fill (`ring-offset-push-surface-raised`), so the ring reads as a crisp line in a clean gap *outside* the soft depth halo rather than fighting it. This is keyboard-only (`focus-visible`, not `focus`) so a pointer press never paints the ring; the press itself still recesses via `:active`. Wired once into `HUB_MATERIAL_INTERACTIVE_CLASS` — don't hand-roll a focus ring per button. Recessed wells (inputs) keep their existing `focus:border-push-sky/50` edge-light instead, since a sunken field has no raised halo to clear.

## State layers & touch

### State layers — flat surfaces

Chrome presses via the neumorphic shadow-swap (above). **Flat, dense interactive surfaces** — list rows, action rows, custom (non-Base-UI) menu rows — get their hover/press/focus feedback from **state layers** instead: a `currentColor` veil at fixed opacities (`--state-hover` 8%, `--state-focus` / `--state-pressed` 10%, `--state-dragged` 16% — the Material 3 `md.sys.state` values). Apply the **`.state-layer`** utility to any transparent-at-rest interactive row; it layers the veil via `color-mix` on `:hover` (pointer devices only — no sticky hover on touch), `:active`, and `:focus-visible`, transitioning on `--motion-fast` / `--ease-default`. One consistent feedback language for flat surfaces without a per-component `hover:bg-*` guess. Base UI menu items keep their own `data-highlighted:bg-accent` highlight — don't double up. The state layer is for the flat surfaces that currently improvise their own hover.

### Touch targets

Interactive controls carry a **48px minimum hit area** — the larger of Apple's 44pt and Material 3's 48dp, and the shell is Android. The visual glyph may be smaller (a 20px icon in a 48px target), but the *tappable* region must reach 48px via padding or an expanded hit area, and adjacent targets keep **≥8px separation**. This is the sizing counterpart to the `pointer-events` hit-testing rules in the hover→long-press idiom — a control that's big enough to see isn't automatically big enough to hit.

## Motion

### High refresh rate (120Hz)

All surfaces are high-refresh-ready: animations run at whatever the display provides (120Hz on capable hardware), not a fixed 60fps. Browsers handle this automatically; the Android shell needs an explicit opt-in because some OEMs (notably Samsung) pin WebView-backed windows to 60Hz — `MainActivity.requestHighestRefreshRate()` (`app/android/.../MainActivity.java`) prefers the display's highest mode at the active resolution. Two rules keep it that way:

- **Never hardcode a frame budget.** No `setInterval(…, 16)` frame loops, no logic assuming 16.7ms frames — drive JS-timed animation from `requestAnimationFrame` deltas and let CSS transitions/animations own timing wherever possible (the duration/easing tokens below are all CSS-driven and refresh-rate-independent).
- **Animate compositor properties.** `transform`, `opacity`, and `filter` stay off the main thread and actually hit 120fps; animating layout properties (`width`, `top`, `margin`) forces reflow per frame and will drop frames at any refresh rate.

### Duration Tokens

| Token             | Value | Note |
| ----------------- | ----- | ---- |
| `--motion-stagger` | 40ms | per-item stagger offset |
| `--motion-micro`   | 80ms | tooltip delay, tiny segments |
| `--motion-fast`   | 150ms | quick — close beats, text swap |
| `--motion-normal` | 250ms | fast — open beats, icon swap, tabs |
| `--motion-slow`   | 350ms | panel close |
| `--motion-slower` | 400ms | panel open, skeleton reveal |
| `--motion-slowest` | 500ms | emphasis, badge appear, text reveal |

### Easing

| Token            | Value                            |
| ---------------- | -------------------------------- |
| `--ease-spring`  | `cubic-bezier(0.16, 1, 0.3, 1)` |
| `--ease-press`   | `cubic-bezier(0.34, 1.56, 0.64, 1)` |
| `--ease-default` | `cubic-bezier(0.4, 0, 0.2, 1)`  |

### Distance, blur & scale

Travel offsets, motion-blur, and enter/exit scale. Keep distances small — motion should read as "settling into place", not flying across the screen; surfaces grow in from just under 1. Promote a hardcoded value to one of these the moment a second motion needs it (scales mirror transitions.dev).

| Distance | Value | | Blur | Value | | Scale | Value |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--distance-micro` | 4px | | `--blur-small` | 2px | | `--scale-large` | 0.96 (modal) |
| `--distance-small` | 6px | | `--blur-medium` | 3px | | `--scale-medium` | 0.97 (dropdown) |
| `--distance-base` | 8px | | `--blur-large` | 8px | | `--scale-small` | 0.98 (tooltip) |
| `--distance-medium` | 12px | | | | | `--scale-tiny` | 0.99 |
| `--distance-large` | 30px | | | | | | |

Consumed by `.panel-reveal` (`--distance-base` default throw, `--panel-blur` → `--blur-small`), `ScrollToBottomButton` (`--distance-medium`), the pager nav (`nav-transition.ts`: `--distance-base` slide + `--blur-medium`), and `.menu-pop-in` (`--scale-large`). Negating a token in an inline transform needs `calc(-1 * var(--…))` — you can't write `-var(…)`.

### Panel reveal

One open/close vocabulary for every panel — the shadcn Sheets and any custom floating reveal share it, so they read as one motion instead of three hand-tuned ones. Built on the duration/easing tokens above via a small `--panel-*` set:

| Token              | Value (resolves to) | Role |
| ------------------ | ------------------- | ---- |
| `--panel-open-dur`  | `--motion-slow` (350ms)   | Open beat — deliberate |
| `--panel-close-dur` | `--motion-normal` (250ms) | Close beat — snappy |
| `--panel-ease`      | `--ease-spring`           | Soft decel, no overshoot |
| `--panel-blur`      | `--blur-small` (2px)      | Cross-blur — **small reveals only** |

- **`.panel-reveal`** (custom floating panels/reveals): a `data-open` boolean toggles a Y-slide + fade + cross-blur. Closed → `translateY(--panel-translate-y, var(--distance-base))`, `opacity 0`, `blur(--panel-blur)`, `pointer-events: none`; open reverses all three and only lengthens the duration. Set `--panel-translate-y` per consumer for a longer throw. Used by `ScrollToBottomButton`. The `transform` is owned by the primitive — center with margins/`left`, not `-translate-x-*`.
- **shadcn `Sheet`** (the 9 bottom/side sheets): keeps its directional `slide-in/out`, but its timing + easing are retimed onto the same `--panel-*` tokens via the `[data-slot=sheet-content]` rules in `index.css` (not utility classes on the component). **No blur** on the sheets — animating `filter: blur` on a 3/4-width panel janks the Capacitor Android shell, so the cross-blur is reserved for small elements.

### Menu / dropdown open

Every menu that pops from a trigger — dropdown, context menu, menubar, select, popover, hover card, and their submenus — scales up from its trigger origin + fades. The scale/slide come from the shadcn primitives' own `animate-in` classes; `index.css` retimes them (by `[data-slot=…-content][data-open]` / `[data-closed]`) onto the shared tokens with a snappy asymmetric cadence: **open `--motion-normal` (250ms), close `--motion-fast` (150ms)**, both on `--ease-spring`. The retune keys off Base UI's valueless `data-open` / `data-closed` attributes, so a menu opened by mouse, keyboard, or touch all get the same feel. One feel across the whole menu family; sheets and tooltips keep their own timing.

Custom (non-Base-UI) menus that mount on open — e.g. the workspace branch picker — can't hook the `data-open` / `data-closed` retune, so they reuse the **`.menu-pop-in`** class (a one-shot scale-from-origin + fade on the same open cadence; pair with an `origin-*` utility to anchor the scale to the trigger corner).

**Modals / dialogs** (`dialog-content`, `alert-dialog-content`) join the same family on the same cadence (open `--motion-normal` / close `--motion-fast`, spring ease), but scale from **center** rather than a trigger origin — the shadcn dialog's own zoom-in keyframe, just retimed.

### Navigation model

How the chat-history drawer and the workspace hub enter, shared across every chat surface via `app/src/lib/nav-transition.ts` (`getChatShellNav`):

- **`pager`** (default): chat is a center page that cross-fades + blurs (`--blur-medium`) + slides (`--distance-base`) toward the incoming menu — history is the page to the left, the hub the page to the right — so opening either reads as a symmetric page swap. Same feel family as the panel reveals.
- **`push`** (legacy): the chat shell slides aside (`translateX`) to reveal the menu; drawer/hub used different offsets, hence the uneven left/right rhythm `pager` replaces.

**Reversible:** flip `NAV_MODE_DEFAULT` in `nav-transition.ts` to revert globally, or override per-session with no redeploy via `?nav=push` / `?nav=pager` in the URL, or `localStorage['push:navMode']`. Push mode reproduces the legacy parallax exactly. Reduced motion is handled by the global `index.css` wildcard.

### Interaction Patterns

- **Spring press:** Scale to 0.97 on `:active`, `--motion-fast`
- **Card hover:** 1px upward translate with shadow transition
- **Stagger in:** List items fade-in-up with 40ms stagger delay
- **Expand/collapse:** ScaleY 0.96 to 1 with opacity
- **Panel reveal:** Y-slide + fade + cross-blur on `--panel-*`; shared by sheets and `.panel-reveal` (see above)
- Reduced motion is respected via `prefers-reduced-motion`

**Hover-reveal → long-press on touch.** A secondary control that appears on **hover** on pointer devices reveals on **long-press** on touch — via `useLongPress` (`app/src/hooks/useLongPress.ts`, 400ms; touch-only; aborts on any pointer-move so a scroll that starts on the trigger never fires it). Keep `group-hover` / `group-focus-within` for pointer + keyboard and add a `revealed` state for touch. Precedent: the message action row (`MessageBubble`), the branch-picker Delete (`DrawerBranchListItem`), the `Tip` tooltip.

It is **not** a blanket "every hover becomes long-press." Use it only when hover *reveals a hidden secondary control*. It bites when:

- **Native long-press is already taken** — selectable text, links, images, draggable/reorderable rows already use press-and-hold (select, link menu, save, drag). Don't put the trigger *on* that content; put it on the chrome and **swallow the trailing click** (`consumeClick` / an `onClickCapture` guard) so the release doesn't also fire what's under the finger.
- **The control is primary, not secondary** — long-press has no affordance and isn't discoverable. A primary/important action stays *visible* on mobile; never hover-only-and-therefore-long-press-only.
- **The hover was for scanning** — tooltips you skim, row previews you glance at. Hover sweeps many; long-press is one deliberate gesture each. Show it on mobile or pick another pattern.
- **The hover was passive feedback** — lift, highlight, cursor cue. Ambient state, not a hidden control; nothing to reveal.

Two requirements or it breaks (both learned the hard way): **`pointer-events-none` while hidden** — `opacity-0` still receives taps, so an invisible row fires its buttons on a blind tap; gate pointer-events with opacity (`pointer-events-auto` only when revealed). And keep a **`group-focus-within`** path for keyboard.

### Animation Classes

Named keyframe animations in `app/src/index.css`. Consume the class directly — don't re-declare keyframes in components. All respect `prefers-reduced-motion`.

| Class | Keyframes | Timing | Use |
| ----- | --------- | ------ | --- |
| `.status-verb-swap` | `status-verb-swap-in`: enter from 0.4em below, 3px blur clearing to 0 | 0.42s `--ease-default` | AgentStatusBar verb / phase-label rotation. Enter-only — fires once per mount via a React `key` on the label span (same pattern as `stream-word`). |
| `.status-verb-shimmer` | `verb-shimmer`: a transparent→`push-fg`→transparent band swept across the glyphs via `background-position` (clipped to text by a `::before` `attr(data-text)` duplicate) | 2.4s `linear` infinite | Layered on `status-verb-swap` while AgentStatusBar rotates themed thinking-verbs (not phase labels). Continuous light sweep; `data-text` mirrors the visible label. Two-layer text-shimmer recipe (after transitions.dev). Removed (not frozen) under reduced motion. |
| `.verdict-safe-icon`, `.commit-landed-icon` | `success-pop` (scale 0.4 → 1.18 → 1) + `success-glow` (green drop-shadow bloom → settle) | pop 0.5s `--ease-spring`; glow 0.9s `--ease-default` 0.1s delay | The earned-success beat: Auditor SAFE shield and commit-landed check. Confident, not celebratory — no rotate or stroke-draw. Each consumer fires once and guards against Virtuoso scroll-remount replays. |
| `.icon-swap` | `icon-swap-in`: scale 0.55 → 1 + 2.5px blur clearing to 0 | 0.26s `--ease-spring` | Shared copy→check feedback for every copy-to-clipboard button (MessageBubble, HubConsoleTab, HubKeptTab, SandboxCard). On the *incoming* icon only; the swapped-in state inits false so it fires once per click, never on mount/remount. Pair the check with `text-push-status-success`. |
| `.error-shake` | `error-shake`: translateX 0 → `--distance-small` → −`--distance-small` → `--distance-micro` (overshoot) → 0 | `--motion-normal` `--ease-spring` | Flag an invalid value (transitions.dev `12`). Add the class after a reflow to replay; drop it on `animationend`. |
| `.digit-pop-in` | `digit-pop-in`: rise `--distance-base` + fade + unblur `--blur-small` | `--motion-slowest` `--ease-press` | Number / counter pop-in (`02`). Stagger trailing digits with `animation-delay` for a rolling counter. |
| `.success-check[data-state=in]` | parallel `success-check-` fade + rotate (80°→0) + unblur (`--blur-large`) + bob (`--distance-large`) | `--motion-slowest`; bob on `--ease-press`, rest `--ease-spring` | Richer success-glyph entrance (`10`) — the sibling of the verdict `success-pop`/`glow` beat. The drawn-checkmark stroke (SVG `path` + `getTotalLength()`) is consumer-supplied; this is the container orchestration. |

**Transition-based (not keyframe):**

- `.badge-dot` (notification badge, `03`) pops/fades/unblurs the count dot via a `data-open` toggle — `--motion-slowest` pop on `--ease-press`, snappier `--motion-fast` close on `--ease-default`. Default (attribute absent) is the visible resting state.
- `.text-swap` (text-states swap, `04`) — swap a span's text with a quick exit-up + enter-from-below (blur + fade) on `--motion-fast`. JS-driven 3-phase: add `.is-exit` → on `transitionend` swap text + `.is-enter-start` (no transition) → reflow → remove to transition in. The general swap-in-place; `status-verb-swap` is the enter-only keyed-remount variant.
- `.text-reveal` (texts reveal, `18`) — staggered line entrance: `.text-reveal-line` children rise (`--distance-medium`) + unblur (`--blur-medium`) + fade on `--motion-slowest`, staggered by `--motion-stagger`. JS toggles `.is-shown` to reveal / `.is-hiding` to fade out without reversing. The state-toggled, reversible cousin of the keyframe-on-mount `.stagger-in`.

**Structural (size / position / reveal transitions):**

- `.resize-smooth` (card resize, `01`) — eases a container's `width`/`height` to its new size instead of snapping. Pure CSS: toggle a class/attribute or set an explicit size and the transition rides the change (`--motion-slow` `--ease-spring`). Only animates between resolvable sizes — `auto`→`auto` won't transition.
- `.tab-indicator` + `.tab-trigger` (tabs sliding, `16`) — the moving pill behind a segmented control slides + resizes from the old tab to the new in one motion (`transform` + `width`, `--motion-normal` `--ease-spring`). JS measures the active tab (`offsetLeft`/`offsetWidth`) and writes the geometry; add `.is-static` (→ set → reflow → remove) to snap on first paint / resize. `.tab-trigger` cross-fades the label tint. Color-free — the consumer paints the pill and tints.
- `.skeleton-reveal` (skeleton → content, `14`) — a stacked skeleton (`absolute inset-0`, content on top) cross-fades into real content with a soft blur as data arrives. Toggle `.is-revealed` to swap `.skeleton-reveal-skeleton`/`.skeleton-reveal-content` (`--motion-slower` `--ease-default`, `--blur-small`); replay via `.is-resetting` (→ clear → reflow → remove). Optional `.skeleton-pulse` is an ambient breathing loop (literal ~1.4s like `.agent-pulse`, not a motion token).
- `.avatar-lift` (avatar group hover, `11`) — hovering an avatar in an overlapping row lifts it and nudges neighbors with distance falloff. JS writes `--avatar-shift` (Y lift) + `--avatar-scale` (hovered item only) per avatar and clears them on mouseleave; the primitive transitions independent `translate`/`scale` (`--motion-slow` `--ease-spring`) so they compose without a shared `transform`. Reduced motion drops the lift entirely.

> **Deferred (component-level, not pure CSS):** transitions.dev `13` input-clear-dissolve is driven by per-frame JS (no keyframes), and `10`'s drawn checkmark needs an SVG path calibrated via `getTotalLength()`. Both are wired up when a consumer needs them, not as standalone CSS primitives.

## Components

### Tooltips (`Tip`)

The shared "explain this control" affordance — use it instead of a native `title=` on icon buttons and terse controls. `<Tip content="…">{trigger}</Tip>` wraps the retuned Base UI tooltip (`components/ui/tooltip.tsx`): a dark raised-chrome surface (`bg-push-surface-raised` + `border-push-edge` + `shadow-push-lg`) that animates with the transitions.dev feel — scale 0.98 → 1 + fade, 150ms in / 75ms out, `ease-out`, pure scale from the popup origin (no slide). It portals out of `overflow:hidden` panels and collides at edges; `max-w` + `text-balance` let longer copy wrap.

- **Reveal (mobile-first):** hover/focus on pointer devices; **long-press** (~400ms) on touch, since hover doesn't exist there. `open` is controlled so both paths drive it; a move/lift before the hold completes aborts. The press-and-hold detection is the shared `useLongPress` hook (`hooks/useLongPress.ts`) — also used by the workspace branch picker, where long-press / hover **reveals a collapsed Delete** (one tap to delete; `consumeClick` keeps the reveal-press from also switching branches).
- Keep an **`aria-label`** on icon-only triggers — the tooltip primitive supplies `aria-describedby` (the description), not the accessible *name*.
- Long-press is a progressive enhancement: on touch the subsequent tap still fires the control, so be deliberate on destructive triggers.

### Buttons

- Border radius: `rounded-md` (8px)
- Default height: `h-9`, padding `px-4 py-2`
- Small: `h-8 px-3`, Large: `h-10 px-6`
- Icon-only: `size-9`, Icon-only-sm: `size-8`, Icon-only-lg: `size-10`
- `default` variant is a **tinted outline** (`border-push-accent/40 bg-push-accent/10 text-push-accent`) — no solid Sky fills; use it for the primary action
- Focus: 3px ring with `ring-ring/50` (light Sky)

### Inputs

- Height: `h-9`, padding `px-3 py-1`
- Background: semi-transparent `bg-input/30`
- Border: `border-input`, focus adds 3px ring
- Placeholder text: `text-muted-foreground`
- **Recessed:** the hub inline input (`HUB_MATERIAL_INPUT_CLASS`) carries `shadow-push-inset` — a field reads as carved into the surface, the recessed half of the neumorphic pair (buttons lift, inputs sink). The shadcn `Input` / `Textarea` primitives keep their `shadow-xs` default: they're composed inside dialogs/sheets that already supply elevation, and several wrappers (`InputGroupInput`, `SidebarInput`) pass `shadow-none` to opt out — baking an inset into the primitive would override that opt-out and stack a competing depth inside an already-elevated shell.

### Cards

- Background: `bg-card`, radius `rounded-xl` (14px)
- Padding: `py-6`, content `px-6`
- Shadow: `shadow-sm`
- **Flat by design** — dense content cards rely on border + background contrast, *not* neumorphic depth. The raised/inset tokens are for chrome and recessed wells; extruding content cards would fight legibility and density.

### Badges

- Fully rounded: `rounded-full`
- Padding: `px-2 py-0.5`
- Font: `text-xs`

### Dialogs

- Overlay: `bg-black/50`, fixed z-50
- Max width: `sm:max-w-lg`
- Padding: `p-6`, gap `gap-4`
- Animates with fade + zoom

### Scrollbars

- Width: 4px
- Track: transparent
- Thumb: `#1f2531`, hover `#2f3949`, radius 2px

## Composition layer

The tables above are the **token** layer. The components in `components/ui/` are the **primitive** layer (shadcn-style wrappers on Base UI — the vendored layer Push composes around, not restyled per-use). Sitting between them is the **composition** layer — the actual Push visual language. It comes in two pieces.

### Hub utility classes — `app/src/components/chat/hub-styles.tsx`

Neumorphic chrome: pill buttons, solid panels, 1px borders. These are the visual identity most surfaces already use (HomeScreen, OnboardingScreen, ChatScreen, ChatSurfaceScreen, LauncherHomeContent). Compose them with token classes for color and size; the hub class supplies the surface — a solid step over the canvas with a clean border and **dark-neumorphic depth**: buttons/panels carry `shadow-push-raised` (a soft drop + lit top edge), buttons press in on `:active`, and `HUB_MATERIAL_INPUT_CLASS` recesses with `shadow-push-inset`. Still **no `backdrop-blur`** (that stays the glass exception below). The base surface class is depth-free so each consumer opts into raise *or* recess (two `shadow-*` on one element collide). See Shadows → Neumorphic depth.

| Class                              | Shape                                                 | Use                                                       |
| ---------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| `HUB_MATERIAL_BUTTON_CLASS`        | Raised surface (`shadow-push-raised`) + border + hover lift + press-to-recess | Default button surface — wrap with size/layout            |
| `HUB_MATERIAL_PILL_BUTTON_CLASS`   | `h-8 rounded-full px-3 text-push-xs`                  | Inline pill action (header chips, mode pickers)           |
| `HUB_MATERIAL_ROUND_BUTTON_CLASS`  | `h-8 w-8 rounded-full`                                | Icon-only header actions (back, settings, menu)           |
| `HUB_MATERIAL_INPUT_CLASS`         | `h-8 rounded-full px-3 text-xs` + recessed (`shadow-push-inset`) | Inline input — auth forms, pairing forms                  |
| `HUB_PANEL_SURFACE_CLASS`          | `rounded-[20px]` raised panel (`bg-push-surface-raised` + `shadow-push-raised`) + border | Top-level panel containing a form / section group         |
| `HUB_PANEL_SUBTLE_SURFACE_CLASS`   | `rounded-[18px]` recessed inset panel (`bg-push-surface-inset` + `shadow-push-inset`) + border | Nested panel inside a HUB_PANEL                           |
| `HUB_TOP_BANNER_STRIP_CLASS`       | Animated full-width banner strip                      | Top-of-page status (sandbox state, missing AGENTS.md)     |
| `HUB_TAG_CLASS`                    | Rounded-full, uppercase mono, `tracking-[0.16em]`     | Inline metadata tag (`RECOMMENDED`, `EXPERIMENTAL`)       |
| `HEADER_ROUND_BUTTON_CLASS`        | `h-9 w-9` plain interactive (no surface)              | Chat app-bar icon buttons (palette, dock, web search)     |
| `HEADER_PILL_BUTTON_CLASS`         | `h-9 px-1.5` plain interactive with gap-2             | Chat app-bar pill (launcher button in the center cell)    |
| `HUB_GLASS_PANEL_CLASS`            | Translucent gradient + `backdrop-blur-2xl` + `border-white/[0.07]` frame (shadow-free; drawer shells add `shadow-push-glass` for elevation + frosted edge) | Menu shell — `<SheetContent>` of the Chats drawer / Workspace hub (caller adds the side: `border-l`/`-r`/`-t`) |
| `HUB_GLASS_HAIRLINE`               | `border-white/[0.06]`                                | Soft dividers inside a glass menu (header / strip / seam) and resting tile outlines |
| `GLASS_SURFACE` / `…_HOVER`        | `border-white/[0.06] bg-white/[0.02]` + hover lift   | Resting bordered tile — Chats-drawer repo & section cards                        |
| `GLASS_ACTIVE_CLASS`               | Accent tint + ring + soft glow (`--push-accent-rgb`) | Active/selected tile — live repo card, live workspace tool tab                   |
| `GLASS_FILL_*` (FAINT / SOFT)      | Borderless `bg-white` `0.02` / `0.05`, resting + `hover:` forms | Fill-only surfaces — drawer footer, workspace tool tabs, Review segmented pills |
| `HUB_GLASS_STRIP_CLASS`            | `border-b` hairline + `bg-white/[0.02]`              | Status / lifecycle strips inside a glass menu                                    |
| `GLASS_GHOST_BUTTON_CLASS`         | Borderless icon action + hover wash                  | Quiet in-menu icon action (e.g. per-repo customize)                             |

The `HUB_GLASS_*` / `GLASS_*` classes are the **one** sanctioned exception to flat chrome: a top-level sliding menu is the seam where the panel meets the live app it slid over, so it stays true glass (translucent + blur) and the chat surface's Sky ambient frosts through its edges instead of reading as a separate black slab. The glass identity reaches past the shell to a **small, tight scale** of tinted surfaces built on it — strips, the drawer's repo/section cards, the workspace tool tabs, and the Review segmented pills — defined once in `hub-styles.tsx` (five alpha steps: `0.02` fill, `0.05` soft/hover fill, `0.06` hairline, `0.07` shell frame, `0.09` hover edge). Bordered tiles use `GLASS_SURFACE`; fill-only surfaces (tabs, pills, footer) compose the borderless `GLASS_FILL_*` tokens — both draw from the same two fill steps, so a quiet inactive tab and a selected pill can't drift onto an undocumented opacity. What stays flat is the **dense content** *inside* a menu — settings forms, inputs, and data/diff cards — where the solid raised `HUB_MATERIAL_*` / `HUB_PANEL_*` step out-reads a translucent tint. Rule of thumb: navigation/structure surfaces in a glass menu take the glass scale; content surfaces stay flat. Don't hand-roll a fresh `white/[x]` for a menu surface — compose the named scale so the tints can't drift.

Hub button height is `h-8`, not `h-9` — pill rhythm differs from the shadcn `h-9` baseline by design. The `HEADER_*` chat app-bar buttons are `h-9` because they sit on the page surface (`bg-push-surface-inset`), not on a raised hub panel; they're plain interactive — no border, no surface — and only color-shift on hover. For full-width form CTAs that need more presence, use `${HUB_MATERIAL_BUTTON_CLASS} h-9 px-4 rounded-md` (the surface treatment composes onto the standard button shape).

### Layout primitives — `app/src/components/layout/`

| Component       | Shape                                                                 |
| --------------- | --------------------------------------------------------------------- |
| `<PageScaffold>`| Page wrapper: dark gradient bg, safe-area insets, `width` prop maps to `max-w-sm \| max-w-md \| max-w-2xl \| full` |
| `<HeaderBar>`   | 3-col grid top bar: `back` (HUB_MATERIAL_ROUND_BUTTON), `title`/`subtitle`, `actions` slot. Padding `px-3 pt-3 pb-2`; height follows content (≈ 56px when back/actions slots carry the standard `h-9` button). |
| `<StatusBanner>`| `variant: 'info' \| 'warning' \| 'error' \| 'success'` using `push-status-*` tokens. Replaces ad-hoc `border-rose-400/40` / `text-destructive` patterns |
| `<SectionCard>` | `HUB_PANEL_SURFACE_CLASS` wrapper with `p-4 space-y-3` and optional `title` / `description` slots |

A new top-level surface (full-screen pairing flow, settings sub-page, onboarding step) should be `<PageScaffold header={<HeaderBar … />}>…</PageScaffold>` rather than an ad-hoc `<div className="min-h-dvh …">`. The primitives own the gradient background, the safe-area math, and the back-button shape so screens don't each reinvent them.

### When to reach for which

- **Navigation chrome** (back-button top bars on pairing / settings / sub-page screens): use `<HeaderBar>` + `<PageScaffold>`. Three roles per slot: `back` / `title` / `actions`.
- **Chat app bar** (`ChatScreen`, `ChatSurfaceScreen`): use the `HEADER_*` classes directly with an inline 3-region grid. Each cell holds interactive content, not a passive title — `HeaderBar` would have to be contorted to fit, so it deliberately doesn't try. The bar is **flat**: no fill, border, shadow, or gradient seam of its own — it sits directly on `bg-push-surface-inset` and blends seamlessly into the content below (the old `from-black` fade strip under the bar was removed as out-of-place depth). Separation comes from spacing and the ambient glow wash, not elevation.
- **Chrome** (header pills, account buttons, mode chips, page wrappers): use HUB classes + layout primitives. This is the dominant Push aesthetic.
- **Inside content cards** (chat bubbles, file diffs, code blocks): use token classes directly. The HUB material adds the raised-surface + border treatment that navigation chrome wants; content cards define themselves with `bg-push-grad-card` + a `border-push-edge` and don't need it.
- **Inside `<Dialog>` / `<Sheet>` forms**: shadcn `Button` and `Input` from `components/ui/` are fine. Dialogs already carry their own overlay + surface; stacking hub material on top reads as heavy.

## Icons

Two systems. **Lucide React** (`lucide-react`) is the general-purpose workhorse — default size `size-4` (16px); common sizes `size-3` (12px), `size-3.5` (14px), `size-4` (16px), `size-8` (32px).

The **Push custom pack** (`app/src/components/icons/push-custom-icons.tsx`, with SVG exports under `app/src/assets/icons/push-pack-v1/`) is the brand expression: 24px viewBox, stroke 2, round caps + joins, `stroke="currentColor"` so each picks up text + status color. When a concept maps to a custom icon (branch, commit, diff, sandbox, review, a repo type, a model capability…), use it; Lucide is the fallback. The per-icon **"when to use" map lives in that file's header comment** — keep it there, next to the definitions, not copied here.

No emoji in chrome; status uses colored dot indicators + iconography, never glyphs.

## Layout

- **Mobile-first** with standard Tailwind breakpoints
- **Safe areas:** Supports `env(safe-area-inset-top/bottom)` and `env(keyboard-inset-height)` for PWA
- **Flex-based** layouts throughout; no CSS Grid for page structure
- **Container queries** used for responsive card headers

## Do's and Don'ts

- Do use the `push-accent` Sky sparingly — only for the primary action or active state
- Do keep text at `push-base` (13px) for body content; smaller sizes are for labels only
- Do use the gradient backgrounds (`bg-push-grad-card`, `bg-push-grad-panel`) for layered surfaces instead of flat colors
- Do respect `prefers-reduced-motion`
- Don't mix rounded and sharp corners in the same view
- Do reach for the neumorphic depth tokens (`shadow-push-raised` / `shadow-push-inset`) only on **chrome** (buttons, pills, panels) and **recessed wells** (inputs, console). Keep dense **content** cards flat — distinguish those layers with border + background contrast, not depth
- Don't compose two `shadow-*` utilities on one element (e.g. raised + inset) — they collide on source order. Pick one per surface; use `:active` to swap raised → inset for a press
- Don't introduce light-mode colors; the app is dark-only
- Don't hardcode colors — use the token classes with Tailwind prefixes: `text-push-fg`, `bg-push-surface`, `border-push-edge`, etc.
- Don't use shadcn `Button` from `components/ui/button.tsx` for chrome — its `default` variant is now the Sky tinted-outline treatment (flat, on-accent), but chrome surfaces want the hub material (solid raised surface + border), so reach for `HUB_MATERIAL_BUTTON_CLASS` (or `HUB_MATERIAL_PILL_BUTTON_CLASS` for inline pills). The shadcn Button is fine **inside** `<Dialog>` / `<Sheet>` forms — see the composition layer notes above.
- Don't invent a new page wrapper with `min-h-dvh bg-[linear-gradient(...)]`. Use `<PageScaffold>` — it owns the gradient, the safe-area insets, and the max-width rhythm so all surfaces share them.
- Don't invent per-screen error/warning chrome (`text-rose-200`, `text-destructive`, `bg-amber-500/15`). Use `<StatusBanner>` — one of `variant="info"`, `variant="warning"`, `variant="error"`, or `variant="success"` — so status colors live in one place.

## Shipping visual changes

Visual changes reach installed PWAs automatically: the service-worker cache name (`app/public/sw.js`) is stamped per build with the git short SHA by `stampServiceWorkerCache()` in `app/vite.config.ts`, so every deploy purges stale caches. No manual cache bump is needed. New colors must still be added to `tailwind.config.js` + the token tables above (the `check:design-tokens` ratchet guards against new hardcoded hex).
