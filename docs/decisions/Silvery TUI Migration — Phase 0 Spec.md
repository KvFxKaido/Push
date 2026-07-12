# Silvery TUI Migration — Phase 0 Spec

**Status:** Draft — implementation spec awaiting build. Parent decision:
[`Retained-Mode TUI — MVU + Pure-TS Compositor.md`](Retained-Mode%20TUI%20—%20MVU%20+%20Pure-TS%20Compositor.md)
(Status: Current — adopt silvery). Validation rubric / prototype:
[`spikes/tui-retained-mode/silvery-spike/`](../../spikes/tui-retained-mode/silvery-spike/).

**Date:** 2026-07-12 · **Track:** Claude-on-local (architectural; guards main).

## Goal

Land silvery in the CLI as an **opt-in, isolated** surface — enough to prove it loads on the
CLI's own toolchain and to ship the one non-negotiable (the fault shell) — **without touching
the default ANSI TUI**. Phase 0 is done when `PUSH_TUI_SILVERY=1 ./push tui` opens a minimal
silvery "hello Push" screen wrapped in the three-layer fault shell, and the ANSI TUI is
unchanged when the flag is off.

## Scope

**In:**
- Add `silvery` **exact-pinned to `0.21.1`** (not `^0.21.1` — approved 2026-07-12; relax to a
  caret only once renderer tests cover the surface) + `react@^19.2.7` + `@types/react` to the
  **root** dependency set (the CLI compiles with the root's toolchain; there is no
  `cli/package.json` — root `push-root` *is* the CLI's package). **Requires Node ≥24 and must also
  survive the Bun single-binary compile** — see Runtime below.
- `PushShell` — the reusable three-layer fault shell from the prototype, as CLI `.tsx`.
- `PUSH_TUI_SILVERY` flag + a single flag-aware `launchTui()` that both existing launch sites
  delegate to.
- A minimal silvery entry (`runTuiSilvery`) rendering a placeholder screen inside `PushShell`.
- Toolchain: `.tsx` support in `cli/tsconfig.json`.
- Tests: fault-path self-check (ported from the spike), a deps-load smoke, a flag-routing drift test.

**Explicitly OUT (→ P1+):** transcript/input parity, `ListView`, role-display wiring, daemon/
session integration, mouse, panes, the round loop. **P0 renders a static screen** — no agent turn.

## The design seam — `PushShell`

The one real decision in P0; everything else is plumbing.

`PushShell` is the root wrapper every silvery Push screen mounts inside — the mechanism that
closes the survey's sole open wound (silent-fault). Three layers, lifted from the prototype:

1. **`RecoverableBoundary`** (class component) around the app body — a *render* fault paints an
   inline error card and keeps the shell alive; exposes a reset (keyed remount).
2. **root `SilveryErrorBoundary`** — silvery's rich last-resort surface for a render fault that
   escapes the recoverable layer.
3. **process watchdog** — `uncaughtException` / `unhandledRejection` handlers that (a) restore
   the terminal (leave alt-screen, show cursor, disable mouse), (b) print the error to stderr,
   (c) exit non-zero. This is the layer that covers **async/effect faults error boundaries
   structurally cannot catch** — the exact scene-14 class.

**Home: `cli/silvery/push-shell.tsx` — deliberately NOT `lib/`.** This looks like it violates
the new-feature checklist ("promote to `lib/` when a second surface needs it"), so the reasoning
is explicit: silvery is a **terminal view-layer** dependency. The web surface renders React-DOM,
not silvery — so the fault-shell *pattern* is cross-surface but its *implementation* (silvery host
components) is CLI-only. Putting it in `lib/` would drag `silvery` into every `lib/` consumer's
graph, including the web Worker bundle. It stays in `cli/`, lazily imported only on the silvery
path — the same reason `app/src/` view code stays out of `lib/`. **Firm (approved 2026-07-12):
do not extract a shared fault *contract* into `lib/` until another surface genuinely needs the
same typed contract.** The reusable concept is cross-surface; the implementation is terminal
presentation code. Premature extraction buys an abstraction with one consumer.

**Contract questions to settle in the build (not hand-waved):**
- **Teardown ordering vs `cli/tui-io.ts`.** The ANSI TUI owns terminal teardown (raw mode, mouse,
  alt-screen) through `tui-io.ts`. On the silvery path P0 gives **silvery sole terminal ownership**
  (no `tui-io`), so the watchdog restores *silvery's* sequences. Document the exact restore bytes;
  do not let any pre-launch `tui-io` setup run on the silvery branch.
- **Idempotent restore.** Both `SilveryErrorBoundary`'s unmount path and the watchdog can fire;
  restore must be idempotent (a `restored` guard) or the second run corrupts an already-clean terminal.
- **Watchdog vs a live turn (flag for P1).** P0 has no session, so the watchdog just restores +
  exits. In P1 an in-progress daemon turn needs graceful abort, not a bare `process.exit`.

## Flag plumbing

- **`PUSH_TUI_SILVERY`** — mirror `PUSH_TUI_ENABLED` semantics: read `=== '1' || === 'true'` to
  opt *in*; default off = today's ANSI TUI, unchanged.
- **Precedence:** `PUSH_TUI_ENABLED=0` still wins (no TUI at all). The silvery flag only chooses
  *which* TUI once a TUI is being launched: `tuiEnabled` gate first, then `PUSH_TUI_SILVERY` picks
  the renderer.
- **DRY the two launch sites.** `runTUI` is dynamically imported today at **`cli/cli.ts:3877`**
  (`tui` subcommand) and **`cli/cli.ts:4170`** (bare `push`). Introduce one helper both call:
  ```ts
  async function launchTui(options: RunTuiOptions) {
    const useSilvery =
      process.env.PUSH_TUI_SILVERY === '1' || process.env.PUSH_TUI_SILVERY === 'true';
    if (useSilvery) {
      console.error(JSON.stringify({ level: 'info', event: 'tui_launch_silvery' }));
      const { runTuiSilvery } = await import('./silvery/entry.js');
      return runTuiSilvery(options);
    }
    console.error(JSON.stringify({ level: 'info', event: 'tui_launch_ansi' }));
    const { runTUI } = await import('./tui.js');
    return runTUI(options);
  }
  ```
  `runTuiSilvery` accepts the **same options contract** as `runTUI`
  (`{ sessionId, provider, model, cwd, maxRounds, explicitMaxRounds }`) so it is a true drop-in;
  P0 ignores all but a couple. The `tui_launch_silvery ↔ tui_launch_ansi` pair is the symmetric
  structured log (to `console.error` — CLI stdout is the user channel).
- **`launchTui()` lands as its own prep commit** (approved 2026-07-12), first, within the same P0
  branch/PR. It is **narrowly responsible for**: renderer selection, the lazy import, the symmetric
  log, and dispatch through the existing options contract — nothing else. It **must not move either
  call site's session or worktree lifecycle** (session resolution, resume, sandbox/worktree setup
  stay exactly where they are at `3877`/`4170`); `launchTui` receives the already-resolved options
  and only chooses the renderer. This keeps the refactor a pure, reviewable extraction with no
  behavior change on the default (ANSI) path.

