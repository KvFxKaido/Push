# Phase 5B — ToolExecutionRuntime Interface Brief

Date: 2026-04-12
Status: **Draft** — pending review before Phase 5B implementation
Owner: ishaw
Related: [push-runtime-v2.md](push-runtime-v2.md), Phase 4 approval seam (`bbd282e`), Phase 5A leaf moves (`8a96fb2`, `ff68c06`, `020d347`, `60d1722`)

## Purpose

Phase 5A moves pure tool protocol / detector / diagnosis code into `lib/` (in progress). Phase 5B defines the **execution seam** that lets Explorer, Coder, and deep-reviewer run without importing `app/src/lib`. This brief specifies the `ToolExecutionRuntime` interface before anyone implements it so the main thread owns the shape, not a roaming agent.

The interface must satisfy three consumers:

1. **Web today** — the existing `executeAnyToolCall` path in `app/src/lib/tool-dispatch.ts`.
2. **pushd** — headless Node, RPC approval, persisted event log (`cli/pushd.ts`).
3. **Future sub-agent runners** inside `lib/` that have no shell coupling at all.

It must **not** solve problems outside the tool execution seam. Provider streaming already lives in `lib/provider-contract.ts`. Memory contexts are already DI-ed per role (Phase 3). Task-graph orchestration is already in `lib/task-graph.ts`.

## Fact base — what we learned before this brief

From the Phase 4 implementation (Lane A, landed `bbd282e`):

- `executeAnyToolCall` at `app/src/lib/tool-dispatch.ts:370` now has **11 positional parameters** including the just-landed `approvalCallback`. This is the ceiling on how unwieldy the current signature can get before it becomes an object.
- The approval callback only fires on `ask_user` gate results, never on `blocked`. Capability escalation is therefore NOT addressable through the Phase 4 seam and is **not** in Phase 5B scope either.
- The denial path skips post-hooks and capability-ledger recording by design. If Phase 5B wants observability on denials, add a separate hook — do not route denials through the post-hook path.
- `getApprovalMode()` reads `safeStorage` synchronously. A headless daemon has no DOM storage, so it silently defaults to `'supervised'`. A Phase 5B pre-req is either stubbing `safeStorage` or routing approval-mode through daemon state.

From the Phase 5A audit (Lane B, read-only):

- Execution dispatches to **four** real sources: `github`, `sandbox`, `web-search`, and `ask-user` (which returns a card without actually executing). `delegate` and `scratchpad` return errors — they are handled at the chat-hook level, not inside the runtime.
- `getSandboxBranch()` at `app/src/lib/tool-dispatch.ts:349` calls `execInSandbox` from `./sandbox-client` as part of Protect Main enforcement. Sandbox access must be part of the runtime or Protect Main cannot move to lib.
- `ToolHookRegistry`, `ApprovalGateRegistry`, and `CapabilityLedger` are already injection-friendly. Phase 5B keeps them as per-call dependencies, not stored state.
- `executeAnyToolCall` is blocked until Phase 5B. `agent-loop-utils.executeReadOnlyTool` (used by Explorer and deep-reviewer) is transitively blocked on the same seam.

What Phase 5A actually shipped (landed before this brief was committed):

- `lib/scratchpad-tools.ts`, `lib/ask-user-tools.ts` — pure per-source detectors, Web shims in place.
- `lib/tool-call-diagnosis.ts` — `diagnoseToolCallFailure`, `detectUnimplementedToolCall`, all phase 1-4 diagnosis helpers, plus the bare-args recovery helpers `extractAllBareJsonObjects` and `inferToolFromArgs`. Lane C moved the bare-args helpers to lib (not just duplicated them) because `tool-dispatch.ts` also needed them — the brief's "duplicate or don't move" rule would have forced either a >50-line duplication or a file split, and the cycle-free lib move was the cleaner outcome. No cycles; Web imports back from lib.
- `lib/tool-call-recovery.ts` — no longer blocked by `tool-dispatch → orchestrator` circular import now that diagnosis is in lib. Decision-doc blocker at `push-runtime-v2.md:317` is retired.
- **Not moved (deferred to Phase 5B or later)**: `detectAnyToolCall`, `detectAllToolCalls`, `detectDelegationTool`, `executeAnyToolCall`, the per-source detectors for GitHub / sandbox / web-search (module-load-coupled), and every execution path. Lane C's explicit recommendation: the remaining pure detector surface depends on Web-coupled per-source detectors and should land inside Phase 5B's `ToolExecutionRuntime` coordination rather than as a 5A follow-up.

