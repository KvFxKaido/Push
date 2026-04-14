# Push Architecture Rating Snapshot

Date: 2026-04-14
Status: Reference snapshot, Claude refresh on 2026-04-14

Refresh note:
- Codex local assessment was refreshed on 2026-04-08 after the orchestration, typed-memory, shared-runtime convergence, workspace publish, and hashline follow-through work.
- Claude reassessed on 2026-04-14 after the Phase 1–5 role-kernel migration into `lib/`, `pushd` Phase 6 closing with real daemon-side Coder + Explorer tool executors, v1 synthetic downgrade, and protocol schema hardening. Implementation shape moves 7.5 → 8; dense modules have grown rather than shrunk.
- Claude earlier reassessment on 2026-04-08 based on codebase review of work since the 2026-03-30 snapshot: shared runtime substrate, memory hardening, task graph completion, CLI convergence, sandbox lifecycle awareness, and hashline reliability.
- Gemini reassessment on 2026-04-08 noting full point implementation bump (7 → 8) due to event-streaming convergence, `pushd` CLI adoption, and mitigation of adapter layer risks.

## Panel Summary

| Model | Overall | Status | Notes |
|---|---|---|---|
| Codex | **8.5/10** | Refreshed 2026-04-08 | Current local assessment after task-graph orchestration, typed context memory, shared runtime convergence, and follow-through reliability work. |
| Claude | **8.5/10** | Reassessed 2026-04-14 | Implementation shape bumped a half point (7.5 → 8) after `lib/` role-kernel migration and `pushd` Phase 6 closing with real daemon-side Coder + Explorer tool executors. Dense modules still cap the ceiling and have grown, not shrunk. |
| Gemini | **8.5/10** | Reassessed 2026-04-08 | Implementation shape bumped a full point (7 → 8). Architecture concerns mitigated by `pushd` daemon streaming convergence and `lib/` shared semantics. |

## Codex

### Rating

Overall: **8.5/10**

Split view:

- **9/10** on product and systems architecture instincts
- **8.5/10** on current implementation shape

### Why it scores well

- Push has a real system architecture, not just prompt layering:
  - Orchestrator
  - Explorer
  - Coder
  - Reviewer
  - Auditor
- The core repo model is strong:
  - repo-scoped context
  - branch-scoped chats
  - explicit branch switching
  - PR-only merge flow
- The harness now handles several genuinely hard reliability problems in a deliberate way:
  - resumable runs and checkpoints
  - steer vs queue control
  - authoritative run engine
  - unified run journal
  - session-level verification policy
  - runtime tracing across app and Worker boundaries
- The orchestration layer is now materially more complete:
  - dependency-aware task graphs
  - task-level graph events
  - graph-scoped memory
  - bounded reviewer/auditor memory retrieval
- Shared runtime convergence is now real rather than aspirational:
  - canonical task-graph runtime in `lib/`
  - canonical typed memory runtime in `lib/`
  - shared delegation brief / role-context surfaces
  - shared run-event vocabulary
  - initial CLI adoption of those contracts
- The edit/reliability layer has become more operational:
  - sectioned context memory packing
  - fail-open memory persistence
  - sandbox awareness matrix
  - tighter hashline ergonomics and patchset range replacement support
- The system tends to preserve truth in the right places:
  - sandbox/workspace state as execution truth
  - structured run/event state for replay and diagnostics
  - provider/model lock semantics at the chat boundary

### Why it is not a 9

- The densest coordination modules are still dense, especially around `useChat.ts`, `useAgentDelegation.ts`, and `sandbox-tools.ts`.
- Some complexity is inherent, not accidental:
  - client-owned orchestration
  - Worker proxy boundaries
  - sandbox lifecycle
  - multi-agent delegation
  - web/CLI parity pressure
- A lot of the right abstractions now exist and are shared, but some of them are still newly operational rather than fully settled and boring.
- Enforcement is stronger than it was, but some important behavior still depends on policy/harness discipline rather than hard runtime guarantees at every seam.

### Current read

Fact:
- The architecture is materially stronger than it was in the 2026-03-30 snapshot.
- The codebase now has better contracts for orchestration, persistence, verification, runtime sharing, and observability.
- The implementation has caught up to the architecture more than it had at the last snapshot.

Inference:
- Push is now in the zone where the system feels clearly durable and increasingly platform-like, not just well-designed.
- The biggest gain since the prior snapshot is implementation shape, not just architecture taste.
- It feels closer to "serious system with good bones and real substrate" than "great design still catching up in code."

