# Architecture Follow-up Plan

## Status
- Created: 2026-03-28
- Completed: 2026-03-28
- State: Done
- Scope: Post-GitHub-core consolidation and post-workspace-route chunk split cleanup
- Goal: Finish the remaining architectural seams without reopening the big refactors that already landed cleanly

## Current Shape

Recent work moved Push into a meaningfully better state:

- The shared GitHub tool implementation now lives in `lib/github-tool-core.ts`
- The app fallback path, Worker bridge, and MCP server all route through that shared core
- `WorkspaceScreen` is now a thin lazy shell, and the workspace route no longer trips the Vite large-chunk warning

That said, three follow-up seams are still visible:

1. `app/src/sections/WorkspaceSessionScreen.tsx`
   - Current size: 402 lines
   - Still acts as the main workspace composition root
   - Owns a lot of hook assembly plus a very large `WorkspaceChatRoute` prop handoff

2. `app/src/lib/github-tools.ts`
   - Current size: 1369 lines
   - No longer duplicates the whole GitHub tool implementation, which is good
   - Still mixes protocol detection, local execution fallback, transport bridging, and a few UI-owned GitHub actions

3. Worker/MCP request parsing
   - `app/src/worker/worker-github-tools.ts` has its own payload parser
   - `mcp/github-server/src/index.ts` has its own tool-arg parser
   - The duplication is smaller than before, but still structural duplication

## Recommendation

Do not do a big-bang rewrite.

The recent changes created good boundaries:

- shared GitHub core
- lazy workspace route shell
- UI-owned branch/PR review helpers

The next pass should make those boundaries more honest and easier to maintain, not replace them.

## Principles

1. Preserve the shared GitHub core as the center of gravity.
2. Prefer compatibility facades over import churn.
3. Extract by ownership, not by line count alone.
4. Keep each phase independently shippable.
5. Avoid reopening solved problems just because adjacent files are still large.

## Workstream 1 — Shared GitHub Tool Parsing

### Problem

The shared core already owns execution and result shaping, but Worker and MCP still each interpret raw request payloads separately.

Current duplication:

- `app/src/worker/worker-github-tools.ts`
- `mcp/github-server/src/index.ts`

### Goal

Make request parsing a shared layer so that:

- one tool surface maps to one parser contract
- Worker and MCP wrappers stay thin
- adding or changing a tool does not require editing parsing logic in multiple runtimes

### Target Shape

Introduce a shared parser module, likely in `lib/`, for example:

- `lib/github-tool-parser.ts`

That shared parser should own:

- raw args -> `GitHubCoreToolCall`
- required/optional arg validation
- common coercions (`string`, `number`, `int`, `record<string, string>`)

Runtime-specific wrappers should stay responsible for:

- Worker-only `allowedRepo`
- request body decoding
- MCP request/response formatting

### Phases

#### Phase 1A
- Extract shared arg parsing helpers from the Worker/MCP implementations
- Add focused parser tests covering all supported GitHub tools

#### Phase 1B
- Replace `parseToolPayload` in `app/src/worker/worker-github-tools.ts` with a thin wrapper around the shared parser
- Replace `parseGitHubToolCall` in `mcp/github-server/src/index.ts` with the same shared parser

### Acceptance Criteria

- No tool-arg validation logic is duplicated between Worker and MCP
- Adding a GitHub tool requires one parser change, not two
- Existing app/Worker/MCP GitHub tests still pass

## Workstream 2 — Split `github-tools.ts` By Ownership

### Problem

`app/src/lib/github-tools.ts` is much healthier than before, but it still does too many different jobs:

- LLM tool protocol detection
- tool-call validation
- local runtime creation / fallback execution
- public prompt/protocol text assembly
- UI-owned GitHub actions like branch creation and PR review helpers

That makes the file hard to reason about even though the worst duplication is gone.

### Goal

Turn `github-tools.ts` into either:

- a compatibility facade, or
- a thin UI-oriented entrypoint

