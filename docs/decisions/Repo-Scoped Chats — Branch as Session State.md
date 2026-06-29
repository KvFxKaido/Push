# Repo-Scoped Chats — Branch as Session State

Date: 2026-06-29
Status: **Draft** — proposed; no code yet. Owner: Push web/runtime.
Tracking: [#1255](https://github.com/KvFxKaido/Push/issues/1255) (sequencing).

Related: the warm UI branch-switch + branch-desync work (the *follow* this keeps and makes
load-bearing); Branch Moments (the transcript moments + out-of-band merge detection this reuses);
[`No-Repo Mode — Sandbox-Free, Local-First.md`](<No-Repo Mode — Sandbox-Free, Local-First.md>)
(the parallel single-lane / repo-only simplification).

## Motivation

The git policy and the chat model are the product of an **unfinished transition** from *locked
branches* (one tracked branch per chat, navigation gated to typed tools, the delegated org-chart)
toward a *free-flow style that stays off main*. Today a chat is **branch-scoped**: `conv.branch` is
the chat's identity, and changing branches **migrates the chat** between per-branch chats through an
elaborate machinery (cross-tab markers, in-tab guards, atomic backfill — carrying a string of
R10/R12 race fixes).

Two real workflows, both **main-centric**, justify dropping it:

- **Local:** main is home base; any change branches, work happens on the branch, a PR merges it back
  to main; occasionally a trivial doc/fix is pushed straight to main.
- **Cloud:** one task per chat — work to merge, then start a new chat.

Neither ever integrates *work-branch into work-branch* locally; integration is always the PR to the
base. So the navigation these workflows want is: pick a starting branch, switch freely, and have a
**merge land you on the base and fast-forward the sandbox there** — all inside one conversation.

**The shift:** drop branch-scoping. A chat is **repo-scoped**; the branch is **mutable session
state** that follows sandbox HEAD. "Stays off main" is enforced by *auto-branch-on-commit*, not by
branch-scoping the chat.

## Context — current state (grounded)

- **The payload.** `BranchSwitchPayload` (`app/src/types/index.ts:459`) has four kinds:
  - `forked` (create_branch) → migrate the active chat onto the new branch.
  - `merged` (merge detected) → migrate the chat back to the default branch.
  - `carried` (`carry_chat`) → migrate the chat onto an existing branch.
  - `switched` (switch_branch) → **light path**: just fire `onBranchSwitch`; no migration.
- **The migration heart.** `applyBranchSwitchPayload` (`app/src/lib/branch-fork-migration.ts:84`)
  splits on kind: `forked`/`merged`/`carried` run the heavy path (`:88–178`) — a cross-tab
  migration marker (`branch-migration-marker.ts`), the in-tab `skipAutoCreateRef` guard, a per-
  message `branch` backfill for provenance, `conv.branch = payload.name`, and a transcript divider
  event. `switched` just calls `onBranchSwitch(name)` (`:91`).
- **The race coordination.** `useBranchForkGuard.ts` + the marker exist *only* to keep the migration
  from racing `useChatAutoSwitch.ts`'s auto-select / **auto-create-the-branch's-chat** effect.
- **The warm follow (keep this).** `handleSandboxBranchSwitch` (`WorkspaceSessionScreen.tsx:145`)
  sets `skipBranchTeardownRef = true` then `setCurrentBranch`; the controller effect
  (`useWorkspaceSandboxController.ts:193`) sees the flag and **skips teardown** — the sandbox
  survives. UI-initiated swaps (no flag) cold-restart by design.
- **The desync reconcile (keep this).** `branch-desync.ts` stamps post-exec HEAD via
  `git symbolic-ref` (`worker-cf-sandbox.ts:988`), compares to the tracked branch, and on a mismatch
  routes through `applyBranchSwitchPayload` to follow it.
- **Merge: detection exists, action is the old model.** `merge_pr` is GitHub-API-only
  (`github-tool-core.ts:2158`) — it never touches the sandbox. The out-of-band detection
  (`merge-detected-banner-state.ts`, branch-gone at `github-tools.ts:316`, the `branch_merged`
  moment at `MessageBubble.tsx:703`) drives `MergeDetectedBanner`, whose action is a **user-clicked,
  cold-restart, hardcoded-to-`defaultBranch`, chat-migrating** "Continue on main?"
  (`MergeDetectedBanner.tsx:41`).
- **Off-main enforcement already exists.** `sandbox_commit` does *pre-commit hook + auto-branch off
  main* (CLAUDE.md delivery rules / the #772 persistence model); uncommitted work on main is captured
  to a `draft/auto/<branch>` ref by auto-back.

## Decision

1. **A chat is repo-scoped; the branch is mutable session state.** `conv.branch` stops being identity
   and becomes the chat's *current* branch, updated on every change to follow sandbox HEAD.
2. **All four `BranchSwitchPayload` kinds collapse into one "branch changed → update state" signal**
   — the existing `switched` light path becomes the only path. No migration, no auto-create, no
   cross-tab coordination.
3. **Keep `message.branch` stamps.** They cost little and preserve the timeline story so a branch
   moment can read "this happened on `feat/x`." (Decided — the one open fork, chosen to keep.)
4. **Merge lands you on the base and fast-forwards the sandbox.** On merge (model-driven `merge_pr`
   emitting a signal directly, or the out-of-band detection as fallback): warm-`switch` the sandbox
   to the **PR base** (not hardcoded `defaultBranch`) → **`git fetch`/`pull --ff-only`** to
   `origin/<base>` → set `conv.branch = base`. FF-only so a divergence *surfaces* instead of silently
   merging (this also closes the `git pull` merge hole in this path). Guard the switch against an
   unexpectedly dirty tree.
5. **"Stays off main" stays enforced by auto-branch-on-commit**, not by chat scope. A commit on main
   silently branches off; uncommitted work is captured to a draft ref. Optionally name the auto-branch
   from the conversation (a small upgrade over the auto-named retroactive branch).

## Build ledger — delete / keep / change

**Delete (the migration machinery — exists only to move chats between per-branch chats):**
- The `forked`/`merged`/`carried` heavy path in `branch-fork-migration.ts` (keep only the
  `onBranchSwitch` light branch — it becomes the whole function).
- `useBranchForkGuard.ts`, `branch-migration-marker.ts`, `skipAutoCreateRef` — the race coordination.
- `useChatAutoSwitch.ts` — auto-select / auto-create the branch's chat (no per-branch chats remain).
- `carry_chat` verb + the `'carried'` kind.
- The merge banner's *"Continue on X?"* migration prompt.

**Keep / repurpose:**
- Warm-follow (`skipBranchTeardownRef`, `handleSandboxBranchSwitch`, controller skip-teardown) —
  becomes load-bearing for *every* switch.
- Desync reconcile (`branch-desync.ts`) — keep; now a pure state update, no migration.
- Branch moments (`branch_forked` / `branch_merged` events) — keep as passive timeline annotations.
- Merge detection (`merge-detected-banner-state.ts`) — keep as the *trigger*; swap its action to the
  switch-to-base + FF in Decision 4.
- `create_branch` / `switch_branch` tools — keep; they emit only "branch is now X."
- `message.branch` stamps — keep (Decision 3).

**Change (the UI — branch: identity → live state):**
- Routing/listing (`App.tsx`, `WorkspaceChatRoute.tsx`, `workspace-chat-route-builders.ts`,
  `RepoChatDrawer`) — chats key on **repo**, not repo+branch.
- Branch picker (`ComposerDraftScreen`, `BranchForkSheet`) → a *starting-branch* choice at creation +
  an *in-session switcher* (calls `switch_branch`, updates state in place). `BranchForkSheet` likely
  deletes.
- Branch indicator — promote to a live, prominent display of the active branch.

## Sequencing

1. **Collapse 4 kinds → 1 + delete the guard/marker/auto-switch trio.** Internal, CI-testable, and it
   subtracts the most race-prone code in the app *first*. The branch change becomes a state update.
2. **Repo-key the routing/UI.** The riskier half — ~20 files read `conv.branch` / route by branch.
   Branch picker → starting-choice + in-session switcher; indicator → live state.
3. **Swap the merge action to switch-to-base + FF-only** (Decision 4). Trivial once the migration it
   used to compete with is gone; `merge_pr` emits the signal, detection is the fallback.

## Out of scope (deferred, not rejected)

- **Local `merge` / `rebase` / `cherry-pick` reconcile** — the commit-level (same-branch HEAD-move)
  follow. The two workflows integrate via PR-to-base, never locally, so this isn't needed; the policy
  blocks that remain are inert, not friction.
- **Delegated-run branch reconcile** — explicitly dropped: the direction is away from delegated
  coding (outside larger tasks), and switching during a delegated task isn't a wanted workflow.
- **Trivial direct-to-main shortcut for models** — whether a model gets a sanctioned "skip the
  branch+PR for a one-liner" path (Protect-Main-gated) is a separate question; today it's the user's
  manual escape hatch.

## Status flip plan

Flip **Draft → Current** when sequencing steps 1–2 land and a chat survives a `branch → work → merge →
back-to-base` loop in one conversation without re-routing, with the sandbox warm throughout. Fold the
durable parts into the platform/sessions decision doc once the model stabilizes.
