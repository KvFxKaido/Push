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

Two distinct shadow families, kept separate on purpose:

1. **Overlay shadows** (`push-sm` … `push-xl`, `push-card*`) float dialogs, popovers, dropdowns and floating cards *off the page*. They are not used to distinguish in-page surface layers.
2. **Neumorphic depth** (`push-inset*`, `push-raised*`, `push-glass-edge`) gives chrome and recessed surfaces tactile relief on the near-black canvas. This is the **surgical dark-neumorphism layer**: raised chrome lifts with a lit top edge and presses in on `:active`; inputs and other recessed wells sink with an inset; the glass shell catches an edge highlight. All depth shadows are **grayscale** (black ambient + a faint white sheen) so they read on `#070a10` without introducing a hue.

Surface hierarchy for **dense content** (chat bubbles, diff/code cards, data tables) still comes from border + background contrast — those surfaces stay flat. Depth is reserved for *chrome* (buttons, pills, panels) and *recessed wells* (inputs, the console log, nested inset panels). The split is the whole point: extruded chrome around flat, legible content.

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
| `push-inset`         | Inset top shadow + faint inner ring                             | Recessed wells — inputs, console body, nested panels |
| `push-inset-strong`  | Deeper inset                                                    | Emphasized recess (reserved; deeper wells)           |
| `push-glass-edge`    | Lit top inner edge + soft dark bottom inner edge               | The glass menu shell (frosted-pane edge)             |

Buttons press in on `:active` by swapping `shadow-push-raised` → `shadow-push-inset` (wired into `HUB_MATERIAL_INTERACTIVE_CLASS`). Don't compose two `shadow-*` utilities on one element — they collide on source order; pick raised **or** inset per surface. Raw shadow values live once in `tailwind.config.js`; consume the `shadow-push-*` token classes, never inline rgba.

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

### Animation Classes

Named keyframe animations in `app/src/index.css`. Consume the class directly — don't re-declare keyframes in components. All respect `prefers-reduced-motion`.

| Class | Keyframes | Timing | Use |
| ----- | --------- | ------ | --- |
| `.status-verb-swap` | `status-verb-swap-in`: enter from 0.4em below, 3px blur clearing to 0 | 0.42s `--ease-default` | AgentStatusBar verb / phase-label rotation. Enter-only — fires once per mount via a React `key` on the label span (same pattern as `stream-word`). |
| `.verdict-safe-icon`, `.commit-landed-icon` | `success-pop` (scale 0.4 → 1.18 → 1) + `success-glow` (green drop-shadow bloom → settle) | pop 0.5s `--ease-spring`; glow 0.9s `--ease-default` 0.1s delay | The earned-success beat: Auditor SAFE shield and commit-landed check. Confident, not celebratory — no rotate or stroke-draw. Each consumer fires once and guards against Virtuoso scroll-remount replays. |

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
- **Recessed:** the shadcn `Input` / `Textarea` carry `shadow-push-inset`, and the hub inline input (`HUB_MATERIAL_INPUT_CLASS`) does too — a field reads as carved into the surface. This is the recessed half of the neumorphic pair (buttons lift, inputs sink).

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

The tables above are the **token** layer. The components in `components/ui/` are the **primitive** layer (shadcn, intentionally untouched). Sitting between them is the **composition** layer — the actual Push visual language. It comes in two pieces.

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
| `HUB_GLASS_PANEL_CLASS`            | Translucent gradient + `backdrop-blur-2xl` + `border-white/[0.07]` frame + frosted edge (`shadow-push-glass-edge`) | Menu shell — `<SheetContent>` of the Chats drawer / Workspace hub (caller adds the side: `border-l`/`-r`/`-t`) |
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
- Do reach for the neumorphic depth tokens (`shadow-push-raised` / `shadow-push-inset`) only on **chrome** (buttons, pills, panels) and **recessed wells** (inputs, console). Keep dense **content** cards flat — distinguish those layers with border + background contrast, not depth
- Don't compose two `shadow-*` utilities on one element (e.g. raised + inset) — they collide on source order. Pick one per surface; use `:active` to swap raised → inset for a press
- Don't introduce light-mode colors; the app is dark-only
- Don't hardcode colors — use the token classes with Tailwind prefixes: `text-push-fg`, `bg-push-surface`, `border-push-edge`, etc.
- Don't use shadcn `Button` from `components/ui/button.tsx` for chrome — its `default` variant is now the Sky tinted-outline treatment (flat, on-accent), but chrome surfaces want the hub material (solid raised surface + border), so reach for `HUB_MATERIAL_BUTTON_CLASS` (or `HUB_MATERIAL_PILL_BUTTON_CLASS` for inline pills). The shadcn Button is fine **inside** `<Dialog>` / `<Sheet>` forms — see the composition layer notes above.
- Don't invent a new page wrapper with `min-h-dvh bg-[linear-gradient(...)]`. Use `<PageScaffold>` — it owns the gradient, the safe-area insets, and the max-width rhythm so all surfaces share them.
- Don't invent per-screen error/warning chrome (`text-rose-200`, `text-destructive`, `bg-amber-500/15`). Use `<StatusBanner>` — one of `variant="info"`, `variant="warning"`, `variant="error"`, or `variant="success"` — so status colors live in one place.

## Shipping visual changes

Visual changes reach installed PWAs automatically: the service-worker cache name (`app/public/sw.js`) is stamped per build with the git short SHA by `stampServiceWorkerCache()` in `app/vite.config.ts`, so every deploy purges stale caches. No manual cache bump is needed. New colors must still be added to `tailwind.config.js` + the token tables above (the `check:design-tokens` ratchet guards against new hardcoded hex).
