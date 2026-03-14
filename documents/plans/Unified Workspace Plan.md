# Unified Workspace Plan

## Status
- Last updated: 2026-03-14
- State: Sprint 0 shipped (capability model + terminology), Sprints 1–4 planned
- Intent: Collapse the sandbox/repo mode split so everything is a workspace, with GitHub as an opt-in capability layer

## Why

Push currently treats "sandbox mode" and "repo mode" as two separate paths through the app. The `isSandboxMode` boolean is threaded through 14 files — state machine, hooks, orchestrator, UI components, and entry points. In practice the runtime is identical (same Modal container, same tools, same Coder loop). The only real difference is whether GitHub tools are injected and whether `/workspace` starts with a cloned repo or empty.

This split creates:
- Two system prompts in the orchestrator with divergent preambles
- Duplicated conditional logic in every hook that touches sandbox lifecycle
- A workspace hub that infers mode from missing data rather than explicit capabilities
- Entry points that frame "no GitHub" as a special mode rather than the default state

The capability model shipped in Sprint 0 proves the hub can work off capabilities instead of mode flags. This plan extends that pattern to the rest of the app.

## Key constraint: three states, not two

`!activeRepo` is **not** equivalent to "scratch workspace exists." The app has three states:

| State | `activeRepo` | `isSandboxMode` | Screen | Sandbox |
|---|---|---|---|---|
| No auth / browsing | `null` | `false` | onboarding or home | none |
| Scratch workspace active | `null` | `true` | chat | running (ephemeral) |
| Repo workspace active | `RepoWithActivity` | `false` | chat | running (cloned repo) |

The refactor must introduce a **workspace session identity** (e.g. `workspaceSession: { kind: 'scratch' | 'repo', ... } | null`) to distinguish "no workspace yet" from "scratch workspace active." Replacing `isSandboxMode` with `!activeRepo` alone would blur the first two states, breaking the screen state machine (`App.tsx:407`), auto-start logic (`App.tsx:649`), and starter suggestions (`ChatContainer.tsx:118`).

This session object becomes the single source of truth. `isSandboxMode` is then `session?.kind === 'scratch'`, and `activeRepo` is `session?.kind === 'repo' ? session.repo : null`. The boolean dies, but the three-state distinction survives.

## Principles

1. Every sprint ships a working app. No intermediate broken states.
2. Collapse from the outside in — UI and entry points first, core state last.
3. The capability model and workspace session are the replacements for the boolean. Don't introduce ad-hoc flags.
4. GitHub is an additive connector, not a prerequisite. The app works without it.
5. Keep the `isSandboxMode` boolean alive as a computed value during the transition. Kill it last.
6. Mid-session promotion (scratch → repo) is **out of scope** for this plan. It's new product behavior requiring its own design for file migration, chat scope, and branch binding. See Open Questions.

## What shipped (Sprint 0)

Commit `b70556a` + follow-up worktree changes (pending commit).

**Committed (`b70556a`):**
- [x] `WorkspaceHubCapabilities` model: `canManageBranches`, `canBrowsePullRequests`, `canCommitAndPush`
- [x] `WorkspaceHubMode`: `'repo' | 'scratch'` — hub reads mode explicitly instead of inferring from missing props
- [x] `WorkspaceHubScratchActions` — sandbox action bar replaces commit/push bar in scratch mode
- [x] PRs tab filtered out in scratch mode
- [x] Branch selector hidden in scratch mode
- [x] Hub + banner terminology: runtime status strings say "sandbox", review tab strings say "workspace"
- [x] Typecheck + lint passing
- Files: `WorkspaceHubSheet.tsx`, `ChatScreen.tsx`, `SandboxStatusBanner.tsx`, `HubReviewTab.tsx`

**Pending commit (worktree):**
- [x] `RepoLauncherPanel.tsx` runtime status strings: "Workspace is starting" → "Sandbox is starting", "Reconnecting to your workspace" → "Reconnecting to your sandbox", "Workspace needs attention" → "Sandbox needs attention"
- [x] User-facing copy in hub action bar aligned to "Sandbox" (not "Scratch") — internal type names remain `scratch`
- [x] Typecheck passing (lint not yet verified on worktree changes)

---

## Sprint 1 — Unify the system prompt

**Goal:** One prompt structure in `orchestrator.ts`, with GitHub tools conditionally included based on workspace state rather than a mode-specific preamble.

