# Mastra — Lessons for Push

Status: Reference (research snapshot, 2026-07-15)

## Question

After borrowing Mastra's typed durable suspend/resume shape for background
Coder jobs, what else in Mastra's current architecture is worth carrying into
Push?

This is not a feature-parity exercise. Mastra is a general TypeScript agent
framework; Push is a repo-locked product with an opinionated runtime and visible
delivery governance. A Mastra feature matters here only when it sharpens an
existing Push contract or closes a concrete substrate gap.

Primary references:

- [Mastra repository](https://github.com/mastra-ai/mastra)
- [AgentController overview](https://mastra.ai/docs/agent-controller/overview)
- [AgentController sessions](https://mastra.ai/docs/agent-controller/session)
- [AgentController subagents](https://mastra.ai/docs/agent-controller/subagents)
- [Gates and verdicts](https://mastra.ai/blog/introducing-gates-and-verdicts)
- [File-based agents](https://mastra.ai/blog/introducing-file-based-agents)
- [Workflow time travel](https://mastra.ai/docs/workflows/time-travel)

## Current read

The obvious runtime lessons are already present. Push has typed runtime events,
approvals, durable sessions, reconnect snapshots, task graphs, role-constrained
delegation, correlation/runtime context, and durable Coder suspension. Mastra
mostly validates those choices rather than supplying the next project.

The remaining useful lessons are about making that runtime easier to configure,
consume, evaluate, and recover.

| Rank | Mastra pattern | Push decision |
|---|---|---|
| 1 | Conventional config separated from instructions, with explicit code registration for dynamic cases | **Borrow the restraint now.** One typed loader owns precedence and provenance; `PUSH.md` remains instructions, not executable policy. |
| 2 | Deterministic gates separated from probabilistic scores, collapsed into one verdict | **Borrow next.** Evaluate `push.runtime.v1` receipts with code-only gates before considering model judges or a dataset service. |
| 3 | Fine-grained controller events plus one coalesced display snapshot | **Fold into machine-interface step 3.** Define a versioned shared `SessionView`/`RunView` reducer instead of letting each client reconstruct status. |
| 4 | Fresh-context and forked-context subagent modes | **Measure before adopting.** Make context transfer explicit only if prefix-cache and quality telemetry justify it. |
| 5 | Snapshot-backed workflow time travel | **Defer literal replay.** First expose checkpoint inspection; code-agent filesystem and Git side effects make blind step replay unsafe. |

## 1. Config loader: borrow the restraint, not the directory zoo

Mastra's file-based agents keep configuration, instructions, tools, skills,
memory, and subagents separate, while retaining code registration for cases that
need dynamic behavior. The useful principle is that convention should be
conservative and explainable.

For Push:

- configuration values and model instructions remain distinct;
- one resolver owns ordered layers and records the winning source for every
  leaf;
- file discovery stays explicit and conservative;
- project configuration cannot silently repoint credentials or loosen policy;
- dynamic subsystems consume the resolved contract rather than scanning files
  independently;
- `push config explain` reports effective values and provenance without secret
  values.

The implementation sequence is deliberately incremental:

1. **Foundation:** user config `<` environment `<` validated CLI overrides,
   with a pure merge/provenance engine and one runtime read path.
2. **Profiles:** named user profiles become a layer rather than a separate
   loader.
3. **Trusted project layer:** project/subdirectory config is inert until trust
   is explicit and is structurally unable to set credentials or loosen managed
   constraints.
4. **Managed policy:** tighten-only system/team constraints sit above user
   preference but remain distinguishable in provenance.
5. **Consumers:** MCP, hooks, permissions, providers, and sandbox settings all
   read the same resolved contract.

This is substrate #2 in
[`Codex CLI Structural Backend Gap Analysis.md`](<Codex CLI Structural Backend Gap Analysis.md>).

## 2. Evaluation receipts over `push.runtime.v1`

Mastra's cleanest evaluation idea is the vocabulary split:

- **gates** are deterministic invariants and must pass;
- **scores** measure quality or efficiency against thresholds;
- one verdict distinguishes failure from a non-blocking score miss and a full
  pass.

Push should begin with a pure reducer over a saved JSONL run, not an evaluation
platform:

```bash
push run --jsonl ... > run.jsonl
push eval run.jsonl --policy ci.json
```

Initial gates can require a terminal `run_complete`, no malformed/tool-failure
events, successful acceptance checks, valid schema-constrained output, required
or forbidden tool behavior, and no unresolved approval or suspension. Scores can
report rounds, retries, duration, tokens, cost, and compactions. LLM-as-judge
scorers and hosted datasets are explicitly out of scope until a real consumer
needs them.

This follows the config loader because evaluation policies need the same
precedence and provenance contract; it directly compounds `--jsonl` and
`--output-schema`.

## 3. One public controller read model

Mastra's AgentController owns both typed activity events and a reducer-maintained
display snapshot. Push already has the ingredients: `push.runtime.v1`,
`get_session_snapshot`, workspace snapshot/delta events, approvals, and
background-work state.

When machine-interface step 3 versions the daemon/app-server protocol, define a
generated `SessionView`/`RunView` schema and a shared reducer in `lib/`. The web
app, TUI, attach client, and external consumers should render that view rather
than carrying independent interpretations of "running," "waiting," or
"suspended."

This is consolidation, not a second state system.

## 4. Explicit delegation context modes, only with evidence

Mastra distinguishes focused subagents with fresh context from forked subagents
that preserve the parent thread and prompt prefix. The latter can improve
continuity and prompt-cache reuse, but it also weakens role/tool isolation if
applied indiscriminately.

The Push-shaped experiment is an explicit internal choice such as
`curated | forked`, with telemetry for prefix identity, cached tokens, total
cost, and outcome quality. `curated` remains the default for constrained
Explorer/Coder briefs. A forked path is plausible only for same-role, usually
read-only work where continuity is the point. Do not ship the switch on cache
intuition alone.

## 5. Checkpoint inspection before time travel

Mastra can restart a workflow from a stored step. Push's task nodes can mutate a
working tree, create commits, or contact external systems; replaying a node
against drifted workspace state is not equivalent to replaying a pure business
workflow.

The safe first capability is read-only checkpoint inspection: node inputs,
outputs, workspace revision, suspension reason, and resume eligibility. A future
replay path must require a matching revision, an isolated worktree, or a node
declared read-only/idempotent. Automatic replay of arbitrary mutating nodes is
not part of the current plan.

## What not to build from this comparison

- A public SDK facade before an external consumer exists.
- Another generic workflow engine beside `lib/task-graph.ts`.
- A second approval or suspension vocabulary.
- A parallel runtime-context carrier.
- An observability platform merely because Mastra has one.

Mastra's value here is contract pressure: configuration should be explainable,
runs should be evaluable, client state should be reducible, delegation context
should be explicit, and recovery should respect side effects.