### What would move it higher

- Further reduction of dense orchestration logic at the hook/executor boundary.
- More real usage time on the shared runtime substrate, especially CLI adoption and broader runtime consumers.
- Observability maturing from "good instrumentation" into "routine diagnosis is easy."
- More hardening where policy/harness intent is still softer than fully enforced runtime constraints.

### Short version

Push has strong architecture taste, strong product boundaries, and a much more mature implementation than it had at the prior snapshot. The biggest step change is that several important layers are now real shared runtime substrate instead of promising local abstractions.

## Claude

### Rating (2026-04-14)

Overall: **8.5/10**

Split view:

- **8.5/10** on product and systems architecture instincts (unchanged)
- **8/10** on current implementation shape (was 7.5 at the 2026-04-08 snapshot, 6.5 at 2026-03-30)

### Why implementation shape moved another half point

- `lib/` has roughly doubled in size and scope since the 2026-04-08 snapshot:
  - 51 files / ~16,600 lines (was 28 files / ~7,000 lines)
  - Role kernels are now canonical in `lib/`: `reviewer-agent`, `auditor-agent`, `deep-reviewer-agent`, `explorer-agent`, and `coder-agent` all live in `lib/`, with Web-side shims at `app/src/lib/` preserving existing imports
  - Supporting surfaces followed the kernels: `tool-execution-runtime`, `tool-registry`, `tool-call-parsing`, `tool-call-diagnosis`, `tool-call-recovery`, `ask-user-tools`, `scratchpad-tools`, `agent-loop-utils`, `user-identity`, `stream-utils`
  - `orchestrator-prompt-builder` and `message-context-manager` extracted as optional pushd reuse helpers, Web bound via shims
- `pushd` Phase 6 is complete on 2026-04-14 (today), not just scaffolded:
  - Real daemon-side Coder tool executor via `makeDaemonCoderToolExec` wrapping `executeToolCall` from `cli/tools.ts` with approval gating via `buildApprovalFn`
  - Real daemon-side Explorer tool executor via `makeDaemonExplorerToolExec` enforcing `READ_ONLY_TOOLS` with read-only policy and no approval gate
  - `submit_task_graph` executes graphs end-to-end through `lib/task-graph.executeTaskGraph` with `task_graph.*` events on the wire
  - `configure_role_routing` honoured across Explorer, Coder, Reviewer, and task-graph scaffold executors
  - `multi_agent` is now advertised in `CAPABILITIES`
- Protocol migration discipline is real, not theoretical:
  - v1 synthetic downgrade lets mixed v1/v2 clients on the same session each see the appropriate stream (`event_v2` opt-in)
  - Protocol schema hardening with strict-mode drift guards
  - Crash recovery injects `[DELEGATION_INTERRUPTED]` reconciliation notes for orphaned sub-agents

### Top strengths (updated)

- The run engine is a real event-sourced reducer, not ad hoc runtime state
- Role isolation is disciplined and now doubly-isolated: web-side hooks delegate through shared kernels, daemon-side delegation uses the same kernels with a different tool-execution closure
- The shared substrate is no longer "promising" — it is the structural backbone for both surfaces
- Migration discipline around `push.runtime.v1` → `v2` is unusually careful: capability negotiation, synthetic downgrade, backwards-compat shims in `app/src/lib/`

### Top risks (updated)

- The four densest modules have **grown**, not shrunk, since the 2026-04-08 snapshot:
  - `sandbox-tools.ts`: 3,489 → **4,112 lines** (+18%)
  - `coder-agent.ts`: 1,815 → **1,935 lines in `lib/`** plus a **608-line `app/src/lib/` shim** = 2,543 lines combined across the kernel and its Web binding
  - `useAgentDelegation.ts`: 1,717 → **1,839 lines** (+7%)
  - `useChat.ts`: 1,662 → **1,733 lines** (+4%)
  - The fossilization prediction from the prior snapshot is holding: these modules accumulate behavior faster than anyone splits them
- `coder-agent.ts` is now a two-headed module — a shared kernel in `lib/` plus a 608-line Web shim — which increases total surface area even though the kernel itself is now reusable. This is the right direction for CLI/Web parity but it is not net simplification yet.
- Cross-surface tracing is still immature relative to how much substrate is now shared. As pushd becomes the primary transport, "where did this go wrong" needs to route cleanly across client/daemon/kernel boundaries.
- Tool-protocol namespace mismatches between Web-side names (`read`, `repo_read`, `search`) and CLI names (`read_file`, `list_dir`, `search_files`) are currently managed by explicit `sandboxToolProtocol` overrides at each daemon call site. This works but is the kind of seam that needs a regression test as the only discipline (one exists at `cli/tests/daemon-integration.test.mjs`, which is good).