## File layout

```
cli/silvery/
  push-shell.tsx     # RecoverableBoundary + SilveryErrorBoundary + installWatchdog()
  entry.tsx          # runTuiSilvery(options); node-<24 guard → render(<PushShell>…).run()
  hello.tsx          # P0 placeholder screen (header + a static line). Replaced in P1.
cli/cli.ts           # + launchTui() [prep commit]; sites 3877 & 4170 delegate to it
cli/tsconfig.json    # + "jsx": "react-jsx", "jsxImportSource": "react", include "**/*.tsx"
cli/README.md        # + Node >=24 requirement for the silvery TUI path
package.json (root)  # + silvery 0.21.1 (exact), react@^19.2.7, @types/react, engines.node>=24
.github/workflows/ci.yml  # CLI job Node 20->24 (+ comment fix); cli-binary smoke exercises silvery
```

## Runtime — Node ≥24 (hard), and Bun must also work

`silvery@0.21.1` ships `using` declarations (explicit resource management) in its dist and
declares `engines: { node: '>=24', bun: '>=1.0' }`. The Node floor is a **hard parse-time
requirement**, verified 2026-07-12: `import 'silvery'` is a `SyntaxError` on Node 22
(`Unexpected identifier 'render'` at `using render = …`), and tsx does not rescue it (it
transpiles your source, not pre-compiled `node_modules`). So adopting latest silvery makes the
**CLI's effective Node floor 24**. Re-validated on Node 24.18.0: prototype `--check` 6/6,
adopt-gate scenes 13/0, ListView tail-follow still hand-windowed (no change from 0.19.2).

