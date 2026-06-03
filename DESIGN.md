# Design

## Overview

Dark-only, mobile-first interface for a developer productivity tool.
High information density, minimal visual noise, careful motion timing.
Built on Tailwind CSS + shadcn/ui (New York style) with Radix primitives.
This document defines the visual system for the graphical app surfaces. CLI/TUI presentation is documented separately and may follow shared semantic intent without matching these exact tokens or components.

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
| `push-surface`        | `#070a10` | Base page background         |
| `push-surface-raised` | `#14171f` | Elevated panels, cards       |
| `push-surface-hover`  | `#0d1119` | Hover background             |
| `push-surface-active` | `#111624` | Pressed state, badge fills   |
| `push-surface-inset`  | `#05080e` | Recessed areas (editor, inputs) |

### Borders

| Token              | Hex       | Use                          |
| ------------------ | --------- | ---------------------------- |
| `push-edge-subtle` | `#242c39` | Dividers, input borders      |
| `push-edge`        | `#2b3340` | Primary border               |
| `push-edge-hover`  | `#2f3949` | Hover border                 |
| `push-edge-focus`  | `#3d5579` | Focus / active input border  |

### Accent & Interactive

The accent is **Sky**, two-tier. Light Sky (`#7dd3fc`) is the airy identity color — accent text, icons, links, the ambient glow, focus rings, and tinted button fills. Deep Sky lives in the shadcn `--primary` var (`200 98% 39%` / `#0284c7`) for the few solid indicators (switch/checkbox) that need white-on-color contrast. There are **no solid Sky button fills** — the `Button` `default` variant is a tinted outline (`border-push-accent/40 bg-push-accent/10 text-push-accent`).

| Token        | Hex       | Use                              |
| ------------ | --------- | -------------------------------- |
| `push-accent`| `#7dd3fc` | Sky accent — text, icons, tinted CTAs, glow |
| `push-sky`   | `#38bdf8` | Mid sky — focus rings, highlights |
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

Shadows are used for overlays and floating elements (dialogs, popovers, dropdowns) — not for distinguishing surface layers. Surface hierarchy uses border and background contrast instead.

| Token             | Value                                                               | Use                  |
| ----------------- | ------------------------------------------------------------------- | -------------------- |
| `push-sm`         | `0 2px 8px rgba(0,0,0,0.25)`                                       | Tooltips, small pops |
| `push-md`         | `0 8px 24px rgba(0,0,0,0.35)`                                      | Dropdowns, menus     |
| `push-lg`         | `0 14px 36px rgba(0,0,0,0.45)`                                     | Dialogs, modals      |
| `push-xl`         | `0 20px 48px rgba(0,0,0,0.55)`                                     | Full-screen overlays |
| `push-card`       | `0 4px 16px rgba(0,0,0,0.3), 0 1px 4px rgba(0,0,0,0.15)`          | Floating cards       |
| `push-card-hover` | `0 8px 28px rgba(0,0,0,0.4), 0 2px 6px rgba(0,0,0,0.2)`           | Card hover lift      |

## Motion

### Duration Tokens

| Token             | Value |
| ----------------- | ----- |
| `--motion-fast`   | 150ms |
| `--motion-normal` | 250ms |
| `--motion-slow`   | 350ms |

### Easing

| Token            | Value                            |
| ---------------- | -------------------------------- |
| `--ease-spring`  | `cubic-bezier(0.16, 1, 0.3, 1)` |
| `--ease-press`   | `cubic-bezier(0.34, 1.56, 0.64, 1)` |
| `--ease-default` | `cubic-bezier(0.4, 0, 0.2, 1)`  |

### Interaction Patterns

- **Spring press:** Scale to 0.97 on `:active`, `--motion-fast`
- **Card hover:** 1px upward translate with shadow transition
- **Stagger in:** List items fade-in-up with 40ms stagger delay
- **Expand/collapse:** ScaleY 0.96 to 1 with opacity
- Reduced motion is respected via `prefers-reduced-motion`

## Components

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

### Cards

- Background: `bg-card`, radius `rounded-xl` (14px)
- Padding: `py-6`, content `px-6`
- Shadow: `shadow-sm`
- No elevation model — relies on border + background contrast

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

The tables above are the **token** layer. The components in `components/ui/` are the **primitive** layer (shadcn, intentionally untouched). Sitting between them is the **composition** layer — the actual Push visual language. It comes in two pieces.

### Hub utility classes — `app/src/components/chat/hub-styles.tsx`

Flat chrome: pill buttons, solid panels, 1px borders. These are the visual identity most surfaces already use (HomeScreen, OnboardingScreen, ChatScreen, ChatSurfaceScreen, LauncherHomeContent). Compose them with token classes for color and size; the hub class supplies the surface — a solid raised step over the canvas with a clean border, **no `backdrop-blur`, no drop shadow, no gloss**. Surface hierarchy comes from border + fill contrast (see Shadows above).

