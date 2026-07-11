# Mobile-Feel Spec Map — Material 3 + Apple HIG → Push

Date: 2026-07-11
Status: **Reference** — a sourced spec map, not a decision. Seeds the eventual
Push component-library work. Owner: Push design.

## Purpose

Push is heading toward its **own component library** — owning the *expression*
layer (composition, tokens, motion, touch feel) on a borrowed *behavior* engine
(Base UI today; see [`ARCHITECTURE.md`](../../ARCHITECTURE.md) and the
`components/ui/` seam that survived the Radix→Base UI swap in #1411). This doc captures what the two
dominant mobile design systems actually specify, mapped against Push's existing
`push-*` tokens, tagged for what to steal vs leave.

**The two-source thesis:** Material 3 is the *ergonomic* half (systematic
mechanics — state layers, spring taxonomy, touch rigor). Apple HIG is the
*philosophical* half (restraint, subtle feedback, signatures — haptics,
materials, continuous corners). Apple's "defer to content, no decoration" ethos
is far closer to Push's calm/honest/high-density identity than M3's
expressiveness. **Steal M3's mechanics with Apple's temperament.**

---

## Durations — Push is already M3-grade

M3's scale is 16 tokens on a 50ms grid; Push curated 7. Five land exactly on M3
tokens:

| Push | ms | M3 token |
|---|---|---|
| `--motion-fast` | 150 | short3 |
| `--motion-normal` | 250 | medium1 |
| `--motion-slow` | 350 | medium3 |
| `--motion-slower` | 400 | medium4 |
| `--motion-slowest` | 500 | long2 |

`--motion-micro` (80) / `--motion-stagger` (40) sit below short1. **Verdict:
nothing to steal — the curation *is* M3's grid minus the bloat.**

## Easing — one legacy curve

- M3 **standard** = `cubic-bezier(0.2, 0, 0, 1)`; **emphasized-decelerate** =
  `cubic-bezier(0.05, 0.7, 0.1, 1)`; **emphasized-accelerate** =
  `cubic-bezier(0.3, 0, 0.8, 0.15)`; emphasized itself is a two-part path.
- Push `--ease-default` = `cubic-bezier(0.4, 0, 0.2, 1)` — this is **Material
  *2*'s** standard curve, not M3's. `--ease-spring` (0.16,1,0.3,1) is a pure
  decelerate; `--ease-press` (0.34,1.56,0.64,1) overshoots.

**Verdict:** optional retune `--ease-default` → `(0.2, 0, 0, 1)` for the crisper
M3 feel. Spring/press already own the decel + overshoot roles.

## State layers — GRAFTED ✅

M3 spec (Compose Material3 `StateTokens`): a semi-transparent overlay in the
content's own color — **hover 0.08 · focus 0.10 · pressed 0.10 · dragged 0.16**,
additive when states stack. *(Older M3 drafts list focus at 0.12; current is
0.10.)*

Push had **no** state-layer system: chrome presses via the neumorphic
shadow-swap (`raised → inset`, correct — leave it), but flat dense surfaces
(menu rows, list rows, action rows) improvised ad-hoc `hover:bg-*`.

**Shipped:** `--state-hover/focus/pressed/dragged` tokens + a `.state-layer`
utility (`app/src/index.css`), documented in `DESIGN.md` → "State layers". A
`currentColor` veil via `color-mix`, hover gated to pointer devices. Introduced
as a primitive; adopted per-consumer as flat surfaces need it (Base UI menu
items keep `data-highlighted`).

## Touch targets — GRAFTED ✅

- Apple: **44×44pt** min. M3: **48×48dp** min; glyph may shrink to 24dp with
  transparent padding out to 48; **8dp** min separation.
- **Shipped:** the 48px-minimum rule (larger of the two; shell is Android) is
  documented in `DESIGN.md` → "Touch targets". Enforcement is by-convention for
  now — a lint/`check:design-tokens` rule is a candidate follow-up.

## Springs — steal the split & the authoring model

- M3 Expressive splits **spatial** (position/size — *may* overshoot) from
  **effects** (color/opacity — *never* overshoot). Spatial CSS approximations:
  fast `0.35s (0.42,1.67,0.21,0.9)`, default `0.5s (0.38,1.21,0.22,1)`, slow
  `0.65s (0.39,1.29,0.35,0.98)`.
- Apple parametrizes by **response** (duration) + **bounce**: `.smooth` =
  `spring(duration: 0.5, bounce: 0)`, `.snappy` = `bounce: 0.15`, `.bouncy` =
  `bounce: 0.3`; default `spring()` ≈ response 0.55 / dampingFraction 0.825.

**Verdict (for the library, not yet grafted):** name motion tokens by **bounce**
(Apple's legible model) and honor the spatial/effects split — **bounce 0 for
opacity/color, bounce > 0 only for position/size.** Reconciles both systems over
one physics.

## Haptics — vocabulary GRAFTED ✅, wiring is deliberate follow-up

Apple's three families: **impact** (Light/Medium/Heavy), **selection** (the
value-changed tick), **notification** (Success/Warning/Error). Push shipped
`@capacitor/haptics` wired as impact-only (Light/Medium).

**Shipped:** `app/src/lib/android/haptics.ts` extended to the full vocabulary —
`hapticHeavy`, `hapticSelection`, `hapticSuccess`/`Warning`/`Error`. Wiring each
into call sites is a **feel decision left to the designer**, not sprayed. The
existing `hapticMedium()` on branch-switch is a deliberate "committed context
change" choice — left as-is.

Recommended semantic wiring (checklist, not yet done):

| Gesture / outcome | Family | Helper |
|---|---|---|
| Toggle / segmented / tab / picker value change | selection | `hapticSelection()` |
| Commit or push succeeded | notification | `hapticSuccess()` |
| Auditor gate flagged / soft-fail | notification | `hapticWarning()` |
| Push rejected / required gate unrunnable | notification | `hapticError()` |

## Materials & corners — Apple signatures, filed for later

- **Materials:** Apple's ultraThin → thin → regular → thick + vibrancy. Push has
  ~one glass treatment (`push-glass`, `HUB_GLASS_PANEL_CLASS`). Reference for a
  small material scale *if* glass proliferates — but dark-only near-black
  (`#070a10`) muddies fast, so graft with restraint.
- **Continuous corners (squircle):** iOS corners are superellipses — a real part
  of why iOS "feels smoother." Push uses standard `border-radius`. Native CSS
  (`corner-shape: superellipse()`) is only just arriving (~2025). A
  maturity-polish detail, not a now-thing.

## What to leave

M3's loud aesthetic (bold color, ripples, roundness, low density, filled
buttons), M3 dynamic/wallpaper color, 9 of 16 duration tokens; Apple's iOS chrome
(nav/tab bar styling), SF Pro (Push is IBM Plex Sans), the light-mode-first
material look. Push's neumorphic chrome press beats an overlay for chrome —
state layers are for flat surfaces only.

