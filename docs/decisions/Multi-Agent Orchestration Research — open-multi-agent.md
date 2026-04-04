# Multi-Agent Orchestration Research — open-multi-agent

Status: Current, added 2026-04-04
Source: https://github.com/JackChen-me/open-multi-agent

## What is it?

A lightweight TypeScript framework (~27 source files, 3 runtime deps) for orchestrating multiple AI agents. Its core innovation: accept a natural-language goal and auto-decompose it into a dependency-aware task graph via a coordinator agent, then execute tasks in parallel where possible.

## Architecture Summary

```
Orchestrator (OpenMultiAgent)
  └─ Team (agents + message bus + shared memory)
       ├─ Coordinator Agent (temporary — decomposes goal → task DAG)
       ├─ TaskQueue (dependency resolution, topological dispatch)
       ├─ AgentPool (semaphore-capped parallel execution)
       ├─ Scheduler (4 strategies: round-robin, least-busy, capability-match, dependency-first)
       └─ Shared Memory (namespaced KV with summary injection)
```

Three execution modes:
| Mode | Method | Description |
|------|--------|-------------|
| Single agent | `runAgent()` | One-shot, no team overhead |
| Auto-orchestrated | `runTeam()` | LLM decomposes goal → DAG, auto-assigns, parallel-executes, synthesizes |
| Explicit pipeline | `runTasks()` | Developer defines tasks with dependencies; skips coordinator |

## Key Patterns

### 1. Goal → DAG Decomposition (Coordinator Pattern)

A temporary coordinator agent receives the goal + team roster (names, roles, capabilities). It outputs JSON: `[{ title, description, assignee, dependsOn }]`. The `TaskQueue` resolves title-based dependencies into IDs and dispatches topologically.

**Graceful degradation:** If coordinator output is unparseable, falls back to one task per agent with full goal.

### 2. Task Scheduling Strategies

- **round-robin** — distribute evenly by index
- **least-busy** — assign to agent with fewest in-progress tasks
- **capability-match** — keyword overlap between task text and agent systemPrompt/name
- **dependency-first** (default) — BFS to count transitive blocked dependents, prioritize critical-path tasks

### 3. Concurrency Control

Custom `Semaphore` class used by both `AgentPool` (5 concurrent agents) and `ToolExecutor` (4 concurrent tool calls).

### 4. Shared Memory with Namespace + Summary Injection

Writes namespaced as `<agentName>/<key>`. A `getSummary()` method generates a markdown digest (truncating values > 200 chars) injected into agent prompts, giving each agent awareness of teammate output.

### 5. Fan-Out / Aggregate (MapReduce)

Multiple agents with different personas evaluate the same question in parallel, then a synthesizer agent combines results. Clean implementation of ensemble reasoning.

### 6. Structured Observability

Optional `onTrace` callback emits typed spans (`LLMCallTrace`, `ToolCallTrace`, `TaskTrace`, `AgentTrace`) with timing and token counts. Zero overhead when unsubscribed.

### 7. Retry with Exponential Backoff

Tasks have `maxRetries`, `retryDelayMs`, `retryBackoff`. Token usage accumulates across retries. Failed tasks cascade failure to all transitive dependents.

## Deliberate Non-Features (DECISIONS.md)

| Rejected | Rationale |
|----------|-----------|
| Agent handoffs | Task-based model with clear boundaries is simpler |
| State persistence | Targets seconds-to-minutes workflows, not hours |
| A2A protocol | Single-process, not distributed |
| MCP integration | `defineTool()` wraps services in ~10 lines |
| Dashboard/UI | Exposes data via callbacks instead |

## Transferable Ideas for Push

Ranked by impact and feasibility:

### High Priority

1. **Goal → DAG decomposition via coordinator agent** — Push's Orchestrator could auto-generate a task graph (Explorer reads, Coder writes, Reviewer checks) instead of sequential back-and-forth delegation. The coordinator prompt would include the team roster (Explorer: read-only investigation; Coder: sandbox mutations; Reviewer: advisory review; Auditor: safety gate) and output a dependency-aware task list.

### Medium Priority

2. **Semaphore-based concurrency for agent pool + tool execution** — Cleaner parallel control than current sequential delegation.
3. **Shared memory with namespace + summary injection** — Structured inter-agent context passing. Push currently passes context via delegation args and tool result envelopes. A shared KV store with markdown summaries could reduce prompt bloat.
4. **Structured trace events** — Push has OTel spans for boundaries; adding typed trace events for task-level observability would complement this.

### Lower Priority

5. **Fan-out/aggregate for reviews** — Multiple review lenses (security, performance, readability) running in parallel, then synthesized.
6. **Task retry with backoff** — Partially covered by resumable sessions.
7. **Scheduling strategies** — Capability-match and dependency-first would be useful if Push gains more than 2 delegatable roles.

## Implementation Notes for #1 (Task Graph)

### What changes in Push

The Orchestrator currently delegates one task at a time via `delegate_coder` / `delegate_explorer` tool calls, waiting for each to complete before deciding the next step. With a task graph layer:

1. **New: `plan_task_graph` tool** — Orchestrator emits a structured task graph instead of individual delegations.
2. **New: `TaskGraph` executor** — Receives the graph, resolves dependencies, dispatches to Explorer/Coder in parallel where possible.
3. **Existing delegation stays** — `delegate_coder` / `delegate_explorer` become the execution primitives called by the graph executor, not directly by the Orchestrator for complex goals.
4. **Synthesis step** — After all tasks complete, Orchestrator summarizes results to user.

### Key constraint

Push's agents run in sandboxes with real side effects (git, file writes). Unlike open-multi-agent's stateless tool calls, Push must sequence mutations carefully — Explorer reads can parallelize, but Coder mutations may conflict. The task graph must enforce write ordering.

### Mapping to Push roles

| open-multi-agent concept | Push equivalent |
|---|---|
| Coordinator agent | Orchestrator (existing, gains `plan_task_graph` tool) |
| Agent with tools | Explorer / Coder (existing delegation targets) |
| TaskQueue | New `TaskGraph` module |
| AgentPool + Semaphore | New parallel dispatch in delegation hook |
| Shared memory | Delegation args + scratchpad (existing, possibly extended) |
