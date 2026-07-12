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
- **Quirk (unclassified)** — the tick advances ~10× faster than its 1000ms
  `setInterval`, i.e. `app.update(fn)` appears to re-invoke the updater more
  than once per call (reducer-replay semantics?). Harmless here since scenes
  derive from tick parity, but a real app must keep updaters pure — and it's
  worth understanding before trusting `update()` with side-effect-adjacent
  state.

Remaining for a human in a rich terminal: case 1 (watch the wide↔narrow
toggle), case 2 (edge clip), case 4+11 (resize wiggle), case 9 (mouse clicks,
including the second cell of a wide glyph and click-blocking under the
modal), and re-eyeballing the two ⚠️s above.