**Why first:** The system prompt is the single biggest behavioral difference between modes. Everything downstream (tool dispatch, Coder delegation, review) inherits from it. Unifying this removes the need for two separate prompt paths and makes the AI experience consistent regardless of how the workspace was created.

### Tasks

- [ ] **1a. Merge the two preambles.** Replace the sandbox-specific preamble and the repo-specific workspace context injection with a single prompt structure. The base prompt always describes the workspace. When GitHub context is available, it's appended. When it's not, the prompt says so simply — no special "Sandbox Mode" framing.
  - File: `lib/orchestrator.ts` (lines 642–700, `toLLMMessages()`)
  - The sandbox preamble text ("You are in **Sandbox Mode**…") becomes the default workspace description
  - `TOOL_PROTOCOL` (GitHub tools section) is conditionally appended when `workspaceContext` is non-null
  - Sandbox tools are always included when `hasSandbox` is true (already the case in both branches)

- [ ] **1b. Make `workspaceContext` always present.** Currently `useProjectInstructions` returns `null` for sandbox mode (line 187). Instead, return a minimal workspace context that describes the empty workspace state — no repo, no branch, just `/workspace`. This means the orchestrator always gets a context object and the null-check branching in `toLLMMessages()` collapses.
  - File: `hooks/useProjectInstructions.ts` (lines 187–189)
  - The minimal context should include: workspace path, sandbox status, user identity block
  - Project instructions (AGENTS.md) remain repo-only — they're just absent from the minimal context

- [ ] **1c. Update Coder delegation context.** The Coder inherits the chat-locked provider/model and gets its own system prompt. Verify the Coder prompt path also works with the unified structure. The Coder should not see a "Sandbox Mode" label — it should see "workspace with no repo connected" at most.
  - File: `lib/coder-agent.ts`

### Verification
- Start a sandbox session. Verify the AI responds naturally without "Sandbox Mode" framing.
- Start a repo session. Verify GitHub tools are available and workspace context is injected.
- Delegate to Coder in both contexts. Verify tool loops work identically.
- Typecheck + lint pass.

---

## Sprint 2 — Introduce workspace session identity + unify hooks

**Goal:** Add a `WorkspaceSession` type that replaces `isSandboxMode` as the source of truth, then migrate hooks to use it.

**Why second:** Hooks are the business logic layer. Once the prompt is unified, the hooks are the next layer of mode-specific branching. But as Codex flagged, naively replacing `isSandboxMode` with `!activeRepo` blurs "no workspace yet" and "scratch workspace active" — two states with different behavior. A session identity object resolves this.

### Tasks

- [ ] **2a. Define `WorkspaceSession` type.** Add to `types/index.ts`:
  ```typescript
  type WorkspaceSession =
    | { kind: 'scratch' }
    | { kind: 'repo'; repo: RepoWithActivity; branch: string };
  ```
  In `App.tsx`, compute `workspaceSession` from existing state:
  - `isSandboxMode === true` → `{ kind: 'scratch' }`
  - `activeRepo !== null` → `{ kind: 'repo', repo: activeRepo, branch: ... }`
  - Otherwise → `null` (no workspace, user is on onboarding/home)

  During the transition, derive `isSandboxMode` from the session: `const isSandboxMode = session?.kind === 'scratch'`. The boolean stays alive but is now computed, not stored.

- [ ] **2b. `useProjectInstructions` — replace guard with session check.** After Sprint 1b makes this hook return a minimal context for no-repo workspaces, the `if (isSandboxMode)` early return is dead code. Replace with `if (!session || session.kind === 'scratch')` to return the minimal workspace context.
  - File: `hooks/useProjectInstructions.ts`

- [ ] **2c. `useBranchManager` — replace sandbox guards with session checks.** Lines 93 and 109 guard on `isSandboxMode`. Replace with `session?.kind !== 'repo'` — this correctly handles both "no workspace" and "scratch workspace" states.
  - File: `hooks/useBranchManager.ts`

- [ ] **2d. `useSnapshotManager` — scope snapshots to session identity.** This hook has 5 `isSandboxMode` guards. Replace with `session?.kind === 'scratch'` checks. Additionally, snapshot storage is currently global ("latest snapshot" state, not workspace-scoped). Before broadening the model, snapshot keys must be scoped to the session — otherwise restoring could cross-contaminate unrelated scratch sessions or leak into repo workspaces.
  - File: `hooks/useSnapshotManager.ts`
  - **Prerequisite:** Scope snapshot storage keys to workspace session identity (e.g. sandbox ID or a session token). This must ship before or with the guard replacement.
  - Decision: Snapshots remain scratch-only for now. Repo workspaces use git as persistence. This can be revisited later.
  - The ephemeral sandbox start path (line 145: `sandbox.start('', 'main')`) needs to remain distinct.