**The CLI has two runtimes — both must clear silvery.** Besides `node --import tsx` (dev), the
`cli-binary` CI job compiles the CLI to a **Bun single binary** (`bun build --compile cli/cli.ts`,
Bun 1.3.11) — the distribution artifact. This is the inverse of the OpenTUI ruling: OpenTUI was
Bun-*only* via native FFI and failed on Node; silvery is pure-TS, so it can satisfy **both** Node
≥24 and Bun ≥1.0 — which is exactly why a pure-TS compositor was the right adopt target. But the
`bun --compile` path bundling silvery's `using`-laden ESM dist is an **unproven de-risk** (Bun's
transpiler supports `using`, and silvery declares `bun>=1.0`, so it's *expected* to work — verify,
don't assume). This is a first-class P0 acceptance gate, not a footnote.

**Recording the floor (approved: CLI floor = 24; app CI independent on Node 20):**
- **Root `package.json` `engines: { node: '>=24' }`** — root (`push-root`) is the CLI's package
  metadata; this is where the floor is declared.
- **`cli/README.md`** — document Node ≥24 as a hard requirement for the (opt-in) silvery TUI path.
- **Bump the CLI CI job** `Format, Typecheck, Test (cli)` (`.github/workflows/ci.yml:196`, root
  `npm ci`) from Node **20 → 24**, and update its comment (lines 199–202) — the "CLI has no external
  npm imports" invariant is now false (silvery + react are its first). **App jobs (working-dir
  `app/`, Node 20 + 22) and the mcp job (Node 20) are untouched** — they install from
  `app/`/`mcp/` package.json, insulated from root `engines`; this is what "app CI independent on
  Node 20" resolves to.
- **`cli-binary` job**: keep Bun 1.3.11 (silvery works on bun≥1.0), but the compile + smoke now
  exercises silvery through the binary — see acceptance.
- **Runtime guard on the silvery path** (behavior-in-code, not just docs): when the silvery
  renderer is selected and `process.version` major `< 24`, fail fast with a clear message (use
  `nvm use 24`, or unset `PUSH_TUI_SILVERY`). Scoped to the opt-in path — the ANSI default and all
  non-silvery CLI paths keep running on 20/22.
- **Silvery tests must not crash the suite on Node < 24.** A static `import 'silvery'` in a test
  file `SyntaxError`s the whole runner on 22/20. Silvery-touching tests therefore **dynamic-import
  behind a `process.version >= 24` guard** and skip below it — so `npm run test:cli` stays green on
  any Node, and the real assertions run on the (now Node-24) CLI CI job.

## Toolchain

- `cli/tsconfig.json`: add `"jsx": "react-jsx"`, `"jsxImportSource": "react"`, and `"**/*.tsx"`
  to `include`. Confirm the root's `typescript@7` both typechecks **and emits** `.tsx` (the CLI's
  `build:cli` runs native `tsc`; the app already does `react-jsx` via its own config, but the CLI's
  emit path is the new variable).
- Runtime path: the CLI runs `node --import tsx`; tsx transpiles `.tsx`. **Partially de-risked** —
  silvery 0.21.1 runs on Node 24 as `.mjs`/`createElement` (spike). The remaining variable is the
  `.tsx` + tsx + React-19 automatic-runtime path specifically; still the first thing to prove (Q1).
- `react` at root must match the app's `^19.2.7` — one React copy for the repo.

## Acceptance / tests

