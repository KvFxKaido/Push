# Auto-Branch on Commit — Nothing Lands on Main

Date: 2026-06-13
Status: **Current (trigger relocated 2026-06-28)** — the persistence goal
("nothing lands on `main`") holds, but the branch is now created at the **first
user prompt** (named from the prompt), not at the first commit. See "Update —
Branch on First Prompt" below. The commit-time auto-branch documented here is
retained as a **fail-safe**: it only forks when `currentBranch === defaultBranch`,
so it self-neutralizes once a session has already branched off the default
branch. Web/cloud surfaces still route an on-default-branch commit through the
auto-branch seam; the hub's commit/push is gated by the secret scan. CLI
deferred (see Non-goals).
Owner: Push

## Update — Branch on First Prompt (2026-06-28)

Working on `main` with an ephemeral sandbox is retired. A repo-backed session
**that starts on the default branch** now forks a work branch the moment the user
sends their **first message** — named from that prompt — before any tool call, so
the session never *works* on the default branch (mirrors Claude Code's
branch-per-session). The trigger is gated on being *positively* on the default
branch (`currentBranch === defaultBranch`, with the **raw** current branch — an
unknown branch is **not** treated as the default): a session the user
deliberately started on an existing branch is left there, never force-forked off
it. Erring toward "don't branch" loses no protection — the commit-time fail-safe
above still blocks an actual commit landing on the default branch. Pragmatic
ordering:
the sandbox has already cloned `main` (prewarm), then immediately
`sandbox_create_branch` (→ `git checkout -b`); the conversation migrates onto the
new branch via the shared `applyBranchSwitchPayload` dispatcher. The branch stays
**local in the sandbox until the first commit** (gate-at-push), so pure Q&A
sessions never create a remote branch — no branch sprawl even though every first
prompt branches.

Implementation: `app/src/lib/first-prompt-branch.ts` (decision + fork +
migration), `deriveBranchNameFromPrompt` in `app/src/lib/branch-names.ts`
(deterministic prompt slug), wired through `prepareSendContext`
(`app/src/hooks/chat-prepare-send.ts`) so `useChat` stays at its line cap. The
commit-time seam specified below is unchanged and now serves only as the
fail-safe. Naming is a deterministic slug for v1 (zero pre-turn latency); the
model-namer from the commit path can be grafted on later if slugs read poorly.

## Problem

