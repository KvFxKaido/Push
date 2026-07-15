# Bun Runtime Adoption

Date: 2026-07-04
Status: **Current** — retained scope: `bun --compile` as the single-binary
distribution path, plus the Phase 0/1 guardrails (ground rules 1–4, compiled-binary
hygiene, the Bun-aware daemon spawn). **Bun *runtime-API* adoption (Phases 2–3) is
dropped (2026-07-15):** the CLI will not migrate hand-rolled code to `Bun.*` APIs,
and running *under* Bun stays a distribution/dev concern, not a call surface. The
Phase 1 "make Bun the test runtime" revisit-triggers are moot — their only purpose
was to unlock Phase 2. Phase 2/3 content is retained below as reference. Owner: Push CLI.

Companion to [`Go Migration Assessment.md`](<Go Migration Assessment.md>),
which established Bun `--compile` as the distribution mechanism. This doc
covers the next question: where Bun *runtime APIs* (`Bun.*`) are allowed to
live, and in what order adoption happens.

## Ground rules

1. **No `Bun.*` in shared `lib/`.** Root `lib/` runs on the Cloudflare Worker
   (the same portability constraint that forced the hand-rolled FNV-1a in
   `lib/verbatim-log.ts`). Bun APIs are `cli/`-scoped, full stop. Where a
   `lib/` module needs a runtime capability, keep the injectable-dependency
   shape (`lib/detached-exec-runner.ts` is the template) and inject the Bun
   implementation from the CLI side.
2. **No `Bun.*` in `cli/` while tests run on Node.** The suite is
   `node:test`-based and Bun's shim cannot run it yet (see Phase 1 findings).
   Until the dev/test path runs Bun, any `Bun.*` call in `cli/` is untested
   code with a Node-crashing fallback problem. Scattered
   `typeof Bun !== 'undefined'` guards are worse than the hand-rolled code
   they'd replace.
3. **Consistency beats correctness in the TUI width kernel.** See Phase 2.
4. **Adjudicate substitutions by differential test, not by reading.** Whether a
   `Bun.*` API should replace hand-rolled code is decided by running both
   against an *adversarial* input corpus — never by reading Bun's docs and
   concluding the hand-roll still looks fine. A read only checks the axes you
   already thought to hand-roll; it can't surface the cases you never knew to
   (emoji ZWJ width, a torn non-atomic write, hash-format drift — the three
   examples the sections below turn on). The Phase 2 width-kernel divergences
   were found exactly this way: a 16-case corpus through both `visibleWidth`
   and `Bun.stringWidth`, not by reading `Bun.stringWidth`'s description — the
   happy path reports "identical, mine's fine" and buries the five cases that
   break it. The read flatters the hand-roll; the diff adjudicates it. This is
   also how rule 3's tradeoff was *discovered* — you can't decide correctness
   vs. consistency on an axis you didn't know diverged.

## Phase 0 — compiled-binary hygiene (shipped)

Compiled Bun binaries autoload **two** things from cwd, both ahead of
`applyConfigToEnv()` and the `cli/env-scrub.ts` allowlist, so any repo the
user cd's into becomes an injection vector (verified empirically on Bun
1.3.11, the CI-pinned version):

1. **`.env` / `.env.local`** → the binary's own `process.env` (provider keys,
   `PUSH_*` flags). Closed by `--no-compile-autoload-dotenv`.
2. **`bunfig.toml`**, whose `preload` runs **arbitrary code before the CLI
   starts** — remote code execution from a repo-local file, strictly worse
   than the env case. Closed by `--no-compile-autoload-bunfig`. (Caught in
   review by the Codex bot; confirmed a repo-local `bunfig.toml` preload
   executes and that the dotenv flag alone does not stop it.)

Both flags are on every `bun build --compile` invocation (CI + documented
commands); verified that real environment variables still pass through and
the preload no longer runs. The dev path (`dev:cli:bun`) carries the runtime
env equivalent `--no-env-file`; Bun exposes no runtime flag to disable
`bunfig.toml` autoload, but that path runs in the trusted Push checkout, not
an arbitrary user repo, so the distributed-binary threat model does not apply
to it.

## Phase 1 — dev path on Bun (partial: dev script shipped, tests blocked)

`bun cli/cli.ts` boots the full CLI surface today (`dev:cli:bun` script) —
**including the pushd daemon**. The daemon spawn paths (self-heal respawn, TUI
autostart, and `daemon start`) originally keyed loader flags off the entry
*extension*
(`.ts` ⟹ `--import tsx`), which is correct under Node but fatal under Bun:
`bun --import tsx pushd.ts` dies with `Cannot find module './cjs/index.cjs'
from ''` (tsx is a Node-only loader) before pushd's `main()` runs, so a
stale-build drain under `dev:cli:bun` could drain the old daemon but never
respawn — the session silently fell back to inline mode. Fixed by
`cli/daemon-spawn-args.ts`, which selects loader flags by *runtime*: under Bun,
native TS with `--no-env-file` (the same cwd-`.env`-autoload guard Phase 0
applies to the compiled binary) and no tsx; under Node, `--import tsx` for
`.ts`/`.mts` as before. The daemon runs **no** `Bun.*` APIs, so this respects
ground rule 2 (running *under* Bun ≠ *calling* Bun APIs). Known Bun gap: the
relay's `ws` `unexpected-response` handler is unimplemented in Bun, so a
rejected relay dial surfaces differently there.

