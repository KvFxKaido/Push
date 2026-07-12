# rezi-spike — Rezi eval against the STRESS.md rubric

Throwaway spike. `npm install`, then:

| Command | What it proves |
|---|---|
| `npm run smoke:node` | N-API binding loads on Node; CellWidth string-level contract |
| `node probe-tty.mjs` (in a real terminal) | full native engine boot + caps report |
| `npm run stress` (in a real terminal) | the interactive STRESS.md cases 1–9 |
| `npm run stress:selftest` | headless build-check of every scene's view tree |

## Driving the stress app

Keys: `1`–`9` switch scenes · `t` toggle wide↔narrow (scene 1) · `m` modal
(scenes 5/9) · `z` rotate z-order (scene 7) · `Esc` close modal · `q` quit.
Each scene renders its own PASS/FAIL criteria. Score results in
[`../STRESS.md`](../STRESS.md)'s scoreboard — that table is the artifact.

## Driven-run notes (2026-07-12, Node 22 / WSL2, terminal-mcp emulator)

First pass driven programmatically (keyboard only — mouse cases still need a
human hand):

- **Case 5 ✅ / 8 ✅** — modal fully occludes a busy ticking background (zero
  leak-through), and closing restores content **with current state**, not
  stale cells. Open sub-check: whether restore was damage-limited or a full
  clear (needs a byte-stream capture, not a screenshot).
- **Case 7 ❌ (the headline finding)** — three overlapping `ui.layer`s with
  rotating `zIndex`: labels re-render, **paint order never changes** from
  insertion order. Verified across two rotations. Either dynamic `zIndex` is
  ignored on update or the layer registry pins z at mount. Upstream-worthy.
- **Case 3 ⚠️** — `👩‍👩‍👧‍👦` renders mangled in the emulator's cell buffer (cluster
  split, `👧` dropped, delimiter displaced) while é / flag pair / skin-tone
  modifier rows stay aligned — despite `measureTextCells` returning 2
  correctly. Could be the emulator's serialization; re-eyeball in Windows
  Terminal before scoring it a real raster bug.
- **Case 6 ⚠️** — the "dim" backdrop stamps a `░` pattern **over** content
  rather than dimming what's beneath. True transparency may need the
  object-form backdrop config (or doesn't exist).
- **Case 14 ✅** — clean alt-screen exit after the whole session.
- **Retracted finding (kept as a methodology lesson)** — an earlier note here
  claimed `app.update(fn)` re-invokes updaters ~10× per call. Instrumented
  measurement (scene 1 shows invocations-per-timer-fire) reads **×1.0**:
  `update()` runs the updater exactly once. The "fast tick" evidence was
  observer error — tens of seconds of tool latency between "1-second-apart"
  screenshots, plus orphaned stress processes double-painting one terminal
  after an un-received `q`. Two spike-methodology rules fall out: anchor
  timing observations to `date` calls, and `ps` for orphans before trusting
  any animation observation. The timer still derives tick from wall-clock —
  robust regardless.

## Final human-scored run (2026-07-12, Windows Terminal / WSL2) — column closed

- **Cases 1, 2, 4(+11), 5, 8, 9 ✅** — cell overwrite, edge clip, reflow,
  modal restore/occlusion, and full mouse hit-testing (including the
  continuation cell of a wide glyph, and modal click-blocking) all pass.
- **Case 3 ❌** — the ZWJ family emoji misaligns at raster in a real
  terminal even though `measureTextCells` returns 2: measure and raster
  disagree. This is the exact CellWidth failure mode the decision doc's
  contract exists to prevent.
- **Case 7 ❌** — human-verified live: `x` (child order) restacks, `z`
  (zIndex) does not. Matches the source finding.
- **Case 6 ❌ + two bonus findings** — the scene originally CRASHED the
  whole spike. Bisection (`probe-fault.mjs`): the trigger was `ui.center`,
  which **faults the app on first paint**; and a faulted Rezi app **dies
  silently** — `run()` resolves cleanly, exit 0, empty stderr, no error
  channel. (The loud ZrUiError users saw was our own timer calling
  `update()` on the faulted app — now guarded.) The dim backdrop itself,
  re-tested without `ui.center`: `░` pattern replace over the whole
  viewport. No transparency.

**Adopt verdict from this rubric:** Rezi's input/mouse layer is genuinely
excellent and the modal path is solid — but it fails the width contract at
raster (3), fails z-order-by-prop (7), has no transparency (6), a core
layout widget faults the engine, and faults have zero error surface. The
adopt case for Push's default surface does not survive this scoreboard.
