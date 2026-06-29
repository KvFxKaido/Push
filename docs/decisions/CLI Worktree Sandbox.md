# CLI Worktree Sandbox

Date: 2026-06-21
Status: **Current** — `--worktree` is wired across headless `push run`, the
default TUI, and the REPL, with a `/worktree` status command and
resume-into-worktree. The only deferred piece is lazy daemon orphan-GC (see
Phase 3 below). Owner: Push CLI.

## Problem

Every Push surface targets the same single conversational lead, and the
CLI/daemon is that lead "with more reach": real filesystem, real shell, no
sandbox. The flip side is that the CLI lead has **no isolation** — it edits the
user's actual working tree. The web/Modal surfaces get container isolation for
free via `SandboxProvider`; the local lead gets nothing. A risky autonomous run
(`push run`) mutates the real checkout in place.

Borrowed from Forge's `--sandbox`: give the local lead an opt-in, OS-native git
worktree + dedicated branch to work in, so an autonomous run is decoupled from
the user's branch and uncommitted changes, and lands as a reviewable branch
diff. This fits Push's existing model — one active branch per session, raw
`git checkout`/`switch` already blocked, work delivered through the PR flow.

## Decision

A session-level opt-in (not an agent-callable tool — isolation is the user's
call, decided at session start), with a clean-if-clean lifecycle.

- **Entry:** `push run --worktree` (auto-named branch `push/sandbox-<stamp>`) or
  `push run --worktree-name <name>` (custom branch). `--worktree` is a boolean,
  not a value-taking flag, to dodge the documented `parseArgs` `strict:false`
  footgun where a bare string option swallows the next argv token.
- **Isolation mechanism:** the worktree directory becomes the session `cwd`.
  Every CLI tool already resolves against `state.cwd`, so nothing else needs to
  change — reads, writes, `exec`, and `git_commit` all land in the worktree.
  `SessionState.worktree` persists `{ path, branch, baseSha, repoRoot }`.
- **Lifecycle — "remove if recoverable, keep if work could be lost":** on
  session end the worktree is removed (and its throwaway branch deleted) when it
  is clean **and** holds nothing unrecoverable — either no commits beyond its
  base SHA, or every commit beyond base is already on `origin/<branch>` (a clean
  fully-pushed branch is re-fetchable, so reclaiming it loses nothing). It is
  kept and its path reported whenever it is dirty or has unpushed commits, so
  unpushed/uncommitted work is never silently destroyed. The keep/remove verdict
  is the pure `decideWorktreeDisposal` in
  [`lib/git/worktree-disposal.ts`](../../lib/git/worktree-disposal.ts); the older
  "any commits beyond base ⇒ keep" rule never reclaimed pushed branches, so
  worktrees accumulated under `~/.push/worktrees`. Teardown runs in a `finally`,
  so an aborted or failed run still gets the disposability check; any read
  failure during it biases toward keeping.
- **Delivery is unchanged:** work in the worktree is committed on its branch and
  shipped through the normal PR flow (`Pushed Branch as Source of Truth`). The
  worktree is disposable compute; the pushed branch is the artifact.

## Why not...

- **An agent-callable `enter_sandbox` tool?** The user chose session-level
  control. An agent deciding its own isolation mid-run is less predictable and
  fights the "cwd is set at session creation" model.
- **Reusing `SandboxProvider`?** That abstraction is web/Cloudflare/Modal
  container isolation. The CLI has the real OS and real git; a worktree is the
  native, zero-infra equivalent. The worktree *plumbing* stays in
  `cli/worktree.ts`; only the keep/remove *decision* moved to
  `lib/git/worktree-disposal.ts` once the web sandbox-reclaim path became its
  second consumer (CLAUDE.md promotion rule).
- **Always remove on exit?** Too dangerous for a real-shell lead — it would
  discard uncommitted or unpushed work. Persistent named worktrees were the
  other option but accumulate trees the user must GC; remove-if-recoverable is
  the safer default — it reclaims clean fully-pushed branches without ever
  discarding work that isn't on the remote.

## Implementation

**Phase 1 — plumbing + headless.**

- `cli/worktree.ts` — `addWorktree` / `removeWorktree` / `listWorktrees` /
  `worktreeState` / `isDisposableWorktree` / `teardownWorktree` /
  `formatWorktreeStatus`, plus path + branch derivation. Git plumbing runs
  through the exported `makeLocalGitExec` (`cli/git-backend.ts`) so it shares
  the CLI's escaped, timeout-aware exec path. Covered by
  `cli/tests/worktree.test.mjs` against a real temp repo.
- `cli/session-store.ts` — `SessionState.worktree`.

**Phase 2 — interactive + ergonomics.**

- **All surfaces.** `--worktree` / `--worktree-name` work for headless
  `push run`, the default TUI (bare `push`), and the REPL. Worktree setup runs
  once before `initSession` (worktree path → session cwd); a single
  `try/finally` around the whole dispatch in `main()` applies clean-if-clean
  teardown on any exit. `return await` on each surface keeps it inside the
  `try` until it actually exits — without the `await` the `finally` would fire
  the instant the promise was created. Interactive `--worktree` requires a TTY
  (the no-TTY/no-task path `process.exit`s, skipping the finally), so it's
  refused up front there rather than leaking a worktree.
- **`/worktree` command** (REPL + TUI) — read-only status: path, branch, work
  state, and what teardown will do. Shares `formatWorktreeStatus`.
- **Resume-into-worktree.** Resuming a session whose persisted `worktree` still
  exists re-roots `cwd` there and re-arms teardown; if it was cleaned up since,
  the stale pointer is dropped and the session continues in the main tree.
  `--worktree` itself still refuses `--session` (it *starts* a sandbox).

## Phase 3 (deferred)

- **Lazy daemon orphan-GC.** A worktree is normally torn down by the owning
  process's `finally`. A hard-killed process (SIGKILL) can orphan one. This
  should be GC'd lazily — remove a sandbox worktree only when its session state
  no longer exists on disk — **not** on daemon shutdown, since a daemon restart
  is not a session end and must not delete a user's (clean) worktree.
  `listWorktrees` + a session-existence check is the shape; not yet built.
