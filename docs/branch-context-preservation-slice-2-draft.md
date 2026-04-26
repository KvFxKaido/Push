# Slice 2 — Conversation-Preserving Fork Flow (Draft v3)

Status: revised after TWO /council passes; ready for implementation
Author: Claude (working with Shawn)
Date: 2026-04-26
Roadmap item: "UX: Preserving Context on Branch Creation" (planned)
Builds on: PR #411 (slice 1, merged)

**v3 revision notes:** Second council pass caught a real bug in v2's D2 mechanism — `queueMicrotask` clear of `skipAutoCreateRef` runs before React commits the render, so the guard is false when the auto-switch effect re-evaluates. v3 replaces it with a state-observed clear (Codex's preferred approach). Other v3 changes: producer defaults committed (`github_create_branch` + `release_draft` = `'switched'` not `'forked'`), D3 carries `branchAtDispatch` structurally on the in-flight tool record, D6 adds prompt-packing filter centralization requirement, D2 adds no-active-chat fallback, R10 adds a minimal localStorage cross-tab marker, R11 data contract spelled out.

**v2 revision notes (kept for history):** v2 incorporated first /council pass: D1 switched to object form, D2 added explicit `skipAutoCreateRef` guard covering both effect branches, D3 stamps at tool-invocation time, D4 made auditor invariant explicit, UI naming changed to "New Branch from Here", `branch_forked` event marked non-model-visible, four new risks (R9–R12) added.

---

## Goal

When a user (or the model) creates a new branch from the current workspace state, the active chat session and the in-progress sandbox state should follow the new branch — not get wiped or replaced by a fresh chat.

This implements the roadmap's "UX: Preserving Context on Branch Creation" item. Slice 1 (PR #411) added the `sandbox_create_branch` tool, the `branchSwitch` propagation plumbing, and the sandbox-no-teardown wiring. Slice 2 closes the remaining gap: the conversation itself.

---

## What slice 1 shipped (substrate we're building on)

- `sandbox_create_branch` tool (web) and `git_create_branch` tool (CLI) with strict ref validation, atomic checkout, file-cache invalidation.
- `git:branch` capability granted to Coder; `INVALID_ARG` error type.
- Guard hardening: raw `git checkout -b` / `git switch -c` blocked even in full-auto mode.
- `branchSwitch?: string` field on `ToolExecutionResult` — propagated through `chat-send.ts:1520` to `runtimeHandlersRef.current?.onBranchSwitch?.()`.
- `handleSandboxBranchSwitch` at `WorkspaceSessionScreen.tsx:100-106` — sets `skipBranchTeardownRef.current = true` then calls `setCurrentBranch(branch)`.
- Sandbox stays alive across the branch change.

**The remaining gap:** when `currentBranch` updates, `useChat`'s filter (`useChat.ts:556-568`) excludes the active conversation (which still has `conv.branch === 'main'`), `sortedChatIds` becomes empty, the auto-create effect at line 571-603 fires, and a fresh chat is created — losing context. There's also a *second* path in the same effect (the `else if` at line 599) that yanks `activeChatId` to `sortedChatIds[0]` if the active chat falls out of the filter — slice 2 must guard against both.

---

## Scope

### In slice 2

1. **`branchSwitch` field becomes a normalized object** with `kind`, `from`, and `sha` for richer provenance.
2. **Forked path migrates the active conversation** — explicit `skipAutoCreateRef` guard (mirroring `skipBranchTeardownRef`) suppresses both auto-create AND the chat-id-steal path during the transition. React batching is a nice-to-have, not the safety mechanism.
3. **Per-message branch attribution** — `branch?: string` field on `ChatMessage`, stamped at message-creation/tool-invocation time (not at completion).
4. **"New Branch from Here" UI entry point** — button in the workspace hub branch selector. Calls the same `forkBranchInWorkspace(name, from?)` helper as the tool handler.
5. **`branch_forked` typed event** inserted in chat — non-model-visible by default; surfaced to the model via prompt-builder as a directive ("workspace file system was branched at this point; prior context may be stale").
6. **Centralized read-boundary fallback** for legacy messages without `branch` — happens in the persistence load layer, not at render sites.
7. **Producer revalidation** — verify each existing `branchSwitch` producer's correct `kind` rather than blindly marking all three as `'forked'`.
8. **Tests** for state ordering, conversation migration, switched-vs-forked discrimination, both effect-branch suppressions, system event insertion.

### Out of slice 2 (deferred)

