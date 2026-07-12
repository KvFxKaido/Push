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

## Not run

Scenes 4, 5 (byte-level full-clear check), 8, 10, 11, 12, 15. The React-wired
hit-testing path (`useHitRegion` → dispatch → continuation-cell hit) is untested
end-to-end.

## Verdict

The substrate survives everything thrown at it so far: grapheme cells, continuation
repair, read-beneath transparency, damage diff (driven, Node 22), and now the
human raster pass that killed Rezi. Remaining wounds, both scoped: the silent-fault
default (upstream-fixable — a default error surface / run() rejection) and
by-convention paint/input z. React authoring stays rejected for Push, so the live
question is **reference implementation vs. substrate-adopt** — silvery is now the
strongest candidate the survey has produced on either reading. File the two
upstream issues before deciding; do not re-litigate build-vs-adopt without them.
