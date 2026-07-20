# REVIEW.md

Repository-specific review guidance for Push. Loaded by the in-app reviewer, the
daemon reviewer, and the autonomous PR review path so all three share one
standard.

Push collapses the mobile dev stack into one conversation — a git tool with the
feel of your everyday AI app — across three surfaces: a web app, an experimental
Capacitor Android shell, and a local CLI, all sharing a role-based runtime in
root `lib/`. Most review value here is **cross-surface consistency**
and **runtime-vs-prompt discipline**, not generic lint. The canonical references
are `AGENTS.md` (startup contract, wins on conflict), `CLAUDE.md`, and
`ARCHITECTURE.md`.

Standard review hygiene — fact-based comments only, no duplicate or
restate-the-code noise, one issue per comment — is assumed. This file covers
what's **specific to Push**: how to weight findings and where the real defects
live.

## Review priorities (in order)

1. **Correctness** — logic errors, unhandled edge cases, race conditions,
   incorrect API usage, data-validation flaws.
2. **Security** — injection (command/XSS/SQL), insecure storage, weak access
   controls, secrets exposure. Pay special attention to `sandbox_exec` command
   construction and anything that interpolates model output into a shell.
3. **Cross-surface consistency** — see "Push-specific focus areas" below. This is
   the most common real defect in this repo.
4. **Efficiency & performance** — bottlenecks, needless work, memory leaks,
   behavior under expected load.
5. **Maintainability** — readability, modularity, idiomatic style. Default to the
   language's idiomatic standard when no style guide is specified.
6. **Testing** — adequate unit/integration coverage and edge cases. New shared
   vocabulary (tools, events, envelopes) requires a drift-detector test in the
   same PR (see below).
7. **Error logging & observability** — effective logging and hooks where they
   matter.

## Severity scale

- 🔴 **Critical** — production failure, security breach, data corruption. Must be
  fixed before merge.
- 🟠 **High** — significant bug or performance degradation. Should be fixed before
  merge.
- 🟡 **Medium** — best-practice deviation or technical debt. Should be considered.
- 🟢 **Low** — minor / stylistic (typos, docs, formatting). Author's discretion.

Mandatory mappings:

- Typos → 🟢
- Adding / improving comments or docstrings → 🟢
- Hardcoded strings/numbers / refactor-to-constant → 🟢
- Test files / test implementation → 🟢 or 🟡
- Markdown (`.md`) files → 🟢 or 🟡

## Push-specific focus areas

These encode the rules that a generic reviewer would miss. Weight them heavily.

### Recurring defect classes