- **Block plain `git checkout <branch>` / `git switch <branch>`** — slice 2.5.
- **`sandbox_switch_branch` tool** for the switch-to-existing case — slice 2.5.
- **Background-job adapter promotion** — slice 3.
- **Bulk migration of existing per-message branch data** — never; forward-only.

---

## Design decisions

### D1: How do we represent the branch-switch result? (REVISED)

**v1 chose** sibling fields (`branchSwitchKind?: 'forked' | 'switched'` alongside `branchSwitch?: string`) for backward compatibility. **Council unanimously pushed back** — sibling optional fields encode an invalid state space (kind without name, or name without kind), and the small slice-1 churn is cheap.

**v2 chooses** a normalized object on `ToolExecutionResult`:

```ts
export interface ToolExecutionResult {
  // ...
  branchSwitch?: {
    name: string;
    kind: 'forked' | 'switched';
    from?: string;       // previous branch (for forked: source branch; for switched: optional)
    sha?: string;        // commit SHA of the new branch's HEAD
    source?: 'sandbox_create_branch' | 'github_create_branch' | 'release_draft' | 'ui';
  };
}
```

**Why these fields:**
- `name` + `kind`: minimum viable discriminator.
- `from` + `sha`: avoids a second source of truth for the `branch_forked` event (D5 also needs them).
- `source`: not user-facing; aids debugging and tests. Lets us tell "tool fired" from "UI fired" from "release flow auto-created" without inspecting the call site.

**Migration cost:** three producer call sites + `chat-send.ts:1520` consumer + a few tests that assert `branchSwitch === 'feature/foo'`. Mechanical change, ~30 lines total.

**Producer revalidation (RESOLVED in v3 per second council pass):** both consultants converged that the github_create_branch and release_draft producers should default to `'switched'`, not `'forked'`. Their user intent is different from `sandbox_create_branch`'s "I'm intentionally forking the conversation right now":

- `app/src/lib/sandbox-tools.ts` (`sandbox_create_branch`): `kind: 'forked', source: 'sandbox_create_branch'`. The whole point of slice 2.
- `app/src/lib/github-tools.ts:100` (github-side `create_branch`): `kind: 'switched', source: 'github_create_branch'`. This is typically PR-side branching that doesn't intend conversation migration — the user is creating a branch on GitHub for some other purpose, not forking their current chat.
- `app/src/lib/sandbox-git-release-handlers.ts:622` (draft branch in commit/push): `kind: 'switched', source: 'release_draft'`. User intent is checkpointing/staging a commit, not "fork my work into a new conversation." Behavior matches existing pre-slice-2 expectations.

If runtime audit during implementation reveals these defaults are wrong, flip them — but starting from `'switched'` matches the principle of least surprise (existing behavior preserved).

### D2: State update ordering — REVISED in v3 to state-observed clear

**Evolution:** v1 relied on React 18 auto-batching (rejected as fragile). v2 added an `skipAutoCreateRef` boolean cleared via `queueMicrotask` (also rejected — microtasks run before React commits the next render, so the guard clears before the auto-switch effect re-evaluates against the migrated state). **v3 uses a state-observed clear:** the guard holds the migration's target state, and a separate effect clears it only when the migration is observable in the rendered state.

**Mechanism:**

```ts
// In WorkspaceSessionScreen.tsx (or wherever the migration handler lives).
type MigrationGuard = { chatId: string; toBranch: string } | null;
const skipAutoCreateRef = useRef<MigrationGuard>(null);
const activeChatIdRef = useRef<string | null>(activeChatId);
useEffect(() => { activeChatIdRef.current = activeChatId; }, [activeChatId]);

const handleForkedBranchSwitch = useCallback(
  ({ name, from, sha, source }: ForkedBranchSwitchPayload) => {
    // CRITICAL: read activeChatId from the ref, not a captured callback value.
    // A stale capture would migrate the wrong conversation if the user
    // switched chats between dispatch and resolution.
    const targetChatId = activeChatIdRef.current;

    if (!targetChatId || !conversations[targetChatId]) {
      // No active conversation to migrate. The fork happened in the sandbox,
      // but there's nothing to follow it. Sync the branch silently and let
      // the existing auto-create path produce a fresh chat on the new branch.
      // Do NOT set the migration guard — there's nothing to migrate.
      skipBranchTeardownRef.current = true;
      setCurrentBranch(name);
      // Optional: append a non-attached system event noting the orphan fork.
      return;
    }

    // Set both guards BEFORE any state update.
    skipBranchTeardownRef.current = true;
    skipAutoCreateRef.current = { chatId: targetChatId, toBranch: name };

    // Update the conversation's branch first (preferred ordering, but the
    // guard is what enforces correctness).
    updateConversations((prev) => {
      const conv = prev[targetChatId];
      if (!conv) return prev;
      return { ...prev, [targetChatId]: { ...conv, branch: name } };
    });

    // Insert the typed branch_forked event (stamped with the NEW branch).
    appendSystemEvent({
      kind: 'branch_forked',
      visibleToModel: false,
      from: from ?? prevBranch,
      to: name,
      sha,
      source,
    });

    // Update the workspace's tracked branch.
    setCurrentBranch(name);

    // NOTE: do NOT clear skipAutoCreateRef here. The state-observation effect
    // below clears it once the migrated state is observable. queueMicrotask
    // is wrong (runs before commit). flushSync is a rendering escape hatch
    // not a domain invariant.
  },
  [conversations, updateConversations, setCurrentBranch, appendSystemEvent],
);
```

