# Push Runtime v2 — Multi-Agent Daemon Protocol

Date: 2026-04-12
Status: **In progress** — Phases 1-3 shipped for the durable scope. Phase 4 approval seam and Phase 5 headless tool-loop runtime are next.
Owner: ishaw
Related: [Web and CLI Runtime Contract](Web%20and%20CLI%20Runtime%20Contract.md), [Resumable Sessions Design](Resumable%20Sessions%20Design.md), [Multi-Agent Orchestration Research — open-multi-agent](Multi-Agent%20Orchestration%20Research%20%E2%80%94%20open-multi-agent.md)

## Why This Exists

Push CLI today runs a single Coder loop. Push Web runs an Orchestrator that delegates to Explorer, Coder, Reviewer, and Auditor roles, composes task graphs, and tracks capability budgets. That divergence isn't tolerable drift — it's a **capability gap that compounds**: every feature decision pays a tax because "does CLI have this yet?" always answers "no."

The mobile delegation pattern is now load-bearing for the product. Users trust it. And the argument for bringing it to CLI gets stronger, not weaker, the moment you factor in small local models — role specialization is essentially prompt-engineered capability amplification. A 7B/14B local model cannot hold "explore, then plan, then edit, then review" in one head; a narrow role prompt can.

This doc commits to the plan for shipping multi-agent delegation on CLI, exposed through the existing `pushd` daemon so that Web can eventually attach as a client and both surfaces run the same brain.

## Decision

**Ship multi-agent delegation on CLI by hosting it inside `pushd`, using the existing `RunEvent` vocabulary in `lib/runtime-contract.ts` as the on-wire event format.** Extract role agents, approval gates, and the provider-streaming layer into `lib/` so that CLI and Web both import from the same canonical source. Preserve Web's current behavior as the fallback path during the migration; collapse to a single path once the daemon is the primary transport.

The naming is deliberate: this is **not** a protocol rewrite. It is a protocol *extension* layered on `push.runtime.v1` (the existing pushd envelope format defined in `cli/session-store.ts`). All v1 requests and events continue to work. v2 adds new capabilities (`multi_agent`, `task_graph`, `role_routing`, `event_v2`) that clients opt into via capability negotiation at `hello` time.

## Non-Goals

- **Not feature parity for its own sake.** The point is shared semantics, not a mirror image.
- **Not a second approval model.** The v1 daemon already uses RPC approval (`cli/pushd.ts:185`). v2 commits Web to the same model and removes Web's chat-message approval dance once the migration is done.
- **Not backwards-compat forever.** v1 clients stay supported through v2.0 to buy migration time. Once the daemon is the primary transport, the v1-only paths in `app/src/lib/tool-dispatch.ts` get removed.
- **Not recovering interrupted sub-agents.** Crash recovery in `cli/pushd.ts:844` recovers the parent run and injects a `[DELEGATION_INTERRUPTED]` reconciliation note. The parent re-delegates if needed.
- **Not a DAG scheduler for server-side background jobs.** Track D (server-side background execution) remains deferred per the 2026-02-20 decision log entry. v2 is about *shell → daemon*, not *user → cloud*.

## Context — What Already Exists

A surprising amount of the machinery is already in place. The audit that motivated this doc found:

**Shared kernel (`lib/`):**
- `lib/runtime-contract.ts` already defines a **15-member `RunEvent` union** including `subagent.started`, `subagent.completed`, `subagent.failed`, and six `task_graph.*` variants. (Fact)
- `lib/task-graph.ts` already implements dependency-ordered execution with an `onProgress` event callback that emits `task_ready` / `task_started` / `task_completed` / `task_failed` / `task_cancelled` / `graph_complete` events. Primary caller bridges these into `RunEvent`s at `app/src/hooks/useAgentDelegation.ts:1442-1517`. (Fact)
- `lib/role-context.ts`, `lib/system-prompt-builder.ts`, `lib/hashline.ts`, `lib/context-memory.ts` are all already shared. (Fact)
- `DelegationOutcome`, `TaskGraphNode`, `AcceptanceCriterion`, `DelegationEvidence`, `DelegationCheck`, `DelegationGateVerdict`, `AgentRole` (added in Phase 1) are canonical types in `lib/runtime-contract.ts`. (Fact)

**Daemon scaffold (`cli/pushd.ts`, `cli/daemon-client.ts`):**
- Unix socket server with NDJSON envelope protocol `push.runtime.v1`. (Fact)
- Capabilities already advertised: `stream_tokens`, `approvals`, `replay_attach`, `multi_client`, `crash_recovery`. (Fact)
- **RPC approval already implemented.** `buildApprovalFn()` at `cli/pushd.ts:185-223` creates a Promise, emits an `approval_required` event, blocks the tool call until `submit_approval` arrives, 5-minute timeout. (Fact)
- Crash recovery at `cli/pushd.ts:844` replays persisted events from `~/.push/sessions/<id>/events.log` and injects `[SESSION_RECOVERED]` reconciliation on resume. (Fact)
- Multi-client fan-out via `sessionClients` map — multiple attached clients get the same event stream. (Fact)

