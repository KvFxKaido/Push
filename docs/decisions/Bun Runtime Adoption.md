# Bun Runtime Adoption

Date: 2026-07-04
Status: **Draft** — the guardrails and Phase 0/1 below are shipped; Phases 2–3
are design-in-motion pending the upstream `node:test` gap and need roadmap
promotion before implementation. Owner: Push CLI.

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

## Phase 0 — compiled-binary hygiene (shipped)

Compiled Bun binaries auto-load `.env` / `.env.local` from cwd into their own
`process.env` (verified empirically on Bun 1.3.11, the CI-pinned version).
That injection lands ahead of `applyConfigToEnv()` and the `cli/env-scrub.ts`
allowlist, so any repo the user cd's into could seed provider keys or
`PUSH_*` flags into the `push` process. Fixed by
`--no-compile-autoload-dotenv` on every `bun build --compile` invocation
(CI + documented commands); verified that real environment variables still
pass through. If the dev path later runs `bun cli/cli.ts` in untrusted cwds,
the runtime equivalent is `--no-env-file`.

## Phase 1 — dev path on Bun (partial: dev script shipped, tests blocked)

`bun cli/cli.ts` boots the full CLI surface today (`dev:cli:bun` script).
Tests are the blocker, measured on Bun 1.3.11 against the full suite:

- `bun test --preload ./cli/tests/setup-test-home-isolation.mjs
  cli/tests/*.test.mjs`: **687 pass, 137 fail, 121 errors** across 824
  tests / 146 files.
- The dominant failure is one upstream gap: Bun's `node:test` shim rejects
  `describe()` nesting patterns this suite uses
  ([oven-sh/bun#5090](https://github.com/oven-sh/bun/issues/5090),
  `ERR_NOT_IMPLEMENTED`).

Decision: **tests stay on `node --test`**; do not port 146 files to
`bun:test` to route around an upstream gap that is actively tracked.
Revisit trigger: a Bun release where the command above goes green — then
flip the canonical test script, make Bun the dev default, and unlock
Phase 2.

## Phase 2 — utility substitutions (blocked on Phase 1)

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
  persisted/compared hash formats; not worth the compat break.
- **Bun auto-`.env`** — conflicts with the deliberate config model
  (`~/.push/config.json` + env scrub); disabled at compile (Phase 0).
- **`Bun.semver` / `Bun.deepEquals` / `Bun.which` / `Bun.peek` /
  `Bun.gzipSync` / `Bun.escapeHTML`** — zero call sites in the repo.

## Phase 3 — process spawning (optional, last)

`Bun.spawn` could subsume `node:child_process` across `cli/shell.ts`,
`cli/git-backend.ts`, `cli/tools.ts`, `cli/pushd.ts` — but that seam is
security-relevant (`lib/git/policy.ts` gating, `cli/env-scrub.ts`).
`node:child_process` works under Bun; there is no forcing function. Keep
`Bun.$` out of the sandboxed-exec path regardless — its quoting/globbing
semantics differ from the policy parser's assumptions.