In `useChat.ts:570-603`, the auto-switch effect grows the guard check covering BOTH branches:

```ts
useEffect(() => {
  // Migration in progress — leave the active chat alone while state settles.
  if (skipAutoCreateRef.current) return;

  if (sortedChatIds.length === 0 && activeRepoFullName) {
    if (!autoCreateRef.current) {
      // ... existing auto-create logic
    }
  } else if (sortedChatIds.length > 0 && !sortedChatIds.includes(activeChatId)) {
    // CRITICAL: this branch also yanks the user out of the active chat.
    // Without the skipAutoCreateRef guard, even if auto-create is suppressed,
    // this can forcefully reassign activeChatId to an older existing chat on
    // the new branch before our migration finishes. Both branches are
    // equally load-bearing.
    setActiveChatId(sortedChatIds[0]);
    saveActiveChatId(sortedChatIds[0]);
  }
}, [sortedChatIds, activeChatId, activeRepoFullName, updateConversations]);
```

A new sibling effect clears the guard once migration is observable:

```ts
// State-observed guard clear: only release once the conversation's branch
// matches the target AND the active chat is still in sortedChatIds (i.e., the
// filter accepts it under the new currentBranch).
useEffect(() => {
  const guard = skipAutoCreateRef.current;
  if (!guard) return;
  const conv = conversations[guard.chatId];
  if (conv?.branch === guard.toBranch && sortedChatIds.includes(guard.chatId)) {
    skipAutoCreateRef.current = null;
  }
}, [conversations, sortedChatIds]);
```

**Why this works:** the guard holds until the migration is *observable in the rendered state*, not until some arbitrary tick. If the conversation update lands first, the guard stays set during the inevitable sequence of intermediate renders. When `currentBranch` finally lands and `sortedChatIds` recomputes to include the migrated chat, the clear-effect runs and releases the guard. The auto-switch effect runs at the same render but early-returns because the guard is still set; on the next render after the guard clears, `sortedChatIds` already includes `activeChatId`, so neither auto-create nor chat-id-steal fires. Net effect: no transient empty filter, no auto-create, no chat-id steal.

**Failure mode:** if migration somehow doesn't complete (state bug), the guard stays set indefinitely and auto-switch is suppressed. This is preferable to silently auto-creating — a stuck guard is observable (the user can't switch chats normally) and surfaces the underlying bug; a transient auto-create is invisible and corrupts state. Optional defensive cleanup: a long-timeout effect that logs a warning if the guard is set for >10s.

**Test plan for D2:**
- **Without the guard:** simulate `currentBranch` updating before `conv.branch` via separate `act()` calls. Assert that a fresh chat is auto-created OR `activeChatId` is reassigned. (Regression test proving the guard does real work.)
- **With the guard:** same simulation. Assert same `activeChatId`, no new conversation, no `setActiveChatId` call with a different id, exactly one conversation per repo.
- **Hostile order:** deliberately call `setCurrentBranch` first, then `updateConversations`. Guard should still hold; no migration regression.
- **No-active-chat fallback:** call the handler with `activeChatId === null` or referring to a deleted conversation. Assert: branch syncs, but no migration is attempted, no guard is set.
- **Stale chat capture:** switch active chat between dispatch and resolution. Assert the migration uses the chat active *at resolution time* (via the ref), not at dispatch time.
- **Guard auto-release:** after migration completes, assert `skipAutoCreateRef.current === null` and the auto-switch effect resumes normal behavior.

