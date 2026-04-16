# Task Graph Orchestration Plan

Status: Complete, started 2026-04-04, completed 2026-04-04
Origin: [Multi-Agent Orchestration Research](../decisions/Multi-Agent%20Orchestration%20Research%20—%20open-multi-agent.md)

## Goal

Enable the Orchestrator to decompose complex goals into a dependency-aware task graph and execute tasks (Explorer reads, Coder writes) in parallel where safe — instead of sequential one-at-a-time delegation.

## Current State

Today the Orchestrator delegates one task at a time:
1. User says "refactor auth and add tests"
2. Orchestrator calls `delegate_explorer` → waits → gets result
3. Orchestrator calls `delegate_coder` → waits → gets result
4. Orchestrator summarizes to user

This is sequential even when tasks are independent. The existing `ParallelDelegation` infrastructure handles parallel *Coder* tasks (multiple tasks in separate sandboxes with git merge), but there's no way to express a graph of mixed Explorer + Coder tasks with dependencies.

## Design

### New Tool: `plan_tasks`

A new Orchestrator-only delegation tool that accepts a task graph:

```json
{
  "tool": "plan_tasks",
  "args": {
    "tasks": [
      {
        "id": "explore-auth",
        "agent": "explorer",
        "task": "Trace the auth flow in src/auth.ts and src/middleware.ts",
        "files": ["src/auth.ts", "src/middleware.ts"],
        "dependsOn": []
      },
      {
        "id": "explore-tests",
        "agent": "explorer",
        "task": "Find existing test patterns and coverage gaps",
        "files": ["tests/"],
        "dependsOn": []
      },
      {
        "id": "refactor-auth",
        "agent": "coder",
        "task": "Refactor auth module based on findings",
        "dependsOn": ["explore-auth"],
        "deliverable": "Clean auth module with same behavior"
      },
      {
        "id": "add-tests",
        "agent": "coder",
        "task": "Add missing test coverage",
        "dependsOn": ["explore-tests", "refactor-auth"],
        "deliverable": "Tests pass with >80% coverage"
      }
    ]
  }
}
```

### Task Graph Executor

New module `app/src/lib/task-graph.ts`:

1. **Parse & validate** — Check for cycles, unknown agents, missing deps.
2. **Topological dispatch** — Find all tasks with satisfied dependencies, dispatch in parallel.
3. **Parallel Explorer** — Multiple Explorer tasks can run concurrently (read-only, no conflicts).
4. **Sequential Coder** — Coder tasks run one at a time in the main sandbox (mutations must be ordered). Two Coder tasks with no dependency between them still run sequentially to avoid sandbox conflicts.
5. **Result propagation** — Each completed task's summary is injected into dependent tasks' `knownContext`.
6. **Failure cascading** — If a task fails, all transitive dependents are marked failed.
7. **Synthesis** — After all tasks complete, return a combined result to the Orchestrator.

### Constraints

- Explorer tasks: fully parallelizable (read-only sandbox access)
- Coder tasks: sequential within the same sandbox (mutations may conflict)
- Mixed: Explorer tasks can run in parallel with a running Coder task (reads don't conflict with writes in separate sandbox views)
- Max concurrency: configurable, default 3 parallel Explorers

### Integration Points

| Component | Change |
|---|---|
| `tool-registry.ts` | Add `plan_tasks` entry |
| `tool-dispatch.ts` | Add `plan_tasks` to `AnyToolCall` union, parse logic |
| `useAgentDelegation.ts` | Add `plan_tasks` execution branch that calls task graph executor |
| `orchestrator.ts` | Add `plan_tasks` to delegation prompt section |
| `types/index.ts` | Add `TaskGraphArgs`, `TaskGraphNode`, `TaskGraphResult` types |
| **New:** `task-graph.ts` | Core executor: validation, topological sort, parallel dispatch, result collection |
| `run-engine.ts` | New phase: `executing_task_graph` |

### What Does NOT Change

- Individual `delegate_coder` / `delegate_explorer` remain as-is. The task graph executor calls them internally.
- Reviewer and Auditor are not part of the task graph (user-initiated or post-completion gates).
- The Orchestrator can still use single `delegate_coder` / `delegate_explorer` for simple tasks. `plan_tasks` is for multi-step goals.

## Implementation Steps

### Phase 1: Types & Task Graph Core
1. Add types to `types/index.ts`
2. Create `task-graph.ts` with validation, topological sort, dispatch loop

### Phase 2: Tool Integration
3. Register `plan_tasks` in `tool-registry.ts`
4. Add parsing in `tool-dispatch.ts`
5. Add execution branch in `useAgentDelegation.ts`

### Phase 3: Orchestrator Prompt
6. Update delegation prompt section to teach the Orchestrator when/how to use `plan_tasks`

### Phase 4: Run Engine & Events
7. Add `executing_task_graph` phase to run engine
8. Emit structured run events for task graph progress

## Open Questions

- Should the Orchestrator auto-decide between single delegation and task graph, or should we always use task graph (even for single tasks)?
  → Start with explicit: Orchestrator chooses. Single tasks use existing delegation. Multi-step goals use `plan_tasks`.

- Should Coder tasks within a graph get their own acceptance criteria?
  → Yes, propagated from the `plan_tasks` args or auto-derived per task.

- How does the Auditor evaluation fit?
  → Runs once after the full graph completes (not per-task), same as today's post-delegation evaluation.

## Completion Notes

- `plan_tasks` is implemented and wired into tool parsing, Orchestrator guidance, execution, run-engine phase tracking, and checkpoint handling.
- The task graph executor now propagates dependency context, preserves per-node delegation outcomes, treats aborts as cancellation, and runs graph-level auditor evaluation for coder work.
- Completed tasks now write compact graph-scoped memory entries that are summarized into dependent tasks' `knownContext`, giving later tasks limited awareness of prior graph work without dumping full raw outputs.
- Task graph execution now emits structured per-node progress events into the existing run-event stream, so Hub/console views can show task readiness, start, completion, failure, cancellation, and graph completion without scraping status text.
- Coverage includes task graph parsing, execution semantics, cancellation, and run-engine phase handling.
