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
v2 keeps the AMOLED canvas and grayscale hierarchy as the baseline, then spends semantic
color only where it makes dense work easier to scan.

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

### 2. Semantic color, grayscale-complete

The AMOLED canvas and grayscale ramp (`bold` / normal / `dim`) establish hierarchy. Color
reinforces that hierarchy through a small, stable vocabulary:

| Role | Meaning |
|---|---|
| **Accent** | focus, selection, live work, and the current input target |
| **Info / link** | references, branches, destinations, quotes, and secondary structure |
| **Success** | completed work and additions |
| **Warning** | caution, partial completion, or a blocked next step |
| **Error** | failures, denied/destructive actions, and removals |

Themes (`/theme`) choose the hues and saturation of those roles; they never change their
meaning. `mono` may collapse them toward grayscale, while more chromatic themes may separate
them strongly. In every theme, removing color must leave the same state legible through
wording, weight, glyph, underline/strike, border, or position. Color may reinforce meaning;
it may not carry meaning alone.

**No emoji in the stream.** A decorative emoji is a full-color glyph whose palette cannot
be themed, dimmed, or made grayscale-complete, and the narrating voice (law 11) doesn't
cheerlead. Decorative color stays inside the semantic theme vocabulary.
Model prose can't be trusted to honor this, so the rule is enforced in code: the markdown
render pass (`cli/silvery/markdown.tsx`, `stripDecorativeEmoji`) strips pictographs before
they reach a cell. Push's own chrome glyphs (hexagons, squares, density blocks) are
geometric, not pictographic, and are unaffected.

**Terminal links are semantic cells, not embedded escape strings.** Adopted 2026-07-23
after comparing the Silvery renderer with Charmbracelet's Glamour. A completed Markdown
link uses Silvery's `Link` primitive so the label and its visible destination carry native
OSC 8 metadata and mouse behavior without putting ANSI control sequences into transcript
text. The destination remains visible and dim for copying, accessibility, and terminals
that do not expose hyperlinks; interactivity therefore never carries information alone.

Model-authored destinations cross a terminal-control boundary. Only absolute `http:` and
`https:` URLs without C0/C1 controls, invisible directional characters, or zero-width
characters become interactive. Relative, fragment-only, custom-scheme, malformed, and
whitespace-padded destinations remain readable plain text and receive no hyperlink metadata.
Push does not resolve relative links until the renderer has an explicit repository-and-branch
base URL to resolve them against.

Markdown images receive the same terminal-native fallback Glamour uses: render alt text and
the visible destination as a link, never the literal `![]()` shell and never an implicit
network fetch. This fallback may only remove Markdown marker cells, so the line-count and
width-non-increasing transcript contracts remain intact.

### 3. State color stays semantic

Success, warning, and error are operational states, not decoration. A green completion still
says "completed" and keeps its settled glyph; a warning names the caution; an error names the
failure and uses the fault mark. Diff additions/removals retain `+`/`-` or their gutter shape
when color is unavailable. The palette may be restrained, but roles never borrow one another's
color merely to make a screen livelier.

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

Consecutive settled, successful tool calls fold into one semantic spine row — for example,
`Read 3 files, Ran pnpm test`. The fold is a render-only projection: expanding it restores
every original card, while pending calls, failures, prose, and status rows remain visible
boundaries.

**The fold compresses repetition, and nothing else.** A verb that occurs once is named, not
counted: three reads earn `Read 3 files` because their paths are noise, but a lone `exec`
reads `Ran pnpm test` — never `Ran 1 command`, which is longer than the truth it replaced
and says less. This applies per verb *within* a mixed row, not just to a group of one; the
example above was `Read 3 files, Ran 1 command` until the code stopped throwing away a
target it was already holding.

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

