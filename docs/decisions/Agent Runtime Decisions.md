# Agent Runtime Decisions

Status: **Current**
Reviewed: 2026-06-12

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
- **Inline is the default (flipped 2026-06-11).** `delegation-mode-settings.ts`
  defaults to `inline`; an explicit `delegated` storage value opts back into
  the wrapper arc.
- **The Orchestrator role/loop is still load-bearing — do not prune it.**
  `resolveTurnEngineTrigger` (`delegation-mode-settings.ts`) returns `null`
  (→ foreground Orchestrator loop, prompt built at runtime by
  `buildOrchestratorBaseBuilder` in `app/src/lib/orchestrator.ts`) on three
  live triggers: (1) **conversational lead turns with a repo** — the
  `conversationalTurn` downgrade in `chat-send-background.ts` deliberately keeps
  chat replies ("what changed recently?") off the Coder kernel's
  no-fake-completion guard; (2) **no-repo workspaces** (chat / scratch /
  local-pc), which are never inline-eligible; (3) the **`delegated` opt-out**.
  Only the Orchestrator→Coder *wrapper/Planner* arc is slated for deletion
  below — the lead loop itself stays until those three triggers are re-homed.
  (Correction: an earlier note here claimed attachment turns force the
  Orchestrator loop. They don't — attachments set `conversationalTurn=false`,
  so they route to the inline lane and are carried into the kernel as multipart
  content; see the dispatch table in `delegation-mode-settings.ts`.)
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
- Pending: delete the Planner/brief (the delegated arc's wrapper). Two
  prerequisites the deletion PR must clear: attachments on the engine
  envelope (or an explicit attachments story), and a bake period on the
  inline default to catch UX regressions the eval can't see (JobCard-first
  presentation, the one-active-job send lock).
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

### 10. Every surface is the same conversational lead; local surfaces add reach

The collapse in §2 is the product model for **every** surface, not a web-only
default. Web, TUI, and the local daemon should all present **one agent you
talk to** — the single conversational lead (phase-first status, no
brief/Orchestrator ceremony) — and differ only in *reach*. The CLI/daemon is
that same lead with a bigger tool surface precisely because it runs locally:
the real filesystem, a real shell with no sandbox token or 30-minute expiry,
the persistent daemon for long-running and background work, and direct machine
access. The target is "feels like the app, with more capabilities" — not a
different interaction model per surface.

