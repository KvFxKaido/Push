# Motion Library Assessment

Date: 2026-06-24
Status: **Reference** — recommendation is **do not adopt Motion now**;
keep the CSS-token primitive system as tier 1, and only reach for Motion at a
*specific* seam (FLIP layout or true exit animations) if and when a concrete
consumer needs it — scoped to the web surface and benched on the Android shell
first. No implementation committed. Owner: Push web.

## Context

Push just finished translating the full [transitions.dev](https://transitions.dev)
recipe set into a token-driven CSS primitive system (`app/src/index.css`,
catalogued in [`DESIGN.md`](../../DESIGN.md)): five staged PRs (#1117–#1121),
~18 recipes as documented primitives plus two reasoned deferrals. The system
runs on **zero JS animation runtime** — just `tailwindcss-animate` /
`tw-animate-css` and CSS custom properties.

[Motion](https://github.com/motiondivision/motion) (motiondivision, 32.5k★;
formerly Framer Motion — same authors as transitions.dev) is a JS animation
*runtime*: a hybrid WAAPI engine with spring physics, gestures, scroll-linked
effects, **layout animations (FLIP)**, and **exit animations (`AnimatePresence`)**.
Framework-agnostic (`motion/react`, `motion-v` for Vue, vanilla `motion`). This
doc records whether Push should adopt it, and if so, where.

## What Motion would actually buy Push

The CSS-token system already covers the *enter beats, micro-feedback, and
state-toggle reveals* well. Motion's value is concentrated in the things pure
CSS structurally cannot do — which maps almost one-to-one onto the recipes we
hand-waved or deferred:

| Capability | CSS-token status today | What Motion does |
|---|---|---|
| **Layout / FLIP** (`01` card-resize, `16` tab-sliding) | `.resize-smooth` only animates between *resolvable* sizes; `.tab-indicator` needs the consumer to measure `offsetLeft`/`offsetWidth` and write geometry by hand | The `layout` prop measures before/after geometry and tweens the delta automatically — `auto`→`auto` resizes and indicator slides "for free", no manual measurement |
| **Exit animations** | All our exit beats are one-shot or instant-unmount; React unmounts before a CSS exit can run without `forceMount` plumbing | `AnimatePresence` holds the node through its exit, then unmounts — real symmetric enter/exit |
| **Spring physics** (`11` avatar falloff) | `.avatar-lift` uses a fixed cubic-bezier + JS-written per-item vars | Real springs with velocity/stiffness; interruptible mid-flight |
| **Per-frame / gesture** (`13` input-clear-dissolve, drag, scroll-linked) | Deferred — needs per-frame JS we chose not to hand-roll | Native gesture + scroll APIs, `useScroll`/`useSpring` |

So Motion isn't a competitor to the CSS tokens — it's the **tier-2 engine** for
the ~4 places CSS bottoms out. If we ever adopt it, the shape is two-tier:
**CSS tokens for everything declarative and cheap; Motion only where layout,
exit, gesture, or interruptible springs are genuinely required.**

## The costs (why "not now")

1. **It breaks a deliberate zero-runtime stance.** Today there is *no* JS
   animation library in the tree. Adding one is a one-way door for bundle and
   for contributor mental model — "is this a CSS primitive or a Motion
   component?" becomes a question on every animation PR. The two-tier rule above
   only works if it's documented and enforced; ungoverned, Motion tends to eat
   the simple cases too (it's ergonomic enough that people reach for it over a
   token).
2. **Bundle weight.** The full `motion/react` feature set (layout +
   `AnimatePresence` + gestures) is the heavy tier (~tens of kb gzipped on the
   React surface), not the ~2.5kb vanilla `animate` mini. The features we'd
   actually want (FLIP, presence) are precisely the ones that pull the big
   bundle. On a mobile-first app this is a real line item.
3. **Capacitor Android shell.** This is the sharpest concern. The motion system
   already avoids `filter: blur` on large panels specifically because it janks
   the Android WebView (see the `--panel-*` token note in `index.css`). FLIP
   layout animations animate `transform` on potentially large subtrees every
   frame from JS — exactly the workload most likely to drop frames in the
   WebView. Any adoption **must** be benched on-device (the Moto G that the
   native-checkpoint work validates against) before it ships, not after.
4. **Coverage is already high.** 16 of 18 recipes are served well by CSS today.
   Motion buys us a *better* card-resize/tab-slide and *real* exit animations —
   genuine but incremental, and none of it is currently blocking a consumer.
   Adopting a runtime to improve four spots that nothing is asking for yet is
   premature.

## Recommendation

**Hold.** Keep the CSS-token primitives as the system of record. Do **not** add
Motion as a blanket dependency.

Adopt Motion **only** when a concrete consumer needs one of its structural
capabilities — the two realistic triggers:

- A surface needs **animated layout on real, dynamic content** (a card that
  resizes around streamed content; a tab/segmented control whose tab set changes
  at runtime), where the manual-measurement contract on `.tab-indicator` /
  `.resize-smooth` becomes the bottleneck.
- A surface needs a **true exit animation** that `forceMount` + CSS can't
  express cleanly.

When that trigger arrives, the smallest viable entry point is:

1. Add `motion` scoped to **`app/` (web) only** — never the CLI, and gate it out
   of / measure it in the Capacitor build explicitly.
2. Use it at that **one seam**, behind the same kind of reversible flag the nav
   work used (`?nav=push`), so it can be A/B'd against the CSS primitive.
3. **Bench on the Android shell first** (frame timing on the layout/exit
   animation) and only promote if it holds 60fps there.
4. Document the **two-tier rule** in `DESIGN.md`: CSS tokens are tier 1; Motion
   is tier 2 for layout/exit/gesture/interruptible-spring only, with a one-line
   justification required per Motion usage (mirrors the "behavior lives in code,
   not prompts" discipline — here, "declarative motion lives in CSS tokens, not
   a runtime, unless it structurally can't").

## Non-goals

- **No "re-platform the motion system onto Motion."** The CSS-token system is
  the right default for a mobile-first app and most of the recipes; wholesale
  migration trades a cheap, legible system for a runtime to fix a minority of
  cases.
- **No CLI usage.** Motion is a DOM/React runtime; the terminal surface has no
  use for it and must not pull it in.
- **No gesture/scroll-linked initiative right now.** Those are real Motion
  strengths but speculative for Push today; revisit only with a named consumer.