**Web orchestrator (`app/src/lib/`):**
- Orchestrator + 4 sub-agents (Coder, Explorer, Reviewer, Auditor) exist and are battle-tested on mobile.
- Delegation tool calls `delegate_coder`, `delegate_explorer`, `plan_tasks` defined in `app/src/lib/tool-registry.ts:209-241`. Argument shapes defined in `app/src/types/index.ts:1089-1138`.
- Parser at `app/src/lib/tool-dispatch.ts:1185-1318` detects and routes delegation calls to `app/src/hooks/useAgentDelegation.ts`.
- Capability ledger at `app/src/lib/capabilities.ts` (now extracted to `lib/capabilities.ts` in Phase 1). (Fact)
- Approval gates at `app/src/lib/approval-gates.ts` with exactly one call site — `app/src/lib/tool-dispatch.ts:413`. (Fact)

## What's Missing

1. **No provider-streaming abstraction in `lib/`.** Every role agent in Web imports `getProviderStreamFn` from `./orchestrator` and `getModelForRole` from `./providers`. Both are Web-coupled. Until this is extracted, no role agent is movable to `lib/`. (Fact — discovered in Phase 1 extraction attempt)
2. **Web's approval flow is incompatible with the daemon's RPC approval.** When an approval gate returns `'ask_user'` at `app/src/lib/tool-dispatch.ts:413`, the dispatcher returns a structured error telling the *model* to emit an `ask_user` tool call. The user's response comes back as a chat message that re-enters the loop. No callback seam exists; no Promise blocks. Exactly one call site, but the refactor is semantic, not mechanical. (Fact)
3. **Orchestrator is a 16K-line monolith.** `app/src/lib/orchestrator.ts` is where provider streaming, context budgeting, delegation dispatch, and system prompt building all live together. Extracting any single piece requires threading through tangled state.
4. **No per-role provider routing on the wire.** The daemon today runs a single provider per session. v2 needs to let a session set `{orchestrator: Claude, explorer: local-8B, coder: Sonnet}` and have each role launch pick its own.
5. **No delegation events in the daemon event log.** `recoverInterruptedRuns()` would need to understand delegation lifecycle if it's going to recover multi-agent sessions correctly.

## Wire Format

**Envelope unchanged from v1.** Every request, response, and event carries the v1 envelope. See `cli/pushd.ts:110-136` for `makeResponse()` and `makeErrorResponse()`, `cli/pushd.ts:246-256` for `broadcastEvent()`.

**Request envelope:**
```
{v, kind: 'request', requestId, type, sessionId, payload}
```

**Response envelope:**
```
{v, kind: 'response', requestId, type, sessionId, ok, payload, error}
```

**Event envelope:**
```
{v, kind: 'event', sessionId, runId, seq, ts, type, payload}
```

### Capability Negotiation (v2 additions)

Current capabilities at `cli/pushd.ts:44-50`: `stream_tokens`, `approvals`, `replay_attach`, `multi_client`, `crash_recovery`.

Add to v2 daemons:
- `multi_agent` — daemon can host Orchestrator + sub-agent delegation
- `task_graph` — daemon accepts dependency-ordered task graphs via `submit_task_graph` or inline via Orchestrator `plan_tasks` tool call
- `role_routing` — daemon supports per-role `{provider, model}` selection
- `event_v2` — daemon emits the full `RunEvent` union (v1 clients get synthetic downgrades; see "v1 Client Handling" below)

v1-only clients filter capabilities they don't understand. A v1 client talking to a v2 daemon reads the `hello` response, ignores unknown capabilities, and proceeds with v1 semantics. The daemon detects v1 clients by the absence of `event_v2` in any subsequent request and degrades its event emission (see below).

### Event Vocabulary — Commit to Existing `RunEvent`

**Rule:** the daemon wire protocol's `type` field on events is exactly the `RunEvent.type` literal union from `lib/runtime-contract.ts:241-354`. No translation layer. No parallel vocabulary. v2-aware clients receive `RunEvent`s serialized into the envelope payload; `broadcastEvent()` at `cli/pushd.ts:246` stringifies them directly.

This is not a new commitment — it's a recognition that we already built the vocabulary and should stop writing a second one.

**Event types** (from `lib/runtime-contract.ts`):
```
assistant.turn_start, assistant.turn_end
tool.execution_start, tool.execution_complete, tool.call_malformed
subagent.started, subagent.completed, subagent.failed
task_graph.task_ready, task_graph.task_started, task_graph.task_completed,
task_graph.task_failed, task_graph.task_cancelled, task_graph.graph_completed
user.follow_up_queued, user.follow_up_steered
```

**Preserved from v1** (continue to fire for backwards compat):
```
session_started, user_message, assistant_token, tool_call, tool_result,
approval_required, approval_received, run_complete, error, run_recovered,
recovery_skipped
```