- **Three-runtime `.tsx` smoke** (the Q1 de-risk — do this *first*, before `PushShell`): a minimal
  `.tsx` that renders one silvery line, proven through **all three** CLI runtimes:
  1. `node --import tsx cli/silvery/…smoke.tsx` (dev path);
  2. the emitted CLI build — `build:cli` (`cd cli && tsc`) → run the emitted `.js` on Node 24;
  3. `bun build --compile … --outfile` → run the binary (the distribution path; the highest-risk
     unknown — bundling silvery's `using` dist).
  Green on all three = the toolchain is real; any red gates P0.
- **Fault self-check** (`cli/tests/`): port `push-surface.mjs --check`'s fault path — mount
  `PushShell` around a throwing component; assert the inline card renders, the shell survives, the
  fault is logged, `run()` settles (no zombie). **Dynamic-import behind the `process.version >= 24`
  guard** so the suite doesn't `SyntaxError` on Node < 24.
- **Flag routing / drift**: `launchTui` with the flag set imports `./silvery/entry.js`; unset
  imports `./tui.js`; assert the branch + the structured log line (no silvery import needed → runs
  on any Node).
- **Regression**: with the flag off, an existing TUI smoke is unchanged (ANSI path, Node 20/22/24).

## Toolchain de-risk — RESULTS (smoke run 2026-07-12, `cli/silvery/smoke.tsx`)

- **`node --import tsx`: ✅** renders a silvery frame on Node 24. Gotcha found: tsx does **not**
  discover `cli/tsconfig.json`'s `jsx: react-jsx` from arbitrary cwds, so it defaults to the classic
  transform → `React is not defined`. Fix (adopted): CLI `.tsx` files use an explicit
  `import React from 'react'` (classic-compatible, works under every transform) rather than relying
  on automatic-runtime tsconfig discovery. Also: `renderStringSync` throws "layout engine not
  initialized" — use the async `renderString()` (self-inits) for one-shot renders.
- **Emitted CLI build (`tsc -p cli/tsconfig.json` → run the `.js` on Node 24): ✅** — the whole CLI
  tree emits clean with the jsx config added (Q2 resolved), and the emitted `smoke.js` runs.
- **`bun build --compile` single binary: ⚠️ blocked (characterized).** silvery pulls
  `@termless/core`, which has a **static** `import "ghostty-web"` (image rasterizer for
  `renderAnsiPng`) plus optional backends (`playwright`, `@napi-rs/canvas`, `@resvg/resvg-js`,
  `@twemoji/svg`, `ghostty-web`, `gifenc`, `upng-js`) and terminal backends (`@termless/ghostty`,
  `@termless/xtermjs`). Bun's `--compile` bundles these eagerly; externalizing the full set lets it
  *compile*, but the static `ghostty-web` import then **fires at runtime** in the binary (it loads a
  WASM file via `createRequire().resolve()`, which doesn't survive `bunfs`). The text render path
  never needs any of this — but Bun can't tree-shake a static side-effecting import. **This is a
  distribution-path decision, not a dev-path blocker** (both dev runtimes are green). See "Bun
  single-binary" below.

## Bun single-binary — the one open decision

The compiled binary (`cli-binary` job) is how the CLI is distributed. silvery's image-rasterizer
subsystem won't cleanly bundle into it. Recommended P0 scoping (**needs your call**):

- **Ship the silvery TUI dev-first.** In the compiled binary, mark silvery + `./silvery/entry`
  **external**; the `launchTui` runtime guard already fails closed — so in the binary,
  `PUSH_TUI_SILVERY` reports "silvery TUI requires the source/tsx runtime; not in the single-binary
  build yet" and the **ANSI TUI (binary default) is untouched**. The silvery path runs under
  `./push` via tsx and the tsc-emitted build, both green.
- **Binary support is its own later slice** — either patch/configure `@termless/core` to drop the
  image backends (upstream ask, or a resolve-alias shim), or accept the binary carries the ANSI TUI
  only. Not P0.

This keeps P0 small and unblocked, and it's honest: silvery TUI is opt-in and experimental; the
distributed binary keeps the proven ANSI path until bundling is solved.

## Open questions (resolve before / at build)

1. ~~`.tsx` + tsx + React-19 runtime~~ — **resolved** (see de-risk results; explicit `import React`).
2. ~~Emitting `.tsx` disturbs `build:cli`~~ — **resolved** (tree emits clean).
3. **Bun single-binary scoping** — confirm the "silvery dev-first, external in the binary + runtime
   guard" call above (or invest in bundling the backends now).
4. **Terminal ownership on the bare-`push` path** — confirm nothing pre-launch (resize listeners,
   `tui-io` setup) runs before `launchTui` and leaks state into silvery's session.
5. **React singleton** — adding root `react` must not create a second instance under the app's
   aliased-typescript setup (the app pins TS via alias, not react; verify react stays single).

## Out of scope → P1

Transcript/input parity, `ListView` cache-mode (the tail-follow fix), role-display idiom,
session/daemon wiring, mouse hit-testing, the round loop. **P0 is deliberately a skeleton with a
spine (the fault shell) and nothing else** — small, isolated, revertable by flipping one flag off.
