# `pushd` Decomposition Plan — Thin Spine, Typed Modules

Date: 2026-07-15
Status: **In progress** — Phases 1–4 implemented; Phase 5 started; Phases 6–7 not started.
Owner: Push CLI

## Why this exists

`cli/pushd.ts` is an approximately 8,300-line daemon entrypoint that currently
owns transport setup, process lifecycle, session state, request dispatch,
remote-device administration, file operations, role routing, and all daemon-side
delegation flows. Its section markers expose real seams, but the file still makes
unrelated changes collide and leaves the module under a file-wide `@ts-nocheck`.

The goal is to turn `pushd.ts` into a small, typed composition root and stable
public facade while moving behavior into modules with explicit ownership. This is
a behavior-preserving TypeScript refactor, not a runtime rewrite.

## Current shape

The line ranges below are a 2026-07-15 survey, not permanent coordinates:

| Area | Approximate lines | Current responsibility |
|---|---:|---|
| Bootstrap, audit, and relay lifecycle | 1–741 | Imports, daemon globals, audit routing, relay allowlist and connection state |
| Utilities and session runtime | 742–1293 | Socket paths, IDs, envelopes, restart policy, attach validation, active-session registry, approvals, event fan-out |
| Core session/run handlers | 1294–2804 | Hello, drain/lifecycle, session start/attach/snapshot, workspace state, approvals, cancel/abort |
| Role routing | 2805–3107 | Role configuration and session-state broadcast |
| Delegation | 3108–6050 | Tool executors, task graphs, event replay, child sessions, and four delegate verbs |
| Remote execution | 6051–6248 | Remote-session `sandbox_exec` handling |
| File operations | 6249–6729 | Authorized reads/writes/listing/diff and daemon identification |
| Device and daemon administration | 6730–7635 | Device/attach tokens, relay control, pairing, runtime config, provider reload |
| Daemon spine | 7636–8343 | Dispatcher, local connection handling, semantic crash recovery, startup, shutdown |

The section boundaries are useful, but they are not all module boundaries. In
particular, the current “utilities and session runtime” range combines pure
helpers with mutable registries and serialized event emission. Those have
different owners and should not move as one block.

## Goals

- Keep `cli/pushd.ts` as the daemon entrypoint and compatibility facade.
- Give mutable daemon state an explicit owning module.
- Enforce a one-way dependency graph with no imports back through the facade.
- Type each extracted boundary under the CLI's strict TypeScript configuration.
- Preserve request, response, event, persistence, replay, lifecycle, and audit behavior.
- Keep each extraction independently reviewable and green.
- Add a mechanical containment guard once the residual spine has stabilized.

## Non-goals

- Rewriting the daemon, CLI, relay, or supervisor in Go.
- Introducing a second implementation of shared runtime or safety policy.
- Changing protocol vocabulary, capability negotiation, event ordering, or
  downgrade behavior.
- Redesigning delegation, session recovery, relay authentication, or approval flow.
- Moving every existing `pushd-*.ts` sibling merely to make the tree symmetrical.
- Choosing an arbitrary line-count target before the coherent residual spine is known.

The Go question is already resolved by
[`Go Migration Assessment.md`](<../decisions/Go Migration Assessment.md>): Push
ships the TypeScript runtime as a Bun single executable, and duplicating the
shared runtime in Go would create a semantic and safety fork. Decomposition may
make process boundaries easier to see, but that is not its justification.

## Target architecture

The dependency direction is:

```text
cli/pushd.ts
  -> dispatcher / connection / startup wiring
    -> handler families and coordinators
      -> daemon-owned runtime services
        -> existing cli/ and lib/ kernels
```

No extracted module may import from `cli/pushd.ts`. Tests and external callers
may continue importing the established public helpers from `pushd.ts`; the facade
will re-export their implementations.

New internal orchestration modules should live under `cli/pushd/`. Existing
bounded siblings such as `pushd-ws.ts`, `pushd-device-tokens.ts`, and
`pushd-relay-client.ts` stay where they are unless a later change has an
independent reason to move them. This avoids a cosmetic rename wave.

Likely ownership areas are:

- **Protocol/runtime helpers:** paths, IDs, envelopes, restart predicates,
  normalization, and attach-token validation.
- **Session runtime:** active sessions, client registrations, approval ownership,
  broadcast/downgrade wiring, and serialized workspace-state emission.
- **Handler families:** session/run, role routing, remote execution, file
  operations, and device/daemon administration.
- **Delegation runtime:** tool executors, task-graph coordination, event replay,
  addressable child sessions, and delegate verbs.