### D3: Per-message branch attribution — REVISED stamp timing

**v1 said** "stamp tool results when committed." **Codex flagged** this as ambiguous: if execution starts on `main`, fork happens, then result commits — stamping at commit time mislabels the result as new-branch context.

**v2 invariant:** *a message belongs to the branch context in which it began.*

Stamp sites and timing:
- **User input message:** stamp `currentBranch` at submit time (when the message object is created).
- **Model streaming response:** stamp at first-chunk time. Don't update mid-stream even if a fork happens during streaming. The message is anchored to where it started.
- **Tool result message:** capture the active branch *structurally* at tool dispatch time into the in-flight tool execution record (e.g., a `branchAtDispatch: string` field on the call descriptor), then stamp the result message with that captured value when it lands. **Do NOT** read `currentBranch` synchronously at result-construction time — by then a fork side-effect from the same tool call may already have shifted `currentBranch`. (v3 change per Codex: a synchronous read at result-construction time is the same bug class as the v2 microtask issue — relying on incidental ordering rather than structural capture.)
- **System events** (including `branch_forked`): stamp `currentBranch` at write time.

The `branch_forked` event itself is the demarcation line for transcript readers: messages before it belong to the old branch, messages after to the new.

**Stamp helper (NEW recommendation):** introduce a `createMessage()` factory that centralizes the stamp. All message creators route through it. TypeScript type stays `branch?: string` (optional) for backward compat.

**Persistence:** existing conversations in IndexedDB don't have the field. Read-boundary fallback (NEW per council): apply `msg.branch ?? conv.branch ?? 'main'` *once* in the persistence load layer, not littered through render sites. After migration, this fallback is structurally lossy (old messages on `main` would inherit the new `feature/foo` branch label) — accept that limitation explicitly. Conversations that existed before slice 2 are blurred to per-conversation granularity; slice-2-and-later conversations have true per-message provenance.

### D4: Auditor isolation — REVISED with explicit invariant (per council)

**v1 said** "probably fine, worth confirming." **Council clarified** the actual invariant.

**Invariant (NEW):** branch stamps are *provenance for UI/tooling*, not authority for Auditor state.

Concretely:
- The Auditor must continue to read **only** the explicit diff/evidence package it was given. It must not infer branch state from chat history.
- The Auditor adapter must NOT pass `branch_forked` events into the Auditor's input as authoritative facts about branch state. If the adapter wants to surface "context shifted at this point," do it as a transcript marker, not as a branch-state assertion.
- Prompt builder for foreground agents (Coder, Orchestrator) DOES surface `branch_forked` aggressively as a directive: `[System: The workspace was branched to 'feature/foo' at this point. Prior context may reflect a different branch state.]` This is what tells the model that file reads from before the fork may not reflect current truth.

**What still needs verification:** read the Auditor adapter (`auditor-agent.ts`, `auditor-file-context.ts`) and confirm that it currently builds context from sources independent of chat history. If it doesn't (i.e., if it consumes the transcript), the slice 2 implementation needs to either (a) filter `branch_forked` events from auditor input or (b) ensure they're treated as transcript metadata, not facts.

### D5: "New Branch from Here" UI button — REVISED naming + behavior (per council)

**v1 named it** "Fork Workspace." **Council unanimously pushed back** — "fork" in Git terminology means cross-namespace cloning (GitHub fork button), which is the opposite of what we're doing.

**v2 names:** primary button label **"New Branch from Here"** (or "New Branch" if space is tight). Confirmation copy:

> "Create a new branch from the current workspace state and keep this conversation attached to it."

That sentence is what makes the conversation-follows behavior explicit to users.

**Where:** branch selector area in the workspace hub. Adjacent to the existing branch switcher.

**Behavior:**
- Click → modal sheet (matches existing `BranchCreateSheet.tsx` pattern).
- Auto-suggests a name using `deriveBranchNameFromCommitMessage` (recent message hint) or `getBranchSuggestionPrefix` (clean "work/" prefix).
- Validates with `sanitizeBranchName`.
- Submits → calls `forkBranchInWorkspace(name, from?)` helper.

**Implementation:** extract `forkBranchInWorkspace(name, from?)` in `app/src/lib/`. Both the tool handler (slice 1) and the new UI button call it. Single source of truth. Helper does: validate → exec `git checkout -b <name> <from>` in sandbox → return `branchSwitch` object → caller invokes `handleForkedBranchSwitch`.

This keeps the tool handler thin and gives the UI a clean async function to await.

