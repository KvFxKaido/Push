# Push Runtime v2 — Multi-Agent Daemon Protocol

Date: 2026-04-12
Status: **In progress** — Phases 1-5 are shipped/closed for the durable scope. Phase 6 daemon-wiring portion is effectively complete as of 2026-04-14: `submit_task_graph` executes graphs end-to-end through `lib/task-graph.executeTaskGraph` with `task_graph.*` events on the wire (2026-04-13); crash recovery injects `[DELEGATION_INTERRUPTED]` reconciliation notes; explorer, reviewer, **and coder** delegation all run through their lib kernels via `handleDelegateExplorer` / `handleDelegateReviewer` / `handleDelegateCoder` (coder scaffold landed 2026-04-14). The remaining Phase 6 gates for advertising `multi_agent` are a real daemon-side Coder tool executor (filesystem ops, approval binding, acceptance-criteria runner) and the v1 synthetic-downgrade path. Phase 5E decided Orchestrator stays Web-side; prompt-builder and context-manager extraction are optional pushd reuse follow-ups, not blockers.
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
- `lib/provider-contract.ts`, `lib/tool-execution-runtime.ts`, and the moved role kernels (`reviewer-agent`, `auditor-agent`, `deep-reviewer-agent`, `explorer-agent`, `coder-agent`) now carry the shared Phase 2-5 semantics. Web keeps compatibility shims under `app/src/lib/`. (Fact — updated 2026-04-13)

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

## What Still Remains