**Role attribution:** v2 events that fire *inside* a sub-agent (e.g., `tool.execution_start` emitted by a running Coder) carry a `role` field in the payload: `'orchestrator' | 'explorer' | 'coder' | 'reviewer' | 'auditor'`. v1 clients that ignore the field see a flat event stream attributed to the parent run. v2 clients filter by role to render sub-agent streams with visual distinction.

### Delegation Event Payloads

`subagent.started` payload:
```typescript
{
  subagentId: string;        // new ID type, format: 'sub_<ts>_<rand>'
  parentRunId: string;       // the orchestrator's runId
  childRunId: string;        // new runId scoped to this sub-agent
  role: 'coder' | 'explorer';
  brief: CoderDelegationArgs | ExplorerDelegationArgs;
  envelope: DelegationEnvelope;
}
```

Where `CoderDelegationArgs` and `ExplorerDelegationArgs` are exactly the shapes at `app/src/types/index.ts:1089-1107` (to be promoted to `lib/runtime-contract.ts` in Phase 2), and `DelegationEnvelope` is the shape at `app/src/types/index.ts:1109-1138`. The brief is model-emitted; the envelope is daemon-injected (branch context, provider, model, project instructions, harness settings, verification policy).

Separating the two in the wire format means: (a) the event log records exactly what the Orchestrator emitted, (b) replay can reconstruct why a child ran the way it did, and (c) the daemon can patch the envelope (e.g., route Explorer to a local model) without touching the brief.

`subagent.completed` payload:
```typescript
{
  subagentId: string;
  parentRunId: string;
  outcome: DelegationOutcome;   // lib/runtime-contract.ts:47-59
  formattedText: string;        // what gets appended to Orchestrator messages
}
```

The `outcome` carries all 9 fields from `DelegationOutcome`: `agent`, `status`, `summary`, `evidence`, `checks`, `gateVerdicts`, `missingRequirements`, `nextRequiredAction`, `rounds`, `checkpoints`, `elapsedMs`. The `formattedText` is the string produced by `formatCompactDelegationToolResult()` at `app/src/hooks/useAgentDelegation.ts:355-365` — what gets inserted into the Orchestrator's conversation as a tool-result user turn.

**Status semantics:** `complete` means the child's loop terminated cleanly with success; `incomplete` means it ran but failed to satisfy the deliverable or acceptance criteria; `inconclusive` means the child emitted a result envelope but the outcome is ambiguous (typically user-cancel). All three fire `subagent.completed`.

`subagent.failed` payload:
```typescript
{
  subagentId: string;
  parentRunId: string;
  error: { code: string; message: string; retryable: boolean };
}
```

`subagent.failed` fires only for **unstructured** runtime errors — network failure, provider error, malformed response. No `DelegationOutcome` is built. Orchestrator typically re-delegates with a retry budget or escalates to the user.

### v1 Client Handling — Option C (Synthetic Downgrade)

A v1 client attaches to a v2 session mid-delegation. It doesn't understand `subagent.started` or `task_graph.task_completed`. What does it see?

**Option C (chosen):** the daemon synthesizes v2 events into `assistant_token` events on the parent's `runId`, prefixed with `[Role]`. A Coder emitting tokens becomes `assistant_token` events on the Orchestrator's runId with payload `text: "[Coder] <token>"`. A `subagent.completed` becomes an `assistant_token` batch summarizing the `DelegationOutcome.summary`.

**Why this is correct even though it's lying:** v1 clients expect a flat stream of assistant tokens and tool results. A v2 event stream is hierarchical. Synthesizing the v2 events back into v1 shape preserves the user experience (something keeps scrolling, the user sees progress) without requiring v1 clients to be updated. The "lie" is that the parent runId didn't literally produce those tokens, but since it *did* delegate the work, the attribution is morally correct.

**What can't be synthesized:** approval events from sub-agents. A v1 client that sees an `approval_required` for a Coder sub-agent has no way to route the `submit_approval` back to the right delegation. For v1 clients, delegated approvals are attributed to the parent `runId` and routed as if they were parent-level approvals. The daemon keeps an internal map from `approvalId` → `subagentId` so the right child gets resumed. v2 clients see the full attribution and can render it properly.

### New Request Types

**`submit_task_graph`** (bypass Orchestrator):
```
{type: 'submit_task_graph', sessionId, payload: {graph: TaskGraphArgs, meta?}}
```
Directly submit a task graph without an Orchestrator turn. Useful for `push run --graph plan.json` and for Web to replay a saved plan. Daemon validates via `lib/task-graph.ts` `validateTaskGraph()`, emits `task_graph.task_ready` for ready nodes, launches them.

**`configure_role_routing`**:
```
{type: 'configure_role_routing', sessionId, payload: {routing: RoleRouting}}
```
Where `RoleRouting = Partial<Record<AgentRole, {provider: string, model: string}>>`. Persisted in `state.roleRouting` on disk so the setting survives crash recovery. Missing roles fall back to session-level provider/model.