Tests are the blocker. The `cli-bun-canary` CI job (non-blocking) runs the
full suite under `bun test` on every run and prints a live breakdown to its
step summary. bun reports three **separate** categories, and keeping them
separate is exactly what a first read got wrong (`fail` and `errors` are not
the same bucket, so you cannot subtract one from the other):

- **Local (Bun 1.3.11):** 791 pass / **133 fail** / **100 errors**, Ran 924
  tests across 147 files.
- The **100 errors** are one upstream gap — Bun's `node:test` shim can't run
  `describe()`/`test()` nested inside a `test()`
  ([oven-sh/bun#5090](https://github.com/oven-sh/bun/issues/5090)); each
  affected file throws once during collection, spread across ~100 of the 147
  files, so de-nesting would be a whole-suite rewrite, not a targeted fix
  (measured, not assumed — rule 4).
- The **133 fail are all real per-test divergences** — tests that *ran* and
  failed under Bun (timeouts, the `ws` API gap, spinner rendering). A much
  larger real surface than a first pass suggested.
- **CI collects only 473 of those 924 tests** (140 fail / 139 errors) running
  the identical command — so bun test is **not yet reproducible across
  environments**, a second blocker sitting behind #5090.

Decision: **tests stay on `node --test`** — reinforced, not weakened, by the
measurement: even with #5090 fixed, ~133 real failures and non-reproducible
collection remain. Do not port the suite to `bun:test` to route around an
upstream gap that is actively tracked.

Revisit trigger (now moot — retained as reference for the measurement, not as a
live path): each was made observable by the canary — (1) **errors → 0** (the
#5090 shim lands — necessary but not sufficient); (2) the **fail** count worked
down to ~0; (3) collection stable across local and CI. These gated flipping the
canonical test script and unlocking Phase 2; with Phase 2 dropped (see header)
they no longer gate anything. Tests stay on `node --test` as a standing
decision, not a pending one.

## Phase 2 — utility substitutions (DROPPED 2026-07-15 — runtime-API adoption abandoned)

Once dev + test + prod all run Bun, these replace hand-rolled code
unconditionally (no seams, no fallbacks):

| Bun utility | Replaces | Site |
|---|---|---|
| `Bun.stringWidth()` | `charWidth`/`visibleWidth` Unicode tables | `cli/tui-renderer.ts` |
| `Bun.color(x, "ansi-256")` | `rgbTo256` + ANSI fallback table | `cli/tui-theme.ts` |
| `Bun.sleep()` | duplicated `setTimeout` promise helpers | `cli/provider.ts`, MCP backoff |
| `Bun.randomUUIDv7()` | `randomBytes(3).toString('hex')` IDs | session/daemon ID mints (new IDs only) |
| `Bun.CryptoHasher` | `createHash('sha256'/'sha1')` | opportunistic; `node:crypto` works under Bun |

**The width kernel moves as one coordinated change, not a drop-in.**
Measured parity between `visibleWidth` and `Bun.stringWidth` on a 16-case
TUI corpus: identical on ASCII, ANSI (truecolor + 256), CJK, Hangul,
combining marks, box drawing; divergent on 5 cases — emoji presentation
selectors (`⚠️`: ours 1, Bun 2), non-Pictograph-block emoji (`✅`), ZWJ
sequences (`👩‍👩‍👧`: ours 6, Bun 2), skin-tone modifiers (`👍🏽`: ours 4,
Bun 2), and tab. Bun matches modern terminal rendering (it is more
correct), but `charWidth` is consumed per-codepoint by `truncate`,
`cli/tui-input.ts`, and `cli/tui-selection.ts` — swapping only
`visibleWidth` makes padding math disagree with truncation/cursor math and
produces layout breakage CI can't see while tests run on Node. Replace the
whole kernel (width + truncation + selection walking, grapheme-segmented)
in one PR, under Bun-run tests.

## Explicit non-adoptions

- **`Bun.Glob`** — the only matchers live in `lib/sandbox-policy.ts`
  (shared surface; ground rule 1). If a `cli/`-only glob need appears,
  reconsider.
- **`Bun.file` / `Bun.write`** — the fs contract that matters is atomic
  temp-file + rename (`cli/fs-atomic.ts`); `Bun.write` is not atomic and
  would silently weaken it.
- **`Bun.hash` for `cli/hashline.ts`** — wyhash-family output would change
  persisted/compared hash formats; not worth the compat break. The relevant
  `createHash('sha256')` line-hashing is in `cli/hashline.ts` (CLI-scoped, so
  a Bun swap would be *permitted* by ground rule 1 — it's the format-compat
  break, not the surface rule, that rules it out). Not to be confused with
  `lib/hashline.ts`, the shared edit-application logic, which contains no
  crypto.
- **Bun auto-`.env`** — conflicts with the deliberate config model
  (`~/.push/config.json` + env scrub); disabled at compile (Phase 0).
- **`Bun.semver` / `Bun.deepEquals` / `Bun.which` / `Bun.peek` /
  `Bun.gzipSync` / `Bun.escapeHTML`** — zero call sites in the repo.

## Phase 3 — process spawning (DROPPED 2026-07-15 — runtime-API adoption abandoned)

`Bun.spawn` could subsume `node:child_process` across `cli/shell.ts`,
`cli/git-backend.ts`, `cli/tools.ts`, `cli/pushd.ts` — but that seam is
security-relevant (`lib/git/policy.ts` gating, `cli/env-scrub.ts`).
`node:child_process` works under Bun; there is no forcing function. Keep
`Bun.$` out of the sandboxed-exec path regardless — its quoting/globbing
semantics differ from the policy parser's assumptions.
