# WorkspaceScreen Extraction Plan

## Status
- Created: 2026-03-25
- Reviewed against code: 2026-03-29
- State: **Complete** — the `WorkspaceScreen` extraction and lazy route boundary are now in code
- Goal: Extract workspace/chat orchestration from App into a lazy-loaded `WorkspaceScreen`, collapsing the 107-prop ChatScreen call site and enabling real code splitting for the workspace entry point

Historical note: the problem statement and phase list below describe the pre-implementation baseline that this plan addressed.

## Problem

`app/src/App.tsx` is 1107 lines. ~63% of the file (≈700 lines) is workspace/chat state — `useChat`, `useSandbox`, `useModelCatalog`, sandbox lifecycle effects, model draft management, snapshot/branch/instruction hooks, and settings UI state. This runs unconditionally before the screen router decides what to show.

Consequences:
- Vite entry chunk is 539 kB minified; the `manualChunks` config only splits `node_modules`, so all app source ends up in the entry graph
- The `ChatScreen` lazy boundary does almost nothing because all the heavy hooks already ran in App
- 107 props passed to `ChatScreen` — App is a state container wearing a router's clothes
- Every new workspace feature accretes in App by default

## Boundary

### App owns (routing shell)
- Auth: `useGitHubAuth`, `useGitHubAppAuth`, `token`, `validatedUser`
- Repo list: `useRepos`
- Active repo: `useActiveRepo` (`activeRepo`, `setActiveRepo`, `clearActiveRepo`, `setCurrentBranch`)
- Workspace session: `workspaceSession`, `setWorkspaceSession`
- `conversationIndex` — slim read-only map for HomeScreen (see Phase 4)
- `pendingResumeChatId` — intent passed to WorkspaceScreen; it calls `switchChat` internally
- Screen state machine: `'onboarding' | 'home' | 'workspace'`
- Handlers rewritten as **pure session/navigation mutations** (no reaching into useChat or useSandbox)

### WorkspaceScreen owns (workspace/chat/sandbox)
- `useChat` and all destructured values
- `useSandbox` + all lifecycle effects (branch teardown, auto-start, sandboxId sync)
- `useModelCatalog`, model draft state, per-provider selection handlers
- `useScratchpad`, `useSnapshotManager`, `useBranchManager`, `useProjectInstructions`
- `useProtectMain`, `useRepoAppearance`
- Settings UI state: `contextMode`, `approvalMode`, `sandboxStartMode`, `showToolActivity`
- Profile form state: `displayNameDraft`, `bioDraft`, `installIdInput`, `showInstallIdInput`
- `useUserProfile`
- Internal routing: `'chat' | 'file-browser'` (owns `showFileBrowser`, renders `FileBrowser` directly)
- Cleanup on session change: stop sandbox, create new chat — via effects, not imperative calls from App

### App → WorkspaceScreen interface (~25 props)
```ts
workspaceSession: WorkspaceSession
onWorkspaceSessionChange: (session: WorkspaceSession | null) => void
activeRepo: ActiveRepo | null
setActiveRepo: (repo: ActiveRepo) => void
clearActiveRepo: () => void
setCurrentBranch: (branch: string) => void
repos: RepoWithActivity[]
reposLoading: boolean
reposError: string | null
token: string | null
patToken: string | null
validatedUser: GitHubUser | null
isAppAuth: boolean
installationId: string | null
appLoading: boolean
appError: string | null
connectApp: () => void
installApp: () => void
setInstallationIdManually: (id: string) => void
onDisconnect: () => void
onSelectRepo: (repo: RepoWithActivity, branch?: string) => void
onStartScratchWorkspace: () => void
onEndWorkspace: () => void
pendingResumeChatId: string | null
onConversationIndexChange: (index: ConversationIndex) => void
```

## Key Corrections (from review)

1. **FileBrowser moves under WorkspaceScreen.** The `screen === 'file-browser'` branch currently in App reads `showFileBrowser && sandbox.sandboxId` — both workspace-owned. Internal routing between chat and file browser belongs in WorkspaceScreen.

2. **App handlers must be rewritten, not just moved.** `handleStartScratchWorkspace`, `handleEndWorkspace`, `handleSelectRepo`, `handleResumeConversationFromHome`, and `handleDisconnect` all currently reach into `useChat` or `useSandbox`. In their current form they cannot stay in App. After rewriting:
   - `handleEndWorkspace` → `setWorkspaceSession(null)` only; WorkspaceScreen effect handles `sandbox.stop()` and `createNewChat`
   - `handleDisconnect` → removes `deleteAllChats`; WorkspaceScreen unmounts and cleans up
   - `handleResumeConversationFromHome` → sets repo + `pendingResumeChatId`; removes `switchChat` call
   - `handleSelectRepo` → removes `sandbox.stop()`; WorkspaceScreen detects session change and stops sandbox

3. **Don't lift full `conversations` to App.** HomeScreen only needs repo-level metadata. A slim `ConversationIndex` is the right bridge (see Phase 4).

## Phases

### Phase 1 — Define boundary types
- Add `ConversationIndex` type: `Record<string, { repoFullName: string | null; branch: string | null; title: string; lastMessageAt: string }>`
- Sketch `WorkspaceScreenProps` interface in a types file
- No behavior changes; validates the API surface before writing any component code

### Phase 2 — Create WorkspaceScreen shell
- Create `app/src/sections/WorkspaceScreen.tsx`
- Move all workspace/chat hooks and state from App into it (≈700 lines)
- Move internal `'chat' | 'file-browser'` routing + `FileBrowser` rendering into WorkspaceScreen
- Wire `pendingResumeChatId`: on mount and prop change, call `switchChat` internally
- WorkspaceScreen calls `onConversationIndexChange` when conversations update
- WorkspaceScreen watches `workspaceSession` via `useEffect`; cleans up sandbox and resets chat when session is nulled

### Phase 3 — Rewrite App handlers
- Rewrite `handleStartScratchWorkspace`, `handleEndWorkspace`, `handleSelectRepo`, `handleResumeConversationFromHome`, `handleDisconnect` as pure session/nav mutations
- App's screen state machine simplifies to: `!token → 'onboarding'`, `!workspaceSession → 'home'`, else `'workspace'`
- App render becomes: `OnboardingScreen | HomeScreen | WorkspaceScreen` (no more FileBrowser or ChatScreen at App level)

### Phase 4 — Wire conversationIndex
- WorkspaceScreen derives `ConversationIndex` from `conversations` and calls `onConversationIndexChange`
- App holds `conversationIndex` state, passes to `HomeScreen` as `conversations`
- Verify `HomeScreen` and `RepoLauncherPanel` work with the slim type — they only read `repoFullName`, `branch`, and display metadata

### Phase 5 — Make WorkspaceScreen lazy
- Add `WorkspaceScreen` to the lazy declarations in App alongside `OnboardingScreen`, `HomeScreen`
- Rebuild and measure entry chunk size
- If `sandbox-client` is no longer statically imported anywhere outside WorkspaceScreen, the dynamic import in `useAgentDelegation.ts` becomes genuinely meaningful

## Principles

1. Don't touch `ChatScreen` — it keeps receiving props as today, just from WorkspaceScreen instead of App. Scope is the App→WorkspaceScreen boundary only.
2. Phase 2 is the big move; Phases 3–5 are cleanup that falls out of it.
3. TypeScript will enforce the boundary: if WorkspaceScreenProps compiles, the interface is honest.
4. Verify each phase builds and passes type checks before moving to the next.