**`cancel_delegation`**:
```
{type: 'cancel_delegation', sessionId, payload: {subagentId}}
```
Aborts a specific sub-agent without killing the parent run. Cascades to the child's `AbortController`, fires `subagent.failed` with `{code: 'CANCELLED'}`, cleans up the entry in `state.activeDelegations`.

### State Additions

Session state gains:
```typescript
{
  roleRouting: Partial<Record<AgentRole, {provider: string, model: string}>>;
  activeDelegations: Map<subagentId, {
    childRunId: string;
    role: AgentRole;
    parentRunId: string;
    startedAt: number;
    abortController: AbortController;  // in-memory only
    messages: Message[];                // in-memory only, discarded on close
  }>;
  delegationOutcomes: Array<{subagentId: string; outcome: DelegationOutcome}>;
  activeGraphs: Map<graphId, {nodes, completed, pending}>;  // in-memory only
}
```

**Storage model for sub-agent messages:** per-delegation `messages` arrays live only in memory. When a delegation closes, the raw messages are discarded and only the `DelegationOutcome` is persisted in `delegationOutcomes`. The event log retains full fidelity (every `assistant_token`, `tool_call`, `tool_result` with `role` and `subagentId` payload fields), so a user running `push session show --delegation <id>` can reconstruct the full transcript from events — but the session state file stays bounded even across dozens of delegations.

This matches the Orchestrator's cognitive model: it doesn't need the Explorer's 50 tool calls in its own context; it needs the Explorer's conclusions. The summary is load-bearing; the transcript is for debugging.

## Approval Seam

The single hardest refactor in the whole port. Web's approval flow at `app/src/lib/tool-dispatch.ts:411-438`:

```typescript
const gateResult = await approvalGates.evaluate(toolName, toolArgs, hookContext);
if (gateResult?.decision === 'ask_user') {
  return {
    text: `[Approval Required — ${toolName}] ... Use ask_user to request permission ...`,
    structuredError: { type: 'APPROVAL_GATE_BLOCKED', retryable: true, ... },
  };
}
```

The model then emits an `ask_user` tool call, a card renders, the user taps, a CardAction fires `sendMessageRef.current()`, chat loop re-enters, model retries the original tool with an approval flag. **Five steps. Round-trip through the model. Hard-coded into the chat loop.**

Daemon flow at `cli/pushd.ts:185-223` does the same job with one RPC:

```typescript
function buildApprovalFn(sessionId, entry, runId) {
  return async (tool, detail) => {
    const approvalPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ... reject(...); }, APPROVAL_TIMEOUT_MS);
      entry.pendingApproval = { approvalId, resolve, reject, timer };
    });
    broadcastEvent(sessionId, { type: 'approval_required', payload: {...} });
    const decision = await approvalPromise;
    return decision === 'approve';
  };
}
```

**The refactor:** add an optional `approvalCallback?: (tool: string, detail: string) => Promise<boolean>` parameter to `executeAnyToolCall()` in `app/src/lib/tool-dispatch.ts`. When set, the `ask_user` branch short-circuits the 5-step chat dance and calls the callback directly. When unset, the current behavior is preserved.

```typescript
if (gateResult.decision === 'ask_user') {
  if (approvalCallback) {
    const approved = await approvalCallback(toolName, gateResult.reason);
    if (approved) {
      /* fall through to execute tool */
    } else {
      return { text: `[Approval] User denied: ${toolName}` };
    }
  } else {
    // existing v1 chat-loop fallback
    return { text: '[Approval Required — ...]', structuredError: {...} };
  }
}
```

**Estimated scope:** ~200-300 lines + tests. Concentrated at `tool-dispatch.ts:413` plus threading the callback down through 3-4 call sites. The approval-mode read from storage at `app/src/lib/approval-mode.ts` stays unchanged — it's read at gate-eval time and doesn't touch the protocol.

**The migration story:** Web-standalone continues to use the chat-loop fallback indefinitely. Web-hosted-by-pushd wires the callback to pushd's `approvalFn`. Once the daemon is Web's primary transport, the chat-loop fallback can be deleted as dead code.

## Phase Breakdown — What's Shipped, What's Next

This is the honest version after running Phase 1 against the real source. The audit that motivated this doc was overoptimistic about which files were "clean"; Phase 1 surfaced that by attempting the extraction and hitting import walls. The revised phases below reflect what the dependency graph actually allows.

### Phase 1 — Shared utilities (SHIPPED 2026-04-12)

Moves of files with no Web-module coupling. Both use the re-export-shim pattern established by `app/src/lib/task-graph.ts`.