- **Recovery:** orphan detection/reconciliation plus interrupted-run recovery.
- **Spine:** handler registration, transport connection wiring, process startup,
  and shutdown composition.

Names are provisional. State ownership and dependency direction are not.

## Extraction rules

### 1. Preserve the facade

Moving an exported helper must not force all consumers to change in the same PR.
`pushd.ts` re-exports it until there is a separate reason to narrow the public
surface. This keeps daemon tests and compiled entry behavior stable.

### 2. Move ownership, not just text

A mutable registry, timer, or callback chain moves with the operations that
maintain its invariants. Do not split state from its lifecycle or recreate the
same singleton in multiple modules.

Avoid solving every dependency with a catch-all `DaemonContext`. Prefer small
owned services or narrow dependency interfaces. A context object that exposes
the entire daemon merely turns the monolith into a distributed monolith wearing
a novelty hat.

### 3. Type the boundary honestly

New modules do not inherit the file-wide `@ts-nocheck`. Pure helpers should use
concrete input/output types immediately. Stateful extractions should first name
their shared entry, request, response, event, and callback contracts; explicit
`unknown` plus validation is preferable to implicit `any` at wire boundaries.

Typing is part of the cost, not a free side effect. If a stateful block cannot be
typed without redesigning behavior, split the contract work into a preceding PR
rather than mixing a semantic rewrite into the move.

### 4. Separate movement from behavior changes

An extraction PR should be mechanically recognizable as an extraction. Fixes or
redesigns discovered during the move land separately unless they are required to
preserve existing behavior. This keeps review evidence legible.

### 5. Preserve behavioral order

The following are contracts even where they are not fully expressed by types:

- auto-attach and first-request capability pinning;
- serialized workspace-state emission and teardown ownership;
- event persistence before/alongside client fan-out;
- v1/v2 downgrade behavior;
- approval timeout and cancellation resolution;
- drain, lifecycle-exit, and shutdown ordering;
- relay allowlist seeding before relay connection;
- crash-recovery reconciliation and restart-policy behavior;
- audit emission that never throws into the response path.

## Phased plan

### Phase 1 — typed pure leaves and facade pattern ✅ (2026-07-16)

Extract the lowest-risk helpers first:

- socket, PID, port, and log path resolution;
- request/approval ID generation;
- response and error-envelope construction;
- restart-policy predicates;
- provider-input normalization;
- attach-token validation helpers;
- pure orphaned-delegation detection and reconciliation-note formatting.

Keep compatibility re-exports in `pushd.ts`. This phase establishes import
direction, naming, type conventions, and test placement without moving mutable
daemon ownership.

### Phase 2 — self-contained execution handlers ✅ (2026-07-16)

Extract file operations and remote `sandbox_exec` handling. These families have
clear authorization and output-boundary seams and already have focused tests.
Keep path authorization, truncation limits, cancellation, and error payloads
with the handlers that enforce them.

The extraction keeps the dispatcher in `pushd.ts` and moves remote execution,
daemon identity, and file operations behind typed handler boundaries in
`cli/pushd/`. Shared handler context and audit provenance types live beside the
handlers; cancellation ownership remains with the daemon WebSocket state.

### Phase 3 — relay/device administration ownership ✅ (2026-07-16)

Give relay connection state, allowlist propagation, token administration, and
pairing flows an explicit coordinator boundary. Then move the associated request
handlers. Do not leave relay globals in the spine while moving only their verbs.

The relay coordinator now owns the live client, connection status, hashed phone
allowlist, relay cancellation state, session registrations, startup seeding, and
shutdown. Typed device-admin handlers own token mint/revoke, relay administration,
pairing bundles, session grants, and live-device listing. The spine supplies only
dispatch, session fan-out, and narrow WS/session registry accessors.

### Phase 4 — session runtime and core handlers ✅ (2026-07-16)

Extract active-session/client registries and their lifecycle operations before
moving session/run handlers. Preserve workspace-state serialization, auto-attach,
approval ownership, drain accounting, and shutdown traversal as one coherent
runtime contract.

Role-routing handlers can move once their session-state dependency is explicit.

`cli/pushd/session-runtime.ts` now owns the active-session and client registries,
capability-aware fan-out, approval waits, serialized workspace-state emission,
drain/idle lifecycle accounting, and shutdown traversal.
`cli/pushd/core-session-handlers.ts` owns the hello/ping and core session/run
verbs, reconnect reads, approval and parent-run cancellation, workspace-state
reads, and role-routing/session-state mutation. The module consumes the runtime
and relay coordinator through typed dependencies; it does not import back through
the facade. `pushd.ts` keeps compatibility facades for delegation and recovery
consumers until their later phases. The `abort` sugar stays in the facade for now
because it composes parent-run cancellation with Phase 5 child-delegation
cancellation.