An **empty transcript** may center one **dim** Push mark — the hexagon, rasterized from the
real `PushMarkIcon` geometry: **braille** dots (2×4 per cell) on unicode terminals for a fine
outline, the density ramp as the ASCII fallback — with a compact list of real launch shortcuts
beneath it. Braille is the one glyph family the mark introduces beyond the ramp, admitted for
the mark specifically; it is still generated from geometry (no image, no dependency), just
sampled finer. The mark is gone the instant there is a row to show. On the launch screen it
carries one slow shimmer, the idle state's single live animation (law 8), which freezes flat
under reduced motion (law 10). The shortcuts appear only while the empty composer owns input,
so the launch screen never advertises an unavailable action.

*Reversal (2026-07-14).* This law previously said "**no placeholder art**", full stop, and
that was too broad. Its real target is **performance** — a UI that manufactures activity to
look alive. A dim mark on a screen with nothing on it is not performing; it is the one moment
the product has to say what it is. Identity is not busyness.

*Extension (2026-07-18).* A short list of working launch controls may share this state with
the mark, and the mark may carry one slow identity shimmer. Both are chrome, not ambient
content: every displayed key must resolve to the advertised action and the list disappears
whenever the composer cannot honor it; the shimmer is the *only* motion on the idle screen
(law 8) and stops dead under reduced motion (law 10). A slow breath on the product's own mark
is identity, not the manufactured busyness the law forbids.

*Extension (2026-07-19).* The unicode mark moved from the density ramp to **braille** for a
finer outline. This admits one glyph family beyond the ramp, but only for the mark and only on
unicode terminals (the ASCII tier keeps the ramp). The bar the original "no new glyph" line
was protecting — no imported charset, no bundled image, no dependency — still holds: braille
is the same geometry sampled at 2×4 dots per cell, not a picture of the logo.

The line the law still holds: no ambient content may occupy an empty transcript. Not a
changelog, not a "try our new model" blurb, not a rotating tip. Those are marketing wearing
the chrome's clothes, and they are what "no placeholder art" was really protecting against.

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
two animations beating at different periods read as flicker. Motion remains tighter than
the color vocabulary: **one live animation at a time.**

