# Chat Surface Evolution Plan

Date: 2026-03-31
Status: **Mostly shipped** — Tracks A, B, D, E, F shipped 2026-03-31; Track C (explicit context escalation) still open
Owner: Push
Related:
- `docs/runbooks/Workspace Route Follow-up Plan.md` — route-boundary cleanup that made the current workspace/chat shell possible
- `docs/runbooks/UX Nice-to-Haves Plan.md` — longer-tail chat UX ideas and quality-of-life follow-ups
- `docs/decisions/Architecture Rating Snapshot.md`

## Why this plan exists

Chat mode now exists as a real workspace mode, not just a "no tools" toggle. That is good progress, but the current product shape is still too workspace-derived.

What we have today is closer to:

- a workspace shell that conditionally hides repo and sandbox behavior
- a launcher that can now show chat entry points, but still thinks in repo/workspace terms first
- boot and persistence logic that has only recently stopped assuming repo or scratch as the primary non-home destinations

That is enough to ship and iterate, but it is not yet the long-term product shape.

The product direction we want is:

- **Chat as a first-class surface**
- **Workspace and repo context as attachable execution/context layers**
- **one shared Push platform underneath**

This is intentionally **not** a plan to split Push into two separate deployed apps.

## Decision

Push should move toward **separate surface, shared platform**:

- chat gets its own shell, launcher framing, and navigation assumptions
- repo/scratch workspaces keep their own execution-oriented shell
- auth, storage, orchestration, providers, conversations, and agent runtime stay shared

The Claude-style product lesson to borrow is "chat feels like its own app surface," not "duplicate the whole app stack."

## Goals

1. Make chat mode feel like a chat-first product surface, not a workspace with features hidden.
2. Keep workspace/repo execution flows available as explicit escalations from chat.
3. Reduce `isChat` branching pressure inside the workspace route over time.
4. Preserve one shared runtime/storage/auth/model platform.
5. Make reload, launcher, and navigation behavior feel native to each mode.
6. Clarify which surface owns global settings, chat instructions, and workspace/project context.

## Non-goals

- Splitting Push into separate deployed web apps.
- Forking auth, provider selection, conversation storage, or agent runtime by mode.
- Rewriting the entire current workspace route before extracting the chat-specific seams.
- Designing the final visual language for every chat screen up front.
- Turning chat mode into a consumer/general-purpose assistant unrelated to Push's coding/product scope.
- Turning the existing short profile bio into the long-term home for chat instructions.

## Current problems to solve

### 1. Chat still borrows too much of the workspace shell

The current route stack can support chat mode, but it still carries workspace assumptions:

- launcher logic is shared, but chat-specific affordances have to be threaded through workspace plumbing
- top-level route composition still branches on `isChat`
- bugs tend to show up as "chat fell back to workspace assumptions"

### 2. The launcher is still repo-first in its information architecture

Even after the recent fixes, the launcher still reads like:

- resume repo work
- browse repos
- optionally start chat

For chat mode, the preferred order should be closer to:

- continue or switch conversation
- attach workspace
- attach repo

### 3. Boot and persistence logic are still catching up

Reload behavior is better now, but mode restoration still lives in the same app bootstrap that historically assumed onboarding/home/repo as the primary flow.

We should expect more subtle leakage until chat/session restoration is treated as a first-class path instead of an exception.

### 4. Chat controls are still mixed with execution-oriented controls

Chat should feel lighter by default:

- fewer execution affordances in the base shell
- clearer "attach context" actions
- less ambient repo/workspace framing until the user opts in

### 5. The route boundaries are right, but not yet mode-specific enough

The workspace-route work gave Push honest screen boundaries. The next step is not to reopen that entire refactor, but to create a cleaner split between:

- `chat shell`
- `execution shell`

without duplicating the runtime underneath them.

### 6. Settings and instructions ownership is still muddy

Right now Push still blurs together several different kinds of configuration:

- short global profile metadata
- chat-specific working instructions
- repo/workspace/project context
- execution/settings controls that only matter in workspace mode

The current `Working style` field is a good example: it is hard-capped at 300 characters and behaves like a short user profile note, not a real custom-instructions system.

That creates two problems:

- chat mode has no honest home for longer-form instructions
- the workspace hub is at risk of becoming a giant mixed "settings + project + execution" drawer

