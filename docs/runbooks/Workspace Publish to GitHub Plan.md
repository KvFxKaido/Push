# Workspace Publish to GitHub Plan

Status: Current, Phase 1 shipped 2026-04-05
Origin: follow-up from the unified workspace model and current sandbox promotion plumbing

## Goal

Let a user create a GitHub repository from inside Push, with explicit `Private` or `Public` visibility, in a way that fits Push's product model:

- start with a workspace
- add GitHub when the work is worth keeping
- keep the transition explicit
- do not turn Push into a generic GitHub repo wizard

## Recommendation

Ship this as **Publish workspace to GitHub** first, not as a generic "create new repository" feature.

That matches the product direction already established in the workspace/onboarding work:

- GitHub is additive, not required to start
- scratch work is first-class
- the interesting missing behavior is promoting work from scratch into a real repo

The existing code already supports most of the low-level repo creation path:

- `createGitHubRepo()` creates a user-owned repo via `POST /user/repos`
- `promote_to_github` sets the remote and pushes the current sandbox branch
- the tool result already returns structured promotion metadata (`repo`, `pushed`, `warning`, `htmlUrl`)

So the real missing work is not raw capability. It is productizing the transition.

## Current State

### What already exists

- `app/src/lib/sandbox-tool-utils.ts`
  - `createGitHubRepo()` already creates a GitHub repository for the authenticated user
- `app/src/lib/sandbox-tools.ts`
  - `promote_to_github` already creates the repo, configures `origin`, and pushes the current branch when possible
  - if no commits exist yet, it still succeeds as a repo-creation/configure-remote action and returns a warning instead of hard failing
- `app/src/lib/tool-registry.ts`
  - the sandbox tool is already registered as `promote(repo_name, description?, private?)`
- `app/src/components/repo/PublishToGitHubSheet.tsx`
  - first-class publish UI now exists for scratch workspaces and launcher entry points
- `app/src/lib/workspace-publish.ts`
  - shared publish-result helper for the workspace transition path
- `app/src/sections/WorkspaceSessionScreen.tsx`
  - direct UI publish now preserves the scratch chat instead of rebinding it and lets normal workspace selection create the repo-scoped chat/session follow-through

### What is now landed

- scratch workspaces can open a dedicated `Publish to GitHub` flow
- the launcher connected empty state no longer dead-ends at "No repositories yet."
- users can explicitly choose `Private` or `Public`
- direct UI publish uses the existing promotion plumbing without forcing the chat-tool flow

### What is still missing

- follow-through polish for the post-publish repo workspace state and provenance messaging
- a lighter empty-repo creation path outside the scratch-workspace story
- any repo-list refresh / success affordance cleanup that user testing shows is still rough

## Product Positioning

This should answer:

"I started in Push, made something useful, and now I want to keep it on GitHub."

It should not try to answer every possible GitHub setup task in v1:

- no org repo creation
- no templates
- no README/license/gitignore scaffolding
- no advanced GitHub settings surface
- no repo-import / fork / transfer workflow

## MVP Scope

### V1 user promise

From inside Push, a user can:

1. connect GitHub if needed
2. choose a repo name
3. choose `Private` or `Public`
4. create the repo
5. publish the current workspace contents when available
6. land in a real repo workspace tied to that repository

### V1 constraints

- user-owned repositories only
- `Private` default, `Public` explicit
- no organization picker
- no templates or starter scaffolding
- no silent promotion
- no hidden branch switching

## Entry Points

### Primary: Scratch workspace publish action

This is the main path.

Candidate surfaces:

1. workspace hub / overflow action: `Publish to GitHub`
2. scratch workspace status banner when GitHub is connected
3. post-edit affordance after first meaningful workspace changes

Recommended copy:

- title: `Publish to GitHub`
- body: `Create a repository and keep this workspace on GitHub.`

### Secondary: Repo launcher empty state

If the user is connected to GitHub and has no repos in Push yet, the launcher should not stop at "No repositories yet."

Recommended empty-state actions:

- `Start workspace`
- `Create repository`

This is still useful, but it should remain secondary to the workspace-first story.

## UX Flow

### Publish workspace flow

1. User taps `Publish to GitHub`
2. Sheet or modal opens with:
   - repository name
   - optional description
   - visibility toggle: `Private` / `Public`
3. User confirms
4. Push creates the repo
5. Push attempts to push the current sandbox branch
6. Push shows result:
   - success: repo created and branch pushed
   - partial success: repo created, remote configured, but no commits existed yet
7. Push transitions into the repo-backed workspace

### Public visibility behavior

`Private` should be preselected.

If the user chooses `Public`, show a one-line confirmation hint:

`Public repositories are visible to anyone on GitHub.`