### D6: `branch_forked` typed event — REVISED with model-visibility flag (per council)

After a successful fork, insert into the conversation:

```ts
{
  id: createId(),
  role: 'system',
  kind: 'branch_forked',
  visibleToModel: false,  // NEW (per council): transcript metadata, not instruction
  from: 'main',
  to: 'feature/foo',
  sha: 'abc1234',
  source: 'sandbox_create_branch',
  branch: 'feature/foo',  // per-message stamp (D3)
  createdAt: Date.now(),
}
```

**Why typed not text:**
- UI renders specially (icon, divider style, monospace branch names — not a chat bubble)
- Auditor / future tooling can reason about branch transitions structurally
- Prompt builder formats it for different consumers (model directive vs auditor metadata vs UI render)

**Why `visibleToModel: false`:** if `role: 'system'` messages are treated as model-visible instructions elsewhere in the codebase, an unmarked `branch_forked` event could be misread as a behavioral directive. The flag (or whatever the existing system-message visibility convention is) makes it explicit that this is transcript metadata.

**Centralized filter enforcement (NEW in v3 per second council pass):** `visibleToModel: false` is only safe if EVERY prompt-packing path honors it. One forgotten packer leaks the metadata as a model-visible system instruction. Mitigation:
1. Add a single filter at the prompt-conversion boundary: `messages.filter(m => m.visibleToModel !== false)` (or equivalent).
2. Tests must cover: foreground model packer, auditor packer, reviewer packer, delegate packer (Coder, Explorer). A packer-coverage test should iterate over all known packing paths and assert each respects the flag.
3. If multiple packers exist, prefer hoisting the filter into a shared helper rather than scattering it.

**Prompt-builder integration:** when building the foreground model's prompt context, the prompt builder should detect `branch_forked` events in the recent transcript and inject a directive like:

> `[System: The workspace was branched to 'feature/foo' at this point in the conversation. File reads or commands from before this point may reflect a different branch state. Re-read files before editing if you're not sure.]`

The directive injection happens in the foreground packer specifically — auditor and other isolated packers don't surface it as instruction (per D4's invariant). This closes the loop on D3's stale-context concern: per-message branch stamps are stored, and the foreground prompt builder uses them to warn the model.

---

## Implementation outline

Two commits, mirroring the slice 1 split shape:

### Piece A — substrate (no behavior change)

- `ToolExecutionResult.branchSwitch` becomes the normalized object form (`app/src/types/index.ts`)
- `ChatMessage.branch?: string` and `ChatMessage.kind?: ... | 'branch_forked'` (or extend existing kind union)
- `ChatMessage.visibleToModel?: boolean` (or align with existing convention if one exists)
- Add `branch_forked` event payload type
- `createMessage()` helper that stamps branch automatically
- Update three producers, with **per-producer kind decision**:
  - `sandbox-tools.ts` → `kind: 'forked', source: 'sandbox_create_branch'`
  - `github-tools.ts:100` → `kind: 'forked', source: 'github_create_branch'` (verify)
  - `sandbox-git-release-handlers.ts:622` → `kind: 'forked', source: 'release_draft'` (verify; default to `'switched'` if user expectation differs)
- Read-boundary fallback in the persistence load layer (single site)
- Migrate existing `branchSwitch === 'foo'` consumer at `chat-send.ts:1520` to read `.name` (and dispatch on `.kind`)
- No new behavior wired yet — `chat-send.ts` still calls the same `handleSandboxBranchSwitch` for both kinds in this commit

Verifies: typecheck clean, all existing tests pass, branch field appears on new messages, no behavior change.

### Piece B — fork migration logic + UI

- `skipAutoCreateRef` (typed as `MigrationGuard | null`) added in parent, passed down to `useChat`
- `activeChatIdRef` to avoid stale callback capture
- `handleForkedBranchSwitch` callback:
  - No-active-chat fallback (sync branch silently if no conv to migrate)
  - Sets both `skipBranchTeardownRef` and `skipAutoCreateRef` (with target state)
  - Atomic R12 backfill: single `updateConversations` that backfills missing message branches with old `conv.branch` AND sets new `conv.branch`
  - Inserts `branch_forked` event with `visibleToModel: false`
  - Updates `currentBranch`
  - Does NOT clear `skipAutoCreateRef` here