- **`capabilities.ts` → `lib/capabilities.ts`** — canonical home for `Capability`, `TOOL_CAPABILITIES`, `ROLE_CAPABILITIES`, `CapabilityLedger`. Rewired `AgentRole` import from `@/types` to `./runtime-contract`. Web shim at `app/src/lib/capabilities.ts`.
- **`AgentRole` → `lib/runtime-contract.ts`** — promoted to named export. Previously duplicated as inline unions at `app/src/types/index.ts:110`, `app/src/lib/turn-policy.ts:28`, and `lib/runtime-contract.ts:191` (MemoryQuery.role). Web barrel now imports-and-re-exports from lib.
- **`system-prompt-sections.ts` → `lib/system-prompt-sections.ts`** — pure static strings (`SHARED_SAFETY_SECTION`, `SHARED_OPERATIONAL_CONSTRAINTS`, `CODER_CODE_DISCIPLINE`, `ORCHESTRATOR_SIGNAL_EFFICIENCY`). Zero dependencies. Web shim in place.

**Verification:** `tsc -b` clean after both moves. 29/29 capability tests pass (`capabilities.test.ts`, `approval-gates-capabilities.test.ts`).

### Phase 2 — Provider-streaming abstraction (SHIPPED 2026-04-12, PR #273)

**The blocker Phase 1 discovered.** Every role agent in Web imported `getProviderStreamFn` from `./orchestrator` and `getModelForRole` from `./providers`, both depending on React hooks and the orchestrator monolith. PR #273 inverted this for reviewer and deep-reviewer: `ReviewerOptions` now takes an injected `streamFn: StreamChatFn` and `modelId: string`, and the WeakMap-backed `streamFnIds` in `reviewer-agent.ts` ensures concurrent reviews with distinct stream implementations don't coalesce into each other's results (regression caught in review).

**What shipped:**
- `streamFn` + `modelId` injected into `ReviewerOptions` (58bc289).
- Coalesce-key regression fix hashing streamFn identity via WeakMap (f51ab23).
- Context-side cleanups from the review (1176cd9).

**Still pending for explorer / coder:** same treatment is not enough anymore — those role agents are tool-loop agents, not one-shot provider calls. They still depend on Web's tool-dispatch / tool-execution subsystem and should move after Phase 5 splits that layer. The `ProviderStreamFn` type itself is now canonical in `lib/provider-contract.ts` (see Phase 3 session 2 below).

### Phase 3 — Role agent extractions

Phase 3 is now scoped to **one-shot role kernels** that can run with provider/model/runtime-context DI. Tool-loop agents move after Phase 5.

1. **`reviewer-agent.ts` → `lib/`** (SHIPPED 2026-04-12, session 2) — see sub-section below.
2. **`auditor-agent.ts` → `lib/`** (SHIPPED 2026-04-13, session 3) — see sub-section below.
3. **Deferred to Phase 5:** `explorer-agent.ts`, `coder-agent.ts`, and `deep-reviewer-agent.ts`. They all transitively depend on Web's tool-dispatch / tool-execution subsystem (`tool-dispatch`, `agent-loop-utils`, tool hooks, per-source detectors, and Web-search/sandbox execution). Moving them before Phase 5 would create hollow `lib/` shells that CLI still cannot run without Web's tool layer, and would likely commit interfaces that Phase 5 would need to replace.

Each move uses the re-export-shim pattern. Web continues to import from `@/lib/<role>-agent`; the shim forwards to `@push/lib/<role>-agent`.

#### Phase 3 — Step 1 (reviewer) SHIPPED 2026-04-12 (session 2)

Five commits landed as a single bundled refactor. The sequence did reviewer + Phase 5-aligned cleanup, not reviewer + deep-reviewer — the deep-reviewer blocker was discovered mid-session by an audit with a tighter brief than the opening scope.