The product boundary we want is:

- **Global settings**
  - account
  - provider/model defaults
  - short personal profile
- **Chat surface**
  - longer-form chat instructions
  - chat behavior/preferences
- **Workspace / project surface**
  - repo/workspace context
  - notes/files/review/diff
  - project-specific instructions and state

## Workstreams

### Track A: Dedicated Chat Surface

### Objective

Introduce a dedicated chat-first shell/route composition so chat mode stops piggybacking on the workspace shell as its primary identity.

### Scope

- Add a dedicated chat route/shell layer under the app shell.
- Keep the shared chat engine, conversation state, and runtime.
- Move chat-specific header, launcher framing, and navigation assumptions into that surface.
- Reduce `isChat` branching inside the workspace route wherever the new shell makes that unnecessary.

### Likely touch points

- `app/src/App.tsx`
- `app/src/sections/WorkspaceSessionScreen.tsx`
- `app/src/sections/WorkspaceChatRoute.tsx`
- new chat-specific section/shell files under `app/src/sections/`
- `app/src/sections/ChatScreen.tsx`

### Exit criteria

- Chat mode can be described as its own screen surface, not "workspace mode with a special flag."
- The workspace route no longer owns every chat-mode presentation concern.
- The main route tree reads clearly as `home/onboarding -> chat surface OR workspace surface`.

### Track B: Chat-First Launcher And Navigation

### Objective

Make the launcher feel native to chat mode instead of repo-first with chat attached.

### Scope

- Create a chat-first launcher IA for chat sessions.
- Prioritize:
  - current conversation
  - other chats
  - start/switch to scratch workspace
  - open/select repo context
- Keep repo launcher behavior available for execution-oriented surfaces.
- Audit central button labels and header copy so they match the actual surface.

### Likely touch points

- `app/src/components/launcher/LauncherHomeContent.tsx`
- `app/src/components/launcher/RepoLauncherPanel.tsx`
- `app/src/components/launcher/RepoLauncherSheet.tsx`
- `app/src/sections/ChatScreen.tsx`

### Exit criteria

- In chat mode, the launcher reads as a context switcher, not primarily as a repo browser.
- In workspace/repo mode, the launcher can remain execution-oriented without carrying chat UX debt.

### Track C: Explicit Context Escalation

### Objective

Make "attach workspace" and "attach repo" explicit actions from chat instead of implicit mode jumps.

### Scope

- Define the user-facing actions and transitions from chat into:
  - scratch workspace
  - repo-backed workspace
  - repo browse/repo work entry
- Ensure these transitions preserve conversation continuity where appropriate.
- Clarify whether escalation creates a new chat, reuses the current one, or offers both.
- Make the UI language match the real state transition instead of silently changing shells.

### Open questions

- Should "attach repo" preserve the same conversation id or create a new branch-scoped conversation with a clear handoff?
- Should chat-to-workspace escalation always offer "continue here" vs "start fresh"?
- How visible should the current context attachment be in the chat header?

### Exit criteria

- Moving from plain chat into execution context feels additive and explicit.
- The user is never surprised about whether they are still in plain chat or now in a workspace/repo context.

### Track D: Mode-Specific Persistence And Boot Logic

### Objective

Make boot/reload behavior feel correct per mode rather than relying on shared fallback heuristics.

### Scope

- Audit session restoration for:
  - onboarding -> chat/workspace entry
  - home -> resume conversation
  - reload in chat
  - reload in scratch
  - reload in repo
- Reduce the remaining assumptions that repo mode is the "real" destination and chat is a special case.
- Make launcher/home availability and restoration rules intentional instead of side effects of shared app boot.

### Likely touch points

- `app/src/App.tsx`
- `app/src/hooks/useActiveRepo.ts`
- `app/src/hooks/chat-management.ts`
- session bootstrap/storage helpers

### Exit criteria

- Reload and resume behavior are mode-correct without one-off patches.
- Chat restoration no longer feels like a recently added exception.

### Track E: Chat-Specific UX And Control Surface Cleanup

### Objective

Strip remaining execution-first framing out of plain chat mode.

### Scope