| Class                              | Shape                                                 | Use                                                       |
| ---------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| `HUB_MATERIAL_BUTTON_CLASS`        | Solid raised surface + border + interactive hover     | Default button surface — wrap with size/layout            |
| `HUB_MATERIAL_PILL_BUTTON_CLASS`   | `h-8 rounded-full px-3 text-push-xs`                  | Inline pill action (header chips, mode pickers)           |
| `HUB_MATERIAL_ROUND_BUTTON_CLASS`  | `h-8 w-8 rounded-full`                                | Icon-only header actions (back, settings, menu)           |
| `HUB_MATERIAL_INPUT_CLASS`         | `h-8 rounded-full px-3 text-xs`                       | Inline input — auth forms, pairing forms                  |
| `HUB_PANEL_SURFACE_CLASS`          | `rounded-[20px]` solid raised panel (`bg-push-surface-raised`) + border | Top-level panel containing a form / section group         |
| `HUB_PANEL_SUBTLE_SURFACE_CLASS`   | `rounded-[18px]` recessed inset panel (`bg-push-surface-inset`) + border | Nested panel inside a HUB_PANEL                           |
| `HUB_TOP_BANNER_STRIP_CLASS`       | Animated full-width banner strip                      | Top-of-page status (sandbox state, missing AGENTS.md)     |
| `HUB_TAG_CLASS`                    | Rounded-full, uppercase mono, `tracking-[0.16em]`     | Inline metadata tag (`RECOMMENDED`, `EXPERIMENTAL`)       |
| `HEADER_ROUND_BUTTON_CLASS`        | `h-9 w-9` plain interactive (no surface)              | Chat app-bar icon buttons (palette, dock, web search)     |
| `HEADER_PILL_BUTTON_CLASS`         | `h-9 px-1.5` plain interactive with gap-2             | Chat app-bar pill (launcher button in the center cell)    |

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
- **Chat app bar** (`ChatScreen`, `ChatSurfaceScreen`): use the `HEADER_*` classes directly with an inline 3-region grid. Each cell holds interactive content, not a passive title — `HeaderBar` would have to be contorted to fit, so it deliberately doesn't try.
- **Chrome** (header pills, account buttons, mode chips, page wrappers): use HUB classes + layout primitives. This is the dominant Push aesthetic.
- **Inside content cards** (chat bubbles, file diffs, code blocks): use token classes directly. The HUB material adds the raised-surface + border treatment that navigation chrome wants; content cards define themselves with `bg-push-grad-card` + a `border-push-edge` and don't need it.
- **Inside `<Dialog>` / `<Sheet>` forms**: shadcn `Button` and `Input` from `components/ui/` are fine. Dialogs already carry their own overlay + surface; stacking hub material on top reads as heavy.

## Icons

Lucide React (`lucide-react`). Default size `size-4` (16px).

Common sizes: `size-3` (12px), `size-3.5` (14px), `size-4` (16px), `size-8` (32px).

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
- Don't use shadows to distinguish surface layers — use border and background contrast. Shadows are reserved for floating elements (dialogs, popovers, dropdowns)
- Don't introduce light-mode colors; the app is dark-only
- Don't hardcode colors — use the token classes with Tailwind prefixes: `text-push-fg`, `bg-push-surface`, `border-push-edge`, etc.
- Don't use shadcn `Button` from `components/ui/button.tsx` for chrome — its `default` variant is now the Sky tinted-outline treatment (flat, on-accent), but chrome surfaces want the hub material (solid raised surface + border), so reach for `HUB_MATERIAL_BUTTON_CLASS` (or `HUB_MATERIAL_PILL_BUTTON_CLASS` for inline pills). The shadcn Button is fine **inside** `<Dialog>` / `<Sheet>` forms — see the composition layer notes above.
- Don't invent a new page wrapper with `min-h-dvh bg-[linear-gradient(...)]`. Use `<PageScaffold>` — it owns the gradient, the safe-area insets, and the max-width rhythm so all surfaces share them.
- Don't invent per-screen error/warning chrome (`text-rose-200`, `text-destructive`, `bg-amber-500/15`). Use `<StatusBanner>` — one of `variant="info"`, `variant="warning"`, `variant="error"`, or `variant="success"` — so status colors live in one place.

## Shipping visual changes

Visual changes reach installed PWAs automatically: the service-worker cache name (`app/public/sw.js`) is stamped per build with the git short SHA by `stampServiceWorkerCache()` in `app/vite.config.ts`, so every deploy purges stale caches. No manual cache bump is needed. New colors must still be added to `tailwind.config.js` + the token tables above (the `check:design-tokens` ratchet guards against new hardcoded hex).
