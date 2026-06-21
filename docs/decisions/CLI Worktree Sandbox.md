# CLI Worktree Sandbox

Date: 2026-06-21
Status: **Current (Phase 1 shipped)** — `push run --worktree` is implemented;
the interactive surfaces (TUI / REPL) and daemon-orphan GC are tracked Phase 2
below. Owner: Push CLI.

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
- **Lifecycle — "clean if clean, keep if work exists":** on session end the
  worktree is removed (and its throwaway branch deleted) **only** when it has no
  uncommitted changes and no commits beyond its base SHA. Otherwise it is kept
  and its path reported, so unpushed/uncommitted work is never silently
  destroyed. Teardown runs in a `finally`, so an aborted or failed run still
  gets the keep-if-work check; any read failure during the disposability check
  biases toward keeping.
- **Delivery is unchanged:** work in the worktree is committed on its branch and
  shipped through the normal PR flow (`Pushed Branch as Source of Truth`). The
  worktree is disposable compute; the pushed branch is the artifact.

## Why not...

- **An agent-callable `enter_sandbox` tool?** The user chose session-level
  control. An agent deciding its own isolation mid-run is less predictable and
  fights the "cwd is set at session creation" model.
- **Reusing `SandboxProvider`?** That abstraction is web/Cloudflare/Modal
  container isolation. The CLI has the real OS and real git; a worktree is the
  native, zero-infra equivalent. No second consumer ⇒ the helper stays in
  `cli/worktree.ts`, not `lib/` (CLAUDE.md promotion rule).
- **Always remove on exit?** Too dangerous for a real-shell lead — it would
  discard uncommitted work. Persistent named worktrees were the other option but
  accumulate trees the user must GC; clean-if-clean is the safer default.

## Implementation (Phase 1)

- `cli/worktree.ts` — `addWorktree` / `removeWorktree` / `listWorktrees` /
  `worktreeState` / `isDisposableWorktree` / `teardownWorktree`, plus path +
  branch derivation. Git plumbing runs through the exported `makeLocalGitExec`
  (`cli/git-backend.ts`) so it shares the CLI's escaped, timeout-aware exec
  path. Covered by `cli/tests/worktree.test.mjs` against a real temp repo.
- `cli/cli.ts` — `--worktree` / `--worktree-name` parsing, setup before
  `initSession` (worktree path → session cwd), and clean-if-clean teardown
  around the headless run.
- `cli/session-store.ts` — `SessionState.worktree`.

## Phase 2 (tracked, not yet shipped)

- **Interactive surfaces.** Wire `--worktree` into the default TUI and the REPL
  (bare `push` opens the TUI, so Phase 1's headless-only scope misses most
  interactive users). Needs the worktree setup hoisted above the surface
  dispatch and teardown on TUI/REPL exit. `--worktree` currently errors outside
  `push run`.
- **A `/worktree` command** for status (where am I, is it disposable) within a
  running session.
- **Daemon orphan GC.** The daemon should track session→worktree and clean
  disposable orphans on session delete / shutdown via `listWorktrees`.
- **Resume.** Resuming a session whose worktree still exists should re-root in
  it; today `--worktree` refuses `--session`.