### Phase 5 — delegation in internal slices 🚧 (started 2026-07-16)

Do not move the approximately 3,000-line delegation block as one PR. Split it
along its existing internal seams:

1. ✅ Coder/Explorer tool executors and shared run-event emission (2026-07-16).
2. Event replay, child-session descriptors, and child-session verbs.
3. Task-graph coordination and the Explorer/Coder/Reviewer delegate verbs.

Shared cancellation, parent-run correlation, persistence, and terminal-event
rules should have one owner across all delegate verbs.

Slice 1 is implemented in `cli/pushd/delegation-execution.ts`. It owns the
approval-bound Coder executor, the capability-gated read-only executor adapter,
and the persistence-before-broadcast bridge for role-kernel run events. The
facade keeps the established executor exports while task-graph and direct
delegation handlers consume the typed adapter factory.

### Phase 6 — recovery and final spine

Move semantic interrupted-run recovery behind a recovery module. Leave
`pushd.ts` responsible for composition:

- importing and registering handlers;
- creating local and optional WebSocket transports;
- initializing stores and runtime services;
- invoking recovery;
- composing orderly shutdown;
- exporting the stable test/public facade;
- running `main()` when invoked directly.

The final line count follows from that responsibility rather than leading it.

### Phase 7 — containment guard and status update

After the spine is stable:

- remove `@ts-nocheck` from `pushd.ts`;
- add a CLI structural test that caps the file near its new baseline with small
  headroom;
- optionally guard against internal modules importing back through `pushd.ts`;
- update this runbook's phase status in the same PR.

The existing ESLint `max-lines` precedent only covers the app. A focused CLI test
is the narrowest current enforcement mechanism because `pnpm run lint` does not
lint `cli/`. If CLI linting becomes a first-class repository command later, the
guard can migrate there.

## Test coupling that must be handled deliberately

The current suite contains both behavioral imports from `pushd.ts` and tests
that read its source text. During extraction:

- preserve public imports through facade re-exports;
- prefer behavioral assertions or imported registries over source scans;
- where a source scan remains valuable, point it at the owning module or a
  declared set of scan targets;
- do not weaken drift checks merely to make a move pass.

`daemon-integration.test.mjs` and `protocol-drift.test.mjs` are important
guardrails, but they do not by themselves prove lifecycle order, shutdown,
recovery, relay state, or every handler family.

## Validation for every extraction PR

Run the repository contract from `AGENTS.md`:

```bash
pnpm install
TMPDIR=/tmp TEMP=/tmp TMP=/tmp pnpm run test:cli && pnpm run test:mcp:github
pnpm run typecheck:all
```

Additionally, run `pnpm run format:check` (Biome). It is not part of the
`AGENTS.md` contract, but it is the only mechanical style gate that covers
`cli/` — `pnpm run lint` does not lint `cli/` — so extraction PRs, which move
TypeScript under `cli/`, run it explicitly.

During development, run the focused tests for the moved family first, followed
by the complete CLI suite. At minimum, the cumulative arc must continue covering:

- daemon helpers and socket paths;
- protocol drift and downgrade behavior;
- daemon integration and handler registration;
- file operations and cancellable execution;
- device administration, allowlists, and bearer grace;
- drain and lifecycle exit;
- delegation capability and event replay behavior;
- crash recovery and interrupted delegation reconciliation.

Also run `git diff --check` and inspect the moved diff for accidental behavior
changes that a green suite cannot prove absent.

## PR shape and estimate

Each PR should have one ownership claim, keep the daemon runnable, and leave the
branch independently green. Six to eight PRs is plausible for mechanical
movement; eight to twelve is a more honest planning range if strict typing
requires separate contract work. The count is guidance, not a reason to bundle
unrelated state into one review.

## Completion criteria

The arc is complete when:

- `pushd.ts` is a typed composition root and compatibility facade;
- extracted modules pass strict CLI typechecking without `@ts-nocheck`;
- mutable session, relay, delegation, and recovery state each have a clear owner;
- the module graph is one-way and free of imports back through `pushd.ts`;
- request/response/event behavior and lifecycle ordering remain unchanged;
- source-scanning tests follow the new owners instead of silently losing scope;
- the full CLI and repository contract passes; and
- a mechanical guard prevents the spine from re-accumulating handler logic.