- New sibling effect in `useChat` (or wherever the guard lives) that clears `skipAutoCreateRef` when migration is observable: `conversations[chatId]?.branch === toBranch && sortedChatIds.includes(chatId)`
- `chat-send.ts:1520` reads `branchSwitch.kind`, dispatches to forked handler if `'forked'`
- `useChat`'s auto-switch effect grows the `skipAutoCreateRef.current` early-return AND covers both branches (auto-create AND chat-id-steal at line 599)
- `appendSystemEvent` helper for the `branch_forked` event
- **Centralized prompt-pack filter for `visibleToModel: false`** (D6) — single helper, used by foreground/auditor/reviewer/delegate packers
- Prompt-builder wiring: foreground packer detects `branch_forked` events in recent context and injects the directive
- Auditor adapter check: confirm `branch_forked` events don't flow through as authoritative facts; rely on the centralized filter
- **Delegate envelope `originBranch` field** (R11 data contract) — captured at delegation dispatch, propagated to result envelope, stamped on result messages
- **Persistence write order** (R10): conversation migration written BEFORE branch state
- **localStorage migration marker** (R10) set during the migration window, cleared after both writes settle, stale fallback after ~5s
- `forkBranchInWorkspace(name, from?)` helper extracted
- "New Branch from Here" UI button in branch selector with confirmation copy
- Tests:
  - Unit: handler sets both refs (with target state on `skipAutoCreateRef`), updates conv, inserts event, updates currentBranch
  - Unit: handler no-active-chat fallback (skips migration, syncs branch silently)
  - Unit: handler uses `activeChatIdRef.current` not stale capture (switch chats between dispatch and resolution → migration uses post-switch chat)
  - Unit: `useChat` auto-switch effect early-returns when `skipAutoCreateRef.current` is set (no auto-create AND no chat-id-steal)
  - Unit: state-observed clear effect releases the guard when migration is observable
  - Unit: hostile-order test (currentBranch first, then conv) still produces no migration regression
  - Unit: `chat-send.ts` dispatches on `branchSwitch.kind` correctly
  - Unit: `branchSwitch.kind === 'switched'` still uses existing flow
  - Unit: `branch_forked` event has `visibleToModel: false`
  - Unit: centralized filter strips `visibleToModel: false` messages from EVERY packer (parameterized test over all known packers)
  - Unit: foreground packer injects the directive when `branch_forked` is in recent context
  - Unit: auditor packer does NOT inject the directive
  - Unit: R12 backfill is atomic — one state update, backfilled messages + new conv.branch
  - Unit: backfill never overwrites already-stamped messages
  - Unit: delegate dispatch stamps `originBranch`; result message stamps with `originBranch` not current branch
  - Integration: model emits `sandbox_create_branch` → existing chat keeps its messages, branch updates, system event appears, no auto-create, no chat-id steal
  - Integration: UI "New Branch from Here" button → same end state as tool-initiated fork
  - Integration (multi-tab): localStorage marker written during migration; second tab respects marker; marker clears after migration; stale fallback after timeout

Verifies: full app suite passes, manual browser verification.

---

## Risks and open questions

**R1: React batching reliability — RESOLVED via explicit guard.**
v1 risk was that batching could break across async boundaries. v2 doesn't depend on batching for correctness — the `skipAutoCreateRef` guard is the contract. Batching becomes a nice-to-have for visual smoothness, not a correctness requirement.

**R2: Stream-in-flight at fork time.**
Message stamp at first-chunk time anchors the message to its starting branch. Tool result stamp at *invocation* time (D3 revision per Codex) avoids the case where execution spans a fork. The `branch_forked` event between them is the boundary marker.

**R3: Auditor isolation — RESOLVED via explicit invariant.**
Per D4: branch stamps are UI/tooling provenance, not authority for Auditor state. Auditor adapter must not infer branch context from `branch_forked` events. Implementation must verify the adapter's input shape doesn't leak this.

**R4: Per-message stamp site coverage.**
Mitigation via `createMessage()` helper. Worst case is silent regression (per-message granularity blurs to per-conversation), not a crash.

**R5: Persisted conversations don't have per-message branch.**
Read-boundary fallback applies `msg.branch ?? conv.branch ?? 'main'` once, in the persistence layer. After migration, structurally lossy for legacy messages — acknowledged limitation.

**R6: Two forks in quick succession.**
Each fork sets `skipAutoCreateRef`. If the second fork fires before the microtask clears the first, both updates land under the guard. Conversation follows the latest. Reasonable.

**R7: User forks an empty conversation.**
Allowed. Same effect as creating a new chat on the new branch with the `branch_forked` event as the first message.