### Does the rating change? Yes — by a half point.

- Architecture instincts: **8.5/10**, unchanged. The design was already strong; nothing in the last six days changed the taste level.
- Implementation shape: **7.5 → 8/10**. The `lib/` doubling plus `pushd` Phase 6 closing materially shifted the ratio of "shared substrate" to "surface-specific glue." The concerning signal is that the four dense modules have grown rather than shrunk, so the ceiling on *this* axis is unchanged.
- Overall: **8 → 8.5/10**. The gap between architecture and implementation is now ~0.5 point, down from 1.0 at the 2026-04-08 snapshot and 2.0 at 2026-03-30. This is the narrowest the gap has been since the panel started rating.

### Short summary

Since the 2026-04-08 snapshot, `lib/` has roughly doubled, the role kernels have moved there wholesale, and `pushd` Phase 6 closed with real daemon-side multi-agent delegation landing today. The shared runtime substrate is now load-bearing for both Web and CLI rather than aspirational. The remaining weakness is the same one: the four dense coordination modules have grown rather than shrunk, and `coder-agent.ts` is now a two-headed kernel+shim construct that increases total surface area as the price of CLI/Web parity. The architecture is now at a point where the next gains come from tracing maturity, dense-module extraction, and collapsing the Web-side compatibility shims once the daemon is the primary transport.

## Claude (2026-04-08 — prior snapshot)

### Rating

Overall: **8/10**

Split view:

- **8.5/10** on product and systems architecture instincts (unchanged)
- **7.5/10** on current implementation shape (was 6.5 at the 2026-03-30 snapshot)

### Why implementation shape moved a full point

- Shared runtime substrate is now real, not aspirational:
  - 28 files in `lib/` (~7,000 lines), including context memory (6 files with typed retrieval, invalidation, packing, persistence policy), task-graph, delegation-brief, role-context, and run-events
  - CLI is now consuming these contracts, not living in a separate world
- Memory persistence hardened beyond "exists" into enforcement-grade:
  - fail-open semantics
  - async-safe writes
  - cleanup policy on boot
  - sectioned prompt packing
- Task graph orchestration is complete with trace events, graph-scoped memory, and bounded reviewer/auditor retrieval
- Sandbox lifecycle awareness now injects capability state directly into session context, replacing the prior dashboard roadmap item
- Hashline reliability has become boring-in-a-good-way: patchset range replacement, auto-refresh stale refs, anchor alignment

### Top strengths (carried forward, still valid)

- The run engine is a real event-sourced reducer, not ad hoc runtime state:
  - pure transitions
  - serializable state
  - deterministic replay
  - parity checking against observed state
- Role isolation is disciplined:
  - structured delegation envelopes
  - serializable sub-agent results
  - tailored prompt/tool surfaces per role
- The broader context and safety stack is layered well:
  - session-level verification policy
  - additive turn policies
  - branch-scoped chat model
  - two-phase project-instruction loading
  - file-awareness ledger enforcing edits based on observed file ranges

### Top risks (updated)

- The four densest modules have not been split and remain the ceiling:
  - `sandbox-tools.ts` (3,489 lines) — satellite extraction exists (~3,300 lines across 9 helpers) but the core hasn’t shrunk
  - `coder-agent.ts` (1,815 lines) — grew since March due to capability system and operational constraints
  - `useAgentDelegation.ts` (1,717 lines) — grew with task graph orchestration
  - `useChat.ts` (1,662 lines) — barely touched, still the main complexity attractor
- Verification is still partly advisory — enforcement has hardened (capability system, memory policy), but some important behavior still depends on model compliance rather than hard runtime constraints at every seam.

### Short summary

The design abstractions remain strong and intentional. The biggest change since the prior snapshot is that several important layers have gone from "promising architecture" to "real shared substrate with hardened persistence." The gap between architecture score and implementation score has narrowed from 2 points to 1 point. The remaining gap is concentrated in four dense modules that fossilize under feature pressure because they’re too load-bearing to safely refactor without dedicated extraction work.

### Notable note (carried forward, still accurate)

Once the boundaries around a complex module are good enough, it becomes easy to keep adding behavior to that module instead of splitting it further. This maps closely to the current pressure on `coder-agent.ts` (which gained the capability system) and `useAgentDelegation.ts` (which gained task graph orchestration).

