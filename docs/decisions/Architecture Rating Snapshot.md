# Push Architecture Rating Snapshot

Date: 2026-04-17
Status: Reference snapshot, full panel refresh on 2026-04-17

Refresh note:
- **State update 2026-05-01** (no fresh panel refresh run yet — facts and line counts only):
  - **`useChat.ts` re-discharge — Waterbed Effect reversed.** The "ceiling ratcheted up" concern from the 2026-04-26 update is over. `useChat.ts` 1,450 → **892 lines** (−38.5%) across a multi-commit program: `prepareSendContext` / `acquireRunSession` / `finalizeRunSession` (2026-04-26, late), `queued-follow-up-utils.ts` and `chat-round-loop.ts` (2026-05-01), then today's three — `useConversationPersistence`, `chat-active-run-router`, `useChatAutoSwitch`. The ESLint `max-lines` cap on `useChat.ts` ratcheted from 1,400 → **1,060** (commit `0dcbbb3a`, 2026-04-28); current file leaves ~168 lines of headroom, so a further ratchet is justified. Net new test surface: ~30 cases pinning previously-uncovered behavior (retry-with-cap-at-3 in persistence, FIFO queue position math, the auto-switch state machine including the migration-marker gate). The "extraction discipline" the synthesis flagged as the next-jump condition is now demonstrated on the densest module — not just operationalized via the cap.
  - **Other Big Four — flat.** `useAgentDelegation.ts` 673 → **673** (unchanged), `sandbox-tools.ts` 670 → **670** (unchanged), `coder-agent.ts` 1,984 → **1,989** (+0.3%, structural). Total Big-Four surface 4,777 → **4,224 lines** (−11.6%). The `coder-agent.ts` permanent-boundary decision still holds (Remediation Plan §Step 5).
  - **What this does not yet move.** The synthesis-named "verification-family extraction from `sandbox-tools.ts`" remains undone — that's the panel's specific test of the handler-context pattern, not just any extraction. Today's work is "more of the right kind" but isn't the strategic landing. The score-relevant question for the next panel refresh: does multi-week, multi-PR discipline on `useChat.ts` count as evidence the pattern works, or does the credit wait for verification-family proof?