## Design decisions

### 1. Single `ToolExecutionRuntime` interface, two implementations

```ts
interface ToolExecutionRuntime {
  execute(
    toolCall: AnyToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;

  getSandboxBranch(sandboxId: string): Promise<string | null>;
}
```

Dispatching by `toolCall.source` stays **inside** `execute()`. Surfacing the per-source switch to the interface boundary (`executeGitHub`, `executeSandbox`, etc.) just pushes the switch up a level without buying anything.

### 2. Collapse the 11-param positional signature into a `ToolExecutionContext` object

```ts
interface ToolExecutionContext {
  allowedRepo: string;
  sandboxId: string | null;
  isMainProtected: boolean;
  defaultBranch?: string;
  activeProvider: ActiveProvider;
  activeModel?: string;
  hooks: ToolHookRegistry;
  approvalGates: ApprovalGateRegistry;
  capabilityLedger?: CapabilityLedger;
  approvalCallback?: ApprovalCallback;
  emit?: ToolEventEmitter;
}
```

A 12th positional param for event emission would be unreadable. The object collapses `execute()` to two arguments and lets Phase 6 additions (per-tool telemetry, daemon session id, etc.) go in without another cascading refactor.

### 3. Approval callback lives on the context, not the runtime instance

Phase 4 put `approvalCallback` on `executeAnyToolCall` as a positional param. Phase 5B moves it into `ToolExecutionContext` so the caller can supply it per-run without re-implementing the runtime.

- Web chat loop supplies `approvalCallback: undefined` (preserves the ask_user 5-hop fallback until Phase 7).
- pushd supplies an RPC-based callback that resolves when `submit_approval` arrives.

### 4. Event emission — thin, typed, optional

Runtime adapters emit three events during execution, mapped onto the existing `RunEvent` vocabulary in `lib/runtime-contract.ts:241-354`:

```ts
interface ToolEventEmitter {
  toolExecutionStart(event: { toolName: string; source: string; toolCallId: string }): void;
  toolExecutionComplete(event: {
    toolName: string;
    durationMs: number;
    error?: StructuredToolError;
  }): void;
  toolCallMalformed(event: { diagnosis: ToolCallDiagnosis }): void;
}
```

- **Web adapter** implements `emit` as a thin bridge to `withActiveSpan` (see `chat-tool-execution.ts:78` and `agent-loop-utils.ts:50`). A no-op is acceptable in Phase 5B if the bridging is painful.
- **pushd adapter** implements `emit` as `broadcastEvent(sessionId, ...)` at `cli/pushd.ts:246`.

**Why typed events instead of a generic `emit(event: RunEvent)`.** The runtime emits a narrow subset (3 types out of 15). Typing prevents role-attribution mistakes — `subagent.*` events are emitted by the delegation layer, not the tool layer.

### 5. What `ToolExecutionRuntime` is NOT responsible for

- Not provider streaming. That is `ProviderStreamFn` in `lib/provider-contract.ts`.
- Not delegation dispatch. `delegate_*` and `plan_tasks` are chat-hook territory. The runtime returns a structured error if asked to execute one.
- Not scratchpad execution. Same reason — chat-hook territory.
- Not system prompt building. Already in `lib/system-prompt-builder.ts`.
- Not task graph execution. Already in `lib/task-graph.ts`.
- Not role memory. Each role kernel has its own memory adapter (Phase 3).

