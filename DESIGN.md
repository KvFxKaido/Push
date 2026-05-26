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
| `push-surface-raised` | `#0c1018` | Elevated panels, cards       |
| `push-surface-hover`  | `#0d1119` | Hover background             |
| `push-surface-active` | `#111624` | Pressed state, badge fills   |
| `push-surface-inset`  | `#05080e` | Recessed areas (editor, inputs) |

### Borders

| Token              | Hex       | Use                          |
| ------------------ | --------- | ---------------------------- |
| `push-edge-subtle` | `#1b2230` | Dividers, input borders      |
| `push-edge`        | `#1f2531` | Primary border               |
| `push-edge-hover`  | `#2f3949` | Hover border                 |
| `push-edge-focus`  | `#3d5579` | Focus / active input border  |

### Accent & Interactive

| Token        | Hex       | Use                              |
| ------------ | --------- | -------------------------------- |
| `push-accent`| `#0070f3` | Primary blue, CTAs, glow         |
| `push-sky`   | `#38bdf8` | Focus rings, cyan highlights     |
| `push-link`  | `#5cb7ff` | Links, interactive text actions  |
| `push-link-hover` | `#86ccff` | Brighter link color on hover |
| `push-violet`| `#c4b5fd` | Chat / conversation accent       |

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

- **Card:** `linear-gradient(180deg, #090d14 0%, #06090f 100%)`
- **Panel:** `linear-gradient(180deg, #05070b 0%, #020306 100%)`
- **Input:** `linear-gradient(180deg, #0a0d13 0%, #04060a 100%)`
- **User bubble:** border `#313b49`, fill `linear-gradient(180deg, #1e2733 0%, #17202b 100%)`

### Repo Theme Accent (dynamic override)

Applied via `data-repo-theme='active'` on `:root`. Default values:

- Accent: `#58a6ff`
- Soft: `rgba(88, 166, 255, 0.1)`
- Border: `rgba(88, 166, 255, 0.38)`
- Glow: `rgba(88, 166, 255, 0.45)`

## Typography

### Font Stacks

- **Sans:** `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`
- **Mono:** `'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace`

JetBrains Mono is loaded via Google Fonts at weights 400, 500, 600.

### Scale

| Token       | Size | Line Height | Use                    |
| ----------- | ---- | ----------- | ---------------------- |
| `push-2xs`  | 10px | 14px        | Micro labels, badges   |
| `push-xs`   | 11px | 16px        | Labels, timestamps     |
| `push-sm`   | 12px | 16px        | Secondary body text    |
| `push-base` | 13px | 18px        | Primary body text      |
| `push-lg`   | 15px | 20px        | Section headings       |

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
- Primary fills with `push-accent` blue; use sparingly
- Focus: 3px ring with `ring-ring/50`

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

Glassmorphic chrome: pill buttons, gradient panels, layered shadows. These are the visual identity most surfaces already use (HomeScreen, OnboardingScreen, ChatScreen, ChatSurfaceScreen, LauncherHomeContent). Compose them with token classes for color and size; the hub class supplies surface treatment.

| Class                              | Shape                                                 | Use                                                       |
| ---------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| `HUB_MATERIAL_BUTTON_CLASS`        | Glass surface + interactive hover                     | Default button surface — wrap with size/layout            |
| `HUB_MATERIAL_PILL_BUTTON_CLASS`   | `h-8 rounded-full px-3 text-push-xs`                  | Inline pill action (header chips, mode pickers)           |
| `HUB_MATERIAL_PILL_BUTTON_NO_BLUR_CLASS` | Identical look, no `backdrop-blur`              | Use when ≥10 pills render in one view (Android paint bug) |
| `HUB_MATERIAL_ROUND_BUTTON_CLASS`  | `h-8 w-8 rounded-full`                                | Icon-only header actions (back, settings, menu)           |
| `HUB_MATERIAL_INPUT_CLASS`         | `h-8 rounded-full px-3 text-xs`                       | Inline input — auth forms, pairing forms                  |
| `HUB_PANEL_SURFACE_CLASS`          | `rounded-[20px]` gradient panel, primary shadow       | Top-level panel containing a form / section group         |
| `HUB_PANEL_SUBTLE_SURFACE_CLASS`   | `rounded-[18px]` gradient panel, lighter shadow       | Nested panel inside a HUB_PANEL                           |
| `HUB_TOP_BANNER_STRIP_CLASS`       | Animated full-width banner strip                      | Top-of-page status (sandbox state, missing AGENTS.md)     |
| `HUB_TAG_CLASS`                    | Rounded-full, uppercase mono, `tracking-[0.16em]`     | Inline metadata tag (`RECOMMENDED`, `EXPERIMENTAL`)       |
| `<HubControlGlow />`               | Inner top-half highlight overlay                      | Drop inside a HUB surface for subtle gloss                |
| `HEADER_ROUND_BUTTON_CLASS`        | `h-9 w-9` plain interactive (no glass surface)        | Chat app-bar icon buttons (palette, dock, web search)     |
| `HEADER_PILL_BUTTON_CLASS`         | `h-9 px-1.5` plain interactive with gap-2             | Chat app-bar pill (launcher button in the center cell)    |

