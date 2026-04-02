# PR & Branch Awareness — Mobile-First Git Model

**Status:** Sprint-Ready
**Date:** 2026-02-11

---

# Philosophy

Push is GitHub designed for mobile.

It assumes:
- Single active context.
- Low friction during work.
- Ceremony concentrated at publication (merge).
- No hidden state.
- All merges go through GitHub — Push never runs `git merge` locally.

Branches are intentional.
Sandbox is ephemeral.
Chats are branch-scoped forever.

---

# Core Model: Active Branch

There is always exactly one **Active Branch**.

Active Branch =
- Sandbox branch
- Chat context branch
- Commit target
- Push target
- Diff base

No background main awareness.
No branch lens.
No dual-state logic.

Switching branches is atomic and explicit.

Main is not sacred. It is simply the default starting branch.

---

# Branch Switching

Branches are visible and switchable in:
- **History drawer** — branches listed with their chats, tap to switch
- **Home page** — active branch shown, tap to switch

Branch switching is for navigation and orientation only.
Branch creation only happens via the header "Create Branch" action.
No branch dashboard. No standalone branch management screen.

Switching branches tears down the current sandbox and creates a fresh one on the target branch. This is deliberate — branching on mobile should feel like a conscious context switch, not a quick toggle. Clean state over speed.

---

# Header Lifecycle Control

The header always shows:

```
Active: <branch-name>
```

If `active === main`:

```
[ Create Branch ]
```

If `active !== main`:

```
[ Merge into main ]
```

Branch creation exists only in the header.

---

# Branch Creation Flow

On `main`, tapping **Create Branch**:

```
Create branch from main

Branch name:
[ auth-refactor ]

After creation:
(+) Switch to branch
( ) Stay on main

[ Create ]  [ Cancel ]
```

Branch is created on GitHub via API.
Default: Switch to branch.
Switching must be confirmed.

---

# Commit Model

- Commits always apply to Active Branch.
- No committing to main while on another branch.
- Auditor runs on staged diff.
- No silent commits.

Work friction is low.
Governance happens at merge.

---

# Push Model

- Push always pushes Active Branch to its remote tracking branch.
- No push target dropdown.
- No implicit targeting of main.

Pushing keeps the remote branch in sync. It does not trigger a merge.

---

# Merge Model (GitHub PR Merge)

All merges go through GitHub.
Push never runs `git merge` locally.

"Merge into main" means:
1. Push the active branch to remote (if not already pushed).
2. Create a Pull Request against `main` via GitHub API (or reuse an existing one).
3. Merge the PR via GitHub API (merge commit strategy).

GitHub creates the merge commit. Fast-forward merges are not used.

Merge commits visually stand out subtly in history (e.g., merge icon or small badge).

---

# Merge Flow

## Step 1 — Clean Working Tree

If working tree is dirty:

```
You have uncommitted changes.

[ Commit & push first ]
[ Cancel merge ]
```

No stashing.
No hidden state.

Commit flow includes:
- Auditor review on staged diff
- Semantic commit message proposal
- Explicit confirmation
- Auto-push to remote after commit

---

## Step 2 — Create or Reuse Pull Request

Before creating a PR, Push checks for an existing open PR from this branch into `main`:

```
GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&base=main&state=open
```

**If a PR already exists:** Push shows the existing PR. User may update the title/body or proceed as-is.

**If no PR exists:** Push creates one via GitHub API.

Agent proposes PR title and body:

```
Title: Refactor auth middleware

Body:
- Refactor auth middleware
- Improve validation
- Add tests
```

User may:
- Confirm
- Edit title/body
- Cancel

---

## Step 3 — Auditor Review (Branch -> Main)

Auditor evaluates the PR diff (`main...active`).

Auditor checks:
- File count
- LOC delta
- Risk patterns
- Structural impact
- Conflict indicators

Verdict is SAFE or UNSAFE.
UNSAFE blocks the merge. User may fix and retry.

---

## Step 4 — Merge

Push checks merge eligibility via the PR's `mergeable` and `mergeable_state` fields.

If Auditor passes and PR is mergeable:

```
Ready to merge `auth-refactor` into `main`.

[ Merge ]  [ Cancel ]
```

Merge uses GitHub's merge commit strategy (equivalent to `--no-ff`).
GitHub creates the merge commit on the server.

**If branch protection blocks merge** (CI pending, reviews required):

```
Cannot merge yet:
- CI checks pending
- 1 review required

[ Check again ]  [ Cancel ]
```

**If the PR has merge conflicts:**

```
This branch has conflicts with main.

[ Resolve on GitHub ]  [ Cancel ]
```

Push does not provide in-app conflict resolution.
Push does not bypass branch protection. It surfaces the status and lets the user act.

---

## Step 5 — Post-Merge Closure

After successful merge:

```
Merged `auth-refactor` into `main`.

[ Switch to main ]
[ Switch to main + delete branch ]
```

Branch deletion deletes both local and remote (GitHub deletes remote via API).
Deletion is never automatic.

---

# Chat Lifecycle

Chats are permanently bound to the branch on which they were created.

When switching to a branch that has existing chats, the user sees them in the history drawer and can resume any of them. No auto-resume — the user picks.

After merge:
- Branch chat receives a closure message.
- If branch is deleted, it is marked `(Merged + Deleted)` in history.
- Chats are never duplicated or rebound.

History groups chats by branch:

```
Push
  main
    Ongoing work
  auth-refactor (Merged + Deleted)
    Auth cleanup
```

---

# Protect Main Setting

## Global Default

```
Protect main by default: [ On / Off ]
```

## Per-Repo Override

```
Protect main in this repo:
( ) Inherit global
( ) Always protected
( ) Never protected
```

---

## When Protect Main Is Enabled

On `main`:
- Commit is blocked.
- User must create a branch to continue work.

Merge into main:
- Only allowed from non-main branches.
- Always goes through PR + Auditor.
- GitHub creates the merge commit.

No direct mutation of main except via PR merge.

Note: Protect Main is a no-op in Sandbox Mode (no Git operations).

---

# PR Awareness

Home Screen:
- Show open PR count.
- Show review-requested indicator.
- Lazy-load recent repos.

Chat Tools:
- `github_list_prs`
- `github_get_pr`
- `github_pr_diff` (summary-first)
- `github_list_branches`

PR reading tools are available for any repo.
PR creation and merge happen only through the merge flow described above.
Push does not expose a standalone "create PR" action — PRs are created as part of the merge ritual.

---

# Opinionated Constraints

Push intentionally enforces:

- Single active branch context
- Explicit merge ritual via GitHub PR
- Auditor gate before publication
- Merge commits always (GitHub merge commit strategy)
- No local merges — all merges go through GitHub
- No silent destructive operations
- No stash abstraction
- No in-app conflict resolution (escape hatch to GitHub)
- Branch switch tears down sandbox (clean state, no carryover)
- Branch-scoped chats forever
- Branch protection rules are respected, never bypassed

Work remains lightweight.
Publication remains deliberate.

---

# Summary

Work on Active Branch.
Commit freely.
Push freely.
Merge deliberately — always through GitHub.
Switch branches in the history drawer.
Close branches intentionally.
Never hide state.

GitHub, designed for mobile.
