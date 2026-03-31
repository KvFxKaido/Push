# Workspace Route Follow-up Plan

## Status
- Created: 2026-03-25
- Reviewed against current code: 2026-03-30
- State: **Partially shipped** — the original boundary plan largely landed; remaining work is optional cleanup, bundle measurement, and deciding whether `WorkspaceChatRoute` needs further decomposition
- Scope: Follow-up work after the `useChat` refactor and the `WorkspaceScreen` extraction
- Goal: Make the workspace route feel like a set of honest boundaries instead of a new place where all complexity collects
- Follow-on note: chat-mode product/shell evolution is now tracked separately in `documents/plans/Chat Surface Evolution Plan.md`

## Implementation Status Snapshot (2026-03-30)

- [x] `WorkspaceChatRoute` exists and owns the secondary chat-route panels/workflows.
- [x] `WorkspaceScreen` has been reduced to a thin lazy wrapper around `WorkspaceSessionScreen`.
- [x] `WorkspaceSessionScreen` now hosts the route-level assembly/controller layer.
- [x] `useWorkspaceComposerState`, `useWorkspaceSandboxController`, and `useWorkspacePreferences` were extracted.
- [x] `toConversationIndex` is shared through `lib/conversation-index.ts`.
- [x] `ChatScreen` now accepts grouped domain props instead of one giant flat signature.
- [x] Secondary panel surfaces in `WorkspaceChatRoute` are lazy-loaded.
- [ ] The main follow-up question is no longer "should these boundaries exist?" but "does `WorkspaceChatRoute` now need a second decomposition pass, and is there still measurable bundle pain worth chasing?"

## Current Snapshot

Current shape after the shipped boundary work:

- `app/src/App.tsx` is 257 lines and behaves like a routing shell
- `app/src/sections/WorkspaceScreen.tsx` is 15 lines and acts as a lazy wrapper
- `app/src/sections/WorkspaceSessionScreen.tsx` is 431 lines and now owns the route-level assembly/controller layer
- `app/src/sections/WorkspaceChatRoute.tsx` is 591 lines and owns most chat-route orchestration and panel workflows
- `app/src/sections/ChatScreen.tsx` is 270 lines and reads as a presentational/composition layer with grouped props
- `app/src/hooks/useChat.ts` is still substantial at 1037 lines, but it is no longer carrying the same route/UI orchestration burden this plan targeted

What that means:

- The root app shell is no longer the bottleneck
- `WorkspaceScreen -> WorkspaceSessionScreen -> WorkspaceChatRoute -> ChatScreen` is now a real boundary chain, not just a pipe
- The original draft recommendation was mostly right and is now mostly implemented
- Any next move should be targeted and justified by current complexity or bundle evidence, not by the original draft assumptions

## Original Baseline (2026-03-25)

The sections below capture the draft diagnosis that motivated the work now largely shipped.

## What I See

`WorkspaceScreen` is currently mixing four separate responsibilities:

1. Workspace controller
   - `useSandbox`
   - session/sandbox lifecycle effects
   - file browser routing
   - sandbox inspection/download/restart

2. Chat composer/model state
   - remembered model memory
   - chat drafts
   - active draft normalization
   - provider/model selection handlers
   - `sendMessageWithChatDraft`

3. Workspace settings/profile state
   - tool activity toggle
   - approval/context/sandbox start modes
   - install-id form state
   - profile drafts and blur handlers

4. App bridge logic
   - `pendingResumeChatId`
   - `ConversationIndex` emission back to `App`

`ChatScreen` is currently mixing three separate responsibilities:

1. Screen composition
   - header
   - banners
   - chat container
   - composer

2. Cross-panel orchestration
   - launcher
   - chats drawer
   - workspace hub
   - new-chat workspace review flow
   - branch / merge sheets

3. Chat workflow adapters
   - edit-and-resend flow
   - quick prompt handling
   - regenerate wrapper
   - snapshot heartbeat wrappers
   - resume-from-launcher behavior

There are also small boundary leaks worth cleaning up:

- `toConversationIndex` exists in both `App.tsx` and `WorkspaceScreen.tsx`
- `ChatScreenProps` is still a huge flat surface instead of a few named domains
- Some heavy secondary UI surfaces are still bundled into the main workspace route even though they are sheet/panel workflows

## Recommendation

Do **not** reopen `App` or `useChat` as the main targets.

The next refactor should aim for this shape:

```text
App
  -> WorkspaceScreen
       -> FileBrowser
       -> WorkspaceChatRoute
            -> ChatScreen
            -> on-demand sheets / panels
```

That is the next honest boundary:

- `WorkspaceScreen` stays the workspace route shell and controller
- `WorkspaceChatRoute` owns chat-route orchestration
- `ChatScreen` becomes mostly composition and presentation

This is a better move than chasing line counts directly because it improves:

- prop boundaries
- ownership
- bundle split opportunities
- testability

## Principles

1. Keep `App` boring.
2. Keep `useChat` as the chat engine unless a bug forces new work there.
3. Extract by coherent subsystem ownership, not by “whatever 200-line block looks movable.”
4. Prefer grouped domain props over dozens of single callbacks and booleans.
5. Only add lazy boundaries after orchestration has moved behind them.
6. Each phase should be shippable and validate independently.

## Phases

### Phase 1 — Boundary Cleanup And Shared Types ✅ MOSTLY COMPLETE

**Goal:** make the next extraction honest before moving logic around.

**Changes:**
- Extract `toConversationIndex` into one shared helper
- Define grouped prop types for the chat route instead of extending the current flat prop list forever
- Move the biggest inline adapter objects in `ChatScreen` behind named helper builders where that improves readability