Hub button height is `h-8`, not `h-9` — pill rhythm differs from the shadcn `h-9` baseline by design. The `HEADER_*` chat app-bar buttons are `h-9` because they sit on the page surface (`bg-push-surface-inset`), not on a glass panel; they're plain interactive — no border, no shadow — and only color-shift on hover. For full-width form CTAs that need more presence, use `${HUB_MATERIAL_BUTTON_CLASS} h-9 px-4 rounded-md` (the surface treatment composes onto the standard button shape).

### Layout primitives — `app/src/components/layout/`

| Component       | Shape                                                                 |
| --------------- | --------------------------------------------------------------------- |
| `<PageScaffold>`| Page wrapper: dark gradient bg, safe-area insets, `width` prop maps to `max-w-sm \| max-w-md \| max-w-2xl \| full` |
| `<HeaderBar>`   | 3-col grid top bar: `back` (HUB_MATERIAL_ROUND_BUTTON), `title`/`subtitle`, `actions` slot. `h-12 px-3 pt-3 pb-2` |
| `<StatusBanner>`| `variant: 'info' \| 'warning' \| 'error' \| 'success'` using `push-status-*` tokens. Replaces ad-hoc `border-rose-400/40` / `text-destructive` patterns |
| `<SectionCard>` | `HUB_PANEL_SURFACE_CLASS` wrapper with `p-4 space-y-3` and optional `title` / `description` slots |

A new top-level surface (full-screen pairing flow, settings sub-page, onboarding step) should be `<PageScaffold header={<HeaderBar … />}>…</PageScaffold>` rather than an ad-hoc `<div className="min-h-dvh …">`. The primitives own the gradient background, the safe-area math, and the back-button shape so screens don't each reinvent them.

### When to reach for which

- **Navigation chrome** (back-button top bars on pairing / settings / sub-page screens): use `<HeaderBar>` + `<PageScaffold>`. Three roles per slot: `back` / `title` / `actions`.
- **Chat app bar** (`ChatScreen`, `ChatSurfaceScreen`): use the `HEADER_*` classes directly with an inline 3-region grid. Each cell holds interactive content, not a passive title — `HeaderBar` would have to be contorted to fit, so it deliberately doesn't try.
- **Chrome** (header pills, account buttons, mode chips, page wrappers): use HUB classes + layout primitives. This is the dominant Push aesthetic.
- **Inside content cards** (chat bubbles, file diffs, code blocks): use token classes directly. The HUB material is for navigation surfaces; content is flatter.
- **Inside `<Dialog>` / `<Sheet>` forms**: shadcn `Button` and `Input` from `components/ui/` are fine. Dialogs already have their own glass treatment from the overlay; double-glassing reads as muddy.

## Icons

Lucide React (`lucide-react`). Default size `size-4` (16px).

Common sizes: `size-3` (12px), `size-3.5` (14px), `size-4` (16px), `size-8` (32px).

## Layout

- **Mobile-first** with standard Tailwind breakpoints
- **Safe areas:** Supports `env(safe-area-inset-top/bottom)` and `env(keyboard-inset-height)` for PWA
- **Flex-based** layouts throughout; no CSS Grid for page structure
- **Container queries** used for responsive card headers

## Do's and Don'ts

- Do use `push-accent` blue sparingly — only for the primary action or active state
- Do keep text at `push-base` (13px) for body content; smaller sizes are for labels only
- Do use the gradient backgrounds (`bg-push-grad-card`, `bg-push-grad-panel`) for layered surfaces instead of flat colors
- Do respect `prefers-reduced-motion`
- Don't mix rounded and sharp corners in the same view
- Don't use shadows to distinguish surface layers — use border and background contrast. Shadows are reserved for floating elements (dialogs, popovers, dropdowns)
- Don't introduce light-mode colors; the app is dark-only
- Don't hardcode colors — use the token classes with Tailwind prefixes: `text-push-fg`, `bg-push-surface`, `border-push-edge`, etc.
- Don't use shadcn `Button` from `components/ui/button.tsx` for chrome — it carries `bg-primary` / `text-primary-foreground`, which is shadcn's neutral blue, not `push-accent`. Reach for `HUB_MATERIAL_BUTTON_CLASS` (or `HUB_MATERIAL_PILL_BUTTON_CLASS` for inline pills). The shadcn Button is fine **inside** `<Dialog>` / `<Sheet>` forms — see the composition layer notes above.
- Don't invent a new page wrapper with `min-h-dvh bg-[linear-gradient(...)]`. Use `<PageScaffold>` — it owns the gradient, the safe-area insets, and the max-width rhythm so all surfaces share them.
- Don't invent per-screen error/warning chrome (`text-rose-200`, `text-destructive`, `bg-amber-500/15`). Use `<StatusBanner variant="error" | "warning" | …>` so status colors live in one place.

## Shipping visual changes

Visual changes reach installed PWAs automatically: the service-worker cache name (`app/public/sw.js`) is stamped per build with the git short SHA by `stampServiceWorkerCache()` in `app/vite.config.ts`, so every deploy purges stale caches. No manual cache bump is needed. New colors must still be added to `tailwind.config.js` + the token tables above (the `check:design-tokens` ratchet guards against new hardcoded hex).
