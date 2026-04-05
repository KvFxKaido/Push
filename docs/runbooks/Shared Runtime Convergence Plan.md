# Shared Runtime Convergence Plan

Date: 2026-04-05
Status: **Historical, major convergence tranche shipped 2026-04-05**
Owner: Push
Origin:
- [Web and CLI Runtime Contract](../decisions/Web%20and%20CLI%20Runtime%20Contract.md)
- [Web–CLI Parity Plan](Web-CLI%20Parity%20Plan.md)
- [Context Memory and Retrieval Architecture](../decisions/Context%20Memory%20and%20Retrieval%20Architecture.md)
- [Task Graph Orchestration Plan](Task%20Graph%20Orchestration%20Plan.md)

## Why this plan exists

Push now has increasingly sophisticated runtime behavior:

- task graphs
- typed artifact memory
- invalidation and freshness
- sectioned prompt packing
- structured run phases and task-level events

Those were good system features, and they initially lived mostly on the web path.

That creates a growing tax when moving between web and CLI:

- the same product behaves differently in hard-to-predict ways
- runtime improvements must be remembered as "web-only" or "CLI-only"
- parity conversations become vague because the real question is not UI parity, but semantic parity

The decision note already sets the rule:

**web and CLI should be two shells over one runtime contract**

This runbook captured the implementation sequence for the first major convergence tranche. That tranche is now shipped; the remaining work is selective CLI follow-through rather than more broad semantic extraction.

## Goal

Reduce web/CLI cognitive drift by moving agent-runtime semantics into shared root `lib/` modules where that improves consistency, while preserving shell-specific UX and platform plumbing.

## Completion snapshot (2026-04-05)

- [x] Phase 0 started: created a shared `lib/runtime-contract.ts` seam for:
  - acceptance-criteria types
  - delegation outcome types
  - task-graph types
  - typed context-memory types
- [x] App runtime modules now consume that shared type seam:
  - `app/src/lib/task-graph.ts`
  - `app/src/lib/context-memory*.ts`
- [x] `app/src/types/index.ts` now re-exports the same runtime-contract slice so existing app imports continue to work.
- [x] Phase 1 complete: the canonical task-graph executor now lives in `lib/task-graph.ts`, with `app/src/lib/task-graph.ts` kept as a compatibility wrapper.
- [x] Phase 2 complete: the canonical typed-memory runtime now lives in shared `lib/context-memory*.ts`, with the corresponding `app/src/lib/context-memory*.ts` modules kept as compatibility wrappers.
- [x] Phase 3 narrowed and complete for Coder/Explorer: the shared delegation-brief formatter now lives in `lib/delegation-brief.ts`, while `app/src/lib/role-context.ts` remains the app-local wrapper for envelope-specific and Reviewer/Auditor context logic.
- [x] Phase 4 complete: the canonical run-event vocabulary now lives in shared `lib/runtime-contract.ts`, `lib/run-events.ts`, and `lib/run-engine-contract.ts`; `app/src/lib/chat-run-events.ts` is now a compatibility wrapper, and `app/src/lib/run-engine.ts` consumes the shared phase/event contract while keeping reducer/state logic local.
- [x] Phase 5 narrowed and complete for role prompts: the canonical reviewer/auditor context builders, request-intent hinting, and project-instructions sanitization now live in `lib/role-context.ts`, `lib/intent-classifier.ts`, and `lib/project-instructions.ts`; `app/src/lib/role-context.ts`, `app/src/lib/intent-classifier.ts`, and `app/src/lib/workspace-context.ts` keep stable app-facing wrappers and exports.
- [x] Track E adoption started: the CLI now consumes the shared delegation-brief formatter for headless `push run` task framing, and the CLI engine/session log emit shared `tool.*` and `assistant.turn_*` run-event names for core turn/tool lifecycle data.

## Non-goals

- Full feature parity between web and CLI
- Moving React hooks or terminal UI code into shared modules
- Rewriting the CLI around the web chat stack
- Making the CLI the solution to current PWA background execution
- Shipping every shared-runtime extraction before the CLI can benefit from any of them