- *Idle:* nothing moves.
- *Streaming:* the reveal cadence **is** the motion (same word, same concept as the web
  surface's Streamdown-derived prose cadence).
- *Working:* the **shimmering status verb** — a brightness band sweeps left→right across
  the live verb (`editing…`, `committing…`, `brewing…`) once per 16 ticks. The label **is**
  the loader, so no cell is spent on a separate spinner glyph. The hexagon holds **static
  and filled** beside it as a liveness anchor.
- *Attention:* a single pulse that fires **once**. A looping attention animation is
  nagging; one pulse is a tap on the shoulder.

The working animation used to be the breathing hex (`⬡` dim → `⬢` bright on the tick), and
the verb was not rendered at all. Both moved for the same reason: the budget is one
animation, and it should sit on the element carrying the most information. A breathing hex
can only say *alive*; a shimmering verb says *alive **and what***. The hex keeps its three
states — hollow/idle, filled/working, filled+accent/attention — distinguished by glyph and
semantic accent rather than by motion, which is why freezing it costs nothing.

> **Do not use silvery's `TextShimmer` for this.** The name matches; the component does not.
> It is a whole-word binary flip between two colors (`value > .5 ? high : low`), not a band
> sweep, and it drives itself from a private `useAnimation` timer — a second clock, beating
> against this one, which is the exact failure this law names. `verbShimmerColors()` in
> `visual-language.ts` computes the sweep off the shared tick instead. Same trap family as
> `Diff` (see the component note in `silvery/theme.tsx`).

### 9. Motion primitives are time and light, not space

Cells are integers; nothing slides. The primitives:

- **Opacity ramps** — silvery's OKLab alpha blending gives the terminal a real fade.
  Modal enter/exit is a backdrop dimming over 2–3 ticks, never a teleport. This is the
  single highest-value smoothness primitive; use it for all chrome enter/exit.
- **Brightness ramps** — dim → normal → bold as the terminal's easing curve.
- **Density ramps** — `░▒▓█` where a meter needs continuous feel.
- **Phase cycles** — a sweeping/breathing sequence, always on the shared clock. The verb
  shimmer is the only one the working state spends (law 8); a glyph spinner would be a second.

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

## Markdown presentation

Markdown styling follows the same grayscale-complete rule as runtime chrome:

- ATX headings collapse six source levels into three terminal tiers: primary is bold +
  underlined with a strong rail, secondary is bold with a square marker, and tertiary is
  italic + muted with a middle dot. Color reinforces those shape/weight differences.
- GFM tasks replace `- [ ]` / `- [x]` with text-presentation boxes. Completion adds the
  success role and strikes the label; either signal remains readable without the other.
- Links use the link role plus a visible destination and OSC 8 metadata. Inline code uses
  the code role plus a subtle neutral surface. Quote rails and table headers use info color while their
  body text remains grayscale.
- Fences and unsupported-language code use the code role; known languages keep syntax
  highlighting. Neither treatment changes source-line count.

These substitutions may remove marker cells but may not add a row or render wider than the
source line. That keeps heading/task styling inside the same transcript measurement contract
as streaming repair and fit-or-raw tables.

## Streaming Markdown adaptation

Adopted 2026-07-23 after comparing the Silvery renderer with Vercel's
[Streamdown](https://github.com/vercel/streamdown). The useful portability boundary is its
streaming behavior, not its React-DOM renderer: Streamdown repairs incomplete Markdown
before parsing and keeps completed blocks stable while the active tail grows. Its browser
components, Tailwind styling, remark/rehype tree, controls, animation, Mermaid, and math do
not belong in the terminal.

The TUI adopts the first behavior through its own grammar:

- Only a **live** machine-authored message receives incomplete-inline repair. Settled
  malformed Markdown stays literal; history is never silently rewritten.
- Repair is limited to the **active final source line**, and never runs inside fenced code.
  This preserves the renderer's one-source-line/one-row height contract and deliberately
  avoids inventing cross-line emphasis semantics.
- The repair vocabulary is exactly the syntax `markdown.tsx` can render: asterisk emphasis,
  inline backticks, and a link whose label is complete but destination is still arriving.
  An incomplete link renders as label text only; a partial URL is neither accented nor
  echoed into the transcript.
- Repair may only remove visible marker cells. It must not add a row or increase the
  displayed width of a source line. The table fit-or-raw rule remains unchanged.

The second Streamdown idea — stable block parsing and memoized completed blocks — is a
measured follow-up, not part of this slice. `markdown.tsx` is substantially cheaper than a
remark pipeline, and Silvery already reconciles retained rows; introduce block caching only
if profiling a long live response shows full-tail parsing or repeated fence highlighting is
material. In particular, the current choice to syntax-highlight an unterminated fence is
intentional and stays in force unless measurement justifies trading live color for less
work.

Streaming Markdown regressions are tested as prefixes, not only as completed examples. For
every relevant partial form, tests pin source-line count, width non-expansion, live-only
repair, fence isolation, and convergence on the ordinary settled parse once the closing
syntax arrives.

## Capability tiers (inherited from v1 spec)

The language must remain fully usable at every tier:

- **Tier 1** — truecolor + Unicode: full language (alpha fades, hexagons, density ramps).
- **Tier 2** — 256-color + Unicode: alpha degrades per silvery's documented ANSI ramping;
  everything else intact.
- **Tier 3** — 16-color + ASCII: hexagons → `o`/`@`, squares → `-`/`+`, density ramps →
  `.:#`, fades → discrete dim/normal steps, and semantic roles map to the nearest ANSI hue.
- **No color** — the same wording, glyphs, weight, underline/strike, borders, and position
  carry every distinction on the AMOLED/grayscale baseline.

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
- **Theme-specific semantics.** Themes may change hue and saturation, not what accent,
  info/link, success, warning, or error mean. The AMOLED/grayscale hierarchy is the shared
  baseline, not an optional afterthought.
- **Ambient personality.** The personality lives in the voice (law 11) and the restraint,
  not in mascots, gradients, or idle animations.