1. **Daemon wiring for multi-agent delegation.** `pushd` hosts Explorer, Coder, and Reviewer delegation plus (2026-04-13) task-graph execution through `lib/task-graph.executeTaskGraph`. Coder scaffold landed 2026-04-14 — `delegate_coder` is a real RPC handler + task-graph coder nodes route through `runScaffoldCoderForTaskGraph`, both invoking `runCoderAgent` from `lib/coder-agent.ts` with a stubbed tool executor. The `task_graph.task_ready` / `task_started` / `task_completed` / `task_failed` / `task_cancelled` / `graph_completed` events all flow through `broadcastEvent()` and persist to the session event log. **Still missing:** a real daemon-side Coder tool executor (filesystem ops, approval binding, acceptance-criteria runner). Today the LLM streams real tokens but every tool call receives a canned "not yet wired" result, so outcomes are marked `status: 'inconclusive'` with `missingRequirements: ['Daemon-side Coder tool executor...']`. Explorer has the same scaffold-level gap.
2. **Per-role provider routing on the wire.** `configure_role_routing` is shipped and honoured by `handleDelegateExplorer`, `handleDelegateCoder` (2026-04-14), `handleDelegateReviewer`, and both task-graph scaffold executors via `resolveRoleRouting()` in `cli/pushd.ts`. Full role-routing coverage for the three shipped delegation types.
3. **Delegation events in the daemon event log.** SHIPPED 2026-04-13. `collectOrphanedDelegations()` scans the session event log for unfinished `subagent.started` / `task_graph.task_*` events bound to the interrupted parent `runId`, and `recoverInterruptedRuns()` injects a `[DELEGATION_INTERRUPTED]` user message plus a `delegation_interrupted` session event. Recovery stays narrow: we do not resume children in place.
4. **Approval callback wiring into the daemon.** The Web seam exists (`approvalCallback?` in `executeAnyToolCall()` / `WebToolExecutionRuntime`), but Phase 6 still has to bind it to pushd's RPC approval flow. Blocked on the same "real Coder tool executor" item above — there is no kernel-side tool to gate approvals on until that lands.
5. **Optional pushd reuse helpers.** Orchestrator stays Web-side by design. If Phase 6 wants reuse instead of duplication, extract the pure prompt-builder helpers and generic context-manager helpers called out in Phase 5E; neither blocks daemon wiring.
6. **v1 client synthetic downgrade.** Option C from the Wire Format section is still unimplemented — a v1 client attached to a v2 daemon currently sees raw `task_graph.*` events it does not recognize instead of the advertised synthetic `assistant_token` rewrite.

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
{v, kind: 'event', sessionId, runId?, seq, ts, type, payload}
```

`runId` is optional: it is present when the event is scoped to an in-flight run (assistant turn, delegated sub-agent, task graph bound to a parent run) and **omitted entirely** when there is no run context. **It must never be serialised as `null`** — a missing key and a `null` value look the same after `JSON.stringify` drops undefined, but consumers that round-trip through `Object.hasOwn` or schema-checked JSON see different shapes. Strict-mode validation rejects `runId: null` at emission time.

### Runtime schema validation

Shipped 2026-04-14 in `cli/protocol-schema.ts`. The module is the canonical runtime validator for the envelope contract above and for the per-type payload shapes of the nine delegation events in the `RunEventInput` union (`subagent.started`/`completed`/`failed` + six `task_graph.*` variants).

- **`validateEventEnvelope(event)`** checks the envelope layer against the `SessionEvent` contract in `cli/session-store.ts`. Rejects missing required fields, wrong types, `runId: null`, and `payload: undefined` (which `JSON.stringify` would silently drop, leaving the wire envelope missing its payload key).
- **`validateRunEventPayload(type, payload)`** layers per-type payload checks on top. Covers the nine delegation event types where we have explicit shape contracts. Daemon-specific events (`session_started`, `approval_required`, `error`, `run_complete`, `run_recovered`, `recovery_skipped`, `delegation_interrupted`) get envelope-only validation — their shapes still live in `cli/pushd.ts` and are deliberately out of scope for this tranche.
- **`assertValidEvent(event)`** throws a formatted error with the full envelope on violation.
- **`broadcastEvent()`** at `cli/pushd.ts` calls `assertValidEvent()` when `isStrictModeEnabled()` returns true, gated on the `PUSH_PROTOCOL_STRICT=1` env var. Production defaults to off (zero per-event overhead); the daemon-integration test harness flips it on in a `before`/`after` hook so every handler test validates its outgoing events as a side effect.
- **Drift guard-rails** in `cli/tests/protocol-schema.test.mjs` re-extract the delegation event literals, `RunEventSubagent` roles, and `TaskGraphNode.agent` values from `lib/runtime-contract.ts` source text at test time. Adding a new variant to any of those types without a matching entry in `cli/protocol-schema.ts` fails the test with a clear drift message.

### Capability Negotiation (v2 additions)

Current capabilities at `cli/pushd.ts:54-72` now advertise: `stream_tokens`, `approvals`, `replay_attach`, `multi_client`, `crash_recovery`, `role_routing`, `delegation_explorer_v1`, `delegation_reviewer_v1`, `delegation_coder_v1`, `task_graph_v1`.

Future v2 caps still to add:
- `multi_agent` — advertised once the daemon hosts a fully-wired Coder tool executor (filesystem ops, approval binding, acceptance-criteria runner) and can host Orchestrator + sub-agent delegation end-to-end. Today explorer, coder, and their task-graph counterparts all run through scaffold tool executors — the kernels are reachable and produce structured `inconclusive` outcomes but do no real work.
- `event_v2` — advertised once the v1 synthetic-downgrade path is implemented (see "v1 Client Handling" below)

Already shipped under the `_v1` suffix naming convention:
- `role_routing` — daemon supports per-role `{provider, model}` selection via `configure_role_routing`
- `delegation_explorer_v1` / `delegation_reviewer_v1` / `delegation_coder_v1` — RPC paths for direct single-agent delegation. Explorer and Coder both run through `runExplorerAgent` / `runCoderAgent` with stubbed tool executors; Reviewer is the only one with a real wired path (single-turn JSON review, no tool loop).
- `task_graph_v1` — `submit_task_graph` accepts dependency-ordered task graphs, executes them via `lib/task-graph.executeTaskGraph`, and streams the full `task_graph.*` RunEvent lifecycle through `broadcastEvent()`. Both `agent: 'explorer'` and `agent: 'coder'` nodes route through the same scaffold helpers as their direct-RPC counterparts.

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

### Phase 4 — Approval callback seam SHIPPED 2026-04-12 (commit `bbd282e6`)

The Web tool-dispatch path now has the daemon-compatible callback seam. `executeAnyToolCall()` accepts `approvalCallback?: (toolName, reason, recoveryPath) => Promise<boolean>` and passes it into `WebToolExecutionRuntime`; when present, approval gates can block on a Promise instead of telling the model to emit an `ask_user` tool call. When absent, the old chat-loop approval path is preserved for Web-standalone.

**What remains:** Phase 6 must bind this callback to pushd's existing RPC approval flow. The seam is present; daemon wiring is not.

### Phase 5 — Headless tool-loop runtime extraction CLOSED 2026-04-13

The biggest and scariest refactor was not "make `orchestrator.ts` pretty." The blocker was narrower and more valuable: Explorer, Coder, and deep-reviewer needed headless role kernels that can run their conversation loops without importing the Web shell.

This phase deliberately avoided a broad orchestrator cleanup. `app/src/lib/orchestrator.ts` stays Web-side by design after the Phase 5E decision below.

Delivered sequence:

1. **Phase 5A — Pure tool protocol + detectors.**
   Move protocol text, parsing, diagnostics, and detector helpers that do not execute tools into `lib/`. Keep Web shims. Do not move tool execution yet.
2. **Phase 5B — Tool runtime interface.**
   Define a shared `ToolExecutionRuntime` seam in `lib/` for execution, approval requests, event emission, sandbox reads, and source-specific adapters. Web implements it using existing GitHub / sandbox / scratchpad / web-search / ask-user code. CLI implements it later. **Interface shape reviewed and documented in [phase-5-tool-runtime-brief.md](phase-5-tool-runtime-brief.md) — read that before implementing.**
3. **Phase 5C — Move deep-reviewer.**
   Use deep-reviewer as the proof that the tool-loop seam is right. It should move only after 5A/5B reduce its DI surface from the current ~12 Web-coupled imports to a small runtime interface.
4. **Phase 5D — Move Explorer and Coder kernels.**
   Move Explorer first because it is read-mostly. Move Coder last because write tools, working memory, verification gates, and approval behavior make it the riskiest role kernel.

The goal is **not** one file for both shells — it's "the *semantics* are in `lib/`, the *transport* is per-shell." The headless loop can live in `lib/`; Web and CLI provide their own runtime adapters.

**Actual closure:** Phases 5A-5D moved the protocol/detector/runtime seam and the deep-reviewer, Explorer, and Coder role kernels. Phase 5E closed the orchestrator question: no move sprint, because Orchestrator has no `run{Role}Agent()` loop boundary to wrap. The remaining prompt-builder/context-manager helper extractions are optional Phase 6 reuse work.

#### Phase 5C — deep-reviewer move SHIPPED 2026-04-13 (commit `6009156`)

Deep-reviewer landed as the first role kernel through the Phase 5B seam. `app/src/lib/deep-reviewer-agent.ts` (624 LOC) moved to `lib/deep-reviewer-agent.ts` (683 LOC after inlining the three pure agent-loop helpers); the Web shim collapsed to ~100 LOC using the same re-export pattern as reviewer and auditor. Net: two files changed, zero test changes, 964/964 vitest passing, `tsc -b --noEmit` silent.

**DI shape — six new injection points on `DeepReviewerOptions<TCall, TCard>`:**

1. `userProfile: UserProfile | null` — replaces the `getUserProfile()` hook call.
2. `resolveRuntimeContext` — inherited from lib `ReviewerOptions` (Phase 3 Step 1 pattern). Web shim binds to `buildReviewerRuntimeContext`.
3. `toolExec: (call: TCall) => Promise<{ resultText: string; card?: TCard }>` — the runtime callback. Web shim curries `executeReadOnlyTool(call, allowedRepo, sandboxId, provider, model, hooks)` by closing over per-run bindings.
4. `detectAllToolCalls: (text) => DetectedToolCalls<TCall>` — Web-side detector passed as callback (required because `detectAllToolCalls` and `detectAnyToolCall` transitively depend on per-source detectors that are module-load-coupled to `useOllamaConfig`/`useTavilyConfig` — see `push-runtime-v2.md:318`).
5. `detectAnyToolCall: (text) => TCall | null` — same rationale as #4.
6. `webSearchToolProtocol: string` — the protocol prompt block passed as a plain string so the lib kernel does not import `./web-search-tools`.

**Why the lib kernel does NOT import `ToolExecutionRuntime` directly.** The audit found that deep-reviewer's tool loop needs two things the runtime interface alone cannot provide: (a) OpenTelemetry spans around each tool call (`executeReadOnlyTool` wraps `WebToolExecutionRuntime.execute()` in `withActiveSpan` with `push.tool.*` attributes), and (b) parsing Web's `AnyToolCall` discriminated union, which transitively drags `ChatMessage`/`ChatCard`/`DelegationArgs` into lib. Both concerns resolve cleanly by treating `executeReadOnlyTool` as the DI boundary instead of `ToolExecutionRuntime` itself — the kernel stays generic over `TCall`/`TCard`, tracing stays in Web, and the Phase 5B runtime is still exercised transitively through the Web shim's `executeReadOnlyTool → WebToolExecutionRuntime` chain. The existing `vi.mock('./web-tool-execution-runtime', …)` test mock intercepts that chain unchanged.

**Why the brief said "five injection points" and the actual count is six.** The brief (at `phase-5-tool-runtime-brief.md:185`) predicted "roughly: `ToolExecutionRuntime`, `ToolHookRegistry`, `ApprovalGateRegistry`, `CapabilityLedger`, plus the existing provider/memory DI from Phase 3." That estimate folded hooks/gates/ledger into the runtime and missed that the tool-call detectors (`detectAllToolCalls`, `detectAnyToolCall`) are themselves Web-coupled and need to be DI-ed separately. The audit caught the bucket error by grep-verifying that both functions live only in `app/src/lib/tool-dispatch.ts` (not in `lib/tool-call-diagnosis.ts` as the Phase 5A notes had suggested). Six is the delivered count; any future role move will likely face the same detector-coupling question until Phase 5D extracts the per-source detectors or the `AnyToolCall` union moves to lib.

**Test coverage preserved 1:1.** `deep-reviewer-agent.test.ts` already mocked `./web-tool-execution-runtime` at line 56 — a mock shape that was already aligned with Phase 5B. After the move, all five existing `vi.mock` intercepts (`./web-tool-execution-runtime`, `./tool-dispatch`, `./role-memory-context`, `./explorer-agent`, `./web-search-tools`, plus `@/hooks/useUserProfile` and `./orchestrator`) continue to intercept the Web shim's imports unchanged. Zero test surgery — better than the brief predicted.

**What's still pending before Phase 5D can start:** the pure agent-loop helpers (`truncateAgentContent`, `formatAgentToolResult`, `formatAgentParseError`) were inlined into `lib/deep-reviewer-agent.ts` this sprint to keep the move to two files. Phase 5D (Explorer) will need the same helpers — the expected outcome is a small `lib/agent-loop-utils.ts` extraction as the first Phase 5D PR, collapsing the deep-reviewer inlines into it.

#### Phase 5D step 1 — Explorer move SHIPPED 2026-04-13 (commit `a47393d`)

Explorer landed as the second role kernel through the Phase 5B seam, mirroring the Phase 5C template. `app/src/lib/explorer-agent.ts` (525 LOC) moved to `lib/explorer-agent.ts` (563 LOC); the Web shim shrank to ~120 LOC. Exactly two files touched, zero test changes, 964/964 vitest passing, `tsc -b --noEmit` silent. The pure agent-loop helpers extracted in `93edeb6` (`lib/agent-loop-utils.ts`) are imported directly by the lib kernel instead of being re-inlined.

**DI shape — 8 injection points on `ExplorerAgentOptions<TCall, TCard>`:**

1. `userProfile: UserProfile | null` — Web shim reads `getUserProfile()` at the boundary.
2. `taskPreamble: string` — pre-built by the Web shim via `buildExplorerDelegationBrief(envelope)`. Mirrors how deep-reviewer passes the diff as a pre-built string; keeps `ExplorerDelegationEnvelope` Web-side so lib never imports `@/types`.
3. `symbolSummary: string | null` — Web shim calls `symbolLedger.getSummary()` at the boundary. Keeps IndexedDB coupling out of lib.
4. `toolExec: (call: TCall) => Promise<{ resultText: string; card?: TCard }>` — inherited from Phase 5C. Web shim curries `executeReadOnlyTool` with `allowedRepo`/`sandboxId`/`provider`/`modelId`/`hooks`/`capabilityLedger` closed over; inside that closure the shim also calls `capabilityLedger.recordToolUse(call.call.tool)`, which lets the lib kernel remain completely ignorant of `CapabilityLedger`.
5. `detectAllToolCalls: (text) => DetectedToolCalls<TCall>` — inherited from Phase 5C.
6. `detectAnyToolCall: (text) => TCall | null` — inherited from Phase 5C.
7. `webSearchToolProtocol: string` — inherited from Phase 5C.
8. `evaluateAfterModel: (response: string, round: number) => Promise<{ action: 'inject'; content: string } | { action: 'halt'; summary: string } | null>` — new, Explorer-specific. Web shim curries `policyRegistry.evaluateAfterModel` with the mutable `turnCtx` bound and flattens the returned `AfterModelResult` to primitives (`content: string` instead of `message: ChatMessage`) so the lib kernel never imports `TurnContext`, `ToolHookRegistry`, or `ChatMessage`.

**Why 8, not 9 (and not 6).** The audit estimated 9 slots including `resolveRuntimeContext` inherited from `ReviewerOptions`. Explorer genuinely does not use a runtime-context resolver — it builds its system prompt directly from envelope fields plus the pre-read symbol summary — so `ExplorerAgentOptions` is a standalone interface, not an extension of `ReviewerOptions`. The `taskPreamble` and `symbolSummary` string slots absorb what would otherwise have been lazy resolver callbacks. The delta vs deep-reviewer's six slots is +2 (taskPreamble, symbolSummary) +1 (evaluateAfterModel) -1 (no resolveRuntimeContext) = 8.

**What stayed Web-side (on purpose).**
- `TurnPolicyRegistry`, `createExplorerPolicy`, `app/src/lib/turn-policy.ts`, `app/src/lib/turn-policies/explorer-policy.ts` — all untouched. The entire policy machinery stays Web-side; the lib kernel sees only the flattened callback. This avoids moving turn-policy (which is shared with Coder) and explorer-policy (which depends on `EXPLORER_ALLOWED_TOOLS`) during a sprint that is scoped to Explorer alone.
- `symbolLedger` / `symbol-persistence-ledger.ts` — untouched. The IndexedDB singleton stays Web-side; lib sees only `symbolSummary: string | null`.
- `createExplorerToolHooks` — untouched, still exported from the Web shim. `runExplorerAgent` no longer uses it internally (the runtime path uses `policyRegistry.toToolHookRegistry(turnCtx)`), so the export exists purely to preserve two call sites: `app/src/lib/deep-reviewer-agent.ts:28` and `app/src/lib/explorer-agent.test.ts:4`. Keeping it where it is costs nothing.
- Provider resolution (`getActiveProvider`, `isProviderAvailable`, `getProviderStreamFn`, `getModelForRole`, `resolveProviderSpecificModel`) and the `'demo'` guard — all stay in the Web shim, same pattern as deep-reviewer. The lib kernel receives `provider`/`streamFn`/`modelId` already resolved.

**Messages-callback choice.** `policyRegistry.evaluateAfterModel(response, messages, ctx)` takes a `messages: ChatMessage[]` argument. The Web shim passes an empty array — Lane B verified that Explorer's only registered `afterModelCall` hook is `noEmptyReport` in `explorer-policy.ts`, and its signature is `(response: string)` with the messages argument unused. A comment in the Web shim flags the upgrade path: if a future Explorer policy adds a messages-dependent `afterModelCall` hook, the callback should switch to passing the real lib-side buffer through a structural cast (same cross-shape cast pattern `streamFn` already uses).

**Test preservation was free.** `explorer-agent.test.ts` has zero `vi.mock()` calls — it's a pure behavioral test that exercises `buildExplorerSystemPrompt()` and `createExplorerToolHooks()` end-to-end. Both exports remain on the Web shim (the former as a zero-arg curried wrapper around the lib version that takes `webSearchToolProtocol: string`, the latter unchanged), so the test passes unmodified. All four callers (`useAgentDelegation`, `deep-reviewer-agent` shim, `explorer-agent.test`, `delegation-handoff.integration.test`) import from `./explorer-agent` or `@/lib/explorer-agent` and continue to resolve to the Web shim 1:1.

**Known follow-up (not blocking).** `EXPLORER_ALLOWED_TOOLS` is still defined in two places — once in `explorer-agent.ts` (derived from `PARALLEL_READ_ONLY_GITHUB_TOOLS` + `PARALLEL_READ_ONLY_SANDBOX_TOOLS` + `'web_search'`) and once in `explorer-constants.ts` (derived directly from `getToolCanonicalNames`). Both resolve to the same set today. The duplication predates this sprint and was not reconciled here — touching `explorer-constants.ts` would have reached into `explorer-policy.ts` via its import, which is out of scope. Worth a one-line reconciliation PR at some point.

#### Phase 5D step 2 — Coder move SHIPPED 2026-04-13 (commit `819ac68`)

Coder landed as the third role kernel through the Phase 5B seam, completing the Phase 5D role-migration sweep for everything except Orchestrator. `app/src/lib/coder-agent.ts` (1959 LOC) moved to `lib/coder-agent.ts` (1935 LOC); the Web shim collapsed to 579 LOC. Exactly two files touched, zero test changes, 964/964 vitest passing, `tsc -b --noEmit` silent. Coder is the first mutating role kernel to cross the lib boundary — deep-reviewer and Explorer were both read-only — so this move validates the headless tool-loop seam against write tools, approval gates, phase-aware turn policies, and sandbox health probing.

**DI shape — 11 injection points on `CoderAgentOptions<TCall, TCard>`:**

1. `userProfile: UserProfile | null` — inherited from Phase 5D step 1.
2. `taskPreamble: string` — inherited. Web shim pre-builds via `buildCoderDelegationBrief(envelope)`.
3. `symbolSummary: string | null` — inherited. Web shim calls `symbolLedger.getSummary()` at the boundary.
4. `toolExec: (call: TCall, execCtx: { round: number; phase?: string }) => Promise<CoderToolExecResult<TCard>>` — **enhanced Coder signature.** Return type is `{ kind: 'executed'; resultText: string; card?: TCard; policyPost?: { kind: 'inject'; content: string } | { kind: 'halt'; summary: string } } | { kind: 'denied'; reason: string }`. The Web shim's closure internally runs `policyRegistry.evaluateBeforeTool` (deny → `{kind:'denied'}`) → `withActiveSpan`-wrapped `executeSandboxToolCall`/`executeWebSearch` with capability enforcement + `capabilityLedger.recordToolUse` → `policyRegistry.evaluateAfterTool` (inject/halt → `policyPost`). On `SANDBOX_UNREACHABLE` errors the closure probes `sandboxStatus` and flattens the outcome into `policyPost` (inject for transient cases, halt for dead containers). The lib kernel branches on `kind` and never sees `TurnPolicyRegistry`, `ChatMessage`, `withActiveSpan`, or `sandboxStatus`.
5. `detectAllToolCalls: (text) => DetectedToolCalls<TCall>` — inherited from Phase 5C.
6. `detectAnyToolCall: (text) => TCall | null` — inherited from Phase 5C.
7. `webSearchToolProtocol: string` — inherited from Phase 5C.
8. `sandboxToolProtocol: string` — **new.** Parallels `webSearchToolProtocol`. Coder's protocol is built dynamically by Web's `getSandboxToolProtocol()` in `sandbox-tools.ts` (which inspects the live tool registry), so the lib kernel reads it as a pre-built string the shim computes at run start. Explorer didn't need this because its own `EXPLORER_TOOL_PROTOCOL` is a static lib-side string.
9. `verificationPolicyBlock: string | null` — **new.** Pre-built by the Web shim via `formatVerificationPolicyBlock(verificationPolicy)`, following the same "string in, not builder" pattern.
10. `approvalModeBlock: string | null` — **new.** Pre-built by the Web shim via `buildApprovalModeBlock(getApprovalMode())`. Folded into a dedicated slot rather than into `taskPreamble` so the kernel can keep placing it on the `SystemPromptBuilder` `user_context` section at its original priority, matching the pre-move prompt layout.
11. `evaluateAfterModel: (response, round) => Promise<CoderAfterModelResult>` — inherited from Phase 5D step 1 with the same primitives shape (`{action:'inject',content}|{action:'halt',summary}|null`). Web shim curries `policyRegistry.evaluateAfterModel` and flattens the `AfterModelResult` to primitives.

**`CoderAgentCallbacks` is richer than Explorer's** (8 fields vs 2), but callbacks are per-run hooks, not injection slots. Fields: `onStatus`, `signal`, `onCheckpointRequest`, `onWorkingMemoryUpdate`, `onAdvanceRound`, `getFileAwarenessSummary`, `runAcceptanceCriterion`, `fetchSandboxStateSummary`. The split between options and callbacks is principled — options configure the run, callbacks fire during it — and keeps the 11 slot count honest.

**Delta from Phase 5D step 1's 8 slots.** +3 (`sandboxToolProtocol`, `verificationPolicyBlock`, `approvalModeBlock` — all pre-built strings the Web shim computes at run start) + enhanced `toolExec` return type (adds `policyPost` and `denied` kinds to absorb the three Coder turn-policy hooks). 8 inherited verbatim, 3 new pre-built strings. The `toolExec` enhancement is the load-bearing decision: it absorbs `evaluateBeforeTool` and `evaluateAfterTool` into the same closure rather than DI-ing them as separate callbacks, which would have pushed the slot count to 13. The main thread's target was 9 (+1 from Explorer); Lane B's deviation to 11 (+3) stayed within the ≤12 cap and followed the spec's explicit "dedicated slot OR fold into taskPreamble" judgment call for the approval-mode block.

**Why absorbing `evaluateBeforeTool` / `evaluateAfterTool` into `toolExec` works.** All three Coder turn-policy hooks run tool-adjacent: `beforeToolExec` immediately before the executor, `afterToolExec` immediately after, `afterModelCall` per-round after streaming. Only `afterModelCall` has control flow the lib loop must own (it runs when no tool call is present, to evaluate whether the response is a final report). The other two are local to the tool execution step. Stuffing them into the shim's `toolExec` closure and returning a discriminated result lets the lib kernel branch once on `kind` instead of interleaving three separate policy callbacks with the tool path. Explorer's policy only had `afterModelCall`, so Explorer never had to make this decision.

**Why the inline mutation-failure tracker stays in the lib kernel.** The pre-move Coder loop had two parallel mutation-failure trackers: one inside `createCoderPolicy()`'s `afterToolExec` hook (Web-side, now absorbed into the shim's `toolExec` closure via `evaluateAfterTool`), and one inline in the loop body as a local `Map<string, MutationFailureEntry>`. The inline tracker operates on `toolResult.structuredError` data the lib kernel already has and uses it to drive `MAX_CONSECUTIVE_MUTATION_FAILURES` hard-stop semantics. Moving it out would have required adding another callback slot or duplicating the tracker shape; Lane B preserved it in the lib kernel 1:1 as a pure helper. The dual-tracker setup is a legacy artifact that predates this sprint — worth a cleanup PR, but explicitly not this one.

**What stayed Web-side (on purpose).**
- `app/src/lib/turn-policies/coder-policy.ts`, `app/src/lib/turn-policy.ts`, `app/src/lib/turn-policy-factory.ts` — entire turn-policy machinery, untouched. Same decision as Phase 5D step 1 for Explorer's policy. The lib kernel sees only the three flattened callbacks (inside `toolExec` closures + `evaluateAfterModel`).
- `CapabilityLedger` + `ROLE_CAPABILITIES` + `checkCapability` helper — closed into the shim's `toolExec` closure. The lib kernel never references capability semantics.
- `fileLedger` + `symbolLedger` — IndexedDB singletons. `symbolLedger.getSummary()` pre-reads into the `symbolSummary` option slot; `fileLedger.advanceRound()` / `fileLedger.getAwarenessSummary()` become the `onAdvanceRound` / `getFileAwarenessSummary` callbacks on `CoderAgentCallbacks`.
- `sandboxStatus` + `execInSandbox` + `getSandboxDiff` — Web-only sandbox-client surfaces. The sandbox health-check probe on `SANDBOX_UNREACHABLE` moved into the Web shim's `toolExec` closure and translates outcomes into `policyPost` inject/halt signals.
- `withActiveSpan` + OpenTelemetry tracing — same decision as Phase 5C/5D step 1. Tracing wraps the real executor inside the shim closure, invisible to the lib kernel.
- `generateCheckpointAnswer` — actually **moved** to the lib kernel (it was pure enough given `streamFn` as an option), but the Web shim preserves the legacy positional signature `(question, coderContext, recentChatHistory?, signal?, providerOverride?, modelOverride?)` by resolving provider+streamFn internally and forwarding to the lib helper. Two callers in `useAgentDelegation.ts` consume the legacy signature 1:1.
- `buildContextSummaryBlock` from `./context-compaction.ts` — Web-only. Rather than adding a 12th DI slot (a `buildContextSummary` callback) or leaving a stub, Lane B inlined a minimal pure-text summarizer (`extractSemanticSummaryLines` + helpers) directly into `lib/coder-agent.ts` mirroring the original regex/bullet/omission-marker semantics 1:1. A future phase that moves `context-compaction.ts` to lib can replace the inline version with a direct import.

**Test preservation was free (again).** `coder-agent.test.ts` has zero `vi.mock()` calls — like Explorer's, it's a pure behavioral test of 8 named helpers (`applyObservationUpdates`, `detectUpdateStateCall`, `formatCoderState`, `formatCoderStateDiff`, `invalidateObservationDependencies`, `normalizeTrimmedRoleAlternation`, `shouldInjectCoderStateOnToolResult`, `summarizeCoderStateForHandoff`). The Web shim re-exports all 12 public symbols from the lib kernel (the 8 test helpers + `CoderObservationUpdate` / `CoderWorkingMemoryUpdate` types + `generateCheckpointAnswer` + `runCoderAgent`), so `import { ... } from './coder-agent'` continues to resolve unchanged. `delegation-handoff.integration.test.ts` does not `vi.mock('./coder-agent')` — it calls through to the real function. Zero test surgery, same tailwind as Phase 5D step 1.

**Caller preservation 1:1.** `useAgentDelegation.ts:9` imports from `@/lib/coder-agent` (the Web shim path) — resolves unchanged to the shim's re-exports. `delegation-handoff.integration.test.ts:47` imports `runCoderAgent` from `./coder-agent` — resolves to the shim's wrapper around the lib kernel. `coder-agent.test.ts:1` imports the 8 helpers from `./coder-agent` — resolves to the shim's re-exports. All three import sites work unchanged.

**Phase 5D is done except for Orchestrator.** Phases 5A–5D step 2 have now moved protocol, detectors, the runtime seam, deep-reviewer, Explorer, and Coder into lib. Only Orchestrator remains in `app/src/lib/`. Whether Orchestrator is the terminal role that stays Web-side by design is a separate architectural decision — the role is the chat-driver and transport coordinator, not just a role kernel, so the cost-benefit of moving it is different from the other four roles. A future sprint should take that up explicitly if it's taken up at all; it is not assumed that "the sweep continues" here.

**Known follow-ups from this sprint (not blocking).**
- The dual mutation-failure tracker (one in the lib kernel's inline `mutationFailures` Map, one in `createCoderPolicy`'s `afterToolExec` hook absorbed into the shim closure) is a legacy artifact worth consolidating in a later PR.
- The inlined context-trim summarizer in `lib/coder-agent.ts` can be replaced with a direct import once `context-compaction.ts` moves to lib.
- `EXPLORER_ALLOWED_TOOLS` still has the Phase 5D step 1 duplication between `explorer-agent.ts` and `explorer-constants.ts` — untouched, still worth a one-line reconciliation PR.

#### Phase 5E — Orchestrator (decided 2026-04-13) — STAY WEB-SIDE

**Verdict: STAY WEB-SIDE.** Orchestrator is not a role kernel in the same structural sense as deep-reviewer, Explorer, and Coder. Moving `app/src/lib/orchestrator.ts` to `lib/` would relocate a Web-transport coordinator, not extract a conversation-loop kernel, and the move would require either lifting Web types into lib or modifying `lib/tool-execution-runtime.ts`. Both are hard stops under the Phase 5 ground rules. Phase 5D is the end of the role-kernel sweep; the sweep does not continue into Phase 5E as a move sprint. A separately-scoped micro-sprint can still extract the pure prompt-builder and context-manager helpers into lib later, but that is a Phase 5 follow-up, not a role migration, and is not required to close Phase 5.

**Evidence against a move — the five questions.**

**1. Role kernel or transport coordinator?** Transport coordinator. Grep for `runCoderAgent|runExplorerAgent|runOrchestrator` inside `app/src/lib/orchestrator.ts` returns zero matches — there is no `runOrchestratorAgent()` function and orchestrator.ts never calls the other role kernels directly. The public surface is `streamSSEChat()` (a streaming primitive), `ORCHESTRATOR_SYSTEM_PROMPT`, `buildChatInstructionsBlock()`, plus re-exports from `orchestrator-streaming`, `orchestrator-context`, and `orchestrator-provider-routing`. The "Orchestrator conversation loop" is implemented by the LLM itself, guided by the delegation instructions that `buildOrchestratorDelegation()` assembles into the system prompt; the actual dispatch of `delegate_coder` / `delegate_explorer` tool calls happens in `app/src/hooks/useAgentDelegation.ts` (`runExplorerAgent` called at lines 292 and 1185; `runCoderAgent` at lines 668 and 1286). Orchestrator.ts is a prompt-builder + streaming transport with no loop semantics to own.

**2. DI-slot count estimate.** ≥11 and probably 13+, past the ≤12 cap — but the count is moot because there is no kernel to wrap. A hypothetical move would need: `userProfile` (replaces `getUserProfile()` hook call at line 601), `approvalModeBlock` (replaces `getApprovalMode()` call at line 603), `workspaceContext` (replaces parameter to `buildSessionCapabilityBlock()` at line 627), pre-built `verificationPolicyBlock`, `streamFn`/`modelId`/`provider`, plus the usual four streaming callbacks (`onToken`, `onThinkingToken`, `onDone`, `onError`), plus `signal` and any model-capability-awareness inputs. The 5C→5D1→5D2 trajectory (6→8→11) calibrates the cap; orchestrator would equal or exceed Coder's 11 slots without the compensating benefit of actually encapsulating a tool-dispatch loop, because there is no loop to encapsulate. Adding 11 DI slots to a stateless formatter is lifting the Web shell into lib in disguise.

**3. What blocks the move?** Three hard stops, all inside the streaming prompt-assembly path (`toLLMMessages`, called from `streamSSEChatOnce` on every streamed response):

- **`ChatMessage` type coupling.** `manageContext()` reads `msg.isToolResult` and `msg.content.length` (classified at `orchestrator.ts:112`). `compactChatMessage()` (imported from `context-compaction`) is shaped around the Web `ChatMessage` union. Moving `manageContext()` to lib requires lifting `ChatMessage` itself, which violates the rule that lib never imports `@/types`.
- **React-hook reads at stream time.** `getUserProfile()` (line 601) and `getApprovalMode()` (line 603, inside `buildApprovalModeBlock`) are called inside prompt assembly, not at a callable boundary. The Phase 5D pattern (pre-build strings in the Web shim and pass them through DI slots) works for `runCoderAgent()` because it has a call site the shim can wrap, but orchestrator has no such call site — it has `streamSSEChat()`, which already owns the streaming callback surface, leaving no natural seam to attach a Web shim's pre-build step.
- **`WorkspaceContext` reads.** Line 595 (`workspaceContext?.mode === 'chat'`) and line 627 (`buildSessionCapabilityBlock(workspaceContext, hasSandbox)`) both read workspace-scoped state inside the same streaming prompt-assembly path. Same problem: no boundary to wrap.

None of the three requires modifying `lib/tool-execution-runtime.ts`, so this is **not** a Phase 5B revisit — it is a clean "the abstraction is wrong" result. Orchestrator does not sit on top of the headless tool-loop seam the way the other roles do; it sits alongside it, upstream, wiring the LLM's output into Web state.

**4. Delegation-parent seam.** Orchestrator does not own it. The `buildOrchestratorDelegation()` block inside the system prompt is descriptive text that teaches the model when to emit `delegate_coder` / `delegate_explorer` tool calls; the actual invocation of `runCoderAgent` / `runExplorerAgent` lives in `useAgentDelegation.ts` (already lib→lib once it reaches the role kernel entry points, because Coder and Explorer are now in `lib/`). The topology today is Web→lib, and moving orchestrator would make it lib→lib, but that transition is cosmetic — the delegation chain already works correctly across the boundary, and the chat-lock / provider-inheritance semantics are enforced in `orchestrator-provider-routing.ts` (via `getActiveProvider()`) at the delegation site in `useAgentDelegation.ts`, not inside orchestrator.ts. The seam topology does not argue for or against a move.

**5. Phase 6 (pushd) cost of NOT moving.** Medium and bounded, not corrosive. The Web-specific transport layer in orchestrator.ts (`toLLMMessages`, `streamSSEChatOnce`, `createThinkTokenParser`, `createChunkedEmitter`, `streamSSEChat`) is SSE-over-fetch glue that pushd would have to reimplement anyway because pushd uses a different RPC transport — that duplication is expected and correct, not a symptom of missed extraction. What pushd genuinely needs to share is (a) the prompt-assembly helpers (`buildOrchestratorGuidelines`, `buildOrchestratorToolInstructions`, `buildOrchestratorDelegation`, `buildOrchestratorBaseBuilder`, `buildOrchestratorBasePrompt`) — roughly 185 LOC, pure text composition, dependent only on `getToolPublicName` and the tool-protocol strings — and (b) the context-management helpers (`manageContext`, `classifySummarizationCause`, `buildContextDigest`) — roughly 190 LOC, pure logic over a generic message shape once `ChatMessage` is abstracted to an `interface { role; content; isToolResult? }`. Both chunks can be lifted into `lib/` without touching the streaming transport, without DI slots, and without Phase 5B revisit. That extraction is the right micro-sprint shape for a Phase 5 follow-up, and it leaves orchestrator.ts itself Web-side as the transport coordinator it actually is.

**What this means for Phase 6.** `cli/pushd.ts` will reimplement the streaming transport (SSE → RPC) as expected, and will import `@push/lib/orchestrator-prompt-builder` and `@push/lib/message-context-manager` (or their eventual names) if and when those follow-up extractions land. If they don't land, pushd can mirror ~375 LOC of prompt+context logic directly; that duplication is small enough to tolerate and clear enough to diff against the Web copy in review. The Phase 6 scope estimate (~1 week) does not change.

**Phase 5 closure.** With this decision, **Phase 5 is done.** The role kernels are in `lib/` (deep-reviewer, Explorer, Coder); the Orchestrator prompt-driver and Web-transport coordinator stays in `app/src/lib/` by design. The architectural distinction is explicit: **role kernels with bounded conversation loops live in lib; transport coordinators with React-state coupling stay Web-side.** Orchestrator is the latter. Phase 6 can proceed without waiting on further Phase 5 work.

**Phase 5 follow-ups (not blocking Phase 6, each a separate ~1-file PR).**
- Extract `buildOrchestratorGuidelines` / `buildOrchestratorToolInstructions` / `buildOrchestratorDelegation` / `buildOrchestratorBaseBuilder` / `buildOrchestratorBasePrompt` into `lib/orchestrator-prompt-builder.ts`. Web shim re-exports. Unblocks pushd's prompt reuse.
- Extract `manageContext` / `classifySummarizationCause` / `buildContextDigest` into `lib/message-context-manager.ts` against a generic `Message` interface. Web shim binds to `ChatMessage`. Unblocks pushd's context trimming and is also a prerequisite for moving `context-compaction.ts` (which the Phase 5D step 2 follow-ups call out).
- The three Phase 5D step 2 follow-ups (`EXPLORER_ALLOWED_TOOLS` duplication, dual mutation-failure tracker in `lib/coder-agent.ts`, inlined context-trim summarizer in `lib/coder-agent.ts`) remain open and still sized as one-file PRs each.

### Phase 6 — Daemon wiring

Wire everything into `cli/pushd.ts`:

1. Add v2 capabilities to the `CAPABILITIES` list. **Partial** — `role_routing`, `delegation_explorer_v1`, `delegation_reviewer_v1`, `delegation_coder_v1` (2026-04-14), and `task_graph_v1` advertised. `multi_agent` and `event_v2` still gated on items 7 and a real Coder tool executor.
2. Implement `submit_task_graph`, `configure_role_routing`, `cancel_delegation` request handlers. **SHIPPED 2026-04-13** (task graph closes out this item; `configure_role_routing` and `cancel_delegation` already shipped earlier in Phase 6). `cancel_delegation` now accepts a task-graph `executionId` and aborts the graph's executor via the session's `AbortController`. Coder scaffold landed 2026-04-14: `delegate_coder` is a real RPC + task-graph coder nodes no longer fail fast.
3. Wire delegation events into `broadcastEvent()`. **SHIPPED** — `subagent.*` events flow through `handleDelegateExplorer` / `handleDelegateCoder` / `handleDelegateReviewer`; `task_graph.*` events flow through the background runner inside `handleSubmitTaskGraph`.
4. Extend `state` to track `roleRouting`, `activeDelegations`, `delegationOutcomes`, `activeGraphs`. **SHIPPED** — `state.roleRouting` and `state.delegationOutcomes` persist to disk via `saveSessionState`; `entry.activeDelegations` and `entry.activeGraphs` live on the in-memory session entry and are initialized via `ensureRuntimeState()`.
5. Extend `recoverInterruptedRuns()` to inject `[DELEGATION_INTERRUPTED]` reconciliation notes for parents whose children were lost on crash. **SHIPPED 2026-04-13** — `collectOrphanedDelegations()` scans the session event log for unterminated `subagent.started` and `task_graph.task_*` events bound to the interrupted parent `runId`, then `recoverInterruptedRuns()` injects a user message via `formatDelegationInterruptedNote()` and emits a `delegation_interrupted` session event.
6. Add `fetch_delegation_events` request handler for clients that want to drill into a specific sub-agent's event stream (used by `push session show --delegation <id>`). **SHIPPED**.
7. Implement v1 client synthetic-downgrade logic (Option C above). **Still outstanding** — a real daemon-side Coder tool executor (filesystem ops, approval binding, acceptance-criteria runner) is the other remaining gate for advertising `multi_agent`.

**Estimated scope:** 1 week. As of 2026-04-14 the daemon-wiring portion is effectively complete; the remaining work is the real-tool-exec tranche (large) + v1 synthetic downgrade (small, independent).

### Phase 7 — Web-as-daemon-client (OPTIONAL, FUTURE)

The endgame: Web attaches to `pushd` instead of running its own agent loop. Requires the approval callback seam (Phase 4) to be wired to `submit_approval`, and the chat-send glue in `useChat.ts` to route through `daemon-client.ts` instead of `useAgentDelegation.ts`. Out of scope for v2.0.

## Open Questions Answered

Captured here so future-self doesn't re-litigate them. All were decided in the 2026-04-12 design session.

1. **Per-delegation messages, or shared parent array?** → Per-delegation. In-memory only, discarded on close, with `DelegationOutcome` persisted in `state.delegationOutcomes`. Event log keeps full fidelity for `push session show --delegation <id>`. Rationale: compaction stays simple, session state stays bounded, matches Orchestrator's cognitive model.

2. **Full event replay on reattach, or summarized?** → Full replay below threshold (500 events or 200KB per delegation, tune from use), summary + `fetch_delegation_events` for on-demand drill-in above threshold. Rationale: keeps attach path fast without losing audit-trail fidelity.

3. **v1 client handling for v2 events?** → Option C: synthetic downgrade to `assistant_token` events on parent's `runId` with `[Role]` prefix. v2 clients see full attribution via role/subagentId payload fields. Rationale: preserves v1 client UX, buys migration time, "lie" is morally correct since parent did delegate.

4. **v2.0 scope — minimal or everything?** → Everything. Delegation + role routing + task graphs + `cancel_delegation` + approval callback seam all in v2.0. Rationale: the half-parity drag compounds; finishing in one tranche stops the bleeding.

## Risks & Unknowns

**Fact:** Phase 5 is closed. The useful target was the Web-coupled tool-loop runtime, not the existence of a large `orchestrator.ts` file. The remaining risk is now concentrated in Phase 6 daemon wiring: request handlers, event fan-out, role routing, approval callback binding, and recovery behavior.

**Fact:** Phase 2's provider-streaming abstraction and Phase 4's approval callback seam are shipped. The remaining approval risk is not the Web seam itself; it is whether pushd's RPC approval flow maps cleanly onto sub-agent approvals once role attribution and v1 synthetic downgrade are active.

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

Phases 1-5 are now done or explicitly closed. Phase 6 can start from the shared role kernels in `lib/`, the existing approval callback seam, and the Phase 5E decision that Orchestrator remains Web-side.

**Calendar estimate (Inference):** Phase 6A-D remains roughly ~1 week if it stays focused on pushd wiring. The two optional Phase 5E helper extractions can run before or during Phase 6 if reuse is worth the extra PRs, but they should not be treated as prerequisites.

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