The first-priority track (`Single-Agent Loop + Branch-at-Commit Persistence`, in
the since-retired root `ROADMAP.md`) decided the persistence model months ago:
**talk on `main`
branch-free, and the first commit auto-creates + auto-pushes a branch so
nothing ever lands on `main`.** The supporting pieces have since shipped —
the deterministic pre-push secret scan (`lib/secret-scan.ts` + the
`PrePushGate` on `PushGit.push()`), and the branch-transition governance that
routes every transition through one dispatcher (`applyBranchSwitchPayload`;
warm switching #912, desync detection #913, Branch Moments #915–#917). What
has **not** been built is the trigger itself: the wiring that, at commit time
on `main`, creates and switches to a branch before the commit lands.

The design rationale (why auto-branch and not the old "branch this?" prompt;
why this is universal-commit-flow with only the *storage substrate*
platform-flagged) lives in `docs/archive/decisions/Main as Scratchpad —
Branch on Graduation.md`. This doc is the **implementation spec**: the seam,
the naming, the flag, the surfaces, and the test obligations. It does not
re-argue the model.

## Settled inputs (do not re-litigate)

- **Auto-branch is universal across the commit flow** — not forked by
  platform. Only the durable-storage substrate is platform-flagged, and that
  is explicitly **out of scope here** (see Non-goals).
- **The model-Auditor stays as the per-commit SAFE/UNSAFE gate in every
  mode** (reversed 2026-06-08 — it earned its keep on evidence; the verdict's
  reader is the agent loop, not a human). Auto-branch does not touch it. Only
  the *secrets* job was unbundled, to the already-shipped scan.
- **Auto-branch only buys durability if it auto-pushes.** Chain: auto-branch
  → auto-push to origin → the existing pre-push secret scan. A branch left in
  the ephemeral sandbox is no more durable than a `main` checkpoint.
- **Reuse, don't reinvent.** `forkBranchInWorkspace`
  (`app/src/lib/fork-branch-in-workspace.ts`) already creates a branch via the
  typed `sandbox_create_branch` path, carries the working tree, preserves the
  sandbox (`skipBranchTeardownRef`), and emits a `branchSwitch` payload.
  Auto-branch is a new *caller* of that path, not a new branch mechanism.

## Decisions taken for this spec (owner calls, 2026-06-13)

1. **Branch naming: model-proposed with deterministic fallback.** The commit
   message **already exists** before naming runs — the user typed it (web
   surfaces) or the model supplied it to `sandbox_prepare_commit` (tool path),
   so there is no circular dependency. Mechanism: a single structured,
   non-streaming completion against the active provider (mirror how
   `runAuditor` is invoked with `providerOverride`/`modelOverride`), prompt =
   "propose a short kebab-case git branch name for this change" + the commit
   message + a bounded diff summary; the result is sanitized to a valid git
   ref (`[a-z0-9._/-]`, length-capped). **The fallback is total** — if the
   call errors, returns an unusable/empty name, or there is no provider
   configured (headless / Full-Auto / `demo`), use the deterministic
   `push/<slug-of-commit-message>-<yyMMdd-HHmm>`. Collisions (branch already
   exists) get a short numeric suffix. Naming never blocks a commit; it only
   chooses between a nice name and a deterministic one.
2. **v1 surfaces: web / cloud only.** All web commit surfaces and the model
   tool path (below). The CLI/daemon local-git path is a deferred follow-up
   (different mechanics — real filesystem, no sandbox lifecycle).
3. **Rollout: behind a flag, default-on.** A single resolver in `lib/` that
   **mirrors the existing `resolveSecretScanEnabled` (`lib/secret-scan.ts`)
   and `resolveAuditorGateEnabled` (`lib/auditor-policy.ts`) pattern** —
   `PUSH_AUTO_BRANCH_ON_COMMIT` env (default on) plus the same
   settings-override resolution those use, so the kill-switch behaves
   consistently with the other two gates. The flag governs *only* whether the
   auto-branch step fires; when off, every surface behaves exactly as today.

## Design

### The trigger

Auto-branch fires when a commit is requested **while HEAD is on the repo's
protected/default branch** — i.e. `currentBranch === defaultBranch` (the
same branch `Protect Main` guards). On any other branch it is a no-op: the
work already has a non-`main` home. This no-op *is* the merge-flow guard —
if `MergeFlowSheet` is already on a non-default branch,
`ensureCommitTargetBranch` returns `{ switched: false }` and never
re-branches; no surface-specific check is needed beyond passing it the real
current branch.

### One shared seam, four callers

The four commit surfaces must not each grow their own copy of the logic
(the universal-commit-flow principle). Introduce one shared helper:

```
ensureCommitTargetBranch({
  sandboxId, currentBranch, defaultBranch,
  diff, commitMessage, proposeName, // proposeName optional (interactive lead)
}) → { switched: false }
  | { switched: true, branch: string, branchSwitch: BranchSwitchPayload }
```

- Returns `{ switched: false }` immediately when off the default branch or
  when the flag is off.
- Otherwise: resolve the name (§Decisions 1), create+switch via the
  `forkBranchInWorkspace` path, and return the `branchSwitch` payload for the
  caller to apply.

The seam takes an injectable `fork` primitive so one implementation serves
both apply styles: the default bare `forkBranchInWorkspace` returns the
`branchSwitch` payload for the caller to apply (model path + file browser);
UI surfaces that already have `forkBranchFromUI` inject it to fork+migrate in
one step (hub). The collision-suffix loop, naming, flag, and trigger are
identical regardless.

Callers (as built):

| Surface | File | Wiring |
|---|---|---|
| File-browser commit | `app/src/hooks/useCommitPush.ts` | calls the seam after the Auditor passes, before the gated commit; applies the returned `branchSwitch` via an `onBranchSwitchPayload` callback threaded `WorkspaceSessionScreen → FileBrowser → CommitPushSheet`. Push was already gated. |
| Workspace hub commit | `app/src/components/chat/WorkspaceHubSheet.tsx` | seam with `fork: forkBranchFromUI` (fork+migrate) for the on-default case; **its raw `git commit`/`git push` migrated to the gated `createSandboxPushGit` path** (gate 2). |
| Model tool path | `app/src/lib/sandbox-git-release-handlers.ts` `handlePrepareCommit` | the handler gained branch awareness (`currentBranch`/`defaultBranch` threaded through `executeSandboxToolCall` options → `buildGitReleaseContext`), runs the seam, and the `branchSwitch` rides the tool result so the inline-lane tee (`onBranchSwitchPayload`, #915) routes the chat — no prompt, the model learns post-hoc it's on a new branch. |
| ~~Merge-flow commit~~ | `MergeFlowSheet.tsx` | **Not a commit surface** (finding): it operates on already-pushed branches via the GitHub API + `mergeBranchInUI`, with no working-tree `git commit`/`git push`. Nothing to wire — auto-branch has no hook here. |

### Chat follows the branch

The auto-created branch uses `kind: 'forked'` migration (the active
conversation moves onto the new branch), not `'switched'` — the work and its
conversation belong together. This is exactly the path `forkBranchInWorkspace`
already drives; no new migration logic.

### Auto-push — every covered surface must push through the gated path

Auto-branch's durability depends on the auto-push, and the auto-push's safety
depends on the secret scan. So **every surface auto-branch covers must push
through `createSandboxPushGit(..., { secretScan: true }).push()`** — the
gated `PushGit` path that runs the scan over the uncapped about-to-be-pushed
commits. A secret-scan block surfaces verbatim and is **not** a recovery
trigger (existing behavior in `useCommitPush`).

**This is not uniformly true today, and the gap is load-bearing** (Codex P1
on the spec PR): `useCommitPush.ts` and the model path (`handleSandboxPush`)
already use the gated path, but **`WorkspaceHubSheet.tsx` pushes via raw
`git push` through `execInSandbox` (~L786–788, and commits raw at ~L762)** —
bypassing the scan entirely. That is a pre-existing hole that auto-branch
would *amplify* (it would auto-push the hub surface with no scan). The
implementation must **migrate the hub's commit+push to the gated `PushGit`
path** as part of this work, not just add the auto-branch step on top of a
raw push. Audit every covered surface's push for the same raw-`execInSandbox`
pattern; route each through the gate or explicitly exclude it with a reason.

### Protect Main interaction

`Protect Main` (block direct commits to `main`) becomes **structurally moot**
on any surface auto-branch covers — nothing reaches a `main` commit because
the branch is created first. It **stays as an unconditional backstop**: it
still guards surfaces auto-branch does not yet cover (CLI, future paths) and
the flag-off state. Auto-branch does not remove, weaken, or gate on it; the
two coexist, with auto-branch simply making the guard rarely-reached on web.

### What the model sees

No prompt, no new tool, no choice (the whole thesis). `handlePrepareCommit`
performs the branch silently and the `branchSwitch` payload in the tool
result tells the chat layer to migrate. The model's next turn observes it is
on a new branch via the normal workspace/branch context — the same way a
typed `switch_branch` already surfaces. Headless/Full-Auto: the deterministic
fallback name is used (no lead call), everything else identical.

## Non-goals (this slice)

- **CLI/daemon auto-branch.** Deferred — local-git mechanics differ.
- **The storage-substrate platform flag** (APK local-git vs PWA
  remote-snapshot). Orthogonal; tracked separately.
- **Snapshot-contract demotion mechanics.** The snapshot already fails loudly
  (`RESTORE_FAILED_MESSAGE`); formally shrinking its job to "uncommitted
  `main` only" is a follow-up, not a blocker for auto-branch.
- **Retiring the model-Auditor.** Settled the other way; it stays.
- **Touching the secret-scan or the push transport.** Already shipped; reused
  as-is.

## Implementation plan (one PR, after this doc merges)

1. `ensureCommitTargetBranch` helper + the flag resolver + the
   model-propose-name call with its deterministic fallback (unit-test the
   fallback paths hard: call fails → deterministic; off-default → no-op; flag
   off → no-op; name collision → suffixed).
2. Wire the four surfaces; thread the `branchSwitch` apply on each.
3. `handlePrepareCommit` branch awareness + payload-on-result; verify the
   inline-lane tee routes it (extends #915's `onBranchSwitchPayload`).
4. Tests: a commit on `main` lands on an auto-named branch and pushes there;
   a commit already off-`main` is untouched; flag-off reverts to today;
   Protect Main still blocks where auto-branch doesn't cover; chat migrates
   (`kind: 'forked'`) onto the new branch; secret-scan block still surfaces
   verbatim without recovery. Pin that the sandbox is **not** torn down
   (reuse the `skipBranchTeardownRef` controller-test pattern from #912).

## Verification gates (do first in impl)

- Confirm `handlePrepareCommit`'s context can learn `currentBranch` /
  `defaultBranch` — `buildGitReleaseContext(sandboxId)` currently takes only a
  sandbox id, so this likely needs threading. If the branch isn't reachable
  there, that's the first thing to fix, not a workaround.
- Confirm the model commit path actually emits a `branchSwitch` on the tool
  result and the inline-lane tee consumes it (the #915 hole was the lane
  dropping these payloads — verify it's closed for this caller too).
