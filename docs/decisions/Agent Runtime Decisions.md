# Agent Runtime Decisions

Status: **Current**
Reviewed: 2026-06-11

This is the live decision surface for Push's agent runtime. Archived source
notes live in [`../archive/decisions/`](../archive/decisions/README.md).

## Operating Contracts

### 1. Shared runtime semantics, different shells

Push keeps agent-runtime semantics in shared `lib/` modules whenever web and
CLI both depend on the same vocabulary. Surfaces can differ in transport and
UX, but shared tools, capabilities, protocol envelopes, memory contracts, and
role vocabulary need one source of truth plus drift tests.

Source notes:
[`Web and CLI Runtime Contract`](<../archive/decisions/Web and CLI Runtime Contract.md>),
[`push-runtime-v2`](../archive/decisions/push-runtime-v2.md),
[`PushStream Gateway Migration`](<../archive/decisions/PushStream Gateway Migration.md>).

### 2. The Orchestrator is the capable lead

The default loop is read, edit, run, and ship in-loop. Delegation remains a
durable engine path, not the default mental model for ordinary work. The
current first-priority runtime track is to collapse the Orchestrator-to-Coder
wrapper while keeping the durable job engine, replay, checkpoints, safety
boundaries, and event compatibility.

Status:
- Roadmap-tracked: inline `delegation-mode` exists behind a flag.
- **Measured (2026-06-11, two runs): quality ties, the wrapper costs ~78%
  wall-clock and owns a unique failure mode** — v2 on fixed instruments:
  completion 11/12 both arms, median wall 33.3 s direct vs 59.3 s delegated,
  tool-error 17% vs 18%; delegated's failure was the handoff itself dying
  (2 m 26 s, zero tool calls), the second dead handoff across runs. The v1
  run's apparent direct-arm failures were instrument defects (cumulative CLI
  loop breaker + harness without `--allow-exec`), fixed in PR #886. Full
  12-task eval suite on zen/glm-5.1; results in
  `docs/measurements/delegation-collapse-ab/`, analysis in
  [`Durable Runs — Adopt-on-Silence`](<Durable Runs — Adopt-on-Silence.md>)
  §Delegation-collapse A/B.
- Pending: flip lead-drives-engine-inline to the default and delete the
  Planner/brief — the measurement gate is met; this is now runtime work.
- Protected: event compatibility, runtime safety boundary, progress/liveness.

Source notes:
[`Coder Delegation Collapse`](<../archive/decisions/Coder Delegation Collapse — Component Audit.md>),
[`Main as Scratchpad`](<../archive/decisions/Main as Scratchpad — Branch on Graduation.md>),
[`Role Display De-emphasis`](<../archive/decisions/Role Display De-emphasis.md>).

### 3. Runtime protocol is code-backed, not prompt-backed

Prompts describe cooperation; protocol correctness lives in code. The runtime
wire contract is `push.runtime.v1` with envelope validation in
`lib/protocol-schema.ts`, publishable JSON Schema generated from
`lib/protocol-json-schema.ts`, and drift tests for shared vocabularies.

The tool-call parser path is converged on the shared dispatcher. New tool/event
vocabularies need a canonical definition and a drift test in the same PR.

Source notes:
[`Tool-Call Parser Convergence Gap`](<../archive/decisions/Tool-Call Parser Convergence Gap.md>),
[`phase-5-tool-runtime-brief`](../archive/decisions/phase-5-tool-runtime-brief.md),
[`Phase 5 Handoff`](<../archive/decisions/Phase 5 Handoff - Task-Graph Extraction.md>).

### 4. Roles are runtime labels; display vocabulary is separate

Runtime roles stay precise: Orchestrator, Explorer, Coder, Reviewer, Auditor.
User-facing surfaces de-emphasize internal org-chart language through
`lib/role-display.ts`: Explorer/Coder render as workflow phases, Orchestrator
renders as Assistant in attribution, and Reviewer/Auditor keep names where
independent attribution is a trust signal.

### 5. Memory is typed, scoped, and selectively verbatim

