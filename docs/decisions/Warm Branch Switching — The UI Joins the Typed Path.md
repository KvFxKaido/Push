# Warm Branch Switching — The UI Joins the Typed Path

Date: 2026-06-12
Status: **Draft** — scoped, nothing built. Pairs with (and deliberately
precedes) branch-desync *detection*: shipping this removes the last
legitimate reliance on teardown-as-guard, so detection lands into a clean
field. Sequencing rationale at the bottom.
Owner: Push

## Problem

Branch switching has two classes of citizen, and the human is the lower one.

The **model's** path (slice 2, `sandbox_switch_branch`): a real `git switch`
in the sandbox with structured errors, shallow-fetch fallback, file-cache +
ledger invalidation, a `branchSwitch { kind: 'switched' }` payload that
routes the chat to the target branch's conversation (auto-creating one if
needed), and `skipBranchTeardownRef` so the long-running container survives.

The **UI's** path (`WorkspaceHubSheet` branch dropdown → confirm →
`onSwitchBranch` → `App.handleSetCurrentBranch`): a pure state write. No git
operation. The only thing keeping tracked state and sandbox HEAD coherent is
the `useWorkspaceSandboxController` effect that watches
`workspaceRepo.current_branch` and **tears the sandbox down** when it
changes without the skip flag. The next start cold-clones on the new branch.

That teardown was the honest option when it was built — pre-slice-2, a UI
switch had no governed path, and restart guaranteed consistency. Slice 2.1
already disproved the constraint for *forking*: `forkBranchFromUI` routes the
"New Branch from Here" button through the same typed tool call the model
emits, and the sandbox survives. The plain switch never got the same upgrade.
The result is a fossil with real costs:

- **Cold restart per hop.** Clone + deps on every UI branch change, on the
  product's most latency-sensitive surface (mobile). `auto-branch-on-commit`
  (Single-Agent Loop step 2) makes branches cheap and plentiful, which makes
  branch-hopping routine, which makes teardown-per-hop a growing tax.
- **Uncommitted work is destroyed implicitly.** The teardown "handles" the
  dirty tree by discarding it — destructive *and* invisible. The hub's
  confirm dialog softens this, but the choice it offers is "lose the sandbox
  or don't switch," not a real decision about the work.
- **Asymmetric trust.** The model gets a warm, context-preserving switch; the
  human gets the punitive path. The guard exists to protect against
  *ungoverned* HEAD movement — a UI switch routed through the typed
  operation is governed, so the guard protects against nothing.

## Decision

> The UI branch switch routes through the **same typed switch operation the
> model uses** — warm by default, sandbox preserved, chat routed by the same
> `branchSwitch` dispatch — with the dirty tree handled by **explicit
> choice** instead of implicit destruction. The cold restart stops being a
> guard and becomes a deliberate tool ("clean switch") in the same menu.

Friction moves from hidden-punitive (cold start, work maybe gone) to
visible-informative (you have uncommitted changes — decide).

## Design

### New helper: `switchBranchInWorkspace`

Sibling of `forkBranchInWorkspace` (`app/src/lib/fork-branch-in-workspace.ts`
— same module or a sibling file): calls
`executeSandboxToolCall({ tool: 'sandbox_switch_branch', args: { branch } })`,
returns `{ ok, branchSwitch?, errorMessage? }` with the same
structured-error-first message cleaning. **Why route through the tool:** the
slice-2 rationale verbatim — the migration dispatcher, cross-tab markers, and
chat auto-create all fire exactly as they do for a model-initiated switch. No
second implementation.

`useChat` gains `switchBranchFromUI` mirroring `forkBranchFromUI`: call the
helper, forward `branchSwitch` to `applyBranchSwitchPayload`. The payload's
`kind: 'switched'` routing (existing) takes the user to the target branch's
chat. `runtimeHandlers.onBranchSwitch` → the existing
`handleSandboxBranchSwitch` sets `skipBranchTeardownRef` + `setCurrentBranch`
— from the controller's perspective a UI switch becomes indistinguishable
from a sandbox-initiated one. **Zero controller changes.** The teardown
effect remains, demoted to a backstop for any unrouted writer — defense in
depth, not the primary mechanism.