- **State update 2026-04-26** (no fresh panel refresh run yet — facts and line counts only):
  - **Cloudflare Sandbox provider v1 landed** (~2026-04-20) at `/api/sandbox-cf/*`, routed through the existing sandbox-provider abstraction. Known gaps: no owner tokens, no snapshots, `revision=0`. Doesn't move the architecture axis — parallel backend behind the same seam — but adds operational surface.
  - **Sandbox stall hardening complete** (PRs [#372](https://github.com/KvFxKaido/Push/pull/372)–[#382](https://github.com/KvFxKaido/Push/pull/382), 2026-04-24) plus the `/opt/push-cache` bake. The 100s cold-npm-install + stall pattern that was hurting reliability is closed; "edits vanishing" is the only remaining item from that cluster, pending snapshots.
  - **Cloudflare AI Gateway routing** (PRs [#419](https://github.com/KvFxKaido/Push/pull/419)/[#420](https://github.com/KvFxKaido/Push/pull/420)) consolidates provider traffic through CF AI Gateway and gives us a real log-inspection surface (now wired into the AI Gateway MCP).
  - **Context budget refactor** (PR [#421](https://github.com/KvFxKaido/Push/pull/421), 2026-04-26) replaces the per-model budget profile table with a catalog-driven formula (`max = 92% × window`, `target = 85% × window`). Adding a new model no longer requires editing `orchestrator-context.ts` for any provider with models.dev metadata; name-pattern fallback covers direct providers (CF / Vertex / Bedrock / Azure / Kilocode / OpenAdapter).
  - **Tool-call parser convergence — partial** (PRs [#422](https://github.com/KvFxKaido/Push/pull/422)/[#423](https://github.com/KvFxKaido/Push/pull/423), 2026-04-26) adds `lib/tool-call-namespaced-recovery.ts`, consumed by both the CLI shared kernel and the web grouping dispatcher. Recovers OpenAI-style `functions.<name>:<id> <args>` traces (the Kimi/Blackbox silent-drop pattern captured in session `sess_mogit6qt_447633`). Narrows the parity hole called out in `Tool-Call Parser Convergence Gap.md`, but does not unify the two dispatchers — that's still deferred.
  - **Dense modules — fossilization watch.** The "discharge" claim from the 2026-04-19 update is partially regressing under feature pressure: `useChat.ts` 1,365 → **1,450** (+6%, ceiling ratcheted up from 1,400 to match), `useAgentDelegation.ts` 490 → **673** (+37%), `sandbox-tools.ts` 475 → **670** (+41%), `coder-agent.ts` 1,935 → **1,984** (+3%, structural). The `useChat.ts` cap-ratchet going the wrong direction is the Waterbed Effect the Remediation Plan warned about — feature pressure is repopulating the modules the extraction work emptied. Worth flagging for the next panel refresh: the "Big One" framing from the late-2026-04-19 update may need to retrench to "Big Three regrowing." The structural fix (capping growth via fitness rules + co-extraction discipline) is now the gap, not the original extraction.
- **State update 2026-04-19** (no fresh panel refresh run yet — line counts only): `sandbox-tools.ts` discharged to **475 lines** (−88% from 4,112) via the 5-family extraction that completed on 2026-04-18. `useAgentDelegation.ts` discharged to **490 lines** (−74% from 1,883) via PRs [#335](https://github.com/KvFxKaido/Push/pull/335)–[#339](https://github.com/KvFxKaido/Push/pull/339) between 2026-04-18 and 2026-04-19. `useChat.ts` regression-audited at **1,733 lines** (`useChat Regression Audit.md`) — it regressed from the 2026-03-25 770-line baseline; a 4-phase re-extraction track is proposed but not yet started. `coder-agent.ts` unchanged and structural (resolved as permanent boundary per Remediation Plan §Step 5). The "Top risks" subsection's "four densest modules have grown, not shrunk" claim is discharged for two of the four modules; the next panel refresh should reassess implementation shape now that the "extraction earns the next real jump" condition two reviewers called out is partially met.
- **State update 2026-04-19 (late)** (no fresh panel refresh run yet — line counts only): `useChat.ts` re-extraction track **complete**. Hook discharged to **1,365 lines** (−21% from 1,733) via PRs [#340](https://github.com/KvFxKaido/Push/pull/340)–[#343](https://github.com/KvFxKaido/Push/pull/343) across 2026-04-19. Five new hook files own the previously-inline stateful clusters: `useQueuedFollowUps`, `useRunEventStream`, `useRunEngine`, `useVerificationState`, `usePendingSteer`. An ESLint `max-lines` guard on `useChat.ts` at 1,400 enforces containment at CI rather than review discipline — the Waterbed Effect risk the Remediation Plan warned about is now operationalized structurally. Three of the Big Four modules are now discharged (sandbox-tools, useAgentDelegation, useChat); only `coder-agent.ts` remains (structural per Remediation Plan §Step 5). The "Big Four" is effectively the "Big One." The "extraction earns the next real jump" condition all three reviewers flagged is now fully met for implementation shape. Audit's Open Question #3 (`sendMessage` decomposition) remains out of scope — it's a different refactor shape (function splitting, not stateful-cluster extraction) and is not part of this track. Next panel refresh should reassess ratings given three of four dense modules are now discharged.
- Claude reassessed on 2026-04-17 after remediation plan steps 1/5/6 landed (CorrelationContext contract, coder-agent permanent boundary, runtime role-capability enforcement) and Phases 4–5 test coverage shipped (313 new tests). Implementation shape moves 8 → 8.2; architecture holds at 9.
- Codex reassessed on 2026-04-17. Rating moves from 8.3 → **8.5/10**: architecture bumps to 9.1 (first time above 9 — `ROLE_CAPABILITY_DENIED` at execution layer makes capability enforcement substrate-grade), implementation 8.1 → 8.3. Conservative read: groundwork earns credit, extraction earns the next real jump.
- Gemini reassessed on 2026-04-17 and moves from 8.5 → **8.7/10**. Architecture holds at 9; implementation bumps 8.0 → 8.4. The 313 tests are a massive de-risking effort for the upcoming extraction; runtime enforcement at the execution layer shows defensive coding. Score can't jump to 9 until dense modules are actually extracted.
- Prior panel refresh on 2026-04-14 put the blended score at 8.4/10 after `lib/` role-kernel migration, `pushd` Phase 6 closing, and protocol schema hardening.
- Earlier 2026-04-08 assessments noted full-point implementation bumps across the panel after shared runtime convergence, memory hardening, task graph completion, and CLI convergence.

## Panel Summary

| Model | Overall | Arch | Impl | Status | Notes |
|---|---|---|---|---|---|
| Codex | **8.5/10** | 9.1 | 8.3 | Reassessed 2026-04-17 | Architecture above 9 for the first time — `ROLE_CAPABILITY_DENIED` at execution layer makes capability enforcement substrate-grade. Groundwork earns credit; extraction earns the next jump. |
| Claude | **8.6/10** | 9.0 | 8.2 | Reassessed 2026-04-17 | Runtime enforcement and 313 new tests are real implementation gains. Dense modules still the gravity well — `sandbox-tools.ts` weighs less but the shape hasn't changed. |
| Gemini | **8.7/10** | 9.0 | 8.4 | Reassessed 2026-04-17 | 313 tests are a massive de-risking effort; runtime enforcement at execution layer shows defensive coding. Score can't reach 9 until dense modules are actually extracted. |

## Codex

### Rating (2026-04-17)

Overall: **8.5/10**

Split view:

- **9.1/10** on architecture taste / system design (was 8.9)
- **8.3/10** on current implementation shape (was 8.1)

### Why the scores moved

The groundwork moves the implementation score modestly. The changes are
not just "planning" or "paper architecture" — they landed executable
boundaries: correlation context contract, passive observability pinning,
coder-agent dual-binding, and role-capability enforcement at the
execution layer before hooks/gates. That is real implementation shape
improvement because the architecture is now harder to accidentally
violate.

The architectural score moves to 9.1 because Push now has stronger
invariants around role boundaries, observability, and runtime authority.
`ROLE_CAPABILITY_DENIED` before hooks/gates makes capability enforcement
a substrate rule rather than a convention — this is the first time the
architecture axis crosses 9.

The 313 tests and branch coverage are meaningful, and `sandbox-tools.ts`
dropping 11% is directionally good. But the big-four modules are still
nearly 10k lines, and the key remediation steps — characterization tests,
tracing spine, and actual extraction — are still not done.

### The ceiling

Groundwork earns credit, extraction earns the next real jump. The ceiling
before extraction is probably around 8.5 overall / 8.4 impl. Once the
dense modules are carved along the now-formalized boundaries, 8.7–8.9
overall is realistic if the extraction preserves the tests and reduces
orchestration coupling rather than just moving code into smaller files.

### Codex (2026-04-14 — prior snapshot)

### Rating (2026-04-14)

Overall: **8.5/10**

Split view:

- **8.9/10** on architecture taste / system design
- **8.1/10** on current implementation shape

### Why the rating moved up honestly

The update is not about aligning with the panel. It changed because the refreshed snapshot adds stronger evidence on the architectural question that mattered most: whether the shared runtime is truly canonical across web and CLI, or still partly aspirational.

What materially changed that read:

- **Role kernels are canonical in `lib/` now**
  - `reviewer-agent`
  - `auditor-agent`
  - `deep-reviewer-agent`
  - `explorer-agent`
  - `coder-agent`

  That is stronger than shared utilities. It suggests the system’s core behavioral seams are converging at the right layer.

- **`pushd` Phase 6 is closed with real daemon-side executors**
  - real daemon-side Coder tool execution
  - real daemon-side Explorer tool execution
  - task graph execution end-to-end
  - capability advertising and routing

  That materially reduces the risk that web/CLI parity is still mostly conceptual.

- **Protocol compatibility and recovery work looks architecture-grade**
  - v1 synthetic downgrade
  - protocol schema hardening
  - interruption reconciliation for orphaned delegations

  Systems start to feel real when they solve mixed-version, failure, and recovery seams deliberately.

### Why it is still not a 9

- The densest coordination modules are still the ceiling, and the refreshed snapshot says plainly that some have grown rather than shrunk.
- Some guarantees are still softer than ideal and depend partly on policy/harness discipline instead of being fully runtime-hard at every seam.
- Cross-boundary diagnosis and tracing still sound like an area that is improving, but not yet effortless.

That keeps the score in the strong-8 range rather than 9+.

### Current read

Fact:
- Push has moved beyond “promising architecture waiting for the codebase to catch up.”
- Shared runtime convergence now appears structural, not just directional.
- The codebase looks more like a mature platform substrate with a few concentrated load-bearing hotspots.

Inference:
- The main architectural risk is no longer weak fundamentals.
- The remaining risk is concentrated complexity: orchestration density, enforcement maturity, and tracing maturity.
- That is a better kind of problem for a system at this stage.

### What would move it higher

- Defuse the densest orchestration modules rather than continuing to let them absorb feature pressure.
- Convert more policy-shaped invariants into hard runtime guarantees.
- Make cross-boundary debugging routine, especially as `pushd` becomes more central.
- Let the shared runtime substrate stay boring under more real usage time across both surfaces.

### Rating sentence

**Push now reads as a mature architecture with a few concentrated load-bearing hotspots, not an architecture that is still waiting for the implementation to catch up.**

## Codex (2026-04-08 — prior snapshot)

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

### Rating (2026-04-17)

Overall: **8.6/10**

Split view:

- **9/10** on product and systems architecture instincts (unchanged)
- **8.2/10** on current implementation shape (was 8.0 at the 2026-04-14 snapshot)

### Why implementation shape moved a quarter point

Three remediation plan steps landed since the prior snapshot, plus
significant test coverage:

- **CorrelationContext contract** (`lib/correlation-context.ts`, 319
  lines, 14 pinning tests). A canonical cross-surface correlation type
  with a hard rule: correlation fields are passive observability only
  and must never alter tool args, prompt text, daemon payloads, sandbox
  behavior, or gate business logic. This is good design hygiene — a
  real contract, not docs — but it is not a new architectural move.
- **Runtime role-capability enforcement** at the execution layer.
  Explorer mutation refused with `ROLE_CAPABILITY_DENIED` structured
  error *before* hooks, approval gates, and Protect Main run. 8 pinning
  tests. This converts a policy-shaped rule into a substrate guarantee —
  the kind of hardening the prior snapshot specifically called for.
- **Coder-agent boundary decision** resolved: the dual-binding shape is
  a permanent boundary, not a transition artifact. This removes an open
  question that was blocking `coder-agent.ts` extraction planning.
- **313 new tests** across components, hooks, MCP server (92% branch
  coverage), and CLI pure-logic. This is the safety net the remediation
  plan's characterization-test step was asking for — not the same thing
  (characterization tests pin specific behavior of the dense modules),
  but directionally aligned.

### Why it is still not an 8.5 on implementation

- `sandbox-tools.ts` shed 472 lines (4,112 → 3,640, -11%) but the
  shape is unchanged — it is still a single dispatcher with tool-family
  handlers inline. The weight dropped; the gravity well didn't.
- `useAgentDelegation.ts` grew +44 lines. `useChat.ts` and
  `coder-agent.ts` are flat. The fossilization pattern holds.
- The actual extraction (step 4 of the remediation plan) is not done.
  Neither are the prerequisite characterization tests (step 2) or the
  tracing spine pass (step 3).

The implementation score moves because the runtime enforcement and test
coverage are real gains, not because the dense module problem got easier.
The next jump requires the verification-family extraction to land and
the fitness rules from the remediation plan to hold.

### Claude (2026-04-14 — prior snapshot)

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
  - `orchestrator-prompt-builder` and `message-context-manager` extracted as optional `pushd` reuse helpers, Web bound via shims
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
- Cross-surface tracing is still immature relative to how much substrate is now shared. As `pushd` becomes the primary transport, "where did this go wrong" needs to route cleanly across client/daemon/kernel boundaries.
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

### Rating (2026-04-17)

Overall: **8.7/10** (up from 8.5)

Split view:

- **9/10** on architecture (holds)
- **8.4/10** on current implementation shape (up from 8.0)

### Why the score moved

The implementation score moves up. Shipping 313 new tests across UI,
MCP, and CLI is a massive de-risking effort that proves the safety net
required for the upcoming refactor is being built. Landing the runtime
role-capability enforcement deep at the execution layer (with regression
tests for edge cases like undefined hooks) shows defensive, rigorous
coding. Formalizing the `coder-agent` dual-binding as a permanent DI
boundary protects `lib/`'s shell-agnostic purity. Defining
`CorrelationContext` with a strict "passive observability only" rule is a
mature, system-level design choice that prevents observability data from
leaking into business logic.

The architecture score holds at 9 — the design was already strong and
nothing in the last three days changed the taste level.

### Why it doesn't move higher yet

While `sandbox-tools.ts` shed 472 lines (-11%), it is still 3,640 lines.
The actual dense module extraction (step 4) and its prerequisite
characterization tests (step 2) are the true test of this remediation
plan. The groundwork builds immense confidence, but a 9 for
implementation requires the verification family to be fully extracted and
the tracing spine to be threaded.

### Gemini (2026-04-14 — prior snapshot)

### Rating (2026-04-14 — held)

Overall: **8.5/10** (unchanged)

Split view:

- **9/10** on architecture (unchanged)
- **8/10** on current implementation shape (unchanged)

The rating holds steady right where the snapshot had it. The split of 9 architecture / 8 implementation still fits the state of the repo today. The gap between how the system is designed to work and how it actually runs has closed significantly, but it's not entirely gone.

**Why the 8.5 sticks**

- **Shared runtime reality.** Shifting the task-graph, delegation briefs, and typed memory contracts into `lib/` so both the CLI and web app consume them was a massive step. It fundamentally resolved the adapter drift issues.
- **Event streaming parity.** Unifying the `emit` callback mechanism across the `pushd` daemon and engine makes the execution paths significantly more predictable.
- **The run engine.** Having a pure, deterministic reducer handling side-effect-free state transitions and the append-only run journal is a remarkably resilient foundation.

**Why it's not a 9 or higher**

- **The "big four" files.** The snapshot nails this. `sandbox-tools.ts`, `coder-agent.ts`, `useAgentDelegation.ts`, and `useChat.ts` have become gravity wells for complexity. They are too load-bearing to easily refactor, so they keep absorbing new features (capability systems, graph orchestration).
- **Distributed tracing.** When something fails across the CLI, daemon, and Modal sandbox boundaries, diagnosing it end-to-end is still much harder than it needs to be.
- **Legacy hooks.** Migration bridges are stabilizing, but there's still cleanup needed to fully deprecate the older execution patterns.

To push the implementation score higher, the next big lever isn't adding new architecture — it's finally breaking apart those dense, multi-thousand-line orchestration files.

## Gemini (2026-04-08 — prior snapshot)

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

## Synthesis (2026-04-17)

Panel spread: **Codex 8.5, Claude 8.6, Gemini 8.7**. Tight — 0.2 of a point across three independent reads. The blended number lands at roughly **8.6/10** (up from 8.4).

Current agreement across Codex, Claude, and Gemini:

- All three moved the score up modestly (+0.2 blended) and for the same reason: the changes are **executable boundaries**, not paper architecture. `ROLE_CAPABILITY_DENIED` at the execution layer, the CorrelationContext "passive only" hard rule, and 313 new tests are real implementation gains.
- All three agree on the ceiling: **the next real jump requires the actual extraction work.** Groundwork earns credit; extraction earns the leap.
- The architecture axis is now consistently at or above 9 across the panel. Codex put it at 9.1 for the first time — the role-capability enforcement at the execution layer makes capability enforcement substrate-grade rather than convention-grade.
- The "big four" dense modules remain the ceiling. `sandbox-tools.ts` shed 472 lines (-11%) but the shape is unchanged. `useAgentDelegation.ts` grew +44 lines. The fossilization pattern holds for the other three.
- The dense module total dropped from 10,262 → 9,852 lines (-4%), which is directionally good but not structurally different.

Current difference in emphasis:

- **Gemini (8.7)** gives more weight to the test coverage as de-risking (+0.4 on impl). The 313 tests are a "massive de-risking effort" that builds the safety net for extraction.
- **Codex (8.5)** gives more weight to the architectural invariants and bumps architecture to 9.1, but is stingier on implementation (+0.2 on impl). Conservative read: the ceiling before extraction is ~8.5 overall.
- **Claude (8.6)** splits the difference. The runtime enforcement and tests are real gains, but the dense module problem didn't get easier — the weight dropped, the gravity well didn't.

Blended takeaway:

- Push is at the point where the remediation groundwork is in place and the next gains come from executing the extraction plan. The remaining path:
  - characterization tests (step 2) to pin dense module behavior before refactoring
  - tracing spine pass (step 3) to thread CorrelationContext through seams
  - verification-family extraction from `sandbox-tools.ts` (step 4) — the first real proof that the handler-context pattern works
  - then evaluate the pattern before proceeding to git/release family
- A 9+ rating requires the big four to stop being gravity wells. The formalized boundaries (CorrelationContext, role-capability enforcement, coder-agent permanent boundary) now give the extraction a clear target shape. The ceiling before extraction is ~8.5–8.7; after successful extraction, 8.7–8.9 is realistic.

## Synthesis (2026-04-14 — prior)

Panel spread at 2026-04-14: Codex 8.3, Claude 8.5, Gemini 8.5. Blended ~8.4/10. All three agreed the ceiling was the four dense modules and enforcement maturity. Codex was the conservative outlier, wanting to see the big four defused before conceding 8.5.

Refresh notes:

- 2026-04-17 Claude reassessment: quarter-point bump on implementation shape (8 → 8.2). Overall moves from 8.5 → 8.6. Three remediation plan steps landed (CorrelationContext contract, coder-agent permanent boundary, runtime role-capability enforcement) plus 313 new tests. Dense modules still the ceiling — `sandbox-tools.ts` shed 472 lines but shape unchanged.
- 2026-04-17 Codex reassessment: moves from 8.3 → 8.5. Architecture bumps to 9.1 (first time above 9) on `ROLE_CAPABILITY_DENIED` at execution layer. Implementation 8.1 → 8.3. Groundwork earns credit; extraction earns the next real jump. Ceiling before extraction is ~8.5 overall.
- 2026-04-17 Gemini reassessment: moves from 8.5 → 8.7. Architecture holds at 9; implementation 8.0 → 8.4. The 313 tests are a massive de-risking effort; runtime enforcement shows defensive coding. Can't reach 9 until dense modules are actually extracted.
- 2026-04-14 Claude: 8 → 8.5. `lib/` doubled, role kernels migrated, `pushd` Phase 6 closed. Dense modules grew rather than shrunk.
- 2026-04-14 Codex: 8.5 → 8.3 (conservative nudge). Docs can overstate how boring the heaviest modules actually are.
- 2026-04-14 Gemini: held at 8.5. Shared runtime reality carries the score; big four cap it.
- 2026-04-08: All three bumped implementation a full point. Shared runtime convergence, memory hardening, task graph, CLI convergence, streaming event parity.