# Branch Desync Detection

Date: 2026-06-12
Status: **Current**
Owner: Push

## Problem

Push now routes intended branch transitions through typed tools:
`sandbox_create_branch` and `sandbox_switch_branch`. The raw `git checkout`
and `git switch` paths are blocked inside `sandbox_exec` so cooperative branch
changes use the governed path.

That still does not cover every way sandbox HEAD can move. Commands like
`git rebase`, `git bisect`, aborted merges, or repo scripts can leave the
sandbox on a different branch than Push's tracked `current_branch`. Without
detection, Push can silently keep targeting one branch while the sandbox is
actually on another.

## Decision

Every `sandbox_exec` result may carry a best-effort branch stamp: the
workspace's git branch after the command completes. The web app compares that
stamp with Push's tracked branch at the dispatch seam.

If the stamp is present, differs from tracked `current_branch`, and is not
`HEAD`, the sandbox is treated as ground truth. Push reconciles toward the
sandbox branch through the same governed branch-switch handler path used by
typed switches, so the sandbox is not torn down and branch-scoped chats route
as if a `kind: 'switched'` branch-switch payload had arrived.

If the stamp is `HEAD`, Push surfaces the desync but does not reconcile: there
is no branch name to track.

## Runtime Contract

- `ExecResult` includes optional `branch?: string`.
- Cloudflare sandbox exec stamping reads the branch after command completion.
  Detached HEAD stamps the literal string `HEAD`.
- The Cloudflare background-exec completion path carries the stamp through
  `exec-status`, because web `sandbox_exec` consumes detached exec results.
- Buffered Cloudflare `exec()` is stamped too while that path still exists.
- Missing stamps skip detection. Modal may omit stamps for now.
- Stamp-read failures never fail the command. They emit a structured worker
  log and omit `branch`.

## Web Reconciliation

Detection runs at both web seams that execute `sandbox_exec` for the lead:

- **Orchestrator round loop** (delegated mode): `applyPostExecutionSideEffects`
  in `chat-send-helpers.ts` checks every sandbox_exec result.
- **Inline lead lane** (the default mode): kernel-led turns never pass through
  the orchestrator dispatch seam, so the stamp is teed out of the kernel's
  sandbox executor closure (`runInPageCoderKernel`'s bindings →
  `onSandboxExecBranch`) and handled by the same module.

Both call into `branch-desync.ts`; the decision logic is shared.

On a stamped `sandbox_exec` result:

- `branch` missing: no-op, no event.
- `branch === current_branch`: no-op.
- `branch === "HEAD"` and tracked branch differs: emit/surface only.
- Any other differing branch: emit/surface, then apply a synthetic
  `branchSwitch { kind: "switched" }` payload toward the sandbox branch.

The reconcile path must use the existing governed handler path
(`skipBranchTeardownRef` + `setCurrentBranch`) so reconciliation never tears
down the live sandbox.

## Events and Logs

Push emits a `branch_desync` run event:

```ts
{ expected: string; actual: string; command: string }
```

The UI surfaces the outcome visibly:

- Reconciled: `Sandbox moved to <branch> (was <expected>) — Push followed.`
- Detached: `Sandbox moved to detached HEAD (was <expected>) — Push did not change branches.`

Structured logs use one JSON line for each detected outcome:

- `branch_desync_detected_reconciled`
- `branch_desync_detected_detached`
- Worker-side stamp failures: `sandbox_exec_branch_stamp_failed`

Stamp absence is silent by design.

## Non-goals

- No detection inside **delegated** in-page Coder runs or background CoderJob
  DO runs. Whether a delegated run's HEAD movement should reconcile the
  foreground UI mid-delegation is an open design question — the delegated arc
  deliberately leaves the tee callback undefined.
- No reconcile on detached HEAD.
- No forcing the sandbox back to Push's tracked branch. The sandbox is ground
  truth after a completed command.
- No hard dependency on branch stamps. The stamp is best-effort.
- No Modal provider stamp in this slice.
