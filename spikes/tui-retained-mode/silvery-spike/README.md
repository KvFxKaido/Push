# Silvery spike — driven stress run (2026-07-12)

Candidate: `silvery@0.21.1` (npm, compiled dist, `engines.node>=18` — runs on Node 22
despite the monorepo's dev floor of 24). React authoring; substrate = grapheme-string
cells + packed wide/continuation flags + z-aware hit registry. First candidate to
survive the source read; this run drives the published package through the **real
render pipeline** on fake TTY streams and verifies emitted ANSI with two referees:
silvery's own `VirtualTerminal` and `@xterm/headless` (independent).

## Files

- `stress-pipeline.mjs` — scenes 1, 2, 3, 6, 7, 14 through `render()` with captured
  stdout. Run: `COLORTERM=truecolor TERM=xterm-256color node stress-pipeline.mjs`.
- `stress-buffer.mjs` — public-API probe + standalone `HitRegistry` semantics
  (scene 9 core). The `TerminalBuffer` class is **not** exported from the npm barrel;
  buffer-level scenes run through the pipeline instead.

## Run result: 9 pass / 3 fail — 2 fails attributed to the referee, 1 real

**Passes (driven, end-to-end):**

- **Scene 1 (CJK overwrite)** — absolute box painting `a` onto `中`'s continuation
  cell repairs the lead through the live incremental pipeline: row reads `" a中中"`,
  no orphan half-glyph.
- **Scene 2 (wide clip)** — truncation path clean (`…`, never a half-`中`). ⚠ the
  raw-clip-without-truncate case was not isolated.
- **Scene 6 (transparency)** — `Backdrop fade` **reads the finished buffer beneath**
  and dims without replacing: glyphs preserved, SGR-dim emitted at the ANSI-16 tier
  exactly as documented (OKLab RGB blend at truecolor tier — untested in this
  harness, caps detection defaulted to 16-color on the fake TTY). Contrast Rezi:
  whole-viewport `░` replace. This is the best transparency story surveyed.
- **Scene 7 (restack)** — reordering absolute siblings repaints the overlap
  correctly; damage-diff emitted the change.
- **Scene 9 core** — standalone `HitRegistry`: highest-z wins at overlap, correct
  routing outside it.
- **Scene 13 (headless)** — the entire run is the evidence: full pipeline on fake
  streams, no TTY, deterministic; plus `renderString`/`VirtualTerminal` ship in the
  public API.

**Scene 3 (ZWJ) — ⚠ attribution matters:**
silvery's emission is correct and self-consistent — the full `👩‍👩‍👧‍👦` cluster is present
in the emitted bytes, and its own VirtualTerminal places the following `x` at col 2,
matching `graphemeWidth=2`. The independent referee (`@xterm/headless`, default
Unicode-6 width tables) splits the cluster and disagrees about columns. That is the
**cross-terminal raster divergence** risk class (what killed Rezi — but Rezi's own
raster was wrong; silvery's is right and the *ecosystem* varies). Final call needs
the same human raster pass Rezi got (Windows Terminal + VS Code terminal).
Note for the build: this referee behavior applies to ANY engine emitting raw
clusters, including ours.

**Scene 14 (fault posture) — ❌ real, driven-confirmed:**
a component throwing during a state-driven re-render produces a **silent zombie**:
nothing on stderr, `run()` never settles, no teardown bytes, no cursor restore.
`SilveryErrorBoundary` exists but is opt-in; the default posture violates the
no-silent-paths contract (same class as Rezi's silent exit-0, arguably worse —
it hangs instead of exiting).

**Scene 7/9 structural note:** paint z = tree order (no `zIndex` on Box); hit-region
z = manually supplied per `useHitRegion`. Agreement is **by-convention**, not
by-construction — the Rezi paint/input split exists here structurally, though as a
convention burden rather than an active contradiction. Whether the built-in
`ModalDialog`/`Popover` wire both sides consistently was not tested.

## Human pass (2026-07-12, Windows Terminal / WSL2)

- **Scene 3 raster: PASSED.** `human-raster.mjs` self-scoring border box — all nine
  cluster classes aligned (control, CJK, combining, plain emoji, VS16, skin tone,
  RI flag, **ZWJ family, ZWJ+tone**). This is the exact case Rezi failed human
  scoring on. The default-config `@xterm/headless` referee still splits clusters —
  recorded as a referee caveat (and a warning for any engine's output on weak
  emulators), not a silvery defect. VS Code terminal (xterm.js) remains an optional
  extra data point.
- **Scene 14 live: refined, still ❌.** `human-fault.mjs`, press `b`: the exception
  message never surfaces anywhere, `run()` never settles, and the process dies via
  Node's *unsettled top-level await* path (exit 13) with a diagnostic pointing at
  the harness's `await` — not the fault. So: not an infinite hang live (the loop
  drains), but the error is swallowed and the exit diagnostic is misleading.
  Contract violation stands as shipped; error boundary is opt-in.

## Adopt-gate run (`stress-adopt.mjs`, 13✅/0❌)

The four scenes that actually decide framework-adopt, all driven on Node 22:

- **Scene 5 (modal restore): PASSED.** Absolute-overlay modal occludes content;
  close emits **no `ESC[2J`** (382ch, damage-only); underlying content restored to
  the **exact byte-identical baseline**. The full-clear-vs-damage check Rezi left open.
- **Scene 8 (occluded update): PASSED.** Counter mutated 0→3 while the modal covers
  all three counter lines — xterm shows the modal, **no `counter=3` leak-through**;
  on close, the new value appears on all three lines. Real occlusion + deferred reveal.
- **Scene 9 (hit routing): PASSED via the real `hitTest`** (the exact function the
  runtime calls at `event-handlers.ts:82`, reached through a Box ref → root walk).
  Overlap → TOP layer (z-correct, **not** smallest-area, which is Storm's bug);
  bottom-only → bottom; top-only → top; **wide-glyph lead AND its continuation cell
  both resolve to their box** — the doc's CellWidth clause "continuation cells inherit
  their lead's hit target," verified. *Scope:* this drives the routing DECISION; the
  onClick handler-invocation that follows (`dispatchMouseEventToTree` →
  `processMouseEvent` → `hitTest` → `onClick`) is source-verified, not live-TTY-driven
  (the App `.click()` test API and live input owner weren't reachable from the
  published barrel — see method note).
- **Scene 15 (perf floor): PASSED.** A one-line change emits **17 bytes at both 80×10
  and 80×40** (full paints 902 / 3512). Update cost is O(damage), flat in screen size —
  textbook damage-diffing.

### Finding that refines an earlier wound

The "paint/input z by-convention" concern (from the first run) is **narrower than
thought**. The live mouse path is the reconciler tree-walk hitTest, whose own header
says it *"replaces manual HitRegistry"* — it iterates children accumulating the last
match, so **paint order = tree order = hit order by construction**; the primary
`onClick`/`onMouseDown` path *cannot* disagree between paint and input. The manual-
zIndex `useHitRegion` registry (where convention was required) is the **legacy/opt-in**
path. So z-agreement is by-construction for the default path, by-convention only for
the deprecated one.

## Method note

`silvery`'s published barrel exports `render()` → the **run-instance** (`.run()`),
not the testable `App` (`.click`/`.nodeAt`/`.press`) that `@silvery/ag-react` and
`@silvery/test`'s `createRenderer` return — and `@silvery/test` isn't a dependency
of the published package. Input-driven scenes therefore use one of two faithful
substitutes: the exported `hitTest(root, x, y)` on a ref-captured root (scene 9), or
fake-TTY stdout capture + `@xterm/headless` (scenes 5/8/15). Both exercise the real
reconciler + real compositor; only the stdin→handler *last inch* is source-verified
rather than driven. A published test entry (or installing `@silvery/test`) would close
that inch.

## Not run

Scenes 4 (mixed reflow — partial via first run), 10 (wheel + drag), 11 (resize
storm), 12 (cursor + selection). Live `onClick` handler invocation (vs the routing
decision, which is driven).

## Push-surface prototype (`push-surface.mjs`) — the adopt gate, walked

The gate the decision doc named to flip the section: a real Push surface authored
in React-on-silvery — header + scrolling transcript + input round loop + one modal
— with the silent-fault workaround baked in. Built and driven: headless self-check
**6/6** (`node push-surface.mjs --check`), labeled visual frames (`--snap`), live
(`node push-surface.mjs`).

- **Authoring feel — livable.** Ordinary React: `useState` for messages/palette/
  scroll, `TextInput.onSubmit` as the round loop, `useInput` for keybindings,
  components composing normally. Nothing about React-in-terminal fought the
  authoring. Simulated streaming (chunks appended to the last message on a timer)
  reflows the live region while the transcript above stays static — the O(damage)
  story from scene 15, now felt end-to-end.
- **The modal genuinely occludes.** The command palette (`ModalDialog` in an
  absolute overlay) covers the transcript — content peeks at the left/right edges —
  and scrims via backdrop fade; Esc/select close; input focus hands off
  (`isActive={!paletteOpen}`) with no keystroke bleed-through.
- **The silent-fault workaround works, in three honest layers** (the survey's sole
  open wound, closed from Push's side):
  1. `RecoverableBoundary` around the transcript body — a render fault paints an
     inline "⚠ this turn failed to render / the shell stayed alive" card; header +
     input survive; Retry remounts. Fault **surfaced and logged**, not swallowed.
  2. root `SilveryErrorBoundary` — rich last-resort surface for an escaped render
     fault.
  3. a process watchdog (`uncaughtException`/`unhandledRejection`) that restores
     the terminal (leaves alt-screen, shows cursor) and exits with a VISIBLE error
     — covering the async/effect faults error boundaries structurally can't catch
     (the exact scene-14 class). The self-check asserts the render-fault path
     end-to-end: card shown, shell alive, fault line written to the log, `run()`
     never zombied.
- **One real adopt-cost surfaced — ListView tail-follow.** silvery's `ListView`
  renders the window + `▲N/▼N` overflow indicators correctly (the scrollback↔window
  contract), but **auto-follow-to-newest is not turnkey in 0.19.2**: `scrollTo`
  (nav=false), `scrollToItem`/`cursorKey` (nav=true) all stay anchored at the top
  even with an accurate `estimateHeight`. A chat transcript must pin the newest
  turn, so the prototype windows the tail by hand — measuring each message with
  silvery's own `countVisualLines` (same width model the compositor paints with) —
  plus PgUp/PgDn scrollback. This is an **authoring cost, not a contract failure**:
  the untested `cache`/virtual-scrollback mode (items → native scrollback) is
  likely the intended path for a growing transcript; wiring and verifying it is the
  first follow-up if we adopt.

## Verdict

Silvery has now cleared **every scored contract**: the CellWidth family (incl. the
human ZWJ raster pass that killed Rezi), z-order compositing and hit routing incl.
continuation-cell targeting, modal restore without full-clear, occlusion with
deferred reveal, and O(damage) perf. The **only** open wound is the silent-fault
default — upstream-fixable, and worked-around from Push's side with a root error
boundary + a `run()` watchdog. React authoring stays rejected as an *authoring*
choice, which frames the decision as **framework-adopt (React) vs. build-with-silvery-
as-reference**, not adopt-vs-nothing. On the evidence, framework-adopt is the cheaper
path to the same substrate the doc set out to build. The gate is walked (see the
prototype section above): the surface is livable, the workaround holds, and the one
adopt-cost is ListView tail-follow ergonomics — an authoring cost, not a contract.

**Decided (2026-07-12): ADOPT.** The decision doc's Status is flipped to Current and
its Decision section rewritten to the committed adopt; the phased migration plan lives
there (Phase 0 = vendor + fault shell behind `PUSH_TUI_SILVERY`; Phase 1 = transcript/
input parity + ListView cache-mode; Phase 2 = panes/modals/mouse; Phase 3 = flip
default, delete the ANSI printer). This spike is now the validation rubric the
migration is held against.
