# Context Memory and Retrieval Architecture

Status: Current, added 2026-04-05
Origin: [Multi-Agent Orchestration Research](Multi-Agent%20Orchestration%20Research%20%E2%80%94%20open-multi-agent.md), [Task Graph Orchestration Plan](../archive/runbooks/Task%20Graph%20Orchestration%20Plan.md)

## Implementation Status

- Phase 1: Shipped
  - Typed `MemoryRecord` model, write path, and local store are in place.
  - Web persistence now uses IndexedDB-backed records scoped to repo/branch/chat.
- Phase 2: Shipped
  - Deterministic retrieval is active for delegation and task-graph handoff enrichment.
- Phase 3: Shipped
  - File-change invalidation and branch-expiration freshness transitions are active.
- Phase 4: Shipped
  - Retrieved memory is packed into bounded sectioned prompt blocks.
- Phase 5: Partial
  - Retrieval is active for delegation, checkpoint decisions, and targeted Reviewer/Auditor prompts.
  - Broad Orchestrator retrieval remains follow-through work.

Persistence note:

- Web persistence is best-effort / fail-open. Memory storage and cleanup failures should not block successful delegations or task-graph completions.

## Why This Exists

Push now has a real task-graph executor, graph-scoped shared memory, and task-level trace events. That makes orchestration meaningfully better than "one delegation at a time."

Context handling is better than a naive rolling transcript, but it is still mostly:

- recent chat
- compacted history digests
- role-specific handoff blocks
- Coder working memory
- task-graph summary injection

That is a good baseline, but it still treats most useful prior work as text to compress instead of structured memory to retrieve.

This doc proposes the next step: treat context as a queryable memory system, not only as chat history.

## Current Baseline

Today Push already has several useful context behaviors:

- Model-aware context budgets with staged compaction in `app/src/lib/orchestrator.ts`
- Semantic-ish message compaction and digest generation in `app/src/lib/context-compaction.ts`
- Structured Coder working memory in `lib/working-memory.ts` and `app/src/lib/coder-agent.ts`
- Phase-based Coder context resets for heavy harness profiles
- Delegation briefs with `knownContext`, constraints, deliverables, and acceptance checks in `app/src/lib/role-context.ts`
- Graph-scoped task memory summarized into dependent tasks in `app/src/lib/task-graph.ts`
- Lightweight context-pressure telemetry in `app/src/lib/context-metrics.ts`

What is missing is a durable, invalidation-aware middle layer between "verbatim chat" and "fully forgotten."

## Design Goal

Build a context system with four layers:

1. Live context
2. Working memory
3. Artifact memory
4. Retrieval + prompt packing

The key shift is that Explorer/Coder/task-graph outputs become typed memory records that can later be selected on purpose.

## Target Model

### 1. Live Context

This remains mostly as-is:

- current user ask
- recent turns
- active tool results
- the exact active task / branch / repo

This is still the highest-trust, lowest-latency context.

### 2. Working Memory

Short-lived state for the active run or agent.

Examples:

- Coder plan, phase, open tasks, touched files, assumptions
- active task-graph node state
- recent mutation or verification warnings

This already exists in partial form via `[CODER_STATE]`. The proposal keeps it, but treats it as one explicit layer in the prompt packer.

### 3. Artifact Memory

Durable structured records produced by work, not just chat.

Initial record kinds:

- `fact`
- `finding`
- `decision`
- `task_outcome`
- `verification_result`
- `file_change`
- `symbol_trace`
- `dependency_trace`

Examples:

- Explorer found that auth refresh is guarded in `useAuth.ts`
- Coder changed `sandbox-tools.ts` and passed `npm run typecheck`
- Task graph node `explore-auth` concluded that middleware injects session state before route guards

### 4. Retrieval + Prompt Packing

Before a role call, Push should ask:

- What role is being invoked?
- What is the current task?
- Which files/symbols are in scope?
- Which memory records are most relevant and still fresh?

Then it should pack only the highest-value records into bounded prompt sections.

## Core Data Model

Start with a simple typed record model. No embeddings are required for phase 1.