### The dialog becomes a real decision surface

The hub's existing switch-confirm dialog (`switchConfirmBranch` state)
upgrades from "are you sure?" to a state-aware choice. Pre-check the tree
(`sandbox_diff` or a status probe; "unknown" treated as dirty):

- **Clean tree:** primary action **Switch** (warm, sandbox preserved);
  secondary **Clean switch** (today's teardown → cold start on target).
- **Dirty tree:** primary **Switch and carry changes** (attempt
  `git switch`; on a checkout conflict the structured error surfaces with
  the conflict reason and the dialog re-offers Clean switch); secondary
  **Clean switch (discards N changed files)** with the count stated;
  **Cancel**.
- **No sandbox running:** plain state write, as today — nothing to preserve,
  next start clones the target branch. (Unchanged behavior, now explicit.)
- **Warm switch fails on transport/sandbox-loss:** fall back to offering the
  clean switch. Availability never regresses below today.

### Writer audit

`setCurrentBranch` writers and their dispositions:

| Writer | Disposition |
|---|---|
| `WorkspaceHubSheet` branch dropdown | → `switchBranchFromUI` (this doc's core) |
| `RepoChatDrawer` (2 sites: branch row, chat-row jump) | → same helper when a sandbox is live for the active repo; plain write otherwise |
| `BranchCreateSheet` | already superseded in spirit by `forkBranchFromUI`; audit whether it still has a live path, route or retire |
| Launcher / pre-session picks (no sandbox) | plain state write, unchanged |

### What this deliberately does NOT change

- The raw `git checkout` / `git switch` **block in `sandbox_exec`** stays —
  it's intent routing into the typed tools, and the typed tools are exactly
  what this doc doubles down on.
- Branch-scoped chats, the merge flow (`mergeBranchInUI`), fork flow.
- The controller teardown effect (kept as backstop).
- The sandbox-side `switchBranch` plumbing (branch-only semantics,
  shallow-fetch fallback, cache/ledger invalidation) — reused as-is.

## Open questions

1. **Stash as a third dirty-tree option.** `git stash push -u` tagged
   `push/<timestamp>` before switching would make "carry failed" recoverable
   instead of a dead end. Recommendation: **defer to v1.1** — v1's
   carry-attempt + honest conflict error + clean-switch fallback already
   strictly dominates today's behavior, and stash lifecycle (where surfaced?
   auto-pop on return?) deserves its own thought.
2. **Cross-branch untracked contamination.** Warm switches share untracked/
   ignored state (stale `node_modules` against a different lockfile).
   Recommendation: v1 ships nothing; if it bites, a post-switch toast when
   the switch diff touches a lockfile. The model path has lived with this
   since slice 2 without incident.
3. **Should clean-switch snapshot uncommitted work first?** Belongs to the
   Main-as-Scratchpad snapshot story, not here — defer to that track.
4. **TUI/CLI parity.** The CLI has no equivalent teardown (local filesystem,
   no sandbox lifecycle), so nothing to do — noted so nobody goes looking.

## Implementation plan (one PR)

1. `switchBranchInWorkspace` helper + `useChat.switchBranchFromUI` (mirror
   the fork pair; unit tests mock `executeSandboxToolCall`).
2. Hub dialog semantics + dirty probe + failure fallbacks.
3. Writer audit per the table (incl. the `BranchCreateSheet` liveness check).
4. Pins: a confirmed warm switch never calls `stopSandbox` (controller skip
   path — extend the existing controller tests); `branchSwitch` round-trip
   routes to the target branch's chat; dirty-tree conflict surfaces the
   structured error and the dialog's fallback; no-sandbox path unchanged.

## Sequencing with desync detection

This ships **first**, by design: it converts the dominant legitimate source
of "teardown as consistency guard" into governed typed-path traffic. The
follow-up (branch stamped on exec result envelopes, post-exec comparison at
the dispatch seam, reconcile-toward-sandbox-HEAD + `branch_desync` event)
then covers everything enumeration can't — `rebase`, `bisect`, scripts,
aborted merges — as a detector over a system whose *intended* transitions
all flow through one path. Detection lands as its own doc/PR once this bakes.