## Decision boundary

### Share if it changes:

- how the agent reasons
- how the agent delegates
- what memory means
- what verification means
- what run phases and events mean
- what safety/approval contracts mean

### Keep local if it changes:

- how the shell renders or captures interaction
- transport and platform boundaries
- auth/connectors/config UX
- daemon attach and terminal ergonomics
- browser/mobile lifecycle behavior

## Current state

### Already shared

The repo already has a real shared-runtime base in root `lib/`:

- `lib/hashline.ts`
- `lib/tool-protocol.ts`
- `lib/error-types.ts`
- `lib/context-budget.ts`
- `lib/reasoning-tokens.ts`
- `lib/diff-utils.ts`
- `lib/working-memory.ts`
- `lib/runtime-contract.ts`
- `lib/task-graph.ts`
- `lib/context-memory.ts`
- `lib/context-memory-store.ts`
- `lib/context-memory-retrieval.ts`
- `lib/context-memory-invalidation.ts`
- `lib/context-memory-packing.ts`
- `lib/delegation-brief.ts`
- `lib/run-events.ts`
- `lib/run-engine-contract.ts`
- `lib/role-context.ts`
- `lib/intent-classifier.ts`
- `lib/project-instructions.ts`

This is the right pattern: shared semantics in `lib/`, shell-specific coordination in `app/` and `cli/`.

### Still app-local after the tranche

- `app/src/lib/role-context.ts` envelope-local delegation wrappers
- `app/src/lib/run-engine.ts` reducer/state model and app-local queue integration

These are no longer evidence that the semantic layer is missing. They are mostly shell-local boundaries and should stay local unless a later product need proves otherwise.

### Likely to remain shell-local

- `app/src/hooks/useChat.ts`
- `app/src/hooks/useAgentDelegation.ts`
- `app/src/hooks/chat-send.ts`
- `cli/engine.ts`
- `cli/pushd.ts`
- terminal UI modules under `cli/`

## Strategy

Do this in two layers:

### Layer 1 — Extract semantics first

Move pure runtime behavior into shared modules and keep the web app consuming them first.

This lowers the risk and creates a stable contract even before the CLI adopts the new behavior.

### Layer 2 — Adopt selectively in CLI

Only pull shared runtime pieces into CLI when they clearly improve the CLI's own north star:

- transcript-first local work
- headless task runs
- attach/resume flows
- stronger semantic consistency with web

This keeps the plan useful even if CLI remains intentionally narrower than web.

## Remaining follow-through after completion

The main extraction tranche is done. The live follow-up is now:

1. selective CLI adoption of typed memory/runtime features where it clearly improves the terminal product
2. deciding whether task graphs should become an active CLI feature, especially if local-model support becomes a first-class CLI direction
3. leaving shell-local reducers, hooks, and UI coordination local unless drift shows up again

## Workstreams

### Track A — Shared task-graph runtime

#### Objective

Move the task-graph executor and its pure helpers into shared `lib/` so task-graph semantics stop being web-only by construction.

#### Scope

- extract shared types if needed
- move validation and execution semantics into `lib/task-graph.ts`
- keep app-specific event emission and hook wiring local
- preserve current web behavior exactly

#### Likely touch points

- new `lib/task-graph.ts`
- `app/src/lib/task-graph.ts` as thin wrapper or re-export
- `app/src/hooks/useAgentDelegation.ts`
- `app/src/types/index.ts`

#### Exit criteria

- task-graph logic lives in shared runtime code
- web tests stay green without behavior drift
- CLI can import the executor later without re-porting the semantics

### Track B — Shared typed memory runtime

#### Objective

Move the typed artifact-memory system into shared `lib/`.

#### Scope

- `context-memory.ts`
- `context-memory-store.ts`
- `context-memory-retrieval.ts`
- `context-memory-invalidation.ts`
- `context-memory-packing.ts`

Keep storage adapters or shell-specific persistence hooks thin and local where needed.

#### Design note

This is one of the highest-value convergence moves because memory semantics are too central to let web and CLI drift.

