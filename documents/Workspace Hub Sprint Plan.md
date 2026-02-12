# Workspace Hub Sprint Plan

## Goal

Unify top-right workspace controls into a single mobile-first hub that feels closer to the Codex web flow.

Core outcomes:
- One top-right button opens a full-screen workspace hub.
- Swipeable tabs for:
  - `Files`
  - `Diff`
  - `Console`
  - `Scratchpad`
- `Commit` and `Push` actions live in the hub header with two-step confirmations.

## Status Snapshot (February 12, 2026)

### Completed
- [x] Added `WorkspaceHubSheet` component.
- [x] Replaced split top-right `File` + `Workspace` buttons with one hub trigger button.
- [x] Added swipeable tabs: `Files`, `Diff`, `Console`, `Scratchpad`.
- [x] Implemented Files tab directory browsing and file preview.
- [x] Implemented Diff tab with refreshable sandbox diff.
- [x] Implemented Console tab from tool call/result message stream.
- [x] Implemented Scratchpad tab with memory load/save/delete actions.
- [x] Added two-step `Commit` confirmation with commit message field.
- [x] Added two-step `Push` confirmation.
- [x] Enforced Protect Main guard for commit/push on default branch.
- [x] Validation run: `npm run lint`, `npm run test`, `npm run build`.

### Not Completed Yet
- [ ] Consolidate repo/chat history drawer into the hub (`Chats` tab).
- [ ] Move branch management/actions into hub context.
- [ ] Add richer diff explorer (per-file navigation / jump).
- [ ] Replace standalone file-browser commit flow with shared hub flow (if desired).

## Why

Current controls are fragmented:
- File viewer launch is one button.
- Console/scratchpad panel is a second button.
- Commit/push currently lives in the file browser screen.

This split increases UI overhead and hides important state transitions. A unified hub improves discoverability, consistency, and mobile ergonomics.

## Scope (Sprint 1)

### In Scope
- New `WorkspaceHubSheet` component.
- Replace top-right file + workspace buttons with one hub trigger button.
- Hub tabs: `Files`, `Diff`, `Console`, `Scratchpad`.
- Swipe left/right to switch tabs.
- File tab:
  - Directory browsing and refresh (viewer behavior, no destructive actions in v1).
- Diff tab:
  - Refreshable working-tree diff preview using sandbox diff endpoint.
- Console tab:
  - Render tool-call/result stream extracted from message history.
- Scratchpad tab:
  - Reuse existing scratchpad content + memory operations.
- Header commit/push actions:
  - `Commit` uses two-step confirmation and commit message input.
  - `Push` uses two-step confirmation.
  - Main/default branch protection respected.

### Out of Scope (Sprint 1)
- Folding repo/chat history drawer into this same hub.
- Full file edit flow inside hub tabs.
- Advanced diff filtering or per-file split diff.
- Replacing existing `CommitPushSheet` behavior in standalone FileBrowser route.

## Safety / Hygiene Rules

- Commit blocked when:
  - No sandbox ready.
  - Protect-main is enabled and active branch equals default branch.
  - No staged/untracked changes after `git add -A`.
  - Auditor verdict is `UNSAFE`.
- Push blocked when:
  - No sandbox ready.
  - Protect-main is enabled and active branch equals default branch.
- Both actions use explicit two-step user confirmation state.

## Implementation Plan

1. Create `WorkspaceHubSheet` component.
2. Implement tab state + touch swipe navigation.
3. Add Files tab with lightweight directory viewer using `useFileBrowser`.
4. Add Diff tab using `getSandboxDiff`.
5. Add Console tab log extraction (same logic as existing panel).
6. Add Scratchpad tab with memory CRUD controls.
7. Add commit/push header actions (two-step confirm).
8. Wire into `App.tsx`, replacing top-right file/workspace buttons.
9. Keep existing branch dropdown, repo drawer, and standalone FileBrowser route unchanged for safety.
10. Validate with `npm run lint`, `npm run test`, `npm run build`.

## Validation Checklist

- Hub opens/closes reliably on mobile.
- Swipe gesture switches tabs without accidental triggers on vertical scroll.
- Files tab can browse `/workspace` tree.
- Diff tab displays current diff and refreshes.
- Console tab shows tool activity.
- Scratchpad edits persist and memory controls still work.
- Commit and push enforce two-step confirmation.
- Protect-main prevents commit/push on default branch when enabled.

## Follow-up (Sprint 2 Candidate)

- Add `Chats` tab and migrate `RepoChatDrawer` content into hub.
- Move/merge branch actions into hub contextual header.
- Add richer diff explorer (file list + jump).
- Add terminal-like structured console with filters.