## Strength map

| Layer | Source | Status |
|---|---|---|
| Behavior / a11y | Base UI | owned seam (#1411) |
| Timing grid | *already M3* | keep 7 curated durations |
| Visual state feedback | M3 state layers | **grafted** |
| Tactile state feedback | Apple haptics | **vocabulary grafted**, wiring TODO |
| Touch targets | M3 / Apple | **grafted** (48px, by-convention) |
| Motion authoring | Apple response+bounce | design note (not built) |
| Materials | Apple scale | filed |
| Corners | Apple continuous | filed |
| Sensibility | Apple restraint | validates "calm over cute" |

M3 = the mechanics · Apple = the taste · Base UI = the engine · **Push = the
editor that picks.**

## Sources

- [M3 Motion](https://m3.material.io/styles/motion/) ·
  [Motion tokens (MDC-Android)](https://github.com/material-components/material-components-android/blob/master/docs/theming/Motion.md) ·
  [M3 State layers](https://m3.material.io/foundations/interaction/states/state-layers) ·
  [Android touch-target size](https://support.google.com/accessibility/android/answer/7101858)
- [Apple HIG](https://developer.apple.com/design/human-interface-guidelines) ·
  [HIG: Playing haptics](https://developer.apple.com/design/human-interface-guidelines/playing-haptics) ·
  [SwiftUI spring presets (GetStream)](https://github.com/GetStream/swiftui-spring-animations) ·
  [Capacitor Haptics](https://capacitorjs.com/docs/apis/haptics)