#### Exit criteria

- record model, retrieval scoring, invalidation rules, and packing live in shared runtime code
- web remains the first consumer
- CLI can adopt retrieval without inventing a second memory model

### Track C — Shared delegation context contract

#### Objective

Move delegation-brief formatting and related pure context-packing logic into shared runtime code.

#### Scope

- extract from `app/src/lib/role-context.ts`
- preserve multiline memory sections and typed handoff blocks
- keep shell-specific calling conventions local

#### Exit criteria

- Explorer/Coder handoff semantics are canonical
- task-graph and direct delegation use the same shared brief rules
- CLI can opt into the same role context format later

### Track D — Shared run-event vocabulary

#### Objective

Extract the pure vocabulary for run phases and agent/task lifecycle events.

#### Scope

- shared phase names
- shared event discriminants and payload shapes
- minimal pure helpers for mapping transitions

Do **not** try to move the whole web run engine into shared code in this pass.

#### Exit criteria

- phase names and task/delegation event meanings are canonical
- web and CLI can produce/render equivalent runtime signals even if their local loops differ

### Track E — CLI adoption tranche

#### Objective

Adopt selected shared runtime pieces in CLI where they clearly improve the CLI product.

#### Initial candidate order

1. shared delegation context contract
2. shared run-event vocabulary
3. shared typed memory runtime
4. shared task-graph runtime

#### Important note

This order is not identical to the extraction order on the web path.

Extraction should follow "what is most purely semantic."
CLI adoption should follow "what most improves the CLI north star."

## Implemented sequence

If this work becomes active, the best order is:

### Phase 0 — Boundary cleanup and type prep

- identify app-local types that block extraction
- move or duplicate only the minimal shared type surface
- avoid dragging UI or hook concerns into root `lib/`

### Phase 1 — Extract task graph

Why first:

- highly semantic
- mostly pure already
- clear separation from UI
- strong signal value for the runtime-contract approach

### Phase 2 — Extract typed memory stack

Why second:

- central semantic layer
- currently one of the strongest app-only runtime systems
- likely to matter on both shells even if CLI stays narrower

### Phase 3 — Extract role context + delegation packing

Why third:

- unifies how work is handed off
- reduces silent drift in sub-agent prompting
- makes later CLI adoption less awkward

### Phase 4 — Extract shared run-event vocabulary

Why fourth:

- easiest to overscope if attempted too early
- better done after task graphs and memory define the real event shapes

### Phase 5 — Decide CLI adoption slice

At this point, choose intentionally:

- keep CLI lean and only adopt memory/event semantics
- or bring over shared delegation/task-graph runtime too

That should be a product decision, not an accidental consequence of extraction work.

## Risks and mitigations

### Risk: fake convergence

Moving code into `lib/` without actually clarifying the runtime contract can create shared confusion instead of shared clarity.

Mitigation:

- only extract modules that are genuinely semantic
- keep shell-specific coordinators local

### Risk: type gravity from app hooks

App-local types and helpers can drag React/hook assumptions into shared runtime code.

Mitigation:

- define narrow shared interfaces
- prefer adapters at the shell boundary

### Risk: CLI overreach

Trying to force full orchestration parity into CLI too early could distract from the CLI's real value.

Mitigation:

- separate semantic extraction from CLI adoption
- keep adoption as an explicit later choice

### Risk: test fragmentation

Shared runtime extraction can leave tests split awkwardly across app and CLI.

Mitigation:

- move pure tests with the shared modules
- keep shell-integration tests local

## Success criteria

This plan is working if:

- runtime improvements are first designed as shared-contract candidates
- the web app increasingly consumes shared semantic modules instead of owning them outright
- CLI adoption becomes an explicit product choice, not a reimplementation burden
- context switching between web and CLI requires less remembering of feature-by-surface differences

## Short version

The right next move is not blanket parity.

It is:

1. extract semantic runtime systems into shared `lib/`
2. keep shell coordination local
3. adopt shared pieces in CLI only where they strengthen the CLI's local-first north star
