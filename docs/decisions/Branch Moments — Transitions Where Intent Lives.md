# Branch Moments — Transitions Where Intent Lives

Date: 2026-06-13
Status: **Current** — delivered; §1 (commit-card chips), §2 (out-of-band merge banner, PR B), and §3 (carry verb, PR A) shipped.
Owner: Push

## Problem

Warm switching (#912) and desync detection (#913) made branch transitions
safe and governed. They did not make them *reachable*. Three gaps, all the
same shape — the intent arises at a **moment** in the conversation, but the
affordance lives in a **place** outside it (or nowhere):

1. **The commit moment.** You just committed; the result card is in front of
   you; you want to switch away or branch off. Today that means leaving the
   transcript for the workspace hub (reached through the diff affordance) and
   finding the branch dropdown. The door is governed but it's in the wrong
   wall.
2. **The out-of-band merge.** You merge the branch's PR from another surface
   (GitHub app, another device, a different Push session). Push never sees
   it — `kind: 'merged'` payloads are only produced by the in-app merge flow
   (`mergeBranchInUI`, `useChat.ts:867`). The chat stays scoped to a merged,
   probably-deleted branch. Worse: every way to leave is `kind: 'switched'`,
   which routes to the *target branch's* chat and strands the conversation
   where the work happened. The migration machinery that would carry it
   exists; only the in-app merge button can invoke it.
3. **The model has no carry verb.** "I merged it from my phone — let's
   continue on main" said to the model today produces a plain switch:
   silently the leave-the-chat-behind behavior, the opposite of the stated
   intent. The typed tools can only emit `forked` and `switched`; there is no
   model-reachable way to migrate a conversation to an existing branch.

## Decision

> Branch transitions become **moment-anchored producers** composing into the
> one existing dispatcher (`applyBranchSwitchPayload`). Three additions:
> contextual actions on the commit result card, an out-of-band-merge banner
> that offers the migration the in-app merge already performs, and a
> `carry_chat` arg on the typed switch tool so the model can express
> "continue this conversation there." No new transition machinery — new
> doors into the machinery #911–#913 built.

The workspace hub keeps its switch dialog unchanged and demotes naturally to
orientation + no-model escape hatch. Nothing is deleted.

## Design

### 1. Commit-card actions (the moment after a commit)

The transcript card rendered for `sandbox_prepare_commit` / `sandbox_push`
results gains up to two contextual chips:

- **Switch to `<default>`** — shown when the commit landed on a non-default
  branch. Calls `switchBranchFromUI` (the #912 helper) directly:
  deterministic, warm, no model round-trip.
- **New branch from here** — calls the existing fork flow
  (`forkBranchFromUI` via `BranchForkSheet`/`BranchCreateSheet` plumbing).

Dirty-tree handling: post-commit is the clean case by construction, but the
action must not assume it — reuse the #912 probe semantics. v1 keeps it
simple: probe via `getSandboxDiff().git_status`; if dirty, open the hub's
existing state-aware confirm instead of switching blindly (extract the
dialog from `WorkspaceHubSheet` into a shared component only if the inline
reuse is awkward — implementation's call). Unknown probe = dirty, as always.

### 2. Out-of-band merge detection (the stranded-chat moment)

A new **producer** for the existing `kind: 'merged'` payload:

- **Detect:** when a chat opens (and on workspace-hub branch refresh), if the
  chat's branch is not the default branch, look up a merged PR whose head is
  that branch — one new helper beside `findOpenPRForBranch` in
  `github-tools.ts` (`GET /repos/{repo}/pulls?state=closed&head=owner:branch`,
  filter `merged_at`). Cache **positive hits only**, per `(repo, branch)`:
  a merged PR stays merged, so the hit never goes stale, but a cached miss
  would permanently suppress the banner in the exact flow this exists for
  (open chat → merge from another surface → return without reloading).
  Misses re-check on the next chat open / refresh — one cheap request, not
  a poll. (Review feedback: Codex P2.) **Identity guard (shipped, Codex P2):**
  a merged-PR hit is verified before it surfaces — the banner makes a
  provenance claim, so branch-name matching alone is insufficient. Capture the
  merged head SHA and compare it to the live branch tip
  (`GET /repos/{repo}/branches/{branch}`): show only when the branch is gone
  (404 — the normal post-merge cleanup) or still points at the merged commit;
  if the tip diverged (a reused/advanced name with new unmerged work) suppress
  and evict the positive cache so a later genuine merge re-checks fresh. A
  secondary guard suppresses when an open PR is now in flight. The verification
  calls only fire when a candidate merged PR exists, so the no-merge common
  case stays a single request.
- **Surface:** a dismissible in-chat banner (sibling of `CIStatusBanner`):
  *"`feat/x` was merged into `main` (PR #57) — continue this chat on
  `main`?"* with a single **Continue on main** action.
- **Act:** the action calls `mergeBranchInUI(defaultBranch, { from: branch,
  prNumber, source: 'merge_detected' })` — the same migration, divider
  (`branch_merged`), and skip-teardown routing as the in-app merge flow.
  This requires extending `mergeBranchInUI`'s opts with
  `source?: BranchSwitchSource` (default `'ui-merge'`, preserving existing
  callers) — today it hard-codes `'ui-merge'`, which would make the banner
  masquerade as an in-app merge and defeat the provenance requirement.
  (Review feedback: Codex P2.) New `BranchSwitchSource` member
  `'merge_detected'` (pattern: `'branch_desync'` from #913).
- Dismissal is per-chat and persistent (don't re-nag every open). If the
  user dismisses and later wants the migration, the model carry verb (§3)
  covers it.

Detection failure (API error, rate limit) is silent — the banner is an
offer, not a state the system depends on. No structured-log requirement
beyond the fetch helper's normal error handling, since "no banner" is
indistinguishable from "no merged PR" by design.

### 3. `carry_chat` on the typed switch tool (the model's missing verb)

`switch_branch` / `sandbox_switch_branch` gains an optional boolean arg
`carry_chat` (default false — existing behavior unchanged):

- `carry_chat: true` → the tool result's `branchSwitch` payload carries a new
  `kind: 'carried'` — same migration path as `forked`/`merged` in
  `applyBranchSwitchPayload` (migrate the active conversation, backfill
  message branch attribution), with its own transcript divider so provenance
  stays honest: a third divider kind alongside `branch_forked` /
  `branch_merged` (`MessageBubble.tsx` renders both as centered dividers —
  follow that pattern), labeled "conversation continued from `<from>`".
  Concrete touch points: the payload is constructed in `sandbox-tools.ts`
  `case 'sandbox_switch_branch'` (emit `carried` conditionally on the arg),
  and the dispatcher's forked/merged migration arm extends to include
  `carried` — today anything that isn't `forked`/`merged` falls through to
  the plain-sync path, which is exactly the leave-the-chat-behind behavior
  this verb exists to avoid.
- Why a new kind instead of reusing `merged`: the divider must not claim a
  merge that didn't happen, and `forked` claims a branch was created. Three
  honest kinds beat two overloaded ones.
- Tool-protocol obligations (new-feature checklist #3): the arg lands in the
  tool registry/prompt descriptions and capability tables together
  (`cli/tests/daemon-integration.test.mjs` pins prompt-vs-capability sync);
  if the payload kind or divider type crosses the wire-event surface, extend
  the `protocol-schema.ts` strict-mode pins in the same PR.

**Prerequisite (verified hole, fix first):** the inline lead lane drops
`branchSwitch` payloads from kernel-executed typed tools **today**. The
kernel's tool-exec contract (`SandboxToolExecResult` in
`lib/coder-agent-bindings.ts` — `text`/`card`/`structuredError`/`meta`) has
no `branchSwitch` field, so the payload is structurally shed before the
kernel sees it; chat routing and `skipBranchTeardownRef` never fire for a
model-initiated switch in the default mode. (#913's desync reconciler
papers over half of this — the *next* `sandbox_exec` stamp reconciles
tracked state after the fact — but chat migration never happens and
after-the-fact is not the typed flow.) Fix by extending the #913 tee
pattern: a sibling `onBranchSwitchPayload` callback teed out of the inline
sandbox-executor closure in `runInPageCoderKernel`, routed to
`applyBranchSwitchPayload`. Without this, `carry_chat` would be born
dormant in the default mode — the exact failure class #913's review
caught.

### Producer audit (after this doc)

| Producer | Payload kind | Surface |
|---|---|---|
| `sandbox_create_branch` (model + fork UI) | `forked` | existing |
| `sandbox_switch_branch` (model + #912 UI) | `switched` | existing |
| `sandbox_switch_branch` + `carry_chat` | `carried` | **new (§3)** |
| In-app merge flow (`mergeBranchInUI`) | `merged` | existing |
| Out-of-band merge banner | `merged` (`source: 'merge_detected'`) | shipped (§2) |
| Desync reconciler (#913) | `switched` (`source: 'branch_desync'`) | existing |
| Commit-card chips | via `switchBranchFromUI` / fork flow | shipped (§1) |

## Non-goals

- **No hub removal.** The hub switch dialog stays as the deterministic,
  no-inference escape hatch (raw `git switch` is blocked in `sandbox_exec`;
  something must work when no provider does).
- **No generic "move any chat to any branch" management UI.** The carry verb
  + banner cover the observed intents; chat-list drag-and-drop branch
  reassignment is scope creep until proven otherwise.
- **No merge-state polling.** Detection fires on chat open / explicit
  refresh only.
- **No auto-migration.** Both new UI producers are offers (banner button,
  card chip); the only silent migration in the system remains the in-app
  merge flow the user just drove, and #913's desync reconcile.

## Interplay with auto-branch-on-commit

Main-as-Scratchpad's `auto-branch-on-commit` (designed, unbuilt) will make
the commit moment *create* branches automatically, which reduces — but does
not eliminate — the need for §1's chips ("back to `main`" survives; it may
even become the chip). §2 and §3 are independent of it entirely. Nothing
here blocks on that track, and nothing here is wasted by it: all three
producers compose into the same dispatcher that track will also use.

## Implementation plan

Suggested split — each lands independently, any order after the
verification gate:

1. **PR A (verification + carry verb) — shipped:** inline-lane `branchSwitch`
   routing fixed via the `onBranchSwitchPayload` tee, then `carry_chat` +
   `kind: 'carried'` + divider + protocol pins + tests. The `carried` kind and
   `branch_carried` divider stay app-internal (`BranchSwitchPayload` /
   `ChatMessage.kind`); they do not cross the CLI wire-event surface, so the
   only protocol pin is the `carry_chat` tool arg in
   `cli/tests/daemon-integration.test.mjs`.
2. **PR B (merge banner): shipped.** `findMergedPRForBranch` helper +
   `'merge_detected'` source + banner component + per-chat dismissal +
   tests (detection hit, miss, API-failure silence, banner action calls
   `mergeBranchInUI` with the PR number).
3. **PR C (commit-card chips): shipped.** Chips + probe reuse + tests (clean switch,
   dirty → confirm, default-branch commit hides the switch chip).

Pins for all three: migration never tears down the sandbox
(`skipBranchTeardownRef` — extend the controller test pattern from #912);
divider provenance honest per producer; no new writer touches
`setCurrentBranch` directly.
