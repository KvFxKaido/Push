# Push Architecture Rating Snapshot

Date: 2026-04-17
Status: Reference snapshot, full panel refresh on 2026-04-17

Refresh note:
- **State update 2026-05-28** (Codex, Gemini, and Claude reassessed; parser convergence closed; Big Four regrowth — and a panel-record correction):
  - **Tool-Call Parser Convergence closed.** The six-PR convergence tranche (#677–#684) successfully unified the parser code path across web and CLI, routing both through `lib/tool-dispatch.ts` and consolidating phase grouping. Spurious heuristics are replaced with exact offset data.
  - **Big Four regrowth — partial Waterbed.** Combined Big Four nominal size grew from 3,646 → **4,263 lines** (+16.9%). The headline number is `app/src/lib/sandbox-tools.ts` 670 → **1,021** (+52.4%). The dispatcher regrowth is real but it is **not** an Waterbed Effect on the previously-extracted handler families — it is concentrated in the `sandbox_exec` arm, which never had a sub-handler split and absorbed `local-pc` daemon dispatch (#511), daemon paths for read/write/diff (#515), mid-run cancel (#517), command-aware tool-output reducers, and GitBackend wiring inline. `coder-agent.ts` regrowth (1,411 → 1,609) is feature pressure (durable resume, parser changes); helper perimeter still cleaner than the 2026-04-26 baseline. `useChat.ts` at 946 still under the 950 cap — the ratchet held for ~four weeks under feature pressure.
  - **Panel-record correction (Claude entry).** Codex / Claude / Gemini all wrote at 2026-05-01 that "the Verification family extraction from `sandbox-tools.ts` still needs to land" — it had landed two weeks earlier on **2026-04-15** (commit `14a63c48`, "refactor(tools): extract sandbox verification family (step 4)"), and by 2026-04-18 the same handler-context pattern had been applied to four more families (edit, write, git-release, read-only-inspection — `app/src/lib/sandbox-{edit,write,git-release,read-only-inspection,verification}-handlers.ts`, each with a test file). The 2026-05-28 Codex entry above still references "extract the daemon binding / verification-family mass" as a future step; the verification half of that is already done. Only the `sandbox_exec`/daemon-binding half remains.
  - **Codex reassessment.** Overall score moves from 8.6 → **8.7/10**, with architecture 9.1 → **9.2/10** because parser convergence turned a cross-surface cooperation risk into shared runtime substrate. Implementation holds at **8.4/10**: exact offsets and common grouping are real shape gains, but `sandbox-tools.ts` regrowth proves containment is still not habit-grade.
  - **Gemini reassessment.** Overall score drops from 8.9 → **8.8/10**, holding architecture at 9.0 but bringing implementation down from 8.8 → **8.6/10** to account for the regrowth.
  - **Claude reassessment.** Overall score moves from 8.7 → **8.8/10**, architecture 9.0 → **9.1/10** (parser convergence as substrate + GitBackend/policy lift mirrors the role-capability hardening that earned the original 9.1), implementation 8.4 → **8.6/10** (panel-named milestone shipped and generalized to five families; durable resume + R2 snapshots are real reliability infrastructure; partial credit only because `sandbox_exec` inline growth and the missing `runCoderAgent` characterization tests cap the upside).
- **State update 2026-05-01** (Gemini reassessed; Codex light refresh after `coder-agent.ts` helper extraction; Claude reassessed):
  - **`useChat.ts` re-discharge — Waterbed Effect reversed.** The "ceiling ratcheted up" concern from the 2026-04-26 update is over. `useChat.ts` 1,450 → **892 lines** (−38.5%) across a multi-commit program: `prepareSendContext` / `acquireRunSession` / `finalizeRunSession` (2026-04-26, late), `queued-follow-up-utils.ts` and `chat-round-loop.ts` (2026-05-01), then today's three — `useConversationPersistence`, `chat-active-run-router`, `useChatAutoSwitch`. The ESLint `max-lines` cap on `useChat.ts` ratcheted from 1,400 → **1,060** (commit `0dcbbb3a`, 2026-04-28); current file leaves ~168 lines of headroom, so a further ratchet is justified. Net new test surface: ~30 cases pinning previously-uncovered behavior (retry-with-cap-at-3 in persistence, FIFO queue position math, the auto-switch state machine including the migration-marker gate). The "extraction discipline" the synthesis flagged as the next-jump condition is now demonstrated on the densest module — not just operationalized via the cap.
  - **Coder helper extraction — permanent boundary refined, not overturned.** `coder-agent.ts` 1,989 → **1,411 lines** (−29.1%) after extracting working-memory delegation, context-trim helpers, and mutation-result helpers into sibling `lib/` modules with focused tests. The core `runCoderAgent` loop remains the load-bearing boundary, which is the right shape; this is not a full decomposition, but it does remove helper mass without creating a fake abstraction.
  - **Big Four surface now materially smaller.** `useAgentDelegation.ts` 673 → **673** (unchanged), `sandbox-tools.ts` 670 → **670** (unchanged), `coder-agent.ts` 1,984 → **1,411** (−28.9%). Total Big-Four surface 4,777 → **3,646 lines** (−23.7%). The `coder-agent.ts` permanent-boundary decision still holds (Remediation Plan §Step 5), but the helper perimeter is now cleaner and test-pinned.
  - **What this does not yet move all the way.** The synthesis-named "verification-family extraction from `sandbox-tools.ts`" remains undone — that's the panel's specific test of the handler-context pattern, not just any extraction. Today's work is "more of the right kind" and earns implementation-shape credit, but it is not the strategic landing for a 9+ implementation read.
- **State update 2026-04-26** (no fresh panel refresh run yet — facts and line counts only):
  - **Cloudflare Sandbox provider v1 landed** (~2026-04-20) at `/api/sandbox-cf/*`, routed through the existing sandbox-provider abstraction. Known gaps: no owner tokens, no snapshots, `revision=0`. Doesn't move the architecture axis — parallel backend behind the same seam — but adds operational surface.
  - **Sandbox stall hardening complete** (PRs [#372](https://github.com/KvFxKaido/Push/pull/372)–[#382](https://github.com/KvFxKaido/Push/pull/382), 2026-04-24) plus the `/opt/push-cache` bake. The 100s cold-npm-install + stall pattern that was hurting reliability is closed; "edits vanishing" is the only remaining item from that cluster, pending snapshots.
  - **Cloudflare AI Gateway routing** (PRs [#419](https://github.com/KvFxKaido/Push/pull/419)/[#420](https://github.com/KvFxKaido/Push/pull/420)) consolidates provider traffic through CF AI Gateway and gives us a real log-inspection surface (now wired into the AI Gateway MCP).
  - **Context budget refactor** (PR [#421](https://github.com/KvFxKaido/Push/pull/421), 2026-04-26) replaces the per-model budget profile table with a catalog-driven formula (`max = 92% × window`, `target = 85% × window`). Adding a new model no longer requires editing `orchestrator-context.ts` for any provider with models.dev metadata; name-pattern fallback covers direct providers (CF / Vertex / Bedrock / Azure / Kilocode / OpenAdapter).
  - **Tool-call parser convergence — partial** (PRs [#422](https://github.com/KvFxKaido/Push/pull/422)/[#423](https://github.com/KvFxKaido/Push/pull/423), 2026-04-26) adds `lib/tool-call-namespaced-recovery.ts`, consumed by both the CLI shared kernel and the web grouping dispatcher. Recovers OpenAI-style `functions.<name>:<id> <args>` traces (the Kimi/Blackbox silent-drop pattern captured in session `sess_mogit6qt_447633`). Narrows the parity hole called out in `Tool-Call Parser Convergence Gap.md`, but does not unify the two dispatchers — that's still deferred. **Update 2026-05-28**: the convergence is now fully closed. Web's `detectAllToolCalls` routes through `createToolDispatcher` for fenced + bare extraction and malformed reporting (PR #679); web's namespaced/XML recovery runs as a separate Phase 2 with `enableInternalRecovery: false` on the kernel (PR #681). The phase-grouping state machine lives in shared `lib/tool-call-grouping.ts` (PR #677); both surfaces emit matching `FILE_MUTATION_BATCH_OVERFLOW` / `MULTI_MUTATION_NOT_ALLOWED` error codes (PRs #680 / #684). PR #683 added new exact-data APIs (`RecoveredNamespacedCall.endOffset`, `RecoveredXmlCall.endOffset`, `ToolDispatchResult.callOffsets`) and replaced two heuristics — kernel-call offset reconstruction and `<function_calls>` invoke offset re-anchor — with exact data; the legacy-scan recovery-args region skip intentionally remains a shape-based 80-char regex lookback because recovery rejects prose mentions on trailing context but the args object still gets picked up by bare-args inference. See `Tool-Call Parser Convergence Gap.md` for the full six-PR breakdown.
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
| Codex | **8.7/10** | 9.2 | 8.4 | Reassessed 2026-05-28 | Parser convergence is architecture-grade shared substrate now. Implementation holds because Big Four regrowth, especially `sandbox-tools.ts`, cancels the shape credit. |
| Claude | **8.8/10** | 9.1 | 8.6 | Reassessed 2026-05-28 (self-rating, conflict-of-interest noted; panel record corrected) | Parser convergence + GitBackend lift earn substrate credit on architecture. Implementation up because the panel-named handler-context pattern shipped + generalized to five families, durable resume infrastructure is real, and the `max-lines` ratchet held under feature pressure. `sandbox_exec` inline growth caps further upside. |
| Gemini | **8.8/10** | 9.0 | 8.6 | Reassessed 2026-05-28 | Parser convergence (PRs #677–#684) closed the Web/CLI parity gap, but Big Four modules regrew from 3,646 to 4,263 lines (+16.9%). |

## Codex

### Rating (2026-05-28)

Overall: **8.7/10** (up from 8.6)

Split view:

- **9.2/10** on architecture taste / system design (was 9.1)
- **8.4/10** on current implementation shape (holds)

### Why the score moved

Tool-call parser convergence is the kind of change that should move the
architecture axis, not just the bug-count axis. The six-PR tranche (#677-#684)
took a failure-prone cross-surface behavior and made it shared substrate:
web and CLI now route through `lib/tool-dispatch.ts`, phase grouping lives in
`lib/tool-call-grouping.ts`, malformed calls share error codes, and the old
offset reconstruction heuristics were replaced with exact offset data.

That matters because this was exactly the class of gap Push says prompts should
not be asked to paper over. A non-cooperating model can still emit odd tool
syntax, but the recovery/parsing path is now a runtime concern with common code
and common diagnostics. That is architecture behaving like architecture.

### Why implementation holds

The implementation score does not move up because the same refresh exposed a
real containment regression. The Big Four have regrown from 3,646 to **4,263
lines**, with `app/src/lib/sandbox-tools.ts` doing most of the damage
(670 -> **1,021 lines**) as local-pc daemon binding logic landed inline in the
dispatcher.

So the honest Codex read is: parser convergence earns architecture credit, but
the Waterbed Effect eats the implementation credit. The codebase can still
execute a focused convergence campaign very well; it is not yet reliably
preventing feature pressure from re-filling the exact modules the remediation
plan named.

### Current ceiling

The next rating jump still needs the same proof, now with sharper evidence:
extract the daemon binding / verification-family mass out of `sandbox-tools.ts`
behind handler-owned modules, then keep the cap from ratcheting upward again.
If parser convergence is the model for targeted substrate work, the
implementation can get to 8.6-8.8 quickly. Without containment discipline, 8.7
overall is the right place to stop being generous.

### Codex (2026-05-01 — prior snapshot)

### Rating (2026-05-01 light refresh)

Overall: **8.6/10**

Split view:

- **9.1/10** on architecture taste / system design (unchanged)
- **8.4/10** on current implementation shape (was 8.3)

### Why the scores moved

The 2026-05-01 light refresh moves implementation up a notch, not a tier. `useChat.ts`
has been re-discharged to 892 lines with a real max-lines ratchet, and
`coder-agent.ts` dropped from 1,989 to 1,411 lines by moving working-memory
delegation, context-trim helpers, and mutation-result handling into sibling
`lib/` modules with focused tests. That is real maintenance-shape improvement:
the helper perimeter is smaller, more testable, and less likely to accrete inside
the Coder loop.

The architectural score stays at 9.1. The `coder-agent.ts` change reinforces the
existing permanent-boundary decision rather than replacing it: the core
`runCoderAgent` loop remains load-bearing, while helper logic now has cleaner
ownership. Good extraction, but not new architecture.

### Prior movement from 2026-04-17

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
dropping 11% was directionally good. At that point, though, the big-four
modules were still nearly 10k lines, and the key remediation steps —
characterization tests, tracing spine, and actual extraction — were still
not done.

### The ceiling

Groundwork earned credit; extraction is now earning the next real jump in
pieces. After the `useChat.ts` and `coder-agent.ts` work, the current ceiling is
around 8.6 overall / 8.4 impl until the Verification family proves the
handler-context pattern in `sandbox-tools.ts`. If that lands with the same
test-pinned discipline, 8.7–8.9 overall is realistic. A 9+ implementation read
still needs proof that the pattern generalizes across tool-handler families, not
just hooks and helper modules.

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

### Rating (2026-05-28)

Overall: **8.8/10** (up from 8.7)

Split view:

- **9.1/10** on architecture (was 9.0)
- **8.6/10** on current implementation shape (was 8.4)

### Conflict-of-interest note

The 2026-04-15 Verification family extraction commit (`14a63c48`) is authored by Claude, and PRs in the parser-convergence tranche likely include my work. Treat the bump as self-rating with the same caveat that applied at 2026-05-01: Claude lands between Codex (held at 8.4 impl) and Gemini (down to 8.6 impl) on the implementation axis, which is consistent with the "Claude splits the difference" pattern from prior synthesis blocks.

### Panel-record correction up front

At 2026-05-01 the entire panel — me included — wrote that the Verification family extraction from `sandbox-tools.ts` was the gating milestone for a 9+ implementation read. That extraction had **already landed on 2026-04-15** (commit `14a63c48`, "refactor(tools): extract sandbox verification family (step 4)") — two weeks before the panel sat down. By 2026-04-18 the same handler-context pattern had been applied to four more families: edit (`7ecd4dda`), write (`afdfc8cd`), git-release (`9c225445`), and read-only-inspection (`114bdc31`). Five sibling handler files (each with `.test.ts`) totalling ~4,165 lines now own what was previously inline in the dispatcher.

The 2026-05-28 Codex entry above still treats verification-family extraction as a future step. It isn't — only the `sandbox_exec` / daemon-binding half of "extract the daemon binding / verification-family mass" remains. The panel kept missing this because the headline line-count signal points the wrong direction: `sandbox-tools.ts` grew from 670 to 1,021 lines since 2026-05-01, but inspection of the dispatcher (sample at L416–L1003) shows the regrowth is concentrated entirely in the `sandbox_exec` arm and its `local-pc` daemon-binding scaffolding. The extracted families haven't reabsorbed anything.

### Why architecture moves to 9.1

- **Parser convergence is substrate-grade.** PRs #677 / #679 / #680 / #681 / #683 / #684 unified the dispatcher kernel, moved phase grouping to `lib/tool-call-grouping.ts`, normalized error codes across surfaces (`FILE_MUTATION_BATCH_OVERFLOW`, `MULTI_MUTATION_NOT_ALLOWED`), and — the move that earns architecture credit, not impl credit — **replaced three convergence heuristics with exact data APIs** (`RecoveredNamespacedCall.endOffset`, `RecoveredXmlCall.endOffset`, `ToolDispatchResult.callOffsets`). Heuristic → exact data is the Push convention's "behavior lives in code, not prompts" rule applied to its own runtime. Codex correctly bumps to 9.2 on this.
- **GitBackend / `lib/git/policy.ts` lift** consolidates git command policy into a typed backend with `PushGit` facade and structured guard guidance. This is the same soft-rule → substrate move that earned the original 9.1 jump for role-capability enforcement, but applied to a different invariant family. Independent architecture credit.
- **Durable coder-job resume** (PRs #649 / #650 / #654-657 / #661) converts what was "operationally improving reliability" into a runtime invariant — checkpoints, `MAX_JOB_RESUMES` cap, orphan-on-DO-wake recovery. **R2-backed filesystem snapshots** (#647 / #648 / #651) close the "edits vanishing" gap that 2026-04-26 left open.

I land at 9.1 rather than Codex's 9.2 because the GitBackend lift is the kind of move I'd weight equally with parser convergence on the architecture axis, and Codex's 9.2 absorbs both into the same bump. Sitting between Codex (9.2) and Gemini (9.0) is honest.

### Why implementation moves to 8.6

- The **handler-context pattern shipped and generalized** to five families (verification, edit, write, git-release, read-only-inspection), each with a test file. This is the panel's named landing for 9+. The 2026-05-01 framing that called it the future test was already wrong by then.
- **The `max-lines` ratchet on `useChat.ts` held under sustained feature pressure for ~four weeks** — that's the structural Waterbed-Effect-reversal claim from 2026-05-01 surviving real load, not just the moment of landing. `useChat.ts` is 946 lines against a 950-line cap; the cap didn't ratchet up under pressure.
- **Durable resume infrastructure** is genuine implementation-shape work that the prior remediation plan called out and that has now landed with test coverage (`MAX_JOB_RESUMES` cap, silent-null path closures in #657, snapshot-restore failure surfacing in #651).

Why not higher:

- **`sandbox_exec` is becoming the next gravity well.** The 670 → 1,021 dispatcher regrowth is concentrated in one case arm absorbing local-pc daemon dispatch, daemon paths for read/write/diff, mid-run cancel, command-aware tool-output reducers, and GitBackend wiring. None of that is fossilization of extracted families — but if the next two months add another 350 lines of inline daemon scaffolding to that arm, we'll have replaced the old gravity well with a new one of similar shape. Codex and Gemini are right to flag this; they're wrong about which families are at risk.
- **`coder-agent.ts` at 1,609** still has no characterization tests on the inline `runCoderAgent` loop body. The helper extractions stuck, but the loop itself is one feature press away from getting harder to refactor without a safety net.
- **Tracing spine through `CorrelationContext`** across web / CLI / Worker boundaries remains the panel-named seam that hasn't been threaded. Codex/Claude/Gemini all flagged this at 2026-05-01 and it remains the cheapest remaining 9+ implementation move.

### What would move implementation past 8.7

- Split `sandbox_exec` into a transport-aware handler family before the dispatcher arm doubles in size again. The pattern is already proven five times.
- Characterization-test pass on the inline `runCoderAgent` loop so `coder-agent.ts` could ratchet down rather than just stay flat under feature pressure.
- Tracing spine through `CorrelationContext` across the seams the 2026-04-17 panel called out (still unmet 41 days later).

### Claude (2026-05-01 — prior snapshot)

### Rating (2026-05-01)

Overall: **8.7/10** (up from 8.6)

Split view:

- **9.0/10** on architecture (unchanged)
- **8.4/10** on current implementation shape (was 8.2)

### Conflict-of-interest note

Today's `useChat.ts` extractions (`useConversationPersistence`, `chat-active-run-router`, `useChatAutoSwitch`) and the review of Codex's `coder-agent.ts` helper extraction were both done by me. That makes this self-rating, so the bump should be weighted accordingly. Codex and Gemini reassessed independently — I'm landing between them (Codex held at 8.4 impl, Gemini moved to 8.8 impl), which is consistent with the "Claude splits the difference" pattern from prior synthesis blocks.

### Why implementation shape moves a quarter point

The Big Four discharge crossed a real threshold today, not just shed lines:

- **`useChat.ts` 1,045 → 892** across three extractions with ~30 new test cases pinning previously-uncovered behavior (persistence retry-with-cap-at-3, FIFO queue position math, the auto-switch state machine including the migration-marker gate). The ESLint `max-lines` cap ratcheted *down* (1,060 → 950) for the first time in the cap's history — the Waterbed Effect concern from the 2026-04-26 update is concretely reversed, not just acknowledged.
- **`coder-agent.ts` 1,989 → 1,411** via working-memory delegation consolidation, context-trim helpers, and mutation-result helpers. The working-memory consolidation in particular is a genuine drift-hazard fix: `coder-agent.ts` had its own copies of `applyObservationUpdates`, `formatCoderState`, and three other functions that already lived in `working-memory.ts` (functionally identical, only parameter naming differed). Two implementations of the same logic in the same package is the kind of thing that drifts silently; collapsing them is worth more than the line count suggests.
- **Big Four total 4,777 → 3,646 lines (-23.7%).** Three of the four are now meaningfully reduced; the helper perimeter on the fourth (`coder-agent.ts`) is cleaner and test-pinned. The remaining mass is now closer to "structural" than "fossilized."
- **Test surface added today is operationally meaningful.** The path-fallback case in `coder-context-trim`, the in-flight-add-survives-snapshot case in `useConversationPersistence`, and the diff-vs-bullet ambiguity case all pin invariants that nobody had documented and that would fail silently on regression.

### Why it is still not 8.6 on implementation

- The synthesis-named **Verification family extraction from `sandbox-tools.ts`** is still not done. That's the panel's specific test of the handler-context pattern — and today's work doesn't substitute for it. `useChat.ts` and `coder-agent.ts` were never the test of that pattern; they're orthogonal landings.
- **Tracing spine** still not threaded through `CorrelationContext` across the seams the 2026-04-17 panel called out.
- **`coder-agent.ts` at 1,411** is meaningfully better but still the heaviest Big Four module by a wide margin. The "permanent boundary" framing is honest about what's structural, but a 1,400-line orchestration module with no internal characterization tests is still a maintenance risk under feature pressure.

### Why architecture holds at 9.0

Nothing today changed the architecture taste level. The extractions reinforce existing seams rather than introduce new ones: the `coder-agent.ts` work confirms (rather than overturns) the Remediation Plan §Step 5 permanent-boundary decision, and the `useChat.ts` work continues a pattern already in motion. The next architecture-axis movement would require something like the Verification family proving the handler-context pattern generalizes — that's a substrate move, not the same as today's hook-shape moves.

### What would move implementation past 8.5

- Verification family extraction from `sandbox-tools.ts` with the same test-pinned discipline (this is the panel's named landing).
- The `max-lines` cap on `coder-agent.ts` ratcheting down once the helper-extraction pattern is proven to compose under feature pressure.
- A characterization test pass on the remaining inline `runCoderAgent` loop — the helpers are extracted but the loop body itself doesn't have direct behavior pinning yet.
- Tracing spine threaded through `CorrelationContext` across web/CLI/Worker boundaries.

### Claude (2026-04-17 — prior snapshot)

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

### Rating (2026-05-28)

Overall: **8.8/10** (down from 8.9)

Split view:

- **9.0/10** on architecture (holds)
- **8.6/10** on current implementation shape (down from 8.8)

### Why the score moved

While the complete closure of the **Tool-Call Parser Convergence Gap** (PRs #677–#684) is a definitive triumph for shared runtime parity—eliminating the parallel parser state machines and unifying the error-code surface under the canonical `lib/tool-dispatch.ts` kernel—the implementation score must honestly reflect a regression in our core containment metrics.

The "Big Four" modules have expanded from 3,646 lines to **4,263 lines** (+16.9% combined size) since the May 1st update:
- `app/src/lib/sandbox-tools.ts` regrew from 670 → **1,021 lines** (+52.4%). This is a textbook example of the Waterbed Effect: the new `local-pc` daemon binding dispatch and error wrapping were implemented inline within the dispatcher's `switch` block instead of being co-extracted into a dedicated adapter.
- `lib/coder-agent.ts` regrew from 1,411 → **1,609 lines** (+14.0%).
- `app/src/hooks/useChat.ts` regrew from 892 → **946 lines** (+6.0%).
- `app/src/hooks/useAgentDelegation.ts` regrew from 673 → **687 lines** (+2.1%).

The parser convergence proves that shared kernels work beautifully once established. However, the regression in `sandbox-tools.ts` indicates that the "extract and restrict" workflow is not yet habit-grade; feature pressure still defaults to piling logic back into the dispatchers.

### Why it doesn't move higher yet

Our architectural ceiling remains the same: we need a strict co-extraction discipline to ensure feature implementations (like the `local-pc` daemon bindings) are kept out of the main dispatchers. To cross the 9.0 boundary on implementation, we need to extract the daemon bindings out of `sandbox-tools.ts` to restore its role as a pure router, and thread a unified tracing spine through `CorrelationContext` across client, daemon, and worker boundaries.

### Gemini (2026-05-01 — prior snapshot)

### Rating (2026-05-01)

Overall: **8.9/10** (up from 8.7)

Split view:

- **9.0/10** on architecture (holds)
- **8.8/10** on current implementation shape (up from 8.4)

### Why the score moved

The 9-phase discharge of `useChat.ts` (1,733 → 892 lines) is a definitive victory for the project's maintenance strategy. This wasn't just code movement; the extraction of stateful clusters into specialized hooks (`useConversationPersistence`, `useChatAutoSwitch`) and pure logic into routers (`chat-active-run-router`) materially decouples the UI from the run engine. The ESLint `max-lines` ratchet (now at 950) is no longer just a guardrail—it's a proven workflow that successfully reversed the "Waterbed Effect." The ~30 new test cases pinning previously-uncovered behavior in the extracted modules fulfill the "characterization test" requirement for the project's most complex surface.

### Why it doesn't move higher yet

The architecture score holds at 9.0; the design was already strong. To reach 9.0 on implementation, the "handler-context" pattern proof still needs to land in `sandbox-tools.ts`. While its weight is now manageable (~613 lines), the panel's specific test for 9.0 is the extraction of the **Verification family** into its own handler context. Once that lands, the "Big Four" will have been structurally transformed, earning the final jump.

### Gemini (2026-04-17 — prior snapshot)

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

## Synthesis (2026-05-28)

Panel spread: **Codex 8.7, Claude 8.8, Gemini 8.8**. All three reviewers reassessed. Blended score lands at roughly **8.77/10** — round to **8.8**. The 0.1 spread is the tightest the panel has been since the snapshot doc started.

Note on independence: Claude's reassessment is partly self-rating — the 2026-04-15 Verification family extraction commit (`14a63c48`) is authored by Claude, and PRs in the parser-convergence tranche likely include Claude's work. Claude landed at 8.6 on implementation, between Codex (8.4 hold) and Gemini (8.6 drop), and at 9.1 on architecture, between Gemini (9.0) and Codex (9.2) — credible splits but weight accordingly.

**Panel-record correction (acknowledged this refresh).** At 2026-05-01 Codex / Claude / Gemini all wrote that the **Verification family extraction from `sandbox-tools.ts` still needed to land** as the panel's named test of the handler-context pattern. It had already landed on **2026-04-15** (commit `14a63c48`), and by 2026-04-18 the same pattern had been applied to four more families (edit, write, git-release, read-only-inspection — see `app/src/lib/sandbox-{edit,write,git-release,read-only-inspection,verification}-handlers.ts`, each with a test file). The Codex 2026-05-28 entry above and the prior version of this synthesis block both inherited the error — Codex referenced "extracting the daemon binding / verification-family mass" as a future step, and this block originally said the ceiling was unchanged because that extraction hadn't happened. The half that's left is `sandbox_exec` and the local-pc daemon-binding mass, not the verification family. Claude's 2026-05-28 entry surfaces the correction in detail.

Current agreement across the panel:

- **Parser convergence is a major milestone.** Complete closure of the convergence gap is a structural victory for shared runtime parity — phase grouping in `lib/tool-call-grouping.ts`, normalized error codes across surfaces, and (the move that justifies architecture credit, not just impl credit) three heuristics replaced with exact data APIs (`endOffset`, `callOffsets`). Codex weights this hardest (9.1 → 9.2 arch); Claude shares the substrate framing but distributes the architecture credit across parser convergence + GitBackend lift (9.0 → 9.1); Gemini reads it as parity work and holds architecture at 9.0.
- **`sandbox-tools.ts` regrowth is real but localized.** All three reviewers flagged the 670 → 1,021 dispatcher growth. On inspection, the regrowth is concentrated in the `sandbox_exec` arm and its `local-pc` daemon-binding scaffolding (#511, #515, #517) plus GitBackend wiring — none of the five previously-extracted handler families reabsorbed anything. So the headline number is a real warning signal about which arm of the dispatcher needs the next split, not evidence that the handler-context pattern failed.
- **The next ceiling test is the `sandbox_exec` / daemon-binding split** behind a transport-aware handler context, plus threading `CorrelationContext` across web / CLI / Worker seams. Both moves were named at 2026-04-17 and remain unmet 41 days later.

Current difference in emphasis:

- **Codex (8.7)** weights parser convergence hardest on the architecture axis (9.2, first time a panel member crosses 9.2), and is strictest on the implementation axis (8.4 hold) because the dispatcher regrowth proves containment isn't yet habit-grade.
- **Gemini (8.8)** holds architecture at 9.0 and reads the regrowth as Waterbed Effect penalty (8.8 → 8.6 impl). Most conservative read on the architecture axis.
- **Claude (8.8)** sits between them: matches Codex on the substrate framing but reads regrowth as `sandbox_exec`-specific rather than general Waterbed, and gives independent architecture credit to the GitBackend lift (9.0 → 9.1, 8.4 → 8.6 impl). Brings the panel-record correction inline.

Blended takeaway:

Push is good at executing a targeted convergence campaign (parser closure, role-capability hardening, GitBackend) and the panel-named handler-context pattern shipped and generalized to five families — both pieces of evidence the panel underweighted at 2026-05-01 because of stale assumptions about what had landed. The current ceiling is concentrated in two specific seams: the `sandbox_exec` dispatcher arm (which is becoming the next gravity well as local-pc binding code accumulates) and the unthreaded tracing spine. The 0.1 panel spread reflects genuine convergence on what the project is and where it needs to land next, not panel fatigue.

## Synthesis (2026-05-01)

Panel spread: **Codex 8.6, Claude 8.7, Gemini 8.9**. All three reviewers refreshed. Blended number lands at roughly **8.7/10** (up from 8.6). The 0.3 spread is the same as the prior synthesis but Claude has now moved off the stale 4-17 read.

Note on independence: Claude's 2026-05-01 reassessment is partly self-rating — Claude did the `useChat.ts` extractions and reviewed Codex's `coder-agent.ts` work directly. Claude landed at 8.4 on implementation, between Codex (8.4 hold) and Gemini (8.8 jump), which is a credible split but should be weighted accordingly.

Current agreement across Codex, Claude, and Gemini:

- The project has successfully demonstrated the "extraction discipline" required to defuse its most complex modules. The 9-phase discharge of `useChat.ts` (1,733 → 892 lines) is the landmark evidence.
- The use of ESLint `max-lines` as a ratchet is a proven structural success, reversing the "Waterbed Effect" and forcing feature pressure into clean, testable sibling modules.
- The `coder-agent.ts` helper extraction gives partial credit on the remaining Big Four surface: 1,989 → 1,411 lines while preserving the Coder loop as the permanent boundary.
- The next strategic milestone is still the **Verification family extraction** from `sandbox-tools.ts`. This is the specific test of the handler-context pattern that will determine if the implementation score can cross the 9.0 threshold.

Current difference in emphasis:

- **Gemini (8.9)** gives full credit for the `useChat.ts` discharge, viewing it as definitive proof that the extraction strategy works and the risk of regression is operationally contained.
- **Claude (8.7)** sees the Big Four discharge as a real threshold crossing (4,777 → 3,646 total) and the working-memory consolidation as a genuine drift-hazard fix, but holds back from Gemini's larger jump until the Verification family proves the handler-context pattern across tool families.
- **Codex (8.6)** gives partial credit for the `coder-agent.ts` helper extraction but remains focused on the Verification family as the specific hurdle for substrate-grade proof. Most conservative read on the panel.

Blended takeaway:

Push has moved from "planning the extraction" to "executing the extraction at scale." The project's most complex coordination hook is now lean and decoupled, and the largest Coder file has a cleaner helper perimeter. The roadmap is clear: repeat this success on the Verification family in `sandbox-tools.ts` to prove the pattern generalizes across families, which would earn a 9+ implementation rating.

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
