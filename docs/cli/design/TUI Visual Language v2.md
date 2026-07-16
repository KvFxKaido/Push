# Push TUI Visual Language v2

Date: 2026-07-12
Status: Current — the design language for the silvery-era TUI (`cli/silvery/`)
Supersedes: [`docs/archive/cli/design/Push CLI TUI Visual Language Spec.md`](../../archive/cli/design/Push%20CLI%20TUI%20Visual%20Language%20Spec.md)
and [`docs/archive/cli/design/TUI Visual System.md`](../../archive/cli/design/TUI%20Visual%20System.md)
(both described the hand-rolled ANSI TUI deleted in the silvery migration, PRs #1426–#1430).
Sibling: [`DESIGN.md`](../../../DESIGN.md) (web surface). Renderer: [silvery](https://github.com/beorn/silvery)
via [`docs/decisions/Retained-Mode TUI — MVU + Pure-TS Compositor.md`](../../decisions/Retained-Mode%20TUI%20—%20MVU%20+%20Pure-TS%20Compositor.md).

## Lineage

The language synthesizes two eras. The v1 ANSI TUI (mono theme) was *severe*: grayscale
everything, one saturated green cursor cell, hollow/filled circle bullets, vast idle
emptiness — a terminal that refused to perform. The silvery era adds hierarchy under
density: an activity spine, tinted turn rows, full-bleed diffs, context-aware footer keys.
v2 keeps the severity as the default posture and spends the new capability only where
work is actually happening.

## The laws

Each law is stated as a constraint, because a design language is what it *refuses* to do.

### 1. Frame / stream split

The edges hold state; the middle holds work; they never interleave.

- **Header** — a dot-separated fact strip: brand mark, branch, path, context meter,
  turn/round counter. Facts only; no controls.
- **Footer** — the active keybinds for the current focus scope (context-aware: what the
  footer shows changes when a modal owns the keys), plus mode (`always-approve`, provider ·
  model) on the composer rule.
- **Stream** — the transcript: turns, activity, diffs, ops narration. State summaries never
  float into it; stream content never docks to the frame.

This is what keeps honest-chrome from metastasizing into dashboard-chrome.

### 2. One accent

Color is meaning, never decoration. The language budgets exactly **one accent color** for
"this is where the action is" (composer cursor, active selection, the live element).
Themes (`/theme`) may choose *which hue* the accent is; they may not raise the budget.
Everything else is the grayscale ramp: `bold` / normal / `dim`.

The v1 mono look proved Push is legible with a single saturated cell on screen. That is
the default posture, not a degraded mode.

**No emoji in the stream.** A decorative emoji is a full-color glyph that can't be dimmed —
every one is an unbudgeted accent entering through a side door, and the narrating voice
(law 11) doesn't cheerlead. Decorative color enters *only* through the accent budget.
Model prose can't be trusted to honor this, so the rule is enforced in code: the markdown
render pass (`cli/silvery/markdown.tsx`, `stripDecorativeEmoji`) strips pictographs before
they reach a cell. Push's own chrome glyphs (hexagons, squares, density blocks) are
geometric, not pictographic, and are unaffected.

### 3. The fault exception

The one sanctioned second color means **something is wrong** — and it is never used for
anything else. No yellow-ish warnings scale, no success green confetti. Errors earn their
salience precisely because the rest of the screen refuses color. Warnings are prose in the
stream (law 10), bolded at most.

### 4. Outline / filled is the state axis

v1's bullet system — hollow `○` for routine, filled `●` for needs-your-eyes — is promoted
to the brand shape:

| Glyph | Meaning | Unicode | ASCII fallback |
|---|---|---|---|
| `⬡` | idle / pending / routine | U+2B21 | `o` |
| `⬢` | active / attention / filled state | U+2B22 | `@` |

State is carried by fill and brightness, **never by glyph variety** — Unicode has no
half-filled hexagon, and font coverage is patchy (the motivating screenshot rendered the
mark as `�`). Every hexagon renders through the theme's unicode seam and must degrade to
its ASCII fallback. If the fallback isn't wired, the hexagon doesn't ship.

### 5. Hexagon signature, square workhorse

**The hexagon is Push's face.** It is worn only by Push: the header mark, the
status/liveness indicator, approval chips, the **lead agent's own turns** (a hollow hex
`⬡`, no name — see the reversal note below), and independent-voice attribution (a filled
hex marks Reviewer/Auditor as a voice distinct from the lead — names still come from
`lib/role-display.ts`). Outside the lead-agent turn it stays **rare**, and that is not an
aesthetic preference: the
spine is the highest-frequency glyph in the app, and law 4 already records that hexagon
font coverage is patchy (the motivating screenshot rendered the mark as `�`). Putting the
worst-supported glyph in the busiest slot would be the one decision that breaks the
language in the field.

The activity spine is a **square**: `▪` Push working, `▫` Push talking. ASCII `+` / `-`.
The Unicode strings carry U+FE0E (text presentation) so Silvery and terminals keep both
squares monochrome and one cell wide instead of promoting them to two-cell emoji.

*Reversal (2026-07-14).* This law previously read "diamond workhorse" and kept `◆` / `◇` on
the spine. Two reasons that was wrong, and neither is "diamonds are ugly":

1. **The workhorse rhymed with the signature.** `◆` and `⬢` are both angular filled
   polygons; in a scrolling transcript they read as the same visual family. A signature
   cannot signify if the highest-frequency mark looks like it. The square's four flat
   sides are the maximum available contrast with six angled ones.
2. **An interim proposal (`•` / `·`) traded fill for size**, which is precisely what law 4
   forbids: `·` is a *smaller* dot, not a hollower one, and it is close to invisible in
   many terminal fonts. The square restores the fill axis the rest of the language uses.

The spine glyph separates exactly **one** thing: Push *working* from Push *talking*.
Pending / ok / error ride **color**, not shape — a settled tool call still wears `▪`. (The
code names them `markWork` / `markQuiet` for this reason; the earlier `dotActive` /
`dotIdle` claimed a live-vs-settled distinction the code never made.)

The **human turn wears neither Push glyph** — not the hexagon (that would put Push's face
on the one voice that isn't Push) and not the square spine (that is Push's own activity).
The user gets a prompt caret `❯` (ASCII `>`) in the accent, the single non-Push shape in
the stream. So the stream reads in four registers:
`❯` you, `⬡` the lead agent (Push's face, hollow — the voice you converse with, no name),
`⬢` an independent Push voice (Reviewer/Auditor, filled + named), `▪`/`▫` Push's tool
activity and quiet chrome.

*Reversal (2026-07-15).* The lead agent's own turns previously wore the quiet square
`▫` and a spelled-out "Assistant" label; the human turn wore `›`. Both are gone. The
lead agent now wears the **hollow hexagon** `⬡` with no name — it is the single voice
you converse with, so the hexagon (Push's face) *is* the attribution, and a label is
redundant. The human caret is now `❯` (heavier than `›`, and already the selection
cursor in the palette/picker — one caret, unified). This admits a tradeoff against the
"stays rare" rule above: the lead hex now appears once per exchange rather than never.
It is accepted because (a) the *highest*-frequency glyph — the per-tool-call spine —
stays a square, so the busiest slot is unchanged; (b) an agent turn is one-per-exchange,
not per-tool; and (c) the ASCII fallback `o`/`@` is wired, so patchy hex fonts still
degrade cleanly. The filled/​hollow axis keeps the lead (`⬡`, routine) distinct from the
louder independent voices (`⬢`, attention).

### 6. Idle is allowed to be empty — but it may still have a face

Stillness is a state indication. An idle screen shows the frame, the composer, and
whatever transcript exists. No ambient animation, no news, no tips, no busy-looking fill.
A TUI that always looks busy is performing.

An **empty transcript** may center one **static, dim** Push mark — the hexagon, rasterized
from the real `PushMarkIcon` geometry onto the language's existing density cells. It
introduces no new glyph, it never moves, and it is gone the instant there is a row to show.

*Reversal (2026-07-14).* This law previously said "**no placeholder art**", full stop, and
that was too broad. Its real target is **performance** — a UI that manufactures activity to
look alive. A motionless mark on a screen with nothing on it is not performing; it is the
one moment the product has to say what it is. Identity is not busyness.

The line the law still holds: the mark is the *only* thing that may occupy an empty
transcript. Not a changelog, not a "try our new model" blurb, not a rotating tip. Those are
marketing wearing the chrome's clothes, and they are what "no placeholder art" was really
protecting against.

### 7. Smooth by construction

Perceived smoothness is mostly the absence of jank, and that is substrate, not styling:

- **Atomic frames** — synchronized output (DEC 2026); a half-painted frame never reaches
  the eye. Silvery drives this; the emergency-restore sequence releases it.
- **Damage-only repaints** — a one-line change repaints one line (the adopt gate measured
  17 bytes). Full-screen repaints are reserved for resume/resize/fault recovery.

These are laws, not implementation details: a change that introduces tearing or
full-repaints-on-local-change is a design regression, not just a perf one.

### 8. One clock, phase-locked, one live animation

All motion derives from a single tick counter, so concurrent effects stay in phase —
two animations beating at different periods read as flicker. And the motion budget matches
the color budget: **one live animation at a time.**

- *Idle:* nothing moves.
- *Streaming:* the reveal cadence **is** the motion (same word, same concept as the web
  surface's Streamdown-derived prose cadence).
- *Working:* the breathing hex — `⬡` dim → `⬢` bright and back on the tick.
- *Attention:* a single pulse that fires **once**. A looping attention animation is
  nagging; one pulse is a tap on the shoulder.

### 9. Motion primitives are time and light, not space

Cells are integers; nothing slides. The primitives:

- **Opacity ramps** — silvery's OKLab alpha blending gives the terminal a real fade.
  Modal enter/exit is a backdrop dimming over 2–3 ticks, never a teleport. This is the
  single highest-value smoothness primitive; use it for all chrome enter/exit.
- **Brightness ramps** — dim → normal → bold as the terminal's easing curve.
- **Density ramps** — `░▒▓█` where a meter needs continuous feel.
- **Phase cycles** — spinner/breathing glyph sequences, always on the shared clock.

Motion tokens are **translated, not invented**: the web app's five-axis motion token
system (transitions.dev lineage, `app/src/index.css`, `DESIGN.md`) maps into tick-space —
duration axes become tick counts, easing curves become brightness ramps. One motion
vocabulary, two substrates.

### 10. Motion is enhancement; the stream never animates into view

Every animation has a static equivalent carrying the same information —
`PUSH_REDUCED_MOTION` (and the `REDUCED_MOTION` alias) disables motion without losing
meaning. And one class rule above all: **chrome moves smoothly; stream truth appears
instantly.** Transcript entries, tool results, ops events land unfaded, undelayed.
Delaying information for elegance is the one trade this app never makes.

### 11. The voice is part of the language

Push narrates its own runtime in plain first-person sentences, cause then action:

> Stale pushd daemon detected — it is running build X, but this session is build Y.
> Refreshing the daemon so your work runs on current code…

No toasts, no spinner-with-a-lie, no passive voice hiding the actor. Ops narration is
stream content (law 1) styled as prose, not as chrome. When writing a new runtime event's
user-facing line, write the sentence a competent operator would say out loud.

## Capability tiers (inherited from v1 spec)

The language must remain fully usable at every tier:

- **Tier 1** — truecolor + Unicode: full language (alpha fades, hexagons, density ramps).
- **Tier 2** — 256-color + Unicode: alpha degrades per silvery's documented ANSI ramping;
  everything else intact.
- **Tier 3** — 16-color + ASCII: hexagons → `o`/`@`, squares → `-`/`+`, density ramps →
  `.:#`, fades → discrete dim/normal steps. The one-accent budget makes this tier nearly
  free: a language that only needs one color and a grayscale ramp survives 16 colors.

## Fault surfaces

The fault path exists because upstream's default was a silent zombie — Push already
decided faults must be *seen* (`RecoverableBoundary` + root `SilveryErrorBoundary` +
process watchdog, `cli/silvery/push-shell.tsx`). The design consequence: the error
boundary is a painted surface, and honest-surfaces philosophy says it should be the
best-designed screen in the app, not the ugliest.

- It may use the fault color (law 3) — this is what the color is budgeted for.
- It states, in the narrating voice: what faulted, what was preserved (session persists in
  the daemon), and the one action available (restart / report).
- It never animates. A fault screen that moves is a fault screen you can't trust.
- The terminal is always restored behind it (`TERMINAL_RESTORE_SEQUENCE` is pinned by
  test) — a fault must never leave the user's terminal in a mangled mode.

## Non-goals

- **Web parity.** The surfaces share vocabulary (motion axes, reveal cadence, role
  display), not pixels. No card cosplay in the terminal.
- **Theming beyond the budget.** Themes pick hues; the budget and the grayscale posture
  are the language, not a theme option.
- **Ambient personality.** The personality lives in the voice (law 11) and the restraint,
  not in mascots, gradients, or idle animations.