**R8: `git checkout -b` fails after migration starts.**
Slice 1 atomic checkout means the tool returns an error WITHOUT setting `branchSwitch`, so the migration handler never fires. Conversation stays on the original branch. ✓

**R9: `activeChatId` persistence may resurrect the wrong chat (NEW per Codex).**
If `saveActiveChatId` is branch-scoped or stored alongside branch identity somewhere, after migration a reload could resurrect a different chat (the auto-created one that the guard prevented in-memory but a stale persisted entry points to). Mitigation: audit `saveActiveChatId` and any related persistence keys; ensure the migration writes the active conversation's new branch identity before any persistence flush.

**R10: Multi-tab / cross-storage event ordering (NEW in v2; ENHANCED in v3 per second council pass).**
If one tab forks and another tab observes the persisted state changes via storage sync in a different order, the second tab can hit the auto-create / chat-id-steal bug in-memory. The acute risk: `activeChatId` is sync-localStorage while conversations are async-IndexedDB, so observers can wedge between the two writes.

v3 mitigation:
1. **Write conversation migration BEFORE branch state to persistence** — a tab observing only the conversation update sees a consistent (or harmless) picture, never the inverted state.
2. **Add a localStorage migration marker** during the migration window: `pushBranchMigration: { chatId, fromBranch, toBranch, startedAt }`. Other tabs respect it by suppressing their own auto-create / chat-id-steal until either (a) the marker is cleared, (b) they observe the migrated state, or (c) the marker is older than ~5 seconds (stale fallback).
3. The marker is written before the persistence flushes and cleared after both writes settle. Cheap (one localStorage entry, one event listener), and it directly addresses the inter-tab race that the in-memory `skipAutoCreateRef` can't cross.

Test: simulate two tab instances; fork in one; assert the other suppresses auto-create until the marker clears or the migrated state is observed. Pathological: marker never clears (crash mid-migration) → after 5s stale window, normal behavior resumes.

**R11: Pending background delegates running on old branch (NEW in v2; data contract LOCKED IN v3).**
A Coder/Explorer delegated run launched on `main` may complete after a fork to `feature/foo`. What branch do their results belong to?

**Slice 2 data-contract invariant (per second council pass):** delegated runs are bound to the branch at launch; their returned messages/results carry that branch stamp. The receiving code MUST not apply old-branch delegate mutations or summaries as current-branch truth without a visible stale-branch marker. The data contract — branch is captured structurally on the delegation request, propagated through to the result envelope — lands in slice 2. The UI rendering of the stale-branch marker can slip to slice 2.5, but the data must already be there or the future UI has nothing to render.

Concretely: every delegation envelope adds `originBranch: string` (set at dispatch). Result messages stamp `branch: originBranch` (not the current branch). Slice 2 stops there; the visible "← work started on main" indicator is slice 2.5 work.

**R12: Old-message fallback erases provenance after migration (NEW in v2; ATOMICITY LOCKED IN v3).**
After migration, a legacy conversation that was previously `conv.branch === 'main'` and now has `conv.branch === 'feature/foo'` would, under naive `msg.branch ?? conv.branch` fallback, claim ALL its old messages happened on `feature/foo`. Structurally false.

**v3 mitigation (atomic per second council pass):** at migration time, the backfill MUST be atomic with the conv.branch update — one `setConversations` call that simultaneously (a) backfills `branch: oldConvBranch` on every existing message that has `branch === undefined`, AND (b) sets `conv.branch = newBranch`. One state update, one persistence write. Never overwrite already-stamped messages. If persistence fails partway, the in-memory state is still consistent; the dirty-tracking flush retries the whole bundle.

Pseudocode:
```ts
updateConversations((prev) => {
  const conv = prev[targetChatId];
  if (!conv) return prev;
  const oldBranch = conv.branch;
  const backfilledMessages = conv.messages.map((m) =>
    m.branch === undefined ? { ...m, branch: oldBranch } : m
  );
  return {
    ...prev,
    [targetChatId]: { ...conv, branch: newBranch, messages: backfilledMessages },
  };
});
```

This is a one-time stamp per conversation per migration, not a bulk migration. New messages going forward stamp themselves at creation time and don't need backfill.

---

## Test plan