Specific bug shapes that have slipped past review on this repo more than once —
higher-yield than generic lint, and easy to miss without looking for them by
name. (Mirrored from CLAUDE.md's "PR self-review pass"; keep the two in sync.)
Kept first so it survives the reviewer-context size cap.

- **HTTP status classification.** Every `if (status >= 400)` arm should enumerate
  the cases (auth, rate-limit, not-found, validation) and assign each a sensible
  `structuredError.type` / surface code. A 429 may be transient rate limiting or
  terminal quota exhaustion (`exceeded_current_quota_error`, `insufficient_quota`);
  use `lib/quota-errors.ts` as the shared vocabulary. Default fallbacks to
  "everything is sandbox loss" or "everything is unknown" are bugs (see PR #656's
  rate-limit misclassification).
- **`await` in a loop.** Every `await` inside a `for`/`while` must prove it can
  exit on terminal conditions (deadlines, abort signals, event-completion races),
  not just the happy path. A naked `await promiseThatOnlyResolvesOnSuccess` is a
  hang waiting to happen.
- **An `await` that breaks a reservation.** A check-then-write (dedupe, liveness,
  uniqueness) is only a reservation if nothing is awaited between check and
  write. Flag any new insert/claim path whose guard sits above an `await` — an
  invariant documented at one call site does not bind a new path. A Durable
  Object's input gate closes for *storage* ops, not network ones: a concurrent
  request can land across `await fetch(...)`, so "single-threaded" is not the
  guarantee it sounds like. Twice in `pr-review-job-do.ts` (#910, #1515).
- **Fire-and-forget promises.** `(async () => { … })()` and `fn().catch(() => {})`
  swallow errors silently. The returned promise must be awaited somewhere, or the
  failure surfaced via `warn()` / a structured log — not dropped.
- **Silent return paths.** Any `return null` / `return` / `return false` a caller
  can't distinguish from "still in progress" needs a structured log line in the
  same change — one per branch, with paired event names (success ↔ failure ↔
  cap-hit).
- **Config-file secrets.** Scan new diffs in `wrangler.jsonc`, `*.yml`, `.env*`,
  and `secrets/` for account IDs, slugs, tokens, or hardcoded URLs that belong in
  the secret store / dashboard vars / `.dev.vars` — the public repo has leaked
  these before.
- **Error-formatting passthrough.** Upstream content (HTTP bodies, stderr, exec
  output) must be wrapped/escaped, never rendered to a surface verbatim — past
  regressions leaked raw upstream JSON/HTML into the UI.
- **Auth / allowlist asymmetry.** When a change gates a security-sensitive
  resource on one path, grep every other path that touches the same resource and
  confirm the gate is symmetric. Trace at least one denied and one allowed path
  end-to-end.
- **Text-edit primitive boundary cases.** A change to a text-editing primitive
  (hashline, the line model, content (de)serialization) must hold across every
  serialization path: empty file; single line with no trailing newline; one vs.
  multiple trailing newlines; all content deleted → empty; a blank line surviving
  a sibling's deletion; an edit on the last line (EOF); and uniform-LF /
  uniform-CRLF / mixed-ending files. Normalization is lossy-by-default — flag any
  canonicalization that fires without the file proving a single convention, and
  any one-line edit that produces collateral diffs on untouched lines.
- **Hidden-but-interactive elements.** A visually-hidden control still receives
  input unless hit-testing is disabled too. `opacity-0` (and `transform`) leave the
  element in layout and **clickable** — so a hidden action row fires its buttons on
  a blind tap, and a long-press starting over it can reveal-and-click in one
  gesture. Confirm anything hidden-until-hover/reveal gates `pointer-events`
  (`pointer-events-none` at rest, `-auto` only when shown) — or uses
  `visibility`/unmount, which do stop hit-testing.
- **Unreachable from the real caller.** A helper can be correct, fully tested, and
  impossible to reach from production — its unit tests stay green because they
  call it *directly*, so nothing goes red. Two shapes, both shipped here: a
  function with **zero production callers** (`osc52Copy` was written, unit-tested,
  and never wired), and a function whose **only caller filters it out** (a copy
  command that selected `kind === 'message'` rows, making the module's entire
  diff/card path dead code). For any new behavior, find the production entry point
  and check a test drives **that** — not the helper. If no caller can reach the
  code, the tests are a green light on nothing.
- **Unit-of-measure at an encoding boundary.** Bytes, characters (UTF-16 code
  units), and code points are three different numbers, and the wrong one fails
  *silently* — the check passes, the payload doesn't. `String#length` is not a byte
  count: 48k CJK characters are ~144KB of UTF-8, so a size cap measured in
  characters lets an oversized payload through with `truncated: false`, and the
  consumer (terminal, wire protocol, DB column) drops it while the code reports
  success. Cap at the boundary the **consumer** measures, and cut on code-point
  boundaries — slicing at a byte-derived index severs surrogate pairs.
- **Claims asserted but never executed.** Flag any claim in the diff, its tests, or
  its PR body that could have been *run* and evidently was not: "you can `git
  apply` this" (was the patch ever fed to `git apply`? one shipped with no `@@`
  headers), "this path is wired" (does a test drive the production caller, or only
  the helper?), "the cause is X" (was the mechanism reproduced, or inferred from an
  error string?). A named failure mode in a comment is not evidence it was checked
  — several defects here shipped in PRs whose own commit message described the very
  class they contained.

### Consult the canonical docs

Push keeps two canonical references the diff should stay consistent with. Pull
them in when the change touches their domain — the deep reviewer can open the
relevant sections directly; the quick reviewer should treat these as pointers:

- **UI / visual diffs → `DESIGN.md`** — visual tokens, colors, typography,
  components. Flag raw hex / ad-hoc `px` values where a defined token exists, and
  component patterns that diverge from the documented ones.
- **Structural / tool-protocol / repo-session diffs → `ARCHITECTURE.md`** —
  the canonical architecture, tool protocol, and repo/session model. Flag
  changes that contradict the documented contracts.

Drift cuts both ways: if a diff intentionally changes behavior a doc describes,
the **doc must be updated in the same PR**. Flag a landed change that leaves
`DESIGN.md` / `ARCHITECTURE.md` describing the old reality — same discipline as
the decision-doc `Status:` flip below.

### Behavior lives in code, not prompts

If a change adds prompt/doc text to compensate for something the **runtime**
should enforce (validation, routing, safety, correctness), flag it — the fix
belongs in code. Prompts are guidance for cooperating models, not a control
plane. The test: *could a non-cooperating model break this?* If yes, it must be
enforced in code. Legitimate prompt/doc edits only **surface** hard runtime
boundaries (e.g. that the tool-call parser scans `content`, not reasoning
tokens), clarify role contracts, or document quirks models can't infer.

### Shared runtime in `lib/` (no per-surface forks)

Cross-surface semantics live in root `lib/` and are consumed by both web and
CLI. Flag any logic that is duplicated per-surface instead of promoted to `lib/`
the moment a second surface needs it. Web/CLI should converge on the shared
runtime contract, not re-implement it.

### Branch / sandbox state sync

- Raw `git checkout <branch>` / `git switch <branch>` (incl. `-b` / `-c`) are
  **intentionally blocked** in `sandbox_exec`. Branch ops must go through the
  typed tools (`create_branch` / `switch_branch`). Do not "fix" the block by
  re-enabling raw checkout — the issue is HEAD-vs-tracked-branch desync, not
  consent. A single bare operand blocks even when it looks path-shaped, such as
  `git checkout src/utils.ts`, because `checkout` does not disambiguate branch
  and path intent without `--`.
- File restores must use the explicit form: `git checkout -- <path>` or
  two-positional `git checkout HEAD <path>`. Ref expressions (`HEAD~1`, `main^`,
  `branch@{upstream}`) are expected to pass through.
- `git branch -m` / `-M` / `--move` is **blocked outright** (`branch-rename`,
  no `allowDirectGit` escape) — renaming the checked-out branch is the same
  desync class. Other `git branch` forms (list / create / delete / upstream)
  are expected to pass the policy.
- Typed branch tools and warm-path branch changes preserve the sandbox; only bare
  UI branch swaps that bypass the typed tools/warm path restart it. Changes that
  alter `skipBranchTeardownRef` teardown suppression in
  `WorkspaceSessionScreen.tsx` / `useWorkspaceSandboxController.ts` need scrutiny.

### Tool-call per-turn budget

The dispatch contract: read-only calls run in parallel (cap 6); pure file
mutations run sequentially as one batch (cap 8); a trailing chain of up to **3**
side-effecting calls (`sandbox_exec`, commit/push, delegation, workflow dispatch)
runs sequentially with fail-fast (`MAX_SIDE_EFFECT_CHAIN`,
`lib/tool-call-grouping.ts`). Flag changes that violate ordering or sneak in extra
side effects — these should be rejected with structured errors, not silently
allowed.

### Delivery rules

- Web/cloud delivery uses **Gate-at-Push**: local `sandbox_commit` is silent, and
  `prepare_push` / direct `sandbox_push` audit the cumulative push diff. CLI/daemon
  `git_commit` retains the pre-commit **Auditor** SAFE/UNSAFE gate (defaults to
  UNSAFE on error — don't weaken that default).
- Reviewer is advisory; only PR-backed branch-diff reviews post back to GitHub.
- Merges go through the **GitHub PR flow** only — Push never runs local
  `git merge`. Flag any code path that introduces a local merge.

### Provider routing

The chat locks the Orchestrator provider/model on first send; delegated Coder
and Explorer runs **inherit** that lock; Reviewer keeps its own sticky
selection; Auditor follows the chat lock when present, else the active backend.
Flag changes that break these inheritance rules.

### Decision-doc discipline

If a PR ships something specified under `docs/decisions/`, it must flip that
doc's `Status:` field in the same PR. Flag landed implementations that leave
their spec at "Draft". See `docs/decisions/README.md` for the label vocabulary.

### New-feature checklist (cross-surface work)

1. **Storage keys are CLI-first.** Durable identifiers (`repoFullName + branch`)
   beat per-session ones. Web `chatId` is durable but CLI `sessionId` is
   per-run, so chatId-shaped keys break cross-run retrieval on CLI. Shared stores
   need their scope resolver in `lib/` from day one.
2. **Background tasks name their coordinator's home first.** New feature hooks
   ship as siblings under `app/src/hooks/` or `app/src/lib/`, not appended to
   `useChat.ts` (guarded by a `max-lines` ESLint rule).
3. **One source of truth per vocabulary.** Any new tool, event, or envelope type
   needs a single canonical definition **and** a drift-detector test in the same
   PR — tool-protocol drift via `cli/tests/daemon-integration.test.mjs`,
   event/envelope drift via `cli/tests/protocol-drift.test.mjs`. Extend
   `lib/capabilities.ts` for shared capability tables.

## Validation expectations

PRs should keep these green (canonical commands in `AGENTS.md`):

- **Test:** `TMPDIR=/tmp TEMP=/tmp TMP=/tmp pnpm run test:cli && pnpm run test:mcp:github` (web: `cd app && pnpm test`)
- **Typecheck:** `pnpm run typecheck:all` (all surfaces run TS 7.0 GA `tsc`; the
  app gets it via the `typescript-go` alias, `node node_modules/typescript-go/lib/tsc.js`)
- **Lint/format:** `pnpm run lint` (ESLint, app-scoped) / `pnpm run format:check`
  (Biome). Biome's linter is intentionally disabled repo-wide; don't flag that as
  a gap. `app/src/components/ui/**` is shadcn — leave it alone.

Confirm the PR's declared **Type** and **Scope** (`.github/PULL_REQUEST_TEMPLATE.md`)
match the actual diff.
