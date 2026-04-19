# useAgentDelegation Coupling Reconnaissance

**Date:** 2026-04-18
**Status:** ✅ Track complete 2026-04-19. All 5 phases shipped, hook reduced 1,883 → 490 lines (−74%).
**Target:** ~~`app/src/hooks/useAgentDelegation.ts` (1,883 lines)~~ → 490 lines post-extraction
**Next:** ~~Extraction order planning for Step 5 of Architecture Remediation Plan~~ — see shipping record below.

## Shipping record

| Phase | PR | Module | Merged |
|---|---|---|---|
| 1 | (in-session commit) | `lib/memory-context-helpers.ts` | 2026-04-18 baseline |
| 2 | [#336](https://github.com/KvFxKaido/Push/pull/336) | `lib/explorer-delegation-handler.ts` (309 lines) | 2026-04-18 |
| 3 | [#337](https://github.com/KvFxKaido/Push/pull/337) | `lib/coder-delegation-handler.ts` (691 lines) | 2026-04-18 |
| 4 | [#338](https://github.com/KvFxKaido/Push/pull/338) | `lib/auditor-delegation-handler.ts` (300 lines) | 2026-04-19 |
| 5 | [#339](https://github.com/KvFxKaido/Push/pull/339) | `lib/task-graph-delegation-handler.ts` (760 lines) | 2026-04-19 |

The four recommended extraction phases (2–5) all followed the three-piece commit structure (characterization tests → extraction → docs/cleanup) and the `*HandlerContext` + `build*Context` pattern proven five times on `sandbox-tools.ts`. Phase 5's design spike resolved the recon's §Open Questions #1 (`lastCoderStateRef` accumulation strategy) with Option A — preserve the single/multi-coder-node `evalWorkingMemory` policy byte-for-byte; see `Phase 5 Handoff - Task-Graph Extraction.md` §"Option A/B decision — resolved" for the rationale and the follow-up issue for Option B.

Cross-cutting outcomes:

- Hook dependency array shrank 19 → 7 (executeDelegateCall's useCallback deps track build* helpers, not individual refs/callbacks).
- All 25 characterization tests in `useAgentDelegation.test.ts` pass at HEAD; none were modified post-extraction.
- None of the coupling hazards enumerated in §Coupling Hazards 1–5 below escaped the tests — the `lastCoderStateRef` ref-write-then-read pattern, the auditor fail-open path, and the graph-node state aggregation all survived extraction. Hazard #3 (TG Auditor per-node state) remains deliberately lossy-but-correct via Option A and is pinned by Test 4 in the characterization suite.

The original recon content below this divider is preserved unchanged for future readers who need the coupling analysis or want to check whether the recommendations in §"Recommended Extraction Order" matched what shipped (they did, in order, with the Phase 3 Planner sub-seam bundled into the Coder handler as recon predicted).

---

**Original recon content below — preserved for archival reference.**


## Why This Exists

The hook is the third-largest architectural hotspot in Push (see `docs/decisions/Architecture Remediation Plan — Defusing the Big Four.md`, Step 5). The plan prescribes splitting it "by role workflow — extract typed-memory helpers first, then Coder/Explorer execution, Auditor evaluation, and task-graph execution into adapter modules." The pattern proven 5 times on `app/src/lib/sandbox-tools.ts` (4,112 → 475 lines, -88%) is: pin behavior with tests at the dispatcher level, extract each handler family behind a `*HandlerContext` shape with a `build*Context` helper, compress the dispatcher's case arm into a one-line delegation, and route all shared state to handlers only through the named context (no module globals, no implicit closure reaches).

## File Anatomy

**Line count breakdown:**
- Imports + type definitions: lines 1–69 (69 lines)
- Module-local helpers: lines 71–172 (102 lines) — 6 functions
- Hook export + internal dispatch function: lines 174–1883 (1,709 lines)
  - Parameter interface: lines 174–198
  - Hook function definition: lines 200–216
  - `mergeAcceptanceCriteria` callback: lines 217–235
  - `executeDelegateCall` callback: lines 237–1880
    - Early dispatch logic + imports: lines 256–288
    - Sequential Explorer seam: lines 289–450
    - Sequential Coder seam: lines 451–1020
    - Task-graph seam: lines 1021–1840
  - Dependency array: lines 1862–1879

**Export surface:** Single export — `useAgentDelegation` hook returning `{ executeDelegateCall }`.

**Parameter object shape (`UseAgentDelegationParams`):**
- 6 callbacks: `setConversations`, `updateAgentStatus`, `appendRunEvent`, `emitRunEngineEvent`, `getVerificationPolicyForChat`, `updateVerificationStateForChat`
- 9 refs: `branchInfoRef`, `isMainProtectedRef`, `agentsMdRef`, `instructionFilenameRef`, `sandboxIdRef`, `repoRef`, `abortControllerRef`, `abortRef`, `lastCoderStateRef`

**Internal sub-function inventory by role workflow:**
- **Shared helpers** (6): `getTaskStatusLabel`, `buildMemoryScope`, `formatMemoryError`, `logContextMemoryWarning`, `runContextMemoryBestEffort`, `retrieveMemoryKnownContextLine`, `withMemoryContext`, `appendInlineDelegationCards`
- **Sequential Explorer** (lines 256–450): input validation, memory retrieval, span dispatch, outcome assembly, memory persistence
- **Planner sub-seam** (lines 531–599, nested in Coder): harness-driven planning pre-pass
- **Sequential Coder + Auditor** (lines 451–1020): task loop, criteria merging, coder span dispatch, diff capture, auditor evaluation span dispatch, outcome assembly
- **Task-graph execution** (lines 1021–1840): graph validation, executor closure definition, graph-execute span dispatch, per-node spans (explorer + coder inside), graph auditor evaluation, aggregated outcome assembly

## The 8 Candidate Extraction Seams

Each seam is marked by a `withActiveSpan` call that names the role + mode. Per Step 3 trace spine pass (commit `dd94346`), all 8 sites already accept `correlation: CorrelationContext` and spread `correlationToSpanAttributes(...)`.

### Seam 1: Sequential Explorer (`subagent.explorer`)
**Lines:** 289–345  
**Role + mode:** Explorer, sequential delegation  
**Inputs consumed:**
- Refs: `sandboxIdRef`, `repoRef`, `branchInfoRef`, `isMainProtectedRef`, `agentsMdRef`, `instructionFilenameRef`
- Callbacks: `updateAgentStatus`, `appendRunEvent` (emission), `setConversations` (inline card append)
- Params: `explorerTask`, `explorerArgs` (file hints, intent, deliverable, knownContext, constraints)

**Outputs produced:**
- Run event: `subagent.started` + `subagent.completed`
- Verification state: `recordVerificationArtifact(...)` call via `updateVerificationStateForChat`
- Memory write: `writeExplorerMemory(...)` (best-effort async, no await)
- Result shape: `explorerResult { rounds, summary, cards }` → structured `DelegationOutcome`

**Role-kernel calls:** `runExplorerAgent(...)`

**Shared mutable state reached:** `setConversations` (for inline cards); verification state via callback; no write to `lastCoderStateRef`

**Cross-seam coupling:** None — Explorer is first-pass sequential.

### Seam 2: Planner Sub-Seam (`subagent.planner`)
**Lines:** 554–583 (nested inside Coder seam)  
**Role + mode:** Planner, sequential (Coder pre-pass)  
**Inputs consumed:**
- Refs: none (planner is stateless)
- Callbacks: `updateAgentStatus` (phase updates)
- Params: single task, file hints, provider/model overrides

**Outputs produced:**
- Run event: `subagent.started` + `subagent.completed` or `subagent.failed`
- Return value: `plan` (null if no plan) → converted to `plannerBrief` string

**Role-kernel calls:** `runPlanner(...)`

**Shared mutable state reached:** None

**Cross-seam coupling:** Output (`plannerBrief`) feeds into Coder span via the options bag; Coder seam reads but does not modify.

### Seam 3: Sequential Coder (`subagent.coder`)
**Lines:** 670–736  
**Role + mode:** Coder, sequential delegation (can loop over multi-task array)  
**Inputs consumed:**
- Refs: `sandboxIdRef`, `branchInfoRef`, `isMainProtectedRef`, `agentsMdRef`, `instructionFilenameRef`, `repoRef`, `lastCoderStateRef` (write via callback at line 703)
- Callbacks: `updateAgentStatus`, `appendRunEvent`, `setConversations`, `getVerificationPolicyForChat`
- Params: `taskList`, `acceptanceCriteria`, `intent`, `deliverable`, `knownContext`, `constraints`, `files`, `declaredCapabilities`
- Prior state: `plannerBrief` (from Planner sub-seam), `verificationCriteria` (built per task), `effectiveAcceptanceCriteria` (merged at line 658)

**Outputs produced:**
- Run events: `subagent.started` + `subagent.completed`, plus task-loop event at line 498
- Verification state: `recordVerificationMutation` (on non-empty diff), `recordVerificationCommandResult` (per criterion), `recordVerificationArtifact` (summary)
- Memory writes: `writeCoderMemory(...)` (pending, see line 1043 structure)
- Sandbox diff capture: `getSandboxDiff(currentSandboxId)` → `taskDiff` → `touchedPaths` for verification invalidation
- Ref mutation: `lastCoderStateRef.current = state` (line 703, via callback from `runCoderAgent`)
- Result shape: `coderResult { rounds, checkpoints, summary, cards, criteriaResults }` → structured `DelegationOutcome`

**Role-kernel calls:** `runCoderAgent(...)`

**Shared mutable state reached:**
- `lastCoderStateRef` (written via callback, read downstream by Auditor at line 818)
- `setConversations` (for inline cards)
- `updateVerificationStateForChat` (callback chaining)

**Cross-seam coupling:**
- **Strong coupling to Sequential Auditor:** `lastCoderStateRef.current` written here (line 703), read by Auditor (line 818). Auditor span only fires if `harnessSettings.evaluateAfterCoder` is true (line 792).
- **Render cycle hazard:** `setConversations` called within Coder's loop (line 347) via `appendInlineDelegationCards`; Auditor span reads `lastCoderStateRef.current` (line 818) *after* the full Coder loop completes, which means it has visibility of the final state but **only if React batches the ref updates before the Auditor callback runs**. This is implicit render-cycle coupling — Auditor's behavior depends on ref mutation timing.

### Seam 4: Sequential Auditor (Coder Evaluation) (`subagent.auditor`)
**Lines:** 826–871  
**Role + mode:** Auditor, sequential evaluation (conditional: fires if Coder produced output and `harnessSettings.evaluateAfterCoder`)  
**Inputs consumed:**
- Refs: `repoRef`, `branchInfoRef`, `sandboxIdRef`, `currentSandboxId` (closure var from parent Coder block)
- Callbacks: `updateAgentStatus`, `appendRunEvent`, `updateVerificationStateForChat`
- Params: `combinedTask` (joined taskList), `combinedSummary` (joined summaries), `allCriteriaResults` (collected from task loop), `evalDiff` (from `getSandboxDiff`), `verificationPolicy`, `evalWorkingMemory` (from `lastCoderStateRef.current` or null)
- Prior state: `taskList`, `summaries`, `allCriteriaResults` (all accumulated in parent Coder block)

**Outputs produced:**
- Run events: `subagent.started` + `subagent.completed` or `subagent.failed`
- Verification state: `recordVerificationGateResult('auditor', verdict, summary)`
- Result shape: `coderEvalResult { verdict, summary, gaps }` → folded into Coder `DelegationOutcome` gateVerdicts

**Role-kernel calls:** `runAuditorEvaluation(...)`

**Shared mutable state reached:**
- `lastCoderStateRef.current` (read-only, written by Coder seam line 703)
- `updateVerificationStateForChat` (callback)

**Cross-seam coupling:**
- **Coupled to Sequential Coder:** reads `lastCoderStateRef.current` (line 818), which is written by Coder's callback (line 703). Fires conditionally: only if `harnessSettings.evaluateAfterCoder` and `summaries.length > 0`.
- **Closure dependency:** `combinedTask`, `combinedSummary`, `allCriteriaResults` are all local vars accumulated in the parent Coder block before the Auditor span fires.
- **Fallible:** if Auditor throws (line 904), the seam falls open to a fail-open path that lets Coder's result stand (comment line 919: "Fail-open: if evaluation fails, Coder result stands as-is").

### Seam 5: Task-Graph Execute (`taskgraph.execute`)
**Lines:** 1469–1567  
**Role + mode:** Task-graph coordinator, parallel/sequential node execution  
**Inputs consumed:**
- Refs: `abortControllerRef`, `sandboxIdRef` (closure var from parent task-graph block)
- Callbacks: `appendRunEvent` (for graph progress events), `updateAgentStatus` (phase updates), none for mutations
- Params: `graphArgs.tasks` (array of task nodes), `onProgress` callback wired into graph executor

**Outputs produced:**
- Run events: `task_graph.task_ready`, `task_graph.task_started`, `task_graph.task_completed`, `task_graph.task_failed`, `task_graph.task_cancelled`, `task_graph.graph_completed`
- Verification state: none directly (delegated to per-node spans)
- Memory writes: `invalidateMemoryForChangedFiles` (line 1584), `writeTaskGraphNodeMemory` (line 1606) — both best-effort async
- Result shape: `graphResult { success, aborted, summary, nodeStates, totalRounds, wallTimeMs }`

**Role-kernel calls:** `executeTaskGraph(...)` (dispatcher; the actual agents are called inside the `taskExecutor` closure)

**Shared mutable state reached:** `abortControllerRef` (signal check), `appendRunEvent` (for emissions)

**Cross-seam coupling:**
- **Parent coupling:** reads `graphNodeById` (built from `graphArgs.tasks` at line 1162) to annotate progress events
- **Child coupling:** calls `taskExecutor` closure (defined at line 1180) which in turn calls Seams 6–7 (task-graph explorer/coder).
- **Post-execution coupling:** line 1615 onwards filters node states by agent type to decide whether to run graph auditor (Seam 8).

### Seam 6: Task-Graph Explorer (`taskgraph.explorer`)
**Lines:** 1199–1252  
**Role + mode:** Explorer, task-graph node execution (inside `taskExecutor` closure)  
**Inputs consumed:**
- Refs: `sandboxIdRef`, `repoRef`, `branchInfoRef`, `isMainProtectedRef`, `agentsMdRef`, `instructionFilenameRef`, `lastCoderStateRef` (never written here)
- Callbacks: `updateAgentStatus` (via `activeTasks` map), `appendRunEvent` (for artifact recording), `setConversations` (inline cards), `updateVerificationStateForChat`
- Params: `node { task, files, deliverable, constraints }`, `memoryEnrichedContext` (retrieved + merged before span), `taskSignal` (abort)
- Prior state: `graphMemoryScope`, `nodeMemoryLine` (retrieved at line 1181), `activeTasks` (status tracking map)

**Outputs produced:**
- Verification state: `recordVerificationArtifact(...)`
- Result shape: task-executor return `{ summary, delegationOutcome, rounds }`
- Side effects: `activeTasks` map mutation (lines 1236, 1254) — local scope, not shared across nodes

**Role-kernel calls:** `runExplorerAgent(...)`

**Shared mutable state reached:**
- `setConversations` (for inline cards)
- `updateVerificationStateForChat` (callback)
- `activeTasks` (local Map, co-mutated with Seam 7 Coder nodes running in parallel)

**Cross-seam coupling:**
- **Loose coupling to Seam 5:** reads `graphMemoryScope` (built at line 1172), `node` (from task loop closure), `activeTasks` (Map shared with sibling Coder nodes for status aggregation line 1237).
- **No explicit coupling to other seams:** does not read `lastCoderStateRef` or any Coder state.

### Seam 7: Task-Graph Coder (`taskgraph.coder`)
**Lines:** 1306–1369  
**Role + mode:** Coder, task-graph node execution (inside `taskExecutor` closure)  
**Inputs consumed:**
- Refs: `sandboxIdRef`, `branchInfoRef`, `isMainProtectedRef`, `agentsMdRef`, `instructionFilenameRef`, `repoRef`, `lastCoderStateRef` (write via callback at line 1339)
- Callbacks: `updateAgentStatus`, `appendRunEvent`, `setConversations`, `updateVerificationStateForChat`
- Params: `node { task, files, deliverable, constraints, acceptanceCriteria }`, `memoryEnrichedContext`, `taskSignal`, `harnessSettings`, `verificationPolicy`
- Prior state: `effectiveAcceptanceCriteria` (merged per node at line 1292), `graphMemoryScope`, `nodeMemoryLine`, `activeTasks`

**Outputs produced:**
- Verification state: `recordVerificationMutation` (on non-empty diff), `recordVerificationCommandResult` (per criterion), `recordVerificationArtifact`
- Memory writes: persistence via callback chain (no explicit write in seam, but `runCoderAgent` receives `verificationPolicy` + `correlation` for possible internal writes)
- Sandbox diff capture: `getSandboxDiff(currentSandboxId!)` → validation + verification state update
- Ref mutation: `lastCoderStateRef.current = state` (line 1339)
- Result shape: task-executor return `{ summary, delegationOutcome, rounds }`

**Role-kernel calls:** `runCoderAgent(...)`

**Shared mutable state reached:**
- `lastCoderStateRef` (written via callback at line 1339)
- `setConversations` (for inline cards)
- `updateVerificationStateForChat` (callback)
- `activeTasks` (local Map, co-mutated with Seam 6 Explorer nodes)

**Cross-seam coupling:**
- **Implicit to graph auditor:** `lastCoderStateRef.current` written at line 1339; read downstream by Seam 8 at line 1669 if graph auditor fires.
- **Graph-level memory coupling:** reads `graphMemoryScope` (used by retrieval), potentially writes memory (via callback, not direct write in seam).
- **Parallel sibling coupling:** `activeTasks` map shared with Seam 6 for concurrent status reporting.

### Seam 8: Task-Graph Auditor (`subagent.auditor` — second span site, lines 1674–1720)
**Lines:** 1674–1720  
**Role + mode:** Auditor, task-graph evaluation (conditional: fires if graph has coder nodes and graph not aborted)  
**Inputs consumed:**
- Refs: `repoRef`, `branchInfoRef`, `sandboxIdRef`
- Callbacks: `updateAgentStatus`, `appendRunEvent`, `updateVerificationStateForChat`
- Params: `combinedTask` (joined coder node tasks, line 1651), `combinedSummary` (joined results, line 1654), `aggregatedChecks` (flattened from node outcomes, line 1657), `evalDiff` (from `getSandboxDiff`, line 1645), `totalCoderRounds` (aggregated, line 1664), `verificationPolicy`, `memoryScope` (graph-scoped at line 1705)
- Prior state: `coderNodeStates` (filtered from `graphResult.nodeStates` at line 1616), `evalWorkingMemory` (from `lastCoderStateRef.current` if single-node graph, line 1669)

**Outputs produced:**
- Verification state: `recordVerificationGateResult('auditor', verdict, summary)`
- Result shape: `graphAuditResult { verdict, summary, gaps }` → folded into graph `DelegationOutcome` gateVerdicts (line 1765)

**Role-kernel calls:** `runAuditorEvaluation(...)`

**Shared mutable state reached:**
- `lastCoderStateRef.current` (read-only, written by Seam 7 at line 1339)
- `updateVerificationStateForChat` (callback)
- `graphResult.nodeStates` (read-only, populated by Seams 5–7)

**Cross-seam coupling:**
- **Coupled to Seam 7 (task-graph Coder):** reads `lastCoderStateRef.current` (line 1669, written by line 1339). Fires conditionally: only if `coderNodeStates.length > 0` (line 1629).
- **Coupled to Seam 5 (task-graph Execute):** reads `graphResult.nodeStates` (line 1616 filter, line 1657 aggregation) to construct the auditor's input.

## Shared State Inventory

**Parameters (refs + callbacks) and which seams reach them:**

| Ref/Callback | Seq Explorer | Planner | Seq Coder | Seq Auditor | TG Execute | TG Explorer | TG Coder | TG Auditor |
|---|---|---|---|---|---|---|---|---|
| `setConversations` | R | - | R | - | - | R | R | - |
| `updateAgentStatus` | R | R | R | R | R | R | R | R |
| `appendRunEvent` | R | R | R | R | R | R | R | R |
| `emitRunEngineEvent` | R | - | - | - | - | - | - | - |
| `getVerificationPolicyForChat` | - | - | R | - | - | - | R | - |
| `updateVerificationStateForChat` | R | - | R | R | - | R | R | R |
| `branchInfoRef` | R | - | R | R | - | R | R | R |
| `isMainProtectedRef` | R | - | R | - | - | R | R | - |
| `agentsMdRef` | R | - | R | - | - | R | R | - |
| `instructionFilenameRef` | R | - | R | - | - | R | R | - |
| `sandboxIdRef` | R | - | R | - | R | R | R | R |
| `repoRef` | R | - | R | R | - | R | R | R |
| `abortControllerRef` | R | - | - | - | R | - | - | - |
| `abortRef` | - | - | - | - | - | - | - | - |
| `lastCoderStateRef` | - | - | W | R | - | - | W | R |

**Legend:** R = read, W = write (via callback), - = not reached

**Context-shape implications:**
- Refs read by all 8 seams (`updateAgentStatus`, `appendRunEvent`, `updateVerificationStateForChat`, `repoRef`, `branchInfoRef`) → base context
- Refs read by 4–7 seams → domain-specific (Coder gets its own context; Auditor might inherit Coder context with an expanded interface; Explorers get minimal context)
- Refs read by 1–2 seams → candidate for keeping in hook (e.g., `emitRunEngineEvent` only for Seq Explorer, `abortControllerRef` only for Seq Explorer + TG Execute)
- **`lastCoderStateRef` is the cross-seam hazard:** written by Coder seams (both sequential and task-graph), read by Auditor seams (both sequential and task-graph). The ref is a shared mutable bridge that violates clean handler-context isolation if not carefully scoped.

## Module-Local Helpers

1. **`getTaskStatusLabel(criteriaResults?)`** (line 71–75)
   - Pure function: maps criterion results to 'OK' or 'CHECKS_FAILED'
   - Called by: Seq Coder (line 738), to format task status for multi-task summary
   - **Candidate:** Keep in hook or move to neutral helper module. Pure, reusable. Current location is fine; no extraction value.

2. **`buildMemoryScope(...)`** (line 81–94)
   - Pure function: assembles a `MemoryScope` from chat/repo/branch params, returns null in scratch mode
   - Called by: Seq Explorer (line 277), Seq Coder (line 500), TG Execute (line 1172), Seq Auditor (line 855), TG Auditor (line 1705)
   - **Candidate:** Extract to a neutral memory-helper module. Called by 5 seams, pure, logic-free builder. **This is a prime candidate for the "typed-memory helpers first" extraction phase.** Would become part of a `MemoryContext` helper module.

3. **`formatMemoryError(error)`** (line 98–101)
   - Pure function: extracts error message from Error object or stringifies unknown
   - Called by: `logContextMemoryWarning` (line 106)
   - **Candidate:** Trivial, keep inline or move with `logContextMemoryWarning`.

4. **`logContextMemoryWarning(action, error)`** (line 103–108)
   - Impure: `console.warn(...)` side effect
   - Called by: `runContextMemoryBestEffort` (line 117)
   - **Candidate:** Move with `runContextMemoryBestEffort` to a memory-error-handling helper module.

5. **`runContextMemoryBestEffort(action, operation)`** (line 110–119)
   - Impure: async operation execution + error logging
   - Called by: Seq Explorer (line 382), Seq Coder (via memory write calls), TG Execute (line 1584, 1603)
   - **Candidate:** Extract to neutral memory-helper module. Appears in 3+ seams, encapsulates the error-handling pattern for memory operations. **Prime extraction candidate alongside `buildMemoryScope`.**

6. **`retrieveMemoryKnownContextLine(...)`** (line 125–150)
   - Impure: async memory query + error handling
   - Called by: Seq Explorer (line 282), Seq Coder (line 505), TG Execute (line 1181 inside `taskExecutor` closure)
   - **Candidate:** Extract to memory-helper module. Appears in 3 seams, builds on `buildMemoryScope` + `runContextMemoryBestEffort`. **Key part of "typed-memory helpers" extraction.**

7. **`withMemoryContext(base, line)`** (line 153–157)
   - Pure function: merges a retrieved memory line into a knownContext array
   - Called by: Seq Explorer (line 312), Seq Coder (line 710), TG Execute (line 1189, 1345)
   - **Candidate:** Move to memory-helper module alongside retrieval helpers. Trivial, utility-only.

8. **`appendInlineDelegationCards(...)`** (line 159–172)
   - Impure: calls `setConversations` (React state mutation)
   - Called by: Seq Explorer (line 347), TG Explorer (line 1257), TG Coder (line 1374)
   - **Candidate:** Keep in hook or extract to a UI-adapter helper. Not part of the "memory helpers" layer — this is presentation logic. If extracted, would live in a sibling module, not the memory-helper context.

## Coupling Hazards

### 1. **`lastCoderStateRef` Cross-Seam Mutation**

The shared mutable ref is written by:
- Seq Coder (line 703 via callback from `runCoderAgent`)
- TG Coder (line 1339 via callback from `runCoderAgent`)

And read by:
- Seq Auditor (line 818, with fallback to null for multi-task delegations line 818)
- TG Auditor (line 1669, same fallback pattern)

**Hazard:** Render-cycle coupling. Seq Coder calls `setConversations` (line 347 via `appendInlineDelegationCards`), which triggers a React re-render batched in the next microtask. The ref mutation callback fires synchronously *during* `runCoderAgent` execution (before the function returns), so the ref is updated before the Auditor span reads it. **However**, if React batches the `setConversations` state update, the hook's dependency on `lastCoderStateRef.current` being populated before Auditor reads it is an implicit render-cycle dependency, not a function-execution dependency. In practice it works because the ref write is synchronous during agent execution, but it's fragile.

**Recommendation for extraction:** The ref must be part of a `CoderHandlerContext` that both Coder and Auditor seams receive. Auditor's context should either:
- Receive the state directly as a parameter (immutable data flow), or
- Receive a callback that Coder has already populated before Auditor's span fires

The second option is the current pattern, just named explicitly.

### 2. **Auditor Gating on Sequential Coder Completion (Render-Cycle Hazard)**

Sequential Auditor seam (Seam 4) fires only if `harnessSettings.evaluateAfterCoder && summaries.length > 0` (line 792). The `summaries` array is populated inside the Coder loop (lines 760–765). After the loop completes, the Auditor span fires *synchronously* inside the same `executeDelegateCall` execution.

**Hazard:** If React batches the `setConversations` call from line 347, the browser's UI will not yet reflect the inline cards by the time the Auditor span runs and emits its own events. The event ordering in the `appendRunEvent` log will show Coder → Auditor events in the correct sequence, but the UI state may be one render behind the events. This is not a correctness hazard (the events are correct), but it's a UX synchronization hazard if any downstream code relies on `setConversations` having settled before reading Auditor results.

**Recommendation for extraction:** Make the gating condition and context-building explicit in the Auditor handler. If the handler receives a `CoderResults` context object, the build function can validate that Coder actually ran before constructing Auditor context.

### 3. **Task-Graph Auditor Coupling to Node States**

Task-graph Auditor (Seam 8) reads `graphResult.nodeStates` (populated at line 1614 by the graph executor, Seam 5) to construct its evaluation input. It also reads `lastCoderStateRef.current` (written by Seam 7 during node execution, inside the `taskExecutor` closure).

**Hazard:** Graph execution is parallel for explorers, sequential for coders within the same sandbox. The `lastCoderStateRef` is overwritten by each Coder node in execution order. When the auditor reads it, it gets the state from the *last* Coder node to complete. If the graph has multiple Coder nodes and they complete out of order (due to abort signals or errors), the auditor will not have visibility into earlier nodes' states. The current code tries to handle this (line 1669: "For multi-task delegations, only the last task's working memory is available — pass null to avoid misleading the evaluator") but the logic checks `coderNodeStates.length <= 1`, not the execution order.

**Hazard level:** Medium. Single-node task graphs work correctly. Multi-node graphs explicitly pass `null` to avoid misleading the auditor, which is correct but lossy. If a future optimization tried to feed all node states to the auditor, this ref-mutation pattern would break.

**Recommendation for extraction:** Task-graph Coder handler must accumulate all node states into a context object (e.g., a Map of `nodeId → CoderState`) instead of mutating a single ref. The handler's build function can construct this map and pass it to the auditor handler.

### 4. **Verification State Mutation via Callback Chain**

Six seams call `updateVerificationStateForChat(chatId, (state) => recordVerificationMutation(...))` or similar, chaining the verification-runtime functions. Each call mutates verification state immutably (the callback returns a new state), but the accumulation across seams means:

- Seq Explorer writes artifacts (line 393)
- Seq Coder writes mutations, command results, artifacts (lines 752, 767, 777)
- Seq Auditor writes gate results (line 875)
- TG Explorer writes artifacts (line 1277)
- TG Coder writes mutations, command results, artifacts (lines 1386, 1394, 1403)
- TG Auditor writes gate results (line 1722)

**Hazard:** The callback chain can batch multiple mutations into a single state transition, but if one callback throws (unlikely, these are pure functions), the chain halts and earlier updates are lost. More realistically, if future code adds branching to decide *which* verification records to write based on prior records, the imperative callback chain becomes a state machine that's hard to reason about.

**Recommendation for extraction:** Verification state mutations should be part of a shared `VerificationHandlerContext` that all seams receive. Instead of callbacks, the context could expose methods like `recordMutation`, `recordArtifact`, `recordGateResult`, which internally manage the state accumulation and can be tested independently.

### 5. **Policy-Shaped Logic Leaking into Seams**

The containment rule from the plan states: "The hook may compose context and callbacks, but must not learn new semantics."

**Examples of policy logic currently in the hook:**
- Line 535: `if (harnessSettings.plannerRequired && taskList.length === 1)` — decides whether to run Planner based on harness profile and task count. This is policy (when to use Planner), not choreography (how to run it).
- Line 792: `if (harnessSettings.evaluateAfterCoder && summaries.length > 0)` — decides whether to run Auditor based on harness settings. Policy.
- Line 658–661: `mergeAcceptanceCriteria(delegateArgs.acceptanceCriteria, verificationCriteria)` — merges explicit criteria with verification-policy criteria. Policy logic.
- Line 818: `const evalWorkingMemory = taskList.length <= 1 ? lastCoderStateRef.current : null;` — decides whether to pass working memory to auditor based on task count. Policy.

**Hazard:** These decisions are baked into the hook's main dispatch logic. If a future PR wants to change when Planner runs (e.g., "always run Planner if task is large, regardless of harness setting"), the change touches the hook body. The containment rule aims to prevent this.

**Recommendation for extraction:** Each seam should receive a `*HandlerContext` that includes a `shouldRun?: boolean` or similar gating field. The hook's dispatch logic becomes more uniform:

```typescript
if (planner.shouldRun) {
  const plan = await withActiveSpan('subagent.planner', ..., async () =>
    runPlanner(...) inside handler context);
}
```

This is not a blocking hazard for extraction, just a cleanup opportunity. The plan already flags this pattern (`makeWebCoderToolExec` in `coder-agent.ts` has similar policy-dispatch logic).

## Test Coverage Matrix

Coverage status for the 6 existing tests in `app/src/hooks/useAgentDelegation.test.ts`:

| Seam | Test Name | Status | Notes |
|---|---|---|---|
| Seq Explorer | "emits DELEGATION_STARTED for a valid explorer task" | Partially covered | DELEGATION_STARTED + `runExplorerAgent` invocation pinned; outcome shape + memory write not directly covered by this test |
| Seq Explorer | "emits subagent.completed with an explorer DelegationOutcome on happy path" | Well covered | Full outcome shape + event emission pinned (new test in Step 2 backfill, commit `1f4ffbf`) |
| Planner | Not directly tested | Uncovered | Planner seam is nested inside Coder; no standalone coverage |
| Seq Coder | "emits DELEGATION_STARTED for coder when sandbox + task are present" | Partially covered | Dispatch + pre-span logic; does not exercise the full Coder span or outcome |
| Seq Coder | "emits subagent.completed with a coder DelegationOutcome on happy path" | Well covered | Full outcome shape, rounds/checkpoints pinned; verification state mutations and auditor gating not in this test (new test in Step 2 backfill, commit `1f4ffbf`) |
| Seq Coder (failure) | "emits subagent.failed and a Tool Error when runCoderAgent throws" | Well covered | Error path + event emission pinned (new test in Step 2 backfill, commit `1f4ffbf`) |
| Seq Auditor (Coder eval) | Not directly tested in "Coder" describe block | Partially covered | Auditor fires conditionally; one test in Step 2 backfill (follow-up commit) pins "auditor enabled → recordVerificationGateResult('auditor', 'passed')" when `evaluateAfterCoder: true`; Auditor failure path + inconclusive verdict paths not covered |
| TG Execute | Not directly tested | Uncovered | Graph validation + execution logic lives in `lib/task-graph.ts` (separate coverage); the `useAgentDelegation.ts` seam is mostly delegation to graph executor + event emission |
| TG Explorer | Not directly tested | Uncovered | Nested inside executor closure; no standalone coverage |
| TG Coder | Not directly tested | Uncovered | Nested inside executor closure; no standalone coverage |
| TG Auditor | Not directly tested | Uncovered | Conditional gate + evaluation; no coverage |

**Coverage gaps by extraction priority:**
1. Planner (uncovered) — small seam, nested dependency. **Pre-requisite for extraction:** need 2–3 tests pinning (a) planner runs when harness setting is true, (b) planner fails gracefully (no runCoderAgent side effect), (c) plan output feeds into coder's knownContext.
2. TG Execute + sub-seams (uncovered) — Graph-level coordination is tested in `lib/task-graph.test.ts`; the hook-level wrapper's event emission is not. **Pre-requisite:** 3–4 tests pinning (a) `task_graph.graph_completed` event on success, (b) memory persistence calls, (c) auditor gate behavior if coders present.
3. Seq Auditor failure paths (partially covered) — Currently only happy path (verdict == 'complete'). **Pre-requisite:** tests for (a) auditor returns null (inconclusive), (b) auditor throws (error handling), (c) verdict == 'incomplete' (incomplete status + gaps).
4. TG Auditor (uncovered) — Same as Seq Auditor + aggregation logic.

## Recommended Extraction Order

Based on the coupling analysis and test coverage matrix:

### Phase 1: Typed-Memory Helpers (standalone, no context needed)
**Seams enabled:** Seq Explorer, Seq Coder, TG Execute, both Auditors  
**Target:** Neutral `lib/memory-context-helpers.ts` module  
**Exports:**
- `buildMemoryScope(...)`
- `retrieveMemoryKnownContextLine(...)`
- `withMemoryContext(...)`
- `runContextMemoryBestEffort(...)`
- `logContextMemoryWarning(...)` (optional, part of error handling)

**Why first:** Pure functions, called by 3–5 seams, zero cross-seam dependencies. Extraction has zero risk of breaking interactions. Clears ~30 lines from the hook. Sets the pattern for how typed-memory flows through handler contexts. The plan calls for "typed-memory helpers first" — this is exactly that layer.

**Test prerequisites:** None beyond existing tests. These are currently tested implicitly (they're called, and if they fail, outcomes fail). Add 2–3 explicit tests pinning `buildMemoryScope` with/without repo context, `retrieveMemoryKnownContextLine` null handling, `withMemoryContext` merge behavior.

**Extraction hazard:** None. Fully pure (except `runContextMemoryBestEffort` which is already error-handling best-effort).

### Phase 2: Sequential Explorer Handler
**Seams enabled:** Seq Explorer only  
**Target:** `app/src/lib/explorer-delegation-handler.ts`  
**Exports:**
- `ExplorerHandlerContext` type (refs, callbacks, correlation)
- `buildExplorerContext(...)` helper
- `handleExplorerDelegation(...)` async handler

**Why second:** 
- Explorer is the simplest seam (no auditor gating, no cross-seam state mutation).
- Well-covered by tests (happy path + failure path).
- Small surface, low risk.
- Validates the handler-context pattern before moving to Coder (which is more complex).

**Test prerequisites:** None. Existing tests can be reused as regression gates if handler structure is internal.

**Extraction hazard:** Low. Explorer is a leaf seam; no other seam depends on it.

### Phase 3: Sequential Coder Handler (+ Planner Sub-Seam)
**Seams enabled:** Sequential Coder, Planner sub-seam  
**Target:** `app/src/lib/coder-delegation-handler.ts`  
**Exports:**
- `CoderHandlerContext` type (all Coder-specific refs, callbacks, Planner decision)
- `buildCoderContext(...)` helper
- `handleCoderDelegation(...)` async handler (multi-task loop + per-task Planner decision)

**Why third:**
- Planner is nested inside Coder; they should extract together.
- Coder is the load-bearing seam; extracting it validates the pattern can handle complexity (criteria merging, diff capture, state mutation via callback).
- Seq Auditor depends on Coder completing first; extracting Coder first makes the dependency explicit.
- Test coverage exists for happy path + failure path.

**Test prerequisites:**
- Add tests pinning Planner runs when `harnessSettings.plannerRequired` (currently implicit).
- Verify auditor gating still works post-extraction (Coder context build function must populate `lastCoderStateRef` callback correctly).

**Extraction hazard:** Medium.
- **`lastCoderStateRef` callback must be part of context:** the callback from `runCoderAgent` (line 703) writes the ref. The handler must accept this callback and wire it to the agent call.
- **`setConversations` call in loop:** line 347 inside loop. Handler must accept the callback and call it per task.
- **Multi-task loop:** the loop is in the hook (line 624 `for (const [taskIndex, task] of taskList.entries())`). The handler should receive `taskList` and loop internally, or the hook should call the handler once per task. Recommendation: handler loops internally, encapsulating task-level state (summaries, allCards, allCriteriaResults) inside its closure. This simplifies the interface.

### Phase 4: Sequential Auditor Handler
**Seams enabled:** Seq Auditor (Coder evaluation)  
**Target:** `app/src/lib/auditor-delegation-handler.ts`  
**Exports:**
- `AuditorHandlerContext` type (overlaps with Coder context; should inherit or compose)
- `buildCoderAuditorContext(...)` helper (builds from Coder handler's output)
- `handleCoderAuditor(...)` async handler

**Why fourth:**
- Depends on Coder handler existing (reads `CoderHandlerContext` output or a narrower subset).
- Simpler than Coder, can validate that handler-context composition works (auditor context = coder context + evaluation-specific fields).
- Partially covered by tests (happy path only; failure paths are gaps that should be covered before extraction).

**Test prerequisites:**
- Add tests for auditor failure paths (returns null, throws, verdict == 'incomplete').
- Verify auditor gating condition is honored (only runs if Coder ran AND `harnessSettings.evaluateAfterCoder`).

**Extraction hazard:** Medium.
- **`lastCoderStateRef` inheritance:** Auditor context must receive the ref (or a copy of its final value) from Coder context build. If Coder context is a separate module, the hook must compose both contexts to pass to Auditor.
- **Gating condition:** the `if (harnessSettings.evaluateAfterCoder && summaries.length > 0)` decision should move to the hook (policy: when to call the auditor handler), not inside the handler (handlers are reactive, not gated).

### Phase 5: Task-Graph Handler (Coordinator + Sub-Seams)
**Seams enabled:** TG Execute, TG Explorer, TG Coder, TG Auditor  
**Target:** `app/src/lib/task-graph-delegation-handler.ts`  
**Exports:**
- `TaskGraphHandlerContext` type (graph-level refs, callbacks, harness settings)
- `buildTaskGraphContext(...)` helper
- `handleTaskGraphDelegation(...)` async handler (returns just the graph outcome; all event emission happens inside)
- `TaskExecutor` type re-export (from `lib/task-graph`)
- Build functions for per-node context (or let nodes receive TaskGraphHandlerContext and query as needed)

**Why fifth:**
- Largest seam, most complex. Extracting after Coder and Auditor validates the pattern can handle coordination + sub-seams.
- Graph-level tests are uncovered; extraction is a good time to add characterization tests.
- Task-graph auditor depends on task-graph coder nodes completing; extracting both together makes the dependency clear.

**Test prerequisites:**
- Add tests pinning graph execution events (task_graph.task_started, task_graph.task_completed, task_graph.graph_completed).
- Add tests pinning auditor gate behavior when graph has coder nodes.
- Add tests pinning memory invalidation calls.

**Extraction hazard:** High (most complex seam).
- **`lastCoderStateRef` mutation in parallel node executions:** Seam 7 (TG Coder) overwrites the ref for each node. Seam 8 (TG Auditor) reads the last-written value. The handler must accumulate *all* node states, not mutate a single ref. This is a breaking change from the current pattern.
- **`activeTasks` map concurrency:** Seams 6–7 both write to this map (lines 1236, 1325 for set; 1254, 1371 for delete). The map is local to the executor closure, so it's safe from external races, but extracting requires careful boundary design — the map is purely for status aggregation, not outcome coordination.
- **Event ordering:** the onProgress callback (lines 1485–1557) emits events in graph execution order, which may not be task-index order if explorers run in parallel. Extraction must preserve this ordering; tests must pin it.

## Open Questions for the Next Session

1. **`lastCoderStateRef` accumulation strategy:** Should the handler context for task-graph Coder nodes accumulate all node states in a `Map<nodeId, CoderState>` instead of mutating a single ref? If yes, the hook's current pattern breaks and auditor context design changes. This should be decided before extracting TG Coder handler.

2. **Auditor context composition:** After Coder handler extraction, the auditor seam receives two pieces of context (Coder results + Auditor-specific fields). Should the auditor handler context inherit from Coder context, or should the hook compose them? The former tightens coupling, the latter makes composition explicit. Recommend deciding after Seq Coder extraction lands and before Seq Auditor extraction.

3. **Planner decision locus:** Currently the decision "run Planner if `harnessSettings.plannerRequired && taskList.length === 1`" is in the hook (line 535). Should this move to Coder handler build logic (policy encapsulation) or stay in the hook (hook as orchestrator of policy decisions)? The plan's containment rule suggests "policy stays in the hook," but this is a close call.

4. **Graph node context builders:** For task-graph node execution (Seams 6–7 inside executor closure), should each node receive a full `TaskGraphHandlerContext` and call `buildNodeContext(...)` for its scope? Or should the executor receive a `buildNodeContext` factory function and call it per node? The latter is more modular but requires the handler to export a higher-order context builder.

5. **Memory isolation between graph nodes:** Each node can retrieve prior node memory (via `graphMemoryScope` + `taskGraphId` + `taskId` hints). After extraction, should the handler context expose a `retrieveNodeMemory(...)` method (encapsulates the retrieval logic), or should nodes call the memory-helper module directly? Encapsulation is cleaner but adds a context method for every memory operation.

---

**Generated:** 2026-04-18, recon-only pass. No extractions performed. Seam boundaries verified against code, test coverage mapped to existing tests, coupling hazards enumerated. Ready for extraction-order planning and test-gap backfilling in next session.