No scary modal needed unless later testing shows users misfire here.

### No-commit case

The current tool already distinguishes this case.

If the workspace has no commits yet:

- still create the repository
- still configure the remote
- show clear copy that nothing was pushed yet
- offer a follow-up action like `Commit and publish` or simply leave the user in the repo workspace with normal next steps

Do not treat this as a failed publish.

## State Transition Rules

This is the core product design work.

### After successful publish

Push should:

1. create or select the new repo as `activeRepo`
2. bind the workspace to that repo
3. bind the active branch to the pushed branch (or default branch if no push happened)
4. keep the user in the same broad work session, but make the workspace boundary change explicit

### Chat behavior

Scratch chats are unscoped; repo chats are branch-scoped.

Recommended v1 behavior:

- after publish, start a **new repo-scoped chat**
- keep the scratch chat in history as provenance
- add a system note in the new chat describing that it was created from a published workspace

This is cleaner than trying to retroactively reinterpret an unscoped scratch chat as branch-scoped history.

### Branch behavior

Do not invent complex branch migration rules.

Recommended v1 behavior:

- use the current sandbox branch name if one exists and pushes successfully
- otherwise use the created repo's default branch

## Implementation Plan

### Phase 1: First-class publish UI

Status: shipped

Add a real user-facing flow on top of the existing promotion tool.

Changes:

- add a `PublishToGitHubSheet` or similar UI surface
- wire scratch workspace action(s) to open it
- wire launcher empty state to show `Create repository`
- keep visibility and naming explicit in the UI

### Phase 2: Workspace transition polish

Status: partially shipped; follow-through still open

Make the app handle promotion as a workspace transition, not just a tool result.

Changes:

- consume the existing `promotion` payload from the sandbox tool result
- update active repo / branch state explicitly
- start a new repo-scoped chat on publish
- preserve the previous scratch chat as historical context
- tighten provenance/success messaging around the new repo-scoped chat and workspace handoff

### Phase 3: Empty-repo creation path

Status: not started

Once the publish flow is solid, add a lighter launcher path for users who just want a new blank repo.

Changes:

- reuse the same create form
- after repo creation, start a repo workspace against the new repository
- no migration required because there is no scratch content to carry over

This is intentionally second. It is easier technically, but less central to Push's identity.

## Technical Seams

### Existing code we should reuse

- `app/src/lib/sandbox-tool-utils.ts`
  - `createGitHubRepo()`
- `app/src/lib/sandbox-tools.ts`
  - `promote_to_github`
- `app/src/lib/tool-registry.ts`
  - existing promote tool definition
- `app/src/components/launcher/RepoLauncherPanel.tsx`
  - repo empty state and launcher affordances
- `app/src/components/repo/PublishToGitHubSheet.tsx`
  - publish sheet and visibility/name form
- `app/src/lib/workspace-publish.ts`
  - publish result interpretation for UI-driven transitions

### Likely new UI/state surfaces

- success/provenance messaging around the new repo-backed session
- optional empty-repo creation surface separate from scratch publish

## Non-Goals

- organization repository creation
- starter templates
- README/license/gitignore generation
- repo imports/forks
- automatic publish without user confirmation
- preserving one continuous chat identity across scratch and repo modes

## Risks

### 1. Scratch-to-repo state feels magical

If the app silently morphs the workspace without telling the user, the mental model gets muddy.

Mitigation:

- make the transition explicit in UI copy
- create a new repo-scoped chat after publish

### 2. "Public" is easy to misclick

Mitigation:

- default to `Private`
- add short copy explaining public visibility

### 3. No-commit publish feels broken

Mitigation:

- treat it as partial success, not failure
- tell the user exactly what happened

### 4. We accidentally build generic GitHub clutter

Mitigation:

- keep v1 to user repos only
- keep the create form minimal
- optimize for Push workflows, not GitHub parity

## Open Questions

1. Should repo creation require GitHub App auth only, or also support PAT-only accounts on equal footing?
   - Recommendation: support whichever auth path can already create repos successfully today; do not block the feature on auth unification.

2. Should the launcher show `Create repository` even when the user already has repos?
   - Recommendation: yes, but as a secondary affordance, not the primary launcher action.

3. Should publish auto-create an initial commit if none exists?
   - Recommendation: no for v1. Keep commit creation explicit.

4. Should this ship before org repo creation?
   - Recommendation: yes. Org creation adds permission and ownership complexity without changing the core Push story.

## Success Criteria

- A connected user can publish a scratch workspace into a new private GitHub repo from the app
- Public visibility is supported but explicit
- The result transitions the user into a repo workspace cleanly
- The no-commit case is understandable and non-destructive
- The launcher no longer dead-ends at "No repositories yet."