- [ ] **2e. `useSandbox` — replace empty-string convention with explicit config.** The hook currently uses `repo === ''` as the signal for ephemeral mode (line 74–75). Replace the call site with a workspace session check:
  - `useSandbox(session?.kind === 'repo' ? session.repo.full_name : session?.kind === 'scratch' ? '' : null)`
  - Or better: accept `WorkspaceSession | null` directly and derive the repo string internally.
  - File: `hooks/useSandbox.ts`, `App.tsx` (line 94)

### Verification
- Remove `isSandboxMode` from hook signatures where possible. Typecheck will catch any remaining references.
- Verify three states work: (a) no workspace (onboarding/home — no sandbox starts), (b) scratch workspace (auto-start, snapshots, no branches), (c) repo workspace (branch loading, project instructions, no auto-snapshots).
- Verify snapshot save in scratch session A, start new scratch session B, restore does NOT load session A's snapshot.

---

## Sprint 3 — Unify entry points and UI

**Goal:** Remove the "sandbox mode" as a named concept from entry points and UI. Replace with "start a workspace" (no repo) vs "open a repo" (with repo).

**Why third:** Entry points are the most visible change to users, so they should land after the infrastructure is solid. This sprint changes what users see, not how the system works.

### Tasks

- [ ] **3a. Onboarding flow.** "Try it now — no account needed" can stay as copy (it's good). But internally it should create a workspace, not "enter sandbox mode." The `onSandboxMode` callback becomes `onStartWorkspace` or similar.
  - File: `sections/OnboardingScreen.tsx`
  - Rename: `onSandboxMode` → `onStartWorkspace` (prop + callback)

- [ ] **3b. Repo picker / launcher.** "New Sandbox" card → keep as "New Sandbox" (it's a sandbox — an empty workspace with a container). The `onSandboxMode` callback renames to match 3a.
  - Files: `sections/RepoPicker.tsx`, `components/launcher/RepoLauncherPanel.tsx`, `components/launcher/RepoLauncherSheet.tsx`, `components/chat/RepoAndChatSelector.tsx`

- [ ] **3c. ChatContainer empty state.** The starter suggestions currently branch on `isSandboxMode` to show different prompts (explore/build/prototype vs PRs/issues/codebase). Replace with a check on `activeRepo` — if no repo, show workspace-oriented suggestions; if repo, show repo-oriented suggestions. Same behavior, no flag.
  - File: `components/chat/ChatContainer.tsx` (lines 119–138)

- [ ] **3d. SandboxStatusBanner exit button.** The "Exit" button on error state (line 97) is gated on `isSandboxMode`. This should be gated on `!activeRepo` instead — if there's no repo, offer to exit; if there's a repo, the user can navigate via launcher.
  - File: `components/chat/SandboxStatusBanner.tsx`

- [ ] **3e. ChatScreen header and sandbox-specific UI.** The header badge ("ephemeral"), snapshot controls, download button, and expiry banner are all gated on `isSandboxMode`. Replace with `!activeRepo` or capability checks where the hub already handles it.
  - File: `sections/ChatScreen.tsx`
  - Consider: The snapshot/download controls in the header overlap with the hub scratch action bar. Sprint 0 added the hub actions — the header controls may now be redundant. Evaluate whether to keep both or consolidate to hub-only.

### Verification
- Walk through onboarding → workspace (no GitHub) → chat. Verify no "sandbox mode" language in the flow.
- Walk through onboarding → GitHub connect → repo select → chat. Verify identical experience except repo context.
- Verify launcher, repo picker, and chat selector all work with renamed callbacks.

---

## Sprint 4 — Kill `isSandboxMode`

**Goal:** Remove the `isSandboxMode` state variable from `App.tsx` and all remaining references. The boolean is replaced by the `WorkspaceSession` introduced in Sprint 2.

**Why last:** This is the final cleanup. By this point, all consumers should read from `workspaceSession`, and the boolean should be a dead computed value. This sprint is deletion and verification, not new logic.

### Tasks

- [ ] **4a. Remove state, keep session.** In `App.tsx`, delete `const [isSandboxMode, setIsSandboxMode] = useState(false)`. All code should already read from `workspaceSession` (Sprint 2). The `handleSandboxMode` callback becomes `handleStartScratchWorkspace` — it sets `workspaceSession = { kind: 'scratch' }`. The `handleExitSandboxMode` callback becomes `handleEndWorkspace` — it clears the session and returns to home/onboarding.
  - File: `App.tsx` (line 93, lines 427–439)

- [ ] **4b. Simplify screen state machine.** The current machine has a special case for `isSandboxMode` (line 409). With the flag gone, the machine reads from `workspaceSession`:
  - `session !== null` → chat (or file-browser if open)
  - `!token` → onboarding
  - `token && !session` → home (repo picker)
  - File: `App.tsx` (lines 408–415)
  - The auth bypass for scratch workspaces survives: `session?.kind === 'scratch'` skips the token check, same as `isSandboxMode` did.

- [ ] **4c. Remove `isSandboxMode` from all prop chains.** Remove the prop from: `ChatScreen`, `ChatContainer`, `SandboxStatusBanner`, `HomeScreen`. Replace with `workspaceSession` or derived checks where needed.
  - Typecheck will enforce completeness.

- [ ] **4d. Rename `onSandboxMode` callbacks.** Final grep + replace of any remaining `onSandboxMode` references from Sprint 3.

- [ ] **4e. Update CLAUDE.md.** The project instructions reference "Sandbox Mode" as a named concept in multiple places. Update to describe the workspace session model. Remove references to `isSandboxMode` flag.
  - File: `CLAUDE.md`

### Verification
- `grep -r "isSandboxMode" app/src/` returns zero results.
- `grep -r "onSandboxMode" app/src/` returns zero results.
- Full flow test: onboarding → "Try it now" → scratch workspace with chat and sandbox tools.
- Full flow test: onboarding → GitHub connect → repo select → repo workspace with full tools.
- Full flow test: repo workspace → exit to home → start scratch workspace → verify no repo state leaks.
- **Not tested:** mid-session promotion (scratch → repo) — this is out of scope (see Open Questions).
- Typecheck + lint + build pass.

---

## Open questions

1. **Mid-session workspace promotion (scratch → repo).** Can a user start a scratch workspace, create files, then connect GitHub and push those files to a repo? This is the most interesting capability the unified model enables, but it's **new product behavior** that doesn't exist today. The current app tears down the sandbox when switching from scratch to repo (`App.tsx:461`) and when switching branches (`App.tsx:625`). "Capabilities unlock" would require designing: (a) file migration from scratch `/workspace` into the cloned repo, (b) chat scope binding (scratch chats are unscoped, repo chats are branch-scoped), (c) branch assignment for files that didn't have one. **This is explicitly out of scope for this plan.** Design it separately if/when the unified model is stable.

2. **Snapshot storage scoping.** Snapshot state is currently global — one "latest snapshot" per app, not per workspace session (`snapshot-manager.ts:3`, `snapshot-manager.ts:178`). Before broadening the workspace model, snapshot keys must be scoped to workspace session identity (sandbox ID or session token). Otherwise, restoring in session B could load session A's snapshot, and any future repo-scoped snapshots would collide. **Must be resolved in Sprint 2d before removing `isSandboxMode` guards on snapshot logic.**

3. **Should snapshots work for repo workspaces?** Today they're scratch-only. Probably not — git is the persistence layer for repos. Keep scratch-only for now, revisit later.

4. **Container lifecycle.** Today scratch mode auto-starts the container. Repo mode starts it on demand. In the unified model, when does the container spin up? Options: (a) always auto-start (simplest, costliest), (b) start on first tool use (current repo behavior), (c) start when user clicks "Start" (current explicit path). Leaning toward (b) as default.

5. **Chat history and branch scoping.** Today scratch chats are not branch-scoped (there are no branches). Repo chats are permanently branch-scoped. In the unified model, scratch chats stay unscoped. The promotion question (binding a scratch chat to a branch after connecting a repo) is tied to Open Question 1.

6. **Header duplication.** Sprint 0 added Save/Restore/Download to the hub scratch action bar. The chat header still has its own snapshot controls and download button for sandbox mode. These overlap. Consolidate to hub-only in Sprint 3e, or keep both for quick access?

7. **`NewChatWorkspaceSheet` branching.** This sheet (lines 58–104) branches on `workspace.mode === 'sandbox'` to show different copy and options ("This sandbox session still has files" vs "This workspace has uncommitted changes"). Should check `workspaceSession.kind` after Sprint 2.
