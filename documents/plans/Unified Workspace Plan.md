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
| Repo workspace active | `ActiveRepo` | `false` | chat | running (cloned repo) |

The refactor must introduce a **workspace session identity** (e.g. `workspaceSession: { kind: 'scratch' | 'repo', ... } | null`) to distinguish "no workspace yet" from "scratch workspace active." Replacing `isSandboxMode` with `!activeRepo` alone would blur the first two states, breaking the screen state machine (`App.tsx:407`), auto-start logic (`App.tsx:649`), and starter suggestions (`ChatContainer.tsx:118`).

This session object becomes the single source of truth. It needs a **stable logical identity** that survives runtime restarts. `isSandboxMode` is then `session?.kind === 'scratch'`, and `activeRepo` is `session?.kind === 'repo' ? session.repo : null`. The boolean dies, but the three-state distinction survives.

## Principles

1. Every sprint ships a working app. No intermediate broken states.
2. Collapse from the outside in — UI and entry points first, core state last.
3. The capability model and workspace session are the replacements for the boolean. Don't introduce ad-hoc flags.
4. GitHub is an additive connector, not a prerequisite. The app works without it.
5. Keep the `isSandboxMode` boolean alive as a computed value during the transition. Kill it last.
6. Mid-session promotion (scratch → repo) is **out of scope** for this plan. It's new product behavior requiring its own design for file migration, chat scope, and branch binding. See Open Questions.

## What shipped (Sprint 0)

Commit `b70556a` + follow-up cleanup (types extraction, builder helper).

- [x] `WorkspaceCapabilities` model: `canManageBranches`, `canBrowsePullRequests`, `canCommitAndPush` — defined in `types/index.ts`
- [x] `WorkspaceMode`: `'repo' | 'scratch'` — hub reads mode explicitly instead of inferring from missing props — defined in `types/index.ts`
- [x] `WorkspaceScratchActions` — sandbox action bar replaces commit/push bar in scratch mode — type in `types/index.ts`, builder in `useSnapshotManager.ts`
- [x] PRs tab filtered out in scratch mode
- [x] Branch selector hidden in scratch mode
- [x] Hub + banner + launcher terminology: runtime status strings say "sandbox", review/workspace strings say "workspace"
- [x] `RepoLauncherPanel.tsx` runtime status strings fixed: "Sandbox is starting", "Reconnecting to your sandbox", "Sandbox needs attention"
- [x] User-facing copy in hub action bar uses "Sandbox" (not "Scratch") — internal type/prop names remain `scratch`
- [x] Scratch actions builder (`buildWorkspaceScratchActions`) extracted from `ChatScreen.tsx` into `useSnapshotManager.ts` with `formatSnapshotAge` and `isSnapshotStale` helpers
- [x] Typecheck + lint passing

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