**Why first:**
- Low risk
- Clears small leaks before a bigger move
- Makes the next extraction more mechanical and less guessy

**Expected result:**
- No duplicated conversation-index bridge logic
- A clear type surface for the next route boundary

### Phase 2 — Introduce `WorkspaceChatRoute` ✅ COMPLETE

**Goal:** split UI orchestration from `ChatScreen` and stop treating `ChatScreen` as the place where every workspace panel flow lives.

**New file:**
- `app/src/sections/WorkspaceChatRoute.tsx`

**Move into `WorkspaceChatRoute`:**
- launcher state
- chats drawer state
- new-chat sheet state
- new-chat workspace review flow
- workspace hub coordination
- hub tab request state
- editing message / composer prefill state
- quick prompt / edit / regenerate wrappers
- resume-from-launcher behavior
- repo-accent theme side effect
- snapshot-heartbeat wrappers

**`WorkspaceChatRoute` should render:**
- `ChatScreen`
- `RepoLauncherSheet`
- `WorkspaceHubSheet`
- `NewChatWorkspaceSheet`
- `BranchCreateSheet`
- `MergeFlowSheet`

**`ChatScreen` should keep:**
- screen layout
- banners
- chat transcript / composer composition
- small view-local interactions only

**Why this is the highest-leverage move:**
- It creates the missing boundary inside the workspace route
- It shrinks both `WorkspaceScreen` and `ChatScreen` in a meaningful way
- It gives secondary UI flows a single owner
- It sets up later lazy loading without weird control flow

### Phase 3 — Split `WorkspaceScreen` Controller Hooks ✅ COMPLETE

**Goal:** turn `WorkspaceScreen` into assembly and route wiring instead of a giant hook host.

**Recommended extractions:**

1. `useWorkspaceComposerState.ts`
   - remembered model memory
   - chat drafts
   - active draft selection
   - provider/model handlers
   - `sendMessageWithChatDraft`

2. `useWorkspaceSandboxController.ts`
   - `showFileBrowser`
   - sandbox state fetch/inspection
   - `ensureSandbox`
   - restart/download helpers
   - start/exit/disconnect wrappers
   - unmount/session cleanup effects

3. `useWorkspacePreferences.ts`
   - tool activity preference
   - approval/context/sandbox start modes
   - install-id input state
   - profile drafts
   - blur/copy handlers

**Recommendation:** do `useWorkspaceComposerState` and `useWorkspaceSandboxController` first. `useWorkspacePreferences` is a good cleanup pass, but it is not the most important seam.

**Expected result:**
- `WorkspaceScreen` mostly wires together stable controller hooks and routes
- The file stops being the default landing zone for every new workspace concern

### Phase 4 — Collapse The `ChatScreen` Prop Surface ✅ COMPLETE

**Goal:** make `ChatScreen` readable as an API.

**Approach:**
- Replace the flat prop list with a few grouped domain objects

**Suggested groups:**
- `workspace`
- `chat`
- `repo`
- `catalog`
- `settings`
- `profile`
- `actions`

**Important constraint:**
- Do not just create one giant `screenState` object and call it a day
- Each group should represent a real subsystem with a clear owner

**Expected result:**
- `ChatScreenProps` becomes understandable at a glance
- Future extractions can move a domain group without rewriting the whole signature

### Phase 5 — Secondary Lazy Boundaries And Bundle Cleanup ✅ MOSTLY COMPLETE

**Goal:** reduce the workspace chunk now that the route boundaries are honest.

**Candidates for lazy loading:**
- `RepoLauncherSheet`
- `WorkspaceHubSheet`
- `NewChatWorkspaceSheet`
- `BranchCreateSheet`
- `MergeFlowSheet`

**Also inspect:**
- `sandbox-client` split warning
- `DiffPreviewCard` warning
- `AuditVerdictCard` warning

**Important note:**
- Do not start by raising `chunkSizeWarningLimit`
- First make the imports honest and move on-demand UI behind actual on-demand boundaries

**Expected result:**
- Smaller workspace chunk
- Better alignment between user flows and loaded code

## What I Would Not Do

- Do not move workspace state back into `App`
- Do not reopen `useChat` just to hit a prettier line count
- Do not hide `WorkspaceScreen` behind one mega-hook that returns 80 values
- Do not lazy load the core chat path if it hurts the first workspace render
- Do not optimize bundle size first if the ownership boundaries are still muddy

## Validation For Every Phase

Run after each phase:

- `cd app && npm run typecheck`
- `cd app && npm run lint`
- `cd app && npm test`
- `cd app && npm run build`

Manual smoke checklist:

- Open a repo workspace
- Open a scratch workspace
- Resume a conversation from Home
- Create a new chat and choose both “continue current workspace” and “start fresh workspace”
- Open the launcher and chats drawer
- Open the workspace hub and switch tabs
- Switch branches and verify sandbox teardown/restart behavior
- Restart and download the sandbox
- Edit/resend and regenerate a response

## Suggested Sequence

If I were shipping this in small PRs, I would do it in this order:

1. Phase 1 boundary cleanup
2. Phase 2 `WorkspaceChatRoute`
3. Phase 3 `useWorkspaceComposerState`
4. Phase 3 `useWorkspaceSandboxController`
5. Phase 4 grouped `ChatScreen` props
6. Phase 5 lazy boundaries and bundle cleanup

## Strongest Recommendation

The original strongest recommendation was **Phase 2: introduce `WorkspaceChatRoute`**.

That move has landed.

The best remaining follow-up is narrower:

- measure whether `WorkspaceChatRoute` is now the right next hotspot
- only split it further if the ownership boundary is starting to blur again
- keep bundle cleanup tied to real lazy-boundary wins instead of chasing line counts