**Unit tests:**
- `handleForkedBranchSwitch` sets both `skipBranchTeardownRef` and `skipAutoCreateRef`
- `handleForkedBranchSwitch` updates `conv.branch` before `currentBranch` (still preferred even with guard)
- `handleForkedBranchSwitch` inserts `branch_forked` event with correct from/to/sha/source/visibleToModel
- `handleForkedBranchSwitch` clears `skipAutoCreateRef` after microtask
- `useChat` auto-switch effect early-returns when `skipAutoCreateRef.current` is true (no auto-create AND no chat-id reassignment)
- `useChat` hostile-order test: even with `currentBranch` updated first, no migration regression occurs
- `chat-send.ts` dispatches on `branchSwitch.kind === 'forked'` to the new handler
- `chat-send.ts` falls through to `handleSandboxBranchSwitch` on `'switched'` or undefined
- `createMessage` helper stamps current branch
- Existing branchSwitch producers set the correct kind per per-producer-decision (D1 revalidation)
- Read-boundary fallback applies `msg.branch ?? conv.branch ?? 'main'` (single site test)
- Migration backfills existing message branches with old `conv.branch` value (R12)
- `branch_forked` event has `visibleToModel: false`
- Prompt builder injects the "branch shifted" directive when `branch_forked` is in recent context
- Auditor adapter does NOT pass `branch_forked` events as authoritative facts

**Integration tests:**
- Model emits `sandbox_create_branch` → conversation's `branch` updates → `currentBranch` updates → no fresh chat → no `activeChatId` reassignment → `branch_forked` event appears with correct fields
- UI "New Branch from Here" button → same end state
- Two forks in quick succession → conversation follows the latest, no orphan chats
- Fork from a non-default branch → migration works without special-casing main

**Manual browser verification:**
- Visual: chat stays put after fork, system event renders as a divider not a bubble
- State: branch indicator updates, sandbox doesn't tear down
- Multi-tab: open two tabs, fork in one, observe second tab (R10 — may show stale state, document expected behavior)

---

## Council pass status

Two passes completed. v3 incorporates resolutions for every issue raised:

| Issue | v1 → v2 | v2 → v3 |
|---|---|---|
| D1 discriminator shape | Sibling field → object form | (no change; v2 settled this) |
| D2 ordering mechanism | React batching → `skipAutoCreateRef` boolean + `queueMicrotask` clear | `queueMicrotask` → state-observed clear with `MigrationGuard | null` ref + sibling effect |
| D2 both-branch coverage | Auto-create only → covers `else if` chat-id-steal too | (no change; v2 settled this) |
| D2 no-active-chat fallback | (not addressed) | Added: skip migration silently if no conv to migrate |
| D2 stale callback capture | (not addressed) | Use `activeChatIdRef.current`, not closed-over `activeChatId` |
| D3 tool-result stamp timing | Stamp at commit → stamp at invocation | Structural `branchAtDispatch` field on in-flight tool record (vs incidental sync read) |
| D4 auditor invariant | "Probably fine" → explicit invariant | (no change; v2 settled this) |
| D6 model-visibility | Plain text → typed event with `visibleToModel: false` | Added centralized prompt-pack filter requirement + parameterized packer-coverage test |
| UI naming | "Fork Workspace" → "New Branch from Here" | (no change; v2 settled this) |
| Producer defaults | "All probably forked" → flagged for revalidation | Committed: github + release default to `'switched'`; only `sandbox_create_branch` is `'forked'` |
| R10 multi-tab | (not addressed) → "may need refresh" footnote | Added localStorage migration marker with stale fallback |
| R11 delegate launch-branch | (not addressed) → invariant flagged | Locked in slice 2: `originBranch` on delegate envelope; UI marker slips to 2.5 |
| R12 migration backfill | (not addressed) → opportunistic backfill | Locked in slice 2: atomic single state update; never overwrite stamped messages |

No open council questions. Ready for implementation.

---

## Out of scope (explicitly deferred)

- **Plain `git checkout <branch>` blocking + `sandbox_switch_branch` tool** — slice 2.5. Different semantics from create (existing chat for target branch should be selected, not migrated).
- **Background-job adapter promotion** — slice 3. Needs CF Sandbox HTTP route wiring + decision on whether background jobs should be allowed to fork at all.
- **Bulk per-message branch backfill across all conversations** — never. Forward-only data evolution; legacy unstamped messages use `conv.branch` fallback.
- **Multi-conversation fork** — "fork this AND that conversation" UX. Too speculative.
- **Branch-aware history filtering** — "show only messages on this branch" in chat UI. Per-message stamp enables it later, but slice 2 doesn't add UI.
- **Cross-tab guard synchronization** — `skipAutoCreateRef` is in-memory per tab. Cross-tab consistency under fork is an open question (R10) but not blocking for slice 2.