| Commit | Scope | Summary |
|---|---|---|
| `6c1a068` | `refactor(context)` | Lift `LlmMessage`, `AIProviderType`, `ProviderStreamFn<M, W>` (generic), `StreamUsage`, `ChunkMetadata`, `PreCompactEvent`, `ReviewComment`, `ReviewResult` to `lib/provider-contract.ts`; lift `asRecord`, `JsonRecord`, `streamWithTimeout` to `lib/stream-utils.ts`. Web shims (`@/types`, `utils.ts`, `orchestrator-streaming.ts`, `orchestrator-provider-routing.ts`) preserve existing call sites. The generic `ProviderStreamFn` defaults to `LlmMessage` with `W = unknown`; Web keeps its richer shape via `StreamChatFn = ProviderStreamFn<ChatMessage, WorkspaceContext>`. The contravariance-unsafe cast is documented: `streamSSEChat` reads every `ChatMessage`-only field (`attachments`, `isToolResult`) via optional chaining, so passing a plain `LlmMessage` is runtime-safe in this codebase. |
| `000cafd` | `refactor(context)` | Move `reviewer-agent.ts` to `lib/reviewer-agent.ts`. `ReviewerOptions` gains `resolveRuntimeContext` and `readSymbols` as injected callbacks; the Web shim at `app/src/lib/reviewer-agent.ts` wires them to `buildReviewerRuntimeContext` / `readSymbolsFromSandbox` so the `reviewer-agent.test.ts` `vi.mock('./role-memory-context')` + `vi.mock('./sandbox-client')` boundary still intercepts correctly. Coalesce-key semantics preserved 1:1 including the PR #273 WeakMap streamFn identity fix. Web shim collapsed from 408 LOC to 29. |
| `11ebd9e` | `refactor(context)` | Lift pure text → tool-call JSON parsing primitives to `lib/tool-call-parsing.ts`: `diagnoseJsonSyntaxError` + `JsonSyntaxDiagnosis`, `repairToolJson` + private helpers, `detectTruncatedToolCall`, `extractBareToolJsonObjects`, `detectToolFromText`. These are tool-wrapper-aware (they look for a top-level `"tool"` key) but have no dependency on any per-source detector. Phase 3's top-level tool-typed detection (`detectAnyToolCall`, `detectAllToolCalls`, `diagnoseToolCallFailure`) stays in Web — see the Phase 5 note below. |
| `ded2622` | `refactor(context)` | Move `tool-registry.ts` (599 LOC) to `lib/tool-registry.ts` as-is. An Explore-agent audit verified zero top-level value imports and one clean `export ... from './capabilities'` at line 599 (lib/capabilities is already in place from Phase 1). 14 Web call sites keep working through the re-export shim. |
| `2683c18` | `refactor(context)` | Extract `buildUserIdentityBlock` (23 LOC pure function) from `orchestrator.ts` to `lib/user-identity.ts`, along with the `UserProfile` data shape. `UserProfile` is now canonical in `lib/` and re-exported from `@/types`. |

**What Phase 5 needs to split in tool-dispatch.ts (1499 LOC) before deep-reviewer can move:**
- The top-level `detectAnyToolCall` / `detectAllToolCalls` / `detectUnimplementedToolCall` / `diagnoseToolCallFailure` functions are thin wrappers around per-source detectors from `./github-tools`, `./sandbox-tools`, `./scratchpad-tools`, `./web-search-tools`, `./ask-user-tools`, plus a local `detectDelegationTool`. Moving the wrappers requires moving (or cleanly inverting) every per-source detector, which in turn depends on moving `tool-hooks.ts`, `approval-gates.ts`, and the tool execution layer (`executeToolCall` / `executeSandboxToolCall` / etc.). This is the tool-dispatch subsystem extraction called out in Phase 5.
- `tool-call-recovery.ts` is blocked because it imports `./tool-dispatch` at module load, which imports `./orchestrator` at line 37. No way around this until tool-dispatch is split.
- `web-search-tools.ts` is blocked because it imports `@/hooks/useOllamaConfig` and `@/hooks/useTavilyConfig` at module load. The `WEB_SEARCH_TOOL_PROTOCOL` constant *could* be extracted to a new lib file in isolation, but the work is marginal until tool-dispatch itself moves.

**Verification for all 5 commits:** `tsc -b --force` clean; test suites that exercise the touched surface pass uninterrupted — `tool-dispatch` (77), `reviewer-agent` (7), `deep-reviewer-agent` (2), `orchestrator` (9), `capabilities` (21), `approval-gates-capabilities` (8). Each commit verified individually before landing.

#### Phase 3 — Step 2 (auditor) SHIPPED 2026-04-13 (session 3)

Auditor moved as the second durable role kernel. The extraction deliberately stopped before Explorer/Coder/deep-reviewer because those are tool-loop agents and need Phase 5's tool-dispatch split first.

- **`auditor-agent.ts` → `lib/auditor-agent.ts`** — `AuditorRunOptions` and `AuditorEvaluationOptions` now take injected `provider`, `streamFn`, `modelId`, and runtime-memory callbacks. The Web shim at `app/src/lib/auditor-agent.ts` preserves the old call signature and wires in `getActiveProvider`, `getProviderStreamFn`, `getModelForRole`, `buildAuditorRuntimeContext`, and `buildAuditorEvaluationMemoryBlock`.
- **`auditor-file-context.ts` → `lib/auditor-file-context.ts`** — pure file-context budgeting stayed callback-based; the app wrapper preserves `@/lib/auditor-file-context`.
- **`verification-policy.ts` → `lib/verification-policy.ts`** — policy formatting and preset helpers now live in shared lib; the app wrapper preserves `@/lib/verification-policy`.
- **Coalescing guard:** Auditor now includes WeakMap-backed `streamFn` identity in its coalesce key, mirroring reviewer, so concurrent audits using distinct provider stream implementations cannot accidentally share a result.

**Verification for Step 2:** direct NodeNext compile for the moved lib files; `tsc -b` in the Web app; focused suites for `auditor-agent`, `verification-policy`, `role-memory-context`, `capabilities`, and `approval-gates-capabilities`.

### Phase 4 — Approval callback seam

Add the `approvalCallback?` parameter to `executeAnyToolCall()` in `app/src/lib/tool-dispatch.ts`. Thread it through the 3-4 call sites. Write tests for both the old chat-loop path and the new callback path. Don't remove the old path yet — the daemon isn't wiring into it until Phase 6.