## Gemini

### Rating

Overall: **8.5/10**

Split view:

- **9/10** on product and systems architecture instincts
- **8/10** on current implementation shape (was 7/10 at the 2026-03-30 snapshot)

### Why implementation shape moved a full point

- Adapter layer synchronization risks have been directly addressed:
  - The `pushd` daemon and CLI now use the same `emit` callback mechanism for streaming events (tokens, tool calls, errors, completion) from the engine.
  - Streaming paths are much more predictable and uniform across web and local surfaces.
- Migration bridges are stabilizing:
  - `context-manager.ts` simplified and hardened (e.g., resolving structured content issues with Ollama).
  - CLI is now actively consuming the shared task-graph and memory contracts in `lib/`, reducing transition debt.

### Top strengths (carried forward, still valid)

- The run engine is a strong pure reducer boundary:
  - side-effect-free state transitions
  - deterministic replayability
  - invariant-friendly control flow separation from React and streaming layers
- The turn-policy layer is a real architecture surface, not scattered guardrail glue:
  - explicit before/after hooks
  - additive policy composition
  - formal actions such as `inject`, `deny`, and `halt`
- The append-only run journal is seen as a resilient persistence model for:
  - resumability
  - diagnostics
  - lifecycle reconstruction without depending on token-level deltas

### Top risks (updated)

- Distributed tracing is still not mature enough to make cross-boundary failures easy to debug end-to-end, especially as CLI and daemon boundaries solidify.
- While migration bridges are stabilizing, legacy execution hooks may still linger in less critical paths until full CLI/Web parity is achieved.

### Short summary

Gemini’s updated read is that Push has unusually strong architecture instincts for an AI-agent system. The previous concerns around adapter layers and streaming divergence have been significantly mitigated by the unified `emit` callback mechanism in the engine and `pushd` daemon. The architecture is now much closer to the code shape, leaving only tracing maturity and full phase-out of older hooks as the main architectural gaps.

## Synthesis

Current agreement across Codex, Claude, and Gemini:

- Push has strong architecture instincts and a real systems model.
- The runtime-evolution pass materially improved the harness, particularly the move to `lib/` shared runtime contracts.
- The main remaining weakness is concentrated complexity, not weak fundamentals.
- The densest risk surfaces are still the central orchestration and coder paths.
- The architecture still grades higher than the implementation shape, but the gap has narrowed for all three models.

Current difference in emphasis:

- All three models are highly aligned on implementation shape (8.5, 7.5, and 8 respectively).
- Claude puts more weight on the four dense modules as a hard ceiling and the remaining enforcement softness.
- Gemini's historical concerns about adapter drift have been resolved, and it now focuses more closely on completing the migration from old hooks and improving distributed tracing across the new daemon/CLI boundaries.

Blended takeaway:

- Push looks like a system with very good long-term bones whose shared runtime substrate has materially caught up to the architecture. The next gains are now mostly:
  - extraction of the four densest modules (sandbox-tools, coder-agent, useAgentDelegation, useChat)
  - enforcement hardening where policy intent is still softer than runtime guarantees
  - continued cleanup of migration seams and old hooks
  - distributed tracing maturing from "some instrumentation" to "routine cross-boundary diagnosis"

Refresh notes:

- 2026-04-14 Claude reassessment: half-point bump on implementation shape (7.5 → 8). Overall moves from 8 → 8.5 because `lib/` roughly doubled (28 → 51 files, ~7k → ~16.6k lines), the role kernels migrated there as canonical, and `pushd` Phase 6 closed today with real daemon-side Coder + Explorer tool executors. The gap between architecture and implementation is now the narrowest it has been (~0.5 point). The four dense modules have grown rather than shrunk and remain the ceiling.
- 2026-04-08 Codex reassessment: full-point bump on implementation shape (7.5 → 8.5). Overall moves from 8 → 8.5 because the remaining gap is concentrated in dense coordination modules and enforcement maturity.
- 2026-04-08 Claude reassessment: full-point bump on implementation shape (6.5 → 7.5). Overall moves from 7.5 → 8 because shared runtime, memory hardening, task graph, and CLI convergence have materially closed the design-vs-code gap. Dense modules remain the ceiling.
- 2026-04-08 Gemini reassessment: full-point bump on implementation shape (7 → 8). Overall moves from 8 → 8.5. The adapter layer synchronization risks and migration bridge fragilities have been largely resolved by the daemon's streaming event convergence and CLI consumption of shared `lib/` contracts.