- [ ] **1b. Make `workspaceContext` always present for active workspaces.** Currently `useProjectInstructions` returns `null` for sandbox mode (line 187). Instead, when a scratch workspace session is active, return a minimal workspace context that describes the empty workspace state — no repo, no branch, just `/workspace`. When there is **no workspace session yet**, keep `workspaceContext = null`. This removes the sandbox-specific null path without blurring "home/onboarding" into "scratch workspace active."
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
    | { id: string; kind: 'scratch'; sandboxId: string | null }
    | { id: string; kind: 'repo'; repo: ActiveRepo; sandboxId: string | null };
  ```

  `id` is the **stable workspace-session identity**. It is generated when the user starts a scratch workspace or opens a repo, survives sandbox restarts, and is replaced only when the user starts a fresh workspace, switches repo, or changes branch context.

  `sandboxId` is `null` until the container starts — it is a **runtime instance id**, not the logical workspace id. The session represents *intent* (the user is in a workspace), not *container health*. This means a sandbox startup failure keeps the user in the session (showing an error state) rather than dumping them back to onboarding.

  `id` is the scoping key for snapshots (Sprint 2d) and the new `workspaceSessionId` field in resumable checkpoints. `sandboxId` remains useful as a runtime sanity check during resume, but it must not be the primary workspace identity.

  In `App.tsx`, introduce `workspaceSession` as real state rather than deriving it from `sandboxId`:
  - start scratch workspace → `{ id: crypto.randomUUID(), kind: 'scratch', sandboxId: null }`
  - open repo → `{ id: crypto.randomUUID(), kind: 'repo', repo, sandboxId: null }`
  - branch switch / repo switch → create a fresh repo session id for the new editing context
  - exit workspace → `null` (user is on onboarding/home)

  The `sandboxId` field is then updated when the runtime becomes ready. During the transition, `activeRepo` can still live in parallel, but it should be derived from `workspaceSession` as early as practical.

  During the transition, derive `isSandboxMode` from the session: `const isSandboxMode = session?.kind === 'scratch'`. The boolean stays alive but is now computed, not stored.

- [ ] **2b. `useProjectInstructions` — replace guard with session check.** After Sprint 1b makes this hook return a minimal context for active scratch workspaces, the `if (isSandboxMode)` early return becomes two cases:
  - `if (!session)` → `setWorkspaceContext(null)` (no workspace yet)
  - `if (session.kind === 'scratch')` → return the minimal workspace context
  - File: `hooks/useProjectInstructions.ts`

- [ ] **2c. `useBranchManager` — replace sandbox guards with session checks.** Lines 93 and 109 guard on `isSandboxMode`. Replace with `session?.kind !== 'repo'` — this correctly handles both "no workspace" and "scratch workspace" states.
  - File: `hooks/useBranchManager.ts`

- [ ] **2d. `useSnapshotManager` — scope snapshots to session identity.** This hook has 5 `isSandboxMode` guards. Replace with `session?.kind === 'scratch'` checks. Additionally, snapshot storage is currently global ("latest snapshot" state, not workspace-scoped — `snapshot-manager.ts:3`, `snapshot-manager.ts:178`). Before broadening the model, snapshot keys must be scoped to the session — otherwise restoring in session B could load session A's snapshot.
  - File: `hooks/useSnapshotManager.ts`
  - **Prerequisite:** Use `session.id` as the snapshot storage key. Snapshots saved in scratch session A remain visible after that session's sandbox restarts, but are invisible to scratch session B. This must ship before or with the guard replacement.
  - Decision: Snapshots remain scratch-only for now. Repo workspaces use git as persistence. This can be revisited later.
  - The ephemeral sandbox start path (line 145: `sandbox.start('', 'main')`) needs to remain distinct.

- [ ] **2e. `useSandbox` — replace empty-string convention with explicit config.** The hook currently uses `repo === ''` as the signal for ephemeral mode (line 74–75). Replace the call site with a workspace session check:
  - `useSandbox(session?.kind === 'repo' ? session.repo.full_name : session?.kind === 'scratch' ? '' : null)`
  - Or better: accept `WorkspaceSession | null` directly and derive the repo string internally.
  - File: `hooks/useSandbox.ts`, `App.tsx` (line 94)

### Verification
- Remove `isSandboxMode` from hook signatures where possible. Typecheck will catch any remaining references.
- Verify three states work: (a) no workspace (onboarding/home — no sandbox starts), (b) scratch workspace (auto-start, snapshots, no branches), (c) repo workspace (branch loading, project instructions, no auto-snapshots).
- Verify snapshot save in scratch session A, restart the sandbox inside session A, restore still sees session A's snapshot.
- Verify snapshot save in scratch session A, start new scratch session B, restore does NOT load session A's snapshot.

---

## Sprint 3 — Unify entry points and UI

**Goal:** Remove the "sandbox mode" as a named concept from entry points and UI. Replace with "start a workspace" (no repo) vs "open a repo" (with repo), and redesign onboarding around that workspace-first model.

**Why third:** Entry points are the most visible change to users, so they should land after the infrastructure is solid. This sprint changes what users see, not how the system works.

### Tasks

- [ ] **3a. Redesign the onboarding screen.** The current `OnboardingScreen.tsx` is still organized around GitHub connection mechanics first (OAuth / install / PAT / installation ID), with the no-account path feeling like a fallback. Redesign it so the first-run story matches the unified workspace model:
  - Present two clear primary actions: `Start Workspace` and `Connect GitHub`
  - Make the no-account path feel first-class, not secondary
  - Demote PAT / installation ID flows into clearly-labeled advanced or recovery paths
  - Update headline, supporting copy, and visual hierarchy so onboarding explains "start with a workspace, add GitHub when you need repo capabilities"
  - Preserve returning-user convenience: GitHub App reconnect should still be the fastest path when credentials/install are already available
  - File: `sections/OnboardingScreen.tsx`
  - Output: new mobile-first layout + revised copy, not just renamed buttons

- [ ] **3b. Onboarding flow callbacks.** "Try it now — no account needed" can stay as copy (or evolve within the redesign). Internally it should create a workspace, not "enter sandbox mode." The `onSandboxMode` callback becomes `onStartWorkspace` or similar.
  - File: `sections/OnboardingScreen.tsx`
  - Rename: `onSandboxMode` → `onStartWorkspace` (prop + callback)

- [ ] **3c. Repo picker / launcher.** Rename "New Sandbox" to workspace language such as "New Workspace" or "Start Workspace." Keep `sandbox` wording only when explicitly referring to the live runtime/container status, not the product-level entry point. The `onSandboxMode` callback renames to match 3b.
  - Files: `sections/RepoPicker.tsx`, `components/launcher/RepoLauncherPanel.tsx`, `components/launcher/RepoLauncherSheet.tsx`, `components/chat/RepoAndChatSelector.tsx`

- [ ] **3d. ChatContainer empty state.** The starter suggestions currently branch on `isSandboxMode` to show different prompts (explore/build/prototype vs PRs/issues/codebase). Replace with a check on `activeRepo` — if no repo, show workspace-oriented suggestions; if repo, show repo-oriented suggestions. Same behavior, no flag.
  - File: `components/chat/ChatContainer.tsx` (lines 119–138)

- [ ] **3e. SandboxStatusBanner exit button.** The "Exit" button on error state (line 97) is gated on `isSandboxMode`. This should be gated on `workspaceSession?.kind === 'scratch'` instead — the banner should follow the active workspace session, not infer from missing repo data.
  - File: `components/chat/SandboxStatusBanner.tsx`

- [ ] **3f. ChatScreen header and sandbox-specific UI.** The header badge ("ephemeral"), snapshot controls, download button, and expiry banner are all gated on `isSandboxMode`. Replace with `workspaceSession.kind === 'scratch'` or capability checks where the hub already handles it.
  - File: `sections/ChatScreen.tsx`
  - Consider: The snapshot/download controls in the header overlap with the hub scratch action bar. Sprint 0 added the hub actions — the header controls may now be redundant. Evaluate whether to keep both or consolidate to hub-only.

### Verification
- Walk through onboarding cold-start on mobile. Verify the screen clearly presents `Start Workspace` and `Connect GitHub` as the two main paths.
- Verify advanced auth fallbacks (PAT, installation ID) are still reachable but visually secondary.
- Walk through onboarding → workspace (no GitHub) → chat. Verify no "sandbox mode" language in the flow.
- Walk through onboarding → GitHub connect → repo select → chat. Verify identical experience except repo context.
- Verify launcher, repo picker, and chat selector all work with renamed callbacks.

---

## Sprint 4 — Kill `isSandboxMode`

**Goal:** Remove the `isSandboxMode` state variable from `App.tsx` and all remaining references. The boolean is replaced by the `WorkspaceSession` introduced in Sprint 2.

**Why last:** This is the final cleanup. By this point, all consumers should read from `workspaceSession`, and the boolean should be a dead computed value. This sprint is deletion and verification, not new logic.

### Tasks

- [ ] **4a. Remove state, keep session.** In `App.tsx`, delete `const [isSandboxMode, setIsSandboxMode] = useState(false)`. All code should already read from `workspaceSession` (Sprint 2). The `handleSandboxMode` callback becomes `handleStartScratchWorkspace` — it sets `workspaceSession = { id: crypto.randomUUID(), kind: 'scratch', sandboxId: null }`. The `handleExitSandboxMode` callback becomes `handleEndWorkspace` — it clears the session and returns to home/onboarding.
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

- [ ] **4e. Update project instruction files.** These reference "Sandbox Mode" as a named concept. Update to describe the workspace session model. Remove references to `isSandboxMode` flag.
  - `CLAUDE.md` — primary project instructions (checked into repo, read by Claude Code)
  - `AGENTS.md` — project instructions file the app reads from user repos and injects into AI context
  - `GEMINI.md` — Gemini-specific project instructions

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

1. **Mid-session workspace promotion (scratch → repo).** Can a user start a scratch workspace, create files, then connect GitHub and push those files to a repo? This is the most interesting capability the unified model enables, but it's **new product behavior** that doesn't exist today. The current app tears down the sandbox when switching from scratch to repo (`App.tsx:461`) and when switching branches (`App.tsx:625`). "Capabilities unlock" would require designing: (a) file migration from scratch `/workspace` into the cloned repo, (b) chat scope binding (scratch chats are unscoped, repo chats are branch-scoped), (c) branch assignment for files that didn't have one. **This is explicitly out of scope for this plan.** Start a dedicated design doc after this plan ships.

2. **Snapshot storage scoping.** Snapshot state is currently global — one "latest snapshot" per app, not per workspace session (`snapshot-manager.ts:3`, `snapshot-manager.ts:178`). Before broadening the workspace model, snapshot keys must be scoped to the stable `workspaceSession.id`, not `sandboxId`. Otherwise, restoring in session B could load session A's snapshot, and a sandbox restart inside session A would incorrectly hide that session's own snapshots. **Decision: use `session.id` as the snapshot storage key. Must ship in Sprint 2d before removing `isSandboxMode` guards on snapshot logic.**

3. **Should snapshots work for repo workspaces?** Today they're scratch-only. **Decision: keep scratch-only.** Git is the persistence layer for repos. Revisit if that assumption changes.

4. **Container lifecycle.** Today scratch mode auto-starts the container. Repo mode starts it on demand. In the unified model, when does the container spin up? Options: (a) always auto-start (simplest, costliest), (b) start on first tool use (current repo behavior), (c) start when user clicks "Start" (current explicit path). **Decision: preserve status quo** — auto-start for scratch (users expect immediate readiness), on-demand for repo. Don't try to unify container lifecycle in this plan.

5. **Chat history and branch scoping.** Today scratch chats are not branch-scoped (there are no branches). Repo chats are permanently branch-scoped. In the unified model, scratch chats stay unscoped. **Decision: no action.** The promotion question (binding a scratch chat to a branch after connecting a repo) is tied to Open Question 1.

6. **Header duplication.** Sprint 0 added Save/Restore/Download to the hub scratch action bar. The chat header still has its own snapshot controls and download button for sandbox mode. These overlap. **Decision: consolidate to hub-only in Sprint 3f.** The header is already crowded; the hub is the right surface for workspace-level actions.

7. **`NewChatWorkspaceSheet` branching.** This sheet (lines 58–104) branches on `workspace.mode === 'sandbox'` to show different copy and options ("This sandbox session still has files" vs "This workspace has uncommitted changes"). **Decision: flag swap + copy update in Sprint 3.** Migrate to `workspaceSession.kind` and evolve the language from "sandbox session" to workspace-appropriate framing.

8. **Resumable sessions and `WorkspaceSession`.** The app checkpoints tool-loop state to localStorage (`run_checkpoint_${chatId}`). `WorkspaceSession` should be serializable into the checkpoint so resume can reconstruct which workspace the user was in. The checkpoint should carry both `workspaceSessionId` (logical identity) and `sandboxSessionId` (runtime sanity check). **Decision: old checkpoints without `workspaceSessionId` are treated as unresumable — no resume banner shown, clean cut.**

9. **Session creation vs sandbox start timing.** The `WorkspaceSession` is created when the user clicks "Try it now" or selects a repo — before the container starts. Its stable `id` exists immediately; `sandboxId` is `null` at creation and populated when the container is ready. If sandbox start fails, the session persists in an error state (the user stays on the chat screen with error UI). This prevents startup failures from dumping the user back to onboarding. **Decision: already resolved in plan design, no change.**