```ts
type MemoryRecordKind =
  | 'fact'
  | 'finding'
  | 'decision'
  | 'task_outcome'
  | 'verification_result'
  | 'file_change'
  | 'symbol_trace'
  | 'dependency_trace';

type MemoryFreshness = 'fresh' | 'stale' | 'expired';

interface MemoryScope {
  repoFullName: string;
  branch?: string;
  chatId?: string;
  role?: 'orchestrator' | 'explorer' | 'coder' | 'reviewer' | 'auditor' | 'planner';
  taskGraphId?: string;
  taskId?: string;
  runId?: string;
}

interface MemorySource {
  kind: 'explorer' | 'coder' | 'task_graph' | 'review' | 'audit' | 'orchestrator';
  label: string;
  createdAt: number;
}

interface MemoryRecord {
  id: string;
  kind: MemoryRecordKind;
  summary: string;
  detail?: string;
  scope: MemoryScope;
  source: MemorySource;
  relatedFiles?: string[];
  relatedSymbols?: string[];
  tags?: string[];
  freshness: MemoryFreshness;
  derivedFrom?: string[];
  invalidatedAt?: number;
  invalidationReason?: string;
}
```

Phase 1 should keep this intentionally small. The important part is that a record is:

- typed
- scoped
- attributable
- invalidatable

## Retrieval Query Model

Each prompt build should derive a compact retrieval query.

```ts
interface MemoryQuery {
  repoFullName: string;
  branch?: string;
  chatId?: string;
  role: 'orchestrator' | 'explorer' | 'coder' | 'reviewer' | 'auditor';
  taskText: string;
  fileHints?: string[];
  symbolHints?: string[];
  taskGraphId?: string;
  taskId?: string;
  maxRecords: number;
}
```

Phase 1 retrieval should use deterministic scoring, not semantic embeddings.

Suggested score components:

- same repo: required
- same branch: very high weight
- same task graph lineage: high weight
- file overlap: high weight
- symbol overlap: high weight
- same role family: medium weight
- recency: medium weight
- freshness: required modifier

Records marked `expired` should never be injected. `stale` records may still be surfaced in a small "stale context" bucket for debugging or guarded fallback, but should score far below `fresh`.

## Prompt Packing Model

The prompt builder already has the right shape for this in `app/src/lib/system-prompt-builder.ts`.

Use these sections more deliberately:

- `environment`
- `project_context`
- `memory`
- `state`
- `custom`

Proposed packed blocks:

- `[RETRIEVED_FACTS]`
- `[RETRIEVED_TASK_MEMORY]`
- `[RETRIEVED_VERIFICATION]`
- `[STALE_CONTEXT]`

Each block gets a hard budget. Example starting budgets:

- retrieved facts: 1,500 chars
- task memory: 1,500 chars
- verification: 1,000 chars
- stale context: 500 chars

This prevents one category from eating the whole prompt.

The packer should prefer:

- multiple short records over one giant record
- direct dependency/task-lineage matches over generic "recent" memory
- summaries by default, `detail` only when the record is top-ranked and still fits the section budget

## Write Path: Where Records Come From

### Explorer

Explorer completions should emit:

- `finding`
- `fact`
- `dependency_trace`
- `symbol_trace`

Initial insertion point:

- `app/src/hooks/useAgentDelegation.ts` after Explorer delegation returns, parallel to where delegation outcomes are already summarized

### Coder

Coder completions should emit:

- `task_outcome`
- `file_change`
- `verification_result`
- optional `decision`

Initial insertion points:

- `app/src/hooks/useAgentDelegation.ts` after `runCoderAgent()` returns
- reuse existing verification result collection and diff extraction

### Task Graph

Task-graph node completions should write graph-scoped artifact memory, not only string summaries.

Initial insertion points:

- extend `app/src/lib/task-graph.ts` so `buildTaskGraphMemoryEntry()` becomes a bridge into typed memory records
- use graph/task scope fields instead of only `namespace`

### Checkpoints

Checkpoint answers are a good source of "decision" memory when the Orchestrator resolves ambiguity mid-run.

Initial insertion point:

- `generateCheckpointAnswer()` call path in `app/src/hooks/useAgentDelegation.ts`

## Read Path: Where Retrieval Gets Injected

### Delegation briefs

Current delegation briefs already accept `knownContext`.

Phase 1 read path:

- retrieve records before Explorer/Coder delegation
- convert them into compact `knownContext` lines
- keep the existing brief shape in `app/src/lib/role-context.ts`

### Task graphs

Current task graphs inject dependency summaries.

Phase 2 read path:

- merge graph dependency memory with retrieved branch/chat memory
- preserve dependency memory as highest-priority context

### Coder prompt building

Current Coder prompt already uses `memory` and `state`.

Phase 2 read path:

- inject retrieved artifact memory into `memory`
- reserve `state` for live working memory only

### Orchestrator prompt building

The Orchestrator should eventually retrieve:

- prior implementation decisions
- recent graph outcomes
- relevant verification results

This is a later phase because Orchestrator already has strong chat history access and the first payoff is on delegation quality.

## Invalidation Model

Invalidation is the difference between "memory" and "hallucination with extra steps."

Rules:

- Branch switch:
  branch-scoped records from the old branch become `expired` for the new branch

- File mutation:
  records tied to changed files become `stale`

- Symbol mutation:
  records tied to changed symbols become `stale`

- Sandbox reset:
  sandbox-only transient records become `expired`

- Verification supersession:
  older verification records for the same command/path can become `stale` when a newer run exists

The current observation invalidation path in `lib/working-memory.ts` is the right mental model to copy upward into artifact memory.

## Storage Model

Start simple:

- in-memory cache for the active chat/session
- IndexedDB-backed persistence for records scoped to repo/branch/chat
- no server sync
- no cross-repo retrieval

Do not start by embedding memory records into conversation blobs. Give them a small dedicated store so retrieval and invalidation stay cheap and explicit.

Suggested module split:

- `app/src/lib/context-memory.ts`
- `app/src/lib/context-memory-store.ts`
- `app/src/lib/context-memory-retrieval.ts`
- `app/src/lib/context-memory-packing.ts`
- `app/src/lib/context-memory-invalidation.ts`

## Observability

The new memory layer should be inspectable, not magical.

Add typed events or telemetry for:

- `memory.record_written`
- `memory.record_invalidated`
- `memory.records_retrieved`
- `memory.records_injected`
- `memory.records_dropped`

Useful fields:

- role
- query scope
- matched record ids
- dropped record ids
- stale count
- chars packed
- section budgets used

This should complement, not replace, the existing context-pressure metrics and task-graph run events.

## Integration Map

| Area | Current file(s) | Proposed change |
|---|---|---|
| Record types | `app/src/types/index.ts` | Add `MemoryRecord`, query, score, and invalidation types |
| Store + retrieval | new | Add context-memory store/retrieval modules |
| Delegation write path | `app/src/hooks/useAgentDelegation.ts` | Write Explorer/Coder/task outcomes as memory records |
| Task graph memory bridge | `app/src/lib/task-graph.ts` | Replace string-only memory summary with typed records + formatted pack output |
| Prompt packing | `app/src/lib/system-prompt-builder.ts` plus role agents | Add retrieved-memory block builders and section budgets |
| Coder state interaction | `lib/working-memory.ts`, `app/src/lib/coder-agent.ts` | Keep `[CODER_STATE]` as live state, distinct from retrieved artifact memory |
| Invalidation hooks | `app/src/lib/coder-agent.ts`, file-awareness paths, branch-switch hooks | Mark file/symbol-linked records stale/expired |
| Telemetry | run-event/metrics libs | Add memory retrieval/write/invalidation events |

## Phased Implementation Plan

### Phase 1: Typed records + write path

- Add `MemoryRecord` types
- Add a small local store with repo/branch/chat scoping
- Write records from Explorer, Coder, and task-graph completions
- Add tests for record creation and scoping

Success criteria:

- Push stores structured records instead of only raw summaries
- task-graph shared memory can be derived from the same record model

### Phase 2: Deterministic retrieval for delegation

- Build a deterministic scorer using branch/task/files/symbols/recency/freshness
- Retrieve records before Explorer/Coder delegation
- Inject them through existing `knownContext` / prompt `memory` paths
- Add retrieval trace events

Success criteria:

- later tasks get relevant prior findings without replaying full transcripts
- dependency/task-lineage context beats generic recency

### Phase 3: Invalidation + freshness

- Mark file- and symbol-bound records stale when mutations happen
- Expire branch-scoped records on branch switch
- Add tests that stale records are demoted or excluded

Success criteria:

- mutated code does not keep feeding old findings back into the model as if they were current

### Phase 4: Prompt packer budgets

- Introduce a dedicated packer for retrieved memory sections
- Separate live working memory from artifact memory
- Surface chars/record counts per section

Success criteria:

- prompt composition becomes predictable
- memory injection remains bounded under pressure

### Phase 5: Broaden consumers

- Orchestrator retrieval
- checkpoint-answer retrieval
- Reviewer/Auditor targeted retrieval for prior decisions and verification history

Success criteria:

- memory becomes a shared substrate across roles instead of a Coder/task-graph special case

## Non-Goals for the First Pass

- embedding search
- semantic vector databases
- cross-repo memory
- server-synced memory
- replacing existing chat history or compaction entirely

Those can come later if deterministic retrieval proves too weak.

## Recommendation

Build phase 1 and phase 2 before anything embedding-shaped.

The highest-leverage path is:

1. one typed record model
2. one deterministic retriever
3. one bounded prompt packer
4. strong invalidation rules

That gets Push from "careful context compression" to "actual context selection" without adding a large new infrastructure dependency surface.