**Estimated scope:** 200-300 lines + tests. Can run in parallel with Phase 3 since it's a different file.

### Phase 5 — Headless tool-loop runtime extraction

The biggest and scariest refactor is not "make `orchestrator.ts` pretty." The blocker is narrower and more valuable: Explorer, Coder, and deep-reviewer need a headless tool loop that can detect, validate, approve, and execute tools without importing the Web shell.

This phase should deliberately avoid a broad orchestrator cleanup. Keep `app/src/lib/orchestrator.ts` as Web's transport wrapper until the new runtime seam proves itself.

Recommended PR sequence:

1. **Phase 5A — Pure tool protocol + detectors.**
   Move protocol text, parsing, diagnostics, and detector helpers that do not execute tools into `lib/`. Keep Web shims. Do not move tool execution yet.
2. **Phase 5B — Tool runtime interface.**
   Define a shared `ToolRuntime` / `ToolExecutionRuntime` seam in `lib/` for execution, approval requests, event emission, sandbox reads, and source-specific adapters. Web implements it using existing GitHub / sandbox / scratchpad / web-search / ask-user code. CLI implements it later.
3. **Phase 5C — Move deep-reviewer.**
   Use deep-reviewer as the proof that the tool-loop seam is right. It should move only after 5A/5B reduce its DI surface from the current ~12 Web-coupled imports to a small runtime interface.
4. **Phase 5D — Move Explorer and Coder kernels.**
   Move Explorer first because it is read-mostly. Move Coder last because write tools, working memory, verification gates, and approval behavior make it the riskiest role kernel.

The goal is **not** one file for both shells — it's "the *semantics* are in `lib/`, the *transport* is per-shell." The headless loop can live in `lib/`; Web and CLI provide their own runtime adapters.

**Estimated scope:** 1-2 weeks, split across 4 PRs. This is the best place to use agents, but only with disjoint ownership: one agent can audit detector boundaries, one can implement the Phase 4 seam or Phase 5A tests, and one can attempt the deep-reviewer move after the runtime interface lands. Keep the `ToolRuntime` interface design in the main thread because a wrong abstraction here will multiply pain across Phase 6.

### Phase 6 — Daemon wiring

Finally, wire everything into `cli/pushd.ts`:

1. Add v2 capabilities to the `CAPABILITIES` list at `cli/pushd.ts:44`.
2. Implement `submit_task_graph`, `configure_role_routing`, `cancel_delegation` request handlers.
3. Wire delegation events into `broadcastEvent()` — the `RunEvent` vocabulary is already compatible, so this is mostly plumbing.
4. Extend `state` to track `roleRouting`, `activeDelegations`, `delegationOutcomes`, `activeGraphs`.
5. Extend `recoverInterruptedRuns()` at `cli/pushd.ts:844` to inject `[DELEGATION_INTERRUPTED]` reconciliation notes for parents whose children were lost on crash.
6. Add `fetch_delegation_events` request handler for clients that want to drill into a specific sub-agent's event stream (used by `push session show --delegation <id>`).
7. Implement v1 client synthetic-downgrade logic (Option C above).

**Estimated scope:** 1 week.

### Phase 7 — Web-as-daemon-client (OPTIONAL, FUTURE)

The endgame: Web attaches to `pushd` instead of running its own agent loop. Requires the approval callback seam (Phase 4) to be wired to `submit_approval`, and the chat-send glue in `useChat.ts` to route through `daemon-client.ts` instead of `useAgentDelegation.ts`. Out of scope for v2.0.

## Open Questions Answered

Captured here so future-self doesn't re-litigate them. All were decided in the 2026-04-12 design session.

1. **Per-delegation messages, or shared parent array?** → Per-delegation. In-memory only, discarded on close, with `DelegationOutcome` persisted in `state.delegationOutcomes`. Event log keeps full fidelity for `push session show --delegation <id>`. Rationale: compaction stays simple, session state stays bounded, matches Orchestrator's cognitive model.

2. **Full event replay on reattach, or summarized?** → Full replay below threshold (500 events or 200KB per delegation, tune from use), summary + `fetch_delegation_events` for on-demand drill-in above threshold. Rationale: keeps attach path fast without losing audit-trail fidelity.

3. **v1 client handling for v2 events?** → Option C: synthetic downgrade to `assistant_token` events on parent's `runId` with `[Role]` prefix. v2 clients see full attribution via role/subagentId payload fields. Rationale: preserves v1 client UX, buys migration time, "lie" is morally correct since parent did delegate.

4. **v2.0 scope — minimal or everything?** → Everything. Delegation + role routing + task graphs + `cancel_delegation` + approval callback seam all in v2.0. Rationale: the half-parity drag compounds; finishing in one tranche stops the bleeding.

## Risks & Unknowns