Current state / gap: the web `inline` lane is the collapsed lead today
(`app/src/hooks/chat-send-inline.ts` plus the kernel's `leadMode` option — see
[`Inline Foreground Lane`](<../archive/decisions/Inline Foreground Lane — Local While Watched.md>)).
On the CLI, the first convergence step landed 2026-06-12: interactive turns
(TUI + daemon `send_user_message`) default to the single lead in-loop —
`runAssistantTurn` no longer runs the Planner pre-pass or the subagent
ceremony unless `delegationMode: 'delegated'` / `PUSH_DELEGATION_MODE=delegated`
opts back in (the interactive analog of headless `--delegate`, sharing the
web preference's opt-in rule via `lib/delegation-mode.ts`). The second step
landed the same day as an opt-in lane: `cli/lead-turn.ts` runs the terminal
turn as a `leadMode: true` run of the **shared** coder kernel — same kernel +
lead framing as the inline lane, assembled with the CLI's local reach
(`executeToolCall` against the real filesystem, the CLI provider streams, the
existing approval/Auditor gates) and speaking the engine's existing event
vocabulary so the TUI/REPL/daemon clients render it unchanged. Routing lives
at the `runAssistantTurn` seam; the kernel lane has been the **default**
since 2026-06-12, with an exact `leadRuntime: 'engine'` /
`PUSH_LEAD_RUNTIME=engine` opting back into the CLI-local loop while the
lane bakes (mirroring the web's preference-then-default arc). Remaining:
retire the engine loop's duplicated round machinery once the lane has baked;
the daemon's delegated task-graph nodes keep the implementer prompt by
design (they are delegations, not the lead).

The inline lead is not delegation-free: it wires a narrow, **Explorer-only**
delegation arc (`delegate_explorer` via the kernel's `extraToolSources` /
`executeExtraToolCall` seam, executed by `runInlineExplorerDelegation` in
`app/src/lib/inline-coder-run.ts`). The lead stays the implementer — it does
its own coding and `delegate_coder` / `plan_tasks` are refused — but it can
offload read-only investigation when a question spans many files, and fan out
up to two Explorers concurrently in one turn. This rides an opt-in
parallel-delegation bucket in the shared grouper
(`lib/tool-call-grouping.ts:maxParallelDelegations`, default-disabled so the
Orchestrator and CLI surfaces are unchanged) which the Coder kernel executes
in its read-phase `Promise.all`. `delegate:explorer` is part of the
lead-capable `coder` grant; the empty `extraToolSources` on a delegated
sub-Coder keeps the same call refused at the source gate.

**Conversational-lead convergence (next step toward deleting the routing fork).**
Repo-backed *conversational* turns are still downgraded to the Orchestrator loop
(`chat-send-background.ts`: `inlineEligible = repoBranchReady &&
!conversationalTurn`) because the inline lead is the Coder kernel in a lead
costume — conversation is suppressed (via `taskInFlight`, post-kernel criteria
gating, prompt overrides), not natively supported. The plan to make the lead
conversation-first and retire the downgrade — with a full parity matrix of what
a conversational turn must not lose (chiefly **full conversation history**: the
inline lane today passes only the last 6 turns × 700 chars, vs the Orchestrator's
managed transcript + session digest + memory injection; plus linked-library
content) — lives in
[`../runbooks/Conversational Lead Convergence.md`](<../runbooks/Conversational Lead Convergence.md>).
Phase 0 landed: the cognitive-drift guard is now gated on `taskInFlight === false`
(the last coder-policy guard that could misfire on a chat reply, mirroring the
no-fake-completion guard). Phase 1 landed: conversational inline turns now seed
the kernel from managed transcript messages and linked-library context instead
of collapsing history into the bounded task preamble. Phase 2 landed: the Coder
kernel now carries the remaining policy/observability/tool parity needed before
the flip — trailing-action-intent nudges in `coder-policy.ts`,
reasoning-channel buried-tool recovery in `lib/coder-agent.ts`, scratchpad/todo
tool wiring for the inline lead, per-round `assistant.turn_start/end`, and
`tool.call_malformed` events for dropped candidates. The routing flip remains
Phase 3 work and must still be gated/compared; `delegation-mode-settings.ts` /
`chat-send-background.ts` are intentionally unchanged here.

Protected during convergence: the shared runtime semantics in §1 (one kernel,
drift tests), the durable job engine, and the safety/Auditor boundary — the
local lead still goes through the same gates, just without the sandbox's
constraints.

## Active Runtime Work

1. Delete the Planner/brief now that inline is the measured default (2026-06-11); attachments-on-engine-envelope is the prerequisite.
2. Ship auto-branch-on-commit as the universal commit-flow for scratchpad work.
3. Decide scratchpad durable-storage substrate per platform.
4. Finish TUI daemon-session controller extraction.
5. Graduate loop detection enforcement only after telemetry supports thresholds.
6. Decide whether memory Phase 3 immutable verbatim logs are worth the storage cost.
7. Promote the diff/annotation envelope only when a roadmap item needs it.
8. Converge the CLI/daemon terminal chat onto the single conversational lead (a `leadMode` run of the shared kernel), so the TUI feels like the app with local reach (§10) instead of the delegated org-chart model. Step 1 landed 2026-06-12: interactive turns default to the in-loop lead with the Planner wrapper behind `PUSH_DELEGATION_MODE=delegated`. Step 2 landed 2026-06-12: the lead-kernel lane (`cli/lead-turn.ts`) runs the turn on the shared kernel in `leadMode`. Step 3 landed 2026-06-12: the lane is the **default**; `PUSH_LEAD_RUNTIME=engine` is the exact-match opt-out while it bakes. Remaining: retire the engine loop's duplicated round machinery once the lane has baked.

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