- Continue trimming repo/workspace framing from plain chat empty states and chrome.
- Audit settings, badges, banners, and indicators that should be hidden or relabeled in chat.
- Decide which provider/model controls remain visible in plain chat vs only in expanded settings.
- Revisit onboarding so no-account entry clearly offers:
  - chat
  - scratch workspace

### Exit criteria

- A new user can understand chat mode without mentally translating workspace terminology.
- Chat mode feels intentionally light, not merely reduced.

### Track F: Settings, Instructions, And Project-Surface Ownership

### Objective

Define which surface owns which kind of instructions/settings so chat mode can support richer guidance without stuffing more into the current profile field or workspace hub.

### Scope

- Split settings ownership into three layers:
  - **Global settings**
    - account
    - provider/model defaults
    - short personal profile
  - **Chat instructions**
    - longer-form instructions for plain chat mode
    - optional chat-level or default-chat overrides
  - **Workspace / project surface**
    - repo/workspace/project-specific context and instructions
    - execution-oriented controls and state
- Stop treating the current 300-character profile bio as the long-term instructions system.
- Decide whether the workspace hub should evolve into a more explicit project/context panel over time.
- Keep the first step smaller than full ChatGPT-style Projects:
  - clarify ownership first
  - introduce real chat instructions second
  - only then decide whether first-class Project entities are warranted

### Likely touch points

- `app/src/hooks/useUserProfile.ts`
- `app/src/components/SettingsSectionContent.tsx`
- `app/src/components/chat/WorkspaceHubSheet.tsx`
- `app/src/components/chat/hub-tabs/HubSettingsTab.tsx`
- `app/src/sections/WorkspaceChatRoute.tsx`
- storage/types for chat-level instruction state

### Exit criteria

- Push has a real home for longer-form chat instructions.
- The short global profile remains short and personal.
- The workspace hub is framed as a project/context surface, not a dumping ground for unrelated settings.
- We can evaluate a future Projects abstraction from a cleaner baseline instead of backing into it accidentally.

## Rollout order

1. **Track E (small polish + onboarding clarity)** — shipped 2026-03-31
   - Onboarding now offers Chat + Workspace as separate no-account entry points
   - Chat empty state reframed positively and kept intentionally prompt-free
   - Hub panel visible in chat mode with filtered tabs (notes + settings)

2. **Track F (settings/instructions ownership)** — shipped 2026-03-31
   - Chat instructions field (4000 chars) separate from the 300-char bio
   - Injected into system prompt only in chat mode; workspace uses project instructions
   - Settings ownership clarified: global profile (bio), chat instructions, workspace settings

3. **Track B (chat-first launcher)** — shipped 2026-03-31
   - Launcher shows recent chat conversations first when opened from chat mode
   - Sandbox/repo resume cards hidden in chat mode; Chat action button suppressed
   - Mode prop flows through LauncherHomeContent → RepoLauncherPanel

4. **Track D (mode-specific boot/persistence cleanup)** — shipped 2026-03-31
   - Fixed: handleResumeConversationFromLauncher now handles chat/scratch conversations
   - Audited boot/reload paths — chat session persistence and restoration confirmed correct

5. **Track A (dedicated chat surface)** — shipped 2026-03-31
   - Chat sessions now route through a dedicated `ChatSurfaceRoute` / `ChatSurfaceScreen`
   - `WorkspaceChatRoute` is back to scratch/repo execution concerns instead of owning chat presentation too
   - The route split stays on one shared runtime/storage/auth platform; this is a surface boundary, not an app fork

6. **Track C (explicit context escalation)**
   - now unblocked by the dedicated chat surface and chat-first launcher work
   - should ship once the plain-chat baseline feels settled

## Risks

- Over-splitting too early and accidentally duplicating large parts of the workspace surface.
- Letting "chat as its own surface" become "chat as a separate product" without meaning to.
- Preserving too much current branching in the name of minimal diff, leaving the surface conceptually split but technically tangled.
- Making context escalation too clever and hiding real state transitions from the user.

## Success criteria

This plan is successful if, after shipping, the product feels like:

- **Push Chat** is a natural default conversational surface
- **Workspace** is an execution context you opt into
- **Repo** is a source-of-truth context you attach deliberately

without:

- two separate apps
- duplicated runtime/platform logic
- persistent confusion about which mode the user is actually in