**Fact:** the biggest single refactor is Phase 5, but its useful target is now narrower than "orchestrator extraction." The blocker is the Web-coupled tool loop, not the existence of a 16K-line orchestrator file. 1-2 weeks is still a guess, but the risk is now concentrated around the `ToolRuntime` interface and detector/execution split.

**Inference:** Phase 2 (provider-streaming abstraction) is probably simpler than it looks because the interface surface is small (a streamFn type and a model-id string). The risk is that Web's non-role code paths — especially `orchestrator.ts`'s own internal calls — also use `getProviderStreamFn` and need to be refactored to use the new interface, not just the role agents.

**Inference:** the approval callback seam (Phase 4) is the one most likely to surface unexpected coupling. "Exactly one call site" is true of `approvalGates.evaluate()`, but the downstream behavior — `ask_user` tool, CardAction, `sendMessageRef.current()` — is distributed across multiple files. The refactor might touch more files than the estimate suggests.

**Guess:** v1 client handling via synthetic downgrade is clever but untested. Once Phase 6 ships, running a v1 CLI client against a v2 daemon with active delegation is the first real test of whether the `[Role]` prefix synthesis actually reads well. If it doesn't, we may need to introduce a minimal `v1_delegation_summary` pseudo-event type as a compromise.

**Fact:** crash recovery for multi-agent sessions is explicitly scoped *narrow* — we recover the parent only, not sub-agents. If a user runs a task graph with 10 nodes and the daemon crashes mid-graph, recovery resumes the parent Orchestrator with a `[DELEGATION_INTERRUPTED]` note listing what was lost. The Orchestrator re-delegates. Users who expected the in-flight Coder to pick up from its last checkpoint will be disappointed; we accept that trade-off to keep recovery simple.

## Implementation Order

The dependency graph, visualized:

```
Phase 1 (shipped) ──┐
                    ├──> Phase 2 (provider abstraction) ──> Phase 3 (role extraction)
                    │                                    ├──> Phase 5 (headless tool-loop runtime)
                    │                                    │
                    └──> Phase 4 (approval seam) ────────┴──> Phase 6 (daemon wiring)
                                                                   │
                                                                   └──> Phase 7 (optional: Web-as-client)
```

Phase 4 (approval seam) can run before or alongside Phase 5A because it is the callback hook the later `ToolRuntime` adapter will need. Phase 5 should not start by editing the whole orchestrator; start with the pure tool protocol/detector extraction and runtime interface.

**Calendar estimate (Inference):** Phase 4 = 1-2 days, Phase 5A-D = 1-2 weeks, Phase 6A-D = ~1 week. Since Phases 1-3 are now shipped, the remaining v2.0 tranche is plausibly **2-3 weeks of focused work** if Phase 5 stays scoped to the headless tool-loop runtime.

## Acceptance Criteria

v2.0 is done when:

- [ ] A CLI session can run `push run --graph plan.json` and observe Orchestrator delegating to Explorer and Coder with role-specific provider routing
- [ ] `pushd` emits `subagent.started` / `subagent.completed` / `task_graph.*` events that a v2 client can render with role attribution
- [ ] A v1 CLI client attached to a v2 daemon sees a reasonable (synthetic-downgraded) event stream without crashing
- [ ] Approval requests from sub-agents route correctly: v2 clients get scoped `approvalId` + `subagentId`, v1 clients get parent-attributed approvals that still reach the right child
- [ ] Session state file stays bounded (~10s of KB) across a 20-delegation task graph because raw sub-agent messages are discarded on close
- [ ] Crash recovery of a parent run with active delegations injects `[DELEGATION_INTERRUPTED]` correctly and the Orchestrator resumes without restarting from scratch
- [ ] Web-standalone tests still pass — the chat-loop approval path is preserved as a fallback
- [ ] All file moves to `lib/` retain their test coverage; no test file deleted in the migration

## References

- `cli/pushd.ts:185-223` — existing RPC approval flow
- `cli/pushd.ts:246-256` — `broadcastEvent()` envelope
- `cli/pushd.ts:44-50` — current capability list
- `cli/pushd.ts:844` — crash recovery entry point
- `lib/runtime-contract.ts:241-354` — `RunEvent` union (wire format commitment)
- `lib/runtime-contract.ts:46-59` — `DelegationOutcome` type
- `lib/runtime-contract.ts:65-76` — `TaskGraphNode` type
- `lib/task-graph.ts` — task graph executor with `onProgress` event callback
- `app/src/lib/tool-dispatch.ts:411-438` — the approval seam target
- `app/src/lib/tool-dispatch.ts:1185-1318` — delegation tool parser
- `app/src/lib/tool-registry.ts:209-241` — delegation tool protocol signatures
- `app/src/types/index.ts:1089-1138` — `CoderDelegationArgs`, `ExplorerDelegationArgs`, `DelegationEnvelope`
- `app/src/hooks/useAgentDelegation.ts:232-1085` — current Web delegation execution path
- `app/src/hooks/useAgentDelegation.ts:1442-1517` — task graph bridge