### 6. Protect Main stays in the runtime, for now

`isMainProtected` + `getSandboxBranch()` live on the runtime because the check requires sandbox access and is policy-on-tool-call. A future local CLI adapter (no sandbox) implements `getSandboxBranch()` via `git branch --show-current`. A pure-lib runtime (e.g., for the headless Coder) implements it as whatever the parent already knows about the current branch.

**Inference:** Protect Main could eventually move to an approval-gate rule and the runtime could become pure. That is a refactor of approval-gates territory, not execution territory. Scope creep. Deferred past Phase 5B.

## Minimal method set — final

```ts
interface ToolExecutionRuntime {
  execute(toolCall: AnyToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult>;
  getSandboxBranch(sandboxId: string): Promise<string | null>;
}

interface ToolExecutionContext {
  allowedRepo: string;
  sandboxId: string | null;
  isMainProtected: boolean;
  defaultBranch?: string;
  activeProvider: ActiveProvider;
  activeModel?: string;
  hooks: ToolHookRegistry;
  approvalGates: ApprovalGateRegistry;
  capabilityLedger?: CapabilityLedger;
  approvalCallback?: ApprovalCallback;
  emit?: ToolEventEmitter;
}

interface ToolEventEmitter {
  toolExecutionStart(event: ToolExecutionStartEvent): void;
  toolExecutionComplete(event: ToolExecutionCompleteEvent): void;
  toolCallMalformed(event: ToolCallMalformedEvent): void;
}

type ApprovalCallback = (
  toolName: string,
  reason: string,
  recoveryPath: string,
) => Promise<boolean>;
```

Two interfaces, one type alias, three event payloads. Anything bigger and we are probably solving the wrong problem.

## Web adapter responsibilities

1. Wrap the existing per-source executors (`executeToolCall`, `executeSandboxToolCall`, `executeWebSearch`) **verbatim**. Phase 5B is not a rewrite of the execution code — it is an interface wrap.
2. Provide `getSandboxBranch` via `execInSandbox` (current behavior).
3. Supply `approvalCallback: undefined` when called from the Web chat loop. This preserves the 5-hop ask_user fallback until Phase 7.
4. Implement `emit` as a bridge to `withActiveSpan` tracing, or as a no-op.
5. Keep the existing `executeAnyToolCall` function at its current path as a **thin shim** around `WebToolExecutionRuntime.execute()` so `chat-tool-execution.ts` and `agent-loop-utils.ts` do not need any call-site changes.

## pushd adapter responsibilities — Phase 6 preview

1. Same `execute()` signature. Per-source executors may run against a local checkout, a remote Modal sandbox, or both, depending on session config.
2. Provide `getSandboxBranch` via `git branch --show-current` locally or `execInSandbox` remotely.
3. Supply `approvalCallback` wired to `buildApprovalFn()` at `cli/pushd.ts:185-223` — the RPC callback that resolves when a `submit_approval` envelope arrives.
4. Implement `emit` as `broadcastEvent(sessionId, { type, payload })` at `cli/pushd.ts:246-256`.
5. **Stub `getApprovalMode()` or route approval-mode through daemon state.** Flagged by Lane A: `getApprovalMode()` reads `safeStorage` synchronously and will silently fall back to `'supervised'` in a headless daemon. The daemon should read approval mode from session state and pass it into `approval-gates.ts` through a small wrapper that accepts mode as a parameter. This is a Phase 5B **pre-req**, not a Phase 6 task — the wrapper must exist before the interface lands so the daemon can inject its own mode without forking the approval-gate registry.

## Why deep-reviewer is the first role to move after Phase 5B lands

Three reasons, in order of importance:

1. **Smallest DI surface.** The decision doc at `push-runtime-v2.md:352` estimated ~12 Web-coupled imports today. Phase 5A has now landed `tool-call-diagnosis.ts` and `tool-call-recovery.ts` in lib, and Phase 5B will wrap execution in `ToolExecutionRuntime`. After both, deep-reviewer's DI surface shrinks to roughly: `ToolExecutionRuntime`, `ToolHookRegistry`, `ApprovalGateRegistry`, `CapabilityLedger`, plus the existing provider/memory DI from Phase 3. **Five injection points, all stable interfaces.**
2. **Read-only tool loop.** Deep-reviewer never writes. Protect Main never fires, and `approvalCallback` rarely fires (only on capability violations, which today return `blocked` not `ask_user`). The approval seam is exercised but not load-bearing. This is the lowest-risk way to validate the runtime abstraction before Coder — which writes, commits, and hits every gate.
3. **Existing test coverage is 1:1 swappable.** `deep-reviewer-agent.test.ts:55` already mocks `executeAnyToolCall`. The Phase 5C move replaces the mock shape with a mock `ToolExecutionRuntime` — a mechanical swap, not a test rewrite.

Order after deep-reviewer:

- **Explorer second** — read-mostly, but more per-tool branching than deep-reviewer and lives in a more exercised hot path. Moving it second lets Phase 5C discover any missing read-side context (e.g., a tool the deep-reviewer never calls) before the writes land.
- **Coder last** — writes, commits, verification gates, approval callbacks, and Protect Main all converge here. Move only after the runtime abstraction has survived a full Explorer run.

## Open questions before implementation

1. **Should `ToolExecutionContext` surface hook decisions explicitly?** Today pre/post hooks return decisions that are applied inside `executeAnyToolCall`. Surfacing the decisions as part of `ToolExecutionResult` would leak hook shape to callers. **Recommendation:** keep hooks internal to `execute()` unless a consumer needs them. Defer to implementation.
2. **How does the runtime handle the `ask-user` source that returns a card without executing?** Web today returns `{ text: '[Tool Result] Question sent...', card: { type: 'ask-user', data: ... } }` at `tool-dispatch.ts:501-505`. The runtime should preserve this exactly. The card is returned; the chat hook renders it; the ask_user flow is orthogonal to the approval-gate flow and is NOT a sub-case of `approvalCallback`.
3. **Does `getSandboxBranch` need the sandboxId argument if `ToolExecutionContext` already carries it?** Probably not — it can read from a `this.sandboxId` or be passed the full context. Kept as an explicit argument in this brief for symmetry with the current `getSandboxBranch(sandboxId)` signature. Implementation can tighten.

## Acceptance criteria for Phase 5B

- [ ] `lib/tool-execution-runtime.ts` exists with the two interfaces + type aliases above, and contains zero executor imports.
- [ ] `app/src/lib/web-tool-execution-runtime.ts` exists and wraps existing per-source executors (`executeToolCall`, `executeSandboxToolCall`, `executeWebSearch`).
- [ ] `app/src/lib/tool-dispatch.ts:executeAnyToolCall` becomes a thin shim that constructs a default `WebToolExecutionRuntime` and calls `execute()`. All existing call sites continue to compile with no signature changes.
- [ ] `agent-loop-utils.ts:executeReadOnlyTool` accepts an optional `ToolExecutionRuntime` parameter (defaulting to the Web runtime) so deep-reviewer's Phase 5C move needs no further interface change.
- [ ] `getApprovalMode()` has a parameterized escape hatch so a headless daemon can inject its own mode without forking approval-gates.
- [ ] Every existing test passes unchanged. Phase 5B is an interface wrap, not a behavior change.
- [ ] No CLI adapter is implemented. That is Phase 6.
- [ ] No role agents move. Those are Phase 5C (deep-reviewer) and Phase 5D (Explorer, Coder).

## Out of scope (explicit)

- Phase 5C / 5D role moves.
- Phase 6 daemon wiring.
- Any change to the `blocked` gate path (capability escalation remains a separate future seam).
- Any rewrite of the per-source executor functions themselves — they get wrapped, not touched.
- Any refactor of `orchestrator.ts`.
- Promoting Protect Main out of the runtime into an approval-gate rule.