Context memory is scoped by durable repo/branch/chat identity, not incidental
session IDs. Summary packing is the default. Lossless verbatim memory retrieval
has shipped through the deterministic expand/grep kernel, top-detail packing
override, and model-facing memory tools. Optional immutable verbatim logging and
broader prompt advertising remain draft/future work.

Source notes:
[`Context Memory and Retrieval Architecture`](<../archive/decisions/Context Memory and Retrieval Architecture.md>),
[`Lossless Verbatim Memory Retrieval`](<../archive/decisions/Lossless Verbatim Memory Retrieval (LCM).md>).

### 6. Prompt assembly is sectioned and inspectable

Prompt construction uses sectioned builders and prompt snapshots so debugging
can answer what reached the model without re-running composition. CLI and web
prompt-builder convergence has shipped for the core path.

Source notes:
[`Sectioned System Prompts`](<../archive/decisions/Sectioned System Prompts.md>),
[`CLI Prompt Builder Convergence`](<../archive/decisions/CLI Prompt Builder Convergence.md>).

### 7. Task graphs are goal-anchored, not decorative

`TaskGraphNode.addresses` ties graph nodes back to the user goal. Runtime
validation should reject missing goal anchors instead of relying on prompt
cooperation. Web shipped first; CLI parity is still a separate work item.

Source note:
[`Goal-Anchored Task Graph Layering`](<../archive/decisions/Goal-Anchored Task Graph Layering.md>).

### 8. Loop control is deterministic first, interactive only when useful

Push has exact-call and near-duplicate loop detection in shared code. The
similarity ladder is opt-in/dark by default and should graduate only with
telemetry. A future interactive escalation rung can ask the user before abort
on live surfaces; headless contexts should stay autonomous.

Source notes:
[`Loop Detection`](<../archive/decisions/Loop Detection — Near-Duplicate Layer.md>),
[`ZeroStack Cross-Reference`](<../archive/decisions/ZeroStack Cross-Reference — Interactive Loop Escalation.md>),
[`Kernel Progress Liveness`](<../archive/decisions/Kernel Progress Liveness.md>).

### 9. TUI decomposition targets orchestration, not leaf helpers

The remaining TUI complexity is command orchestration and daemon-session
lifecycle state. Phase 0 shipped the IO/dependency seam and headless harness.
Next extraction should put daemon session lifecycle in a controller module under
`cli/`, not `lib/`.

Source note:
[`TUI Decomposition`](<../archive/decisions/TUI Decomposition - Testability Seam and Daemon Session Controller.md>).

## Active Runtime Work

1. Make inline lead-driven engine mode the default after measurement.
2. Ship auto-branch-on-commit as the universal commit-flow for scratchpad work.
3. Decide scratchpad durable-storage substrate per platform.
4. Finish TUI daemon-session controller extraction.
5. Graduate loop detection enforcement only after telemetry supports thresholds.
6. Decide whether memory Phase 3 immutable verbatim logs are worth the storage cost.
7. Promote the diff/annotation envelope only when a roadmap item needs it.

## Archived Context Worth Knowing

Architecture/provenance:
[`Architecture Rating Snapshot`](<../archive/decisions/Architecture Rating Snapshot.md>),
[`Architecture Remediation Plan`](<../archive/decisions/Architecture Remediation Plan — Defusing the Big Four.md>),
[`useAgentDelegation Coupling Recon`](<../archive/decisions/useAgentDelegation Coupling Recon.md>),
[`useChat Regression Audit`](<../archive/decisions/useChat Regression Audit.md>),
[`Duplication and Structural Symmetry Analysis`](<../archive/decisions/Duplication and Structural Symmetry Analysis.md>).

Comparative/research:
[`Agent Tool Patterns`](<../archive/decisions/Agent Tool Patterns — Claude Code Cross-Reference.md>),
[`Claude Code In-App Patterns`](<../archive/decisions/Claude Code In-App Patterns — Lessons For Push.md>),
[`Copilot SDK Research`](<../archive/decisions/Copilot SDK Research.md>),
[`Hermes Agent`](<../archive/decisions/Hermes Agent — Lessons For Push.md>),
[`opencode SDK Review`](<../archive/decisions/opencode SDK Review.md>),
[`pi-mono Agent Loop Review`](<../archive/decisions/pi-mono Agent Loop Review.md>).