and move the real responsibilities behind clearer modules.

### Target Shape

Suggested split:

- `app/src/lib/github-tool-protocol.ts`
  - `ToolCall`
  - `detectToolCall`
  - prompt/protocol text assembly

- `app/src/lib/github-tool-executor.ts`
  - repo validation
  - Worker/local fallback dispatch
  - local runtime adapter for the shared core

- `app/src/lib/github-tools.ts`
  - compatibility exports for existing callers
  - UI-owned helpers only, or re-exports where needed

UI-owned helpers that may still live behind the facade:

- `executeCreateBranch`
- `findOpenPRForBranch`
- `executePostPRReview`

### Phases

#### Phase 2A
- Move protocol/detection types and helpers into `github-tool-protocol.ts`
- Move execution/fallback logic into `github-tool-executor.ts`

#### Phase 2B
- Leave `github-tools.ts` as a compatibility layer for current imports
- Migrate direct imports gradually only if it improves readability

### Acceptance Criteria

- `github-tools.ts` is no longer the main owner of protocol + execution + UI helpers all at once
- The app still exports the same user-facing behavior
- Import churn stays limited and deliberate

## Workstream 3 — Shrink `WorkspaceSessionScreen`

### Problem

`WorkspaceSessionScreen.tsx` is a much better hotspot than the old `WorkspaceScreen`, but it is still the default landing zone for:

- session bridge effects
- workspace hook assembly
- route-level composition
- giant prop assembly into `WorkspaceChatRoute`

It is not broken, but it is the next place complexity will naturally collect.

### Goal

Make `WorkspaceSessionScreen` read like a composition root instead of a controller dump.

### Target Shape

Keep these layers:

```text
App
  -> WorkspaceScreen
       -> WorkspaceSessionScreen
            -> WorkspaceChatRoute
```

But make `WorkspaceSessionScreen` mostly assemble named domains rather than inline every concern.

### Suggested Extractions

#### 3A. Session bridge helpers

Extract the app/workspace bridge concerns:

- conversation index emission
- pending resume chat handling
- sandbox promotion / branch-switch bridge callbacks

Possible target:

- `app/src/sections/useWorkspaceSessionBridge.ts`

#### 3B. Route prop builders or grouped route domains

The handoff into `WorkspaceChatRoute` is still one huge prop surface.

Instead of a flat wall of props, group them by subsystem:

- `conversation`
- `workspace`
- `repo`
- `catalog`
- `auth`
- `preferences`
- `profile`

This can be done either with:

- grouped prop types in `workspace-chat-route-types.ts`, or
- a small builder/helper module that assembles those domains cleanly

#### 3C. Keep `WorkspaceSessionScreen` as assembly

After the extractions above, `WorkspaceSessionScreen` should mostly:

- invoke the major controller hooks
- assemble route domains
- choose between file browser vs workspace chat route

### Acceptance Criteria

- `WorkspaceSessionScreen.tsx` is substantially smaller and easier to scan
- The `WorkspaceChatRoute` handoff reflects real subsystem boundaries
- Future workspace concerns have obvious owners instead of defaulting back into the composition root

## Suggested Order

1. Shared GitHub tool parsing
   - smallest risk
   - highest immediate duplication win

2. Split `github-tools.ts`
   - clarifies app-side ownership after parser convergence

3. Shrink `WorkspaceSessionScreen`
   - important, but now less urgent because the bundle warning is already fixed

## Non-Goals

- Rewriting the shared GitHub core again
- Reopening the full workspace route split
- Replacing Worker/MCP with a single runtime
- Raising Vite warning thresholds instead of improving boundaries

## Exit Criteria

This follow-up should be considered complete when:

- Worker and MCP no longer duplicate GitHub tool arg parsing
- `github-tools.ts` is split by ownership rather than acting as a structural junk drawer
- `WorkspaceSessionScreen` is clearly a composition root, not the next giant hotspot
- App typecheck/build and MCP typecheck/build still pass after each phase
