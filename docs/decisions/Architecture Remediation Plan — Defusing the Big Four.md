# Architecture Remediation Plan — Defusing the Big Four

Date: 2026-04-14
Status: Draft, working discussion (not a committed plan yet) — revised after council review on 2026-04-14, then revised 2026-04-15 to recast team-scale calendar prescriptions for a solo-dev cadence, then revised 2026-04-17 to hoist CLI runtime parity into a dedicated section once a third parity gap (orchestrator-driven task-graph + typed memory in CLI) surfaced, then corrected the same day after reconnaissance showed Gap 1 had already shipped earlier in the cycle and the section was drafted from a stale premise, then revised again the same day to rescope Gap 2 after reconnaissance showed the gap is not "missing enforcement" but "enforcement via a parallel vocabulary that the shared capability table does not cover"
Companion to: `Architecture Rating Snapshot.md`

## Context

The 2026-04-14 panel refresh put Push at a blended **8.4/10**. All three reviewers — Codex, Claude, Gemini — agree the ceiling is the same four dense coordination modules:

| Module | Lines (verified 2026-04-14) |
|---|---|
| `app/src/lib/sandbox-tools.ts` | 4,112 |
| `lib/coder-agent.ts` (kernel) | 1,968 |
| `app/src/lib/coder-agent.ts` (web shim) | 610 |
| `app/src/hooks/useAgentDelegation.ts` | 1,839 |
| `app/src/hooks/useChat.ts` | 1,733 |

Combined: ~10.3k lines of load-bearing orchestration. All four have **grown** rather than shrunk since the 2026-04-08 snapshot — the fossilization prediction is holding.

The architecture question is no longer "are the abstractions right." It is: **how do we make the existing architecture easier to change, easier to diagnose, and harder to accidentally violate?**

## Codex's Recommended Plan (2026-04-14)

Codex proposed an eight-workstream remediation. Summarized:

1. **Baseline before refactoring** — tracking checklist, characterization tests around sandbox tools, chat send/resume, delegation outcomes, task graph execution, and daemon protocol.
2. **Tracing spine early** — propagate correlation fields (`runId`, `chatId`, `sessionId`, `delegationId`, `taskGraphId`, `taskId`, `toolCallId`, `surface`) through the five hot paths. Build on the existing `app/src/lib/tracing.ts` (267 lines), not a new system.
3. **Defuse `sandbox-tools.ts` first** — keep `executeSandboxToolCall()` as the stable dispatcher; extract handlers by tool family behind a shared handler context:
   - **verification**: `sandbox_run_tests`, `sandbox_check_types`, `sandbox_verify_workspace`
   - **git/release**: `sandbox_diff`, `sandbox_prepare_commit`, `sandbox_push`, `promote_to_github`
   - **read-only inspection**: `sandbox_read_file`, `sandbox_search`, `sandbox_list_dir`, `sandbox_read_symbols`, `sandbox_find_references`
   - **mutation**: `sandbox_edit_file`, `sandbox_edit_range`, `sandbox_search_replace`, `sandbox_write_file`, `sandbox_apply_patchset`
   - Start with verification or git/release, **not** mutation. The hashline/edit path is load-bearing and should move only after tests are stronger.
4. **Turn `useChat.ts` into a composition shell** — extract run-engine/journal bridge, queued follow-up + pending steer state, and persistence flushing into dedicated hooks. Leave the `sendMessage` loop until last.
5. **Split `useAgentDelegation.ts` by role workflow** — extract typed-memory helpers first, then Coder/Explorer execution, Auditor evaluation, and task-graph execution into adapter modules.
6. **`coder-agent.ts` cleanup** — extract `buildWebCoderAgentOptions()` and `makeWebCoderToolExec()` from the web shim. Longer term: collapse the shim once the daemon is the primary transport.
7. **Convert policy-shaped rules into runtime checks**:
   - Explorer cannot mutate, regardless of prompt wording.
   - Prompt-advertised tools match executor-accepted tools.
   - Coder phase-gate refuses cannot drift silently.
   - Build on the discipline already in `cli/tests/daemon-integration.test.mjs` (4,490 lines), don't start fresh.
8. **Migration debt cleanup** — inventory `app/src/lib/*` shims that only exist for moved `lib/` kernels, decide deprecation criteria for `push.runtime.v1` synthetic downgrade.

Codex's facts spot-check clean: line counts are exact, `tracing.ts` exists, the daemon integration test is real, the tool taxonomy maps to actual `case` arms in `executeSandboxToolCall`.

## Critique — Where the Plan Needs Tightening

Codex's diagnosis is correct. The plan is too broad to execute as written.

### 1. Eight workstreams is too many for one push

The plan reads like a roadmap, not a next move. Realistically one workstream gets done well per push. Cut to **one extraction plus the tracing pass**, treat everything else as "after we see how the pattern lands."

### 2. Tracing → tests → extraction is sequential, not parallel

Codex lists baseline tests and tracing as parallel steps 1 and 2. They aren't. **Tracing tells you where to put the characterization tests**; the tests pin behavior; *then* you extract. Reorder explicitly.

The reason this matters: if you refactor a 4,112-line dispatcher and only unit tests tell you it works, you'll find regressions in production. Cross-boundary correlation IDs are how you know a behavior-preserving move actually preserved behavior at runtime. For a system whose hot paths cross web → daemon → sandbox boundaries, runtime evidence outranks unit evidence.

### 3. Verification family first, hard stop after one extraction

Codex says "I'd start with verification or git/release, not mutation" and then describes the full sandbox-tools defuse. Pick one. **Verification first** is the right call:

- Smallest blast radius (no GitHub side effects, no edits, no commits).
- Gives you the handler-context shape before committing to it for the load-bearing mutation family.
- Three tools (`sandbox_run_tests`, `sandbox_check_types`, `sandbox_verify_workspace`) is small enough to land in one PR.

After verification lands, **stop and evaluate the pattern** before doing git/release. Don't pre-commit to a four-family extraction order.

### 4. The two-headed `coder-agent.ts` is underweighted

Codex relegates the web shim to "longer term, collapse the shim instead of letting kernel-plus-shim become the permanent shape." That's the wrong framing.

The snapshot calls this out directly: 1,968 lines in `lib/` plus 610 lines in `app/src/lib/` is **+30% total surface area** as the price of CLI/Web parity. The architectural question is binary:

- **Transition artifact?** Then commit to deleting the shim once `pushd` is the primary transport, and don't add new behavior to it.
- **Permanent boundary?** Then formalize the contract, document what each side owns, and stop apologizing for it.

This decision must happen **before** anyone splits `coder-agent.ts` further, otherwise you'll split the same file twice in two months under different rationales.

### 5. Missing: a "did the refactor actually work" measurement

Codex says "treat line count as a smoke alarm, not the goal" — correct — but then proposes nothing better. Without a measurement story, you can't tell extraction from rearrangement.

The first draft proposed four descriptive signals (imports per file, distinct test files per module, churn rate, time-to-diagnose). The council review pushed back on all four as gameable: imports drop with barrel files, test counts rise with shallow smoke tests, churn drops because nobody touches the module, and time-to-diagnose is subjective unless the clock is defined. The revised approach uses descriptive metrics **and** prescriptive fitness rules together — neither alone is enough.

**Descriptive metrics (track over the next ~10 PRs that touch nearby code, not a calendar window):**

- **Co-churn (change coupling)** — when a PR modifies the extracted module, what percentage of the time does it *also* modify `executeSandboxToolCall` or a sibling tool file? High co-churn means the boundary was drawn wrong. This is the single most reliable signal because rearrangement-only refactors leave co-churn unchanged.
- **Cross-module imports / dependency direction** — do the newly extracted modules import from each other, from the dispatcher, from React hooks, or from orchestrator state? A successful extraction has a one-way graph: dispatcher → handler → domain helpers.
- **Interface surface area** — count the number of public methods/types each new module exposes. A high surface count means the module is still tightly coupled to the rest of the system; it just lives in a different file.

**Prescriptive fitness rules (must hold at merge, enforced by tests/lint where possible):**

- **Boundary rule:** the extracted verification module imports no React hooks, no orchestrator, no dispatcher, and no sibling tool handlers.
- **API rule:** `executeSandboxToolCall` remains the public dispatcher; the verification module exports one handler plus pure helpers, nothing more.
- **Behavior rule:** golden tests assert exact command sequence, mutation flags, cache clearing, card shapes, and user-visible text for each branch — not just return-value shapes.
- **Dependency rule:** no cycles, no barrel masking, and no extracted module importing from `sandbox-tools.ts`.
- **Locality rule:** a future verification behavior change should touch only the verification handler and its tests. If it requires edits to `useChat`, `useAgentDelegation`, or sibling tool handlers, the boundary failed and the extraction needs revision.

Line count remains fine as a smoke alarm. The locality rule is the strongest of the prescriptive set because it expresses the goal directly: fewer reasons for each file to change.

## Agreed Sequencing (Working Proposal, revised after council review)

This is a five-step working proposal, not a committed plan. Each step has a real "did it land" signal and is sized to one PR.

The original draft put tracing before tests. The council pushed back unanimously: tests must pin behavior before any function signatures change, otherwise the propagation pass itself can introduce regressions with no safety net. The order below reflects that correction.

1. ~~**Define a `CorrelationContext` contract.**~~ **Landed 2026-04-14 in [`CorrelationContext Contract.md`](./CorrelationContext%20Contract.md) and [`lib/correlation-context.ts`](../../lib/correlation-context.ts).** Field meanings, owners, nullable cases, containment order, and the hard rule that these fields never alter tool args, prompt text, daemon payloads, or sandbox behavior are all codified. One reconciliation vs. the original plan text: the field originally named `delegationId` is called `executionId` in the contract, matching the existing `RunEvent` arms (`subagent.*`, `task_graph.*`) in `lib/runtime-contract.ts`. Nothing in the kernel or the shells imports the module yet — step 3 is where that happens. Signal met: a single shared type, 14 passing pinning tests (`npx vitest run lib/correlation-context.test.ts`), root typecheck green (`npm run typecheck`).

2. **Characterization tests.** Pin behavior around: sandbox verification tools (especially `sandbox_run_tests` and `sandbox_check_types`, which currently appear under-covered relative to `sandbox_verify_workspace`), chat send/resume, delegation outcomes (Coder + Explorer happy paths and one failure each), task graph execution, daemon protocol drift. Tests must capture exact command sequence, mutation flags, cache invalidation behavior, card shapes, and user-visible text — not just return values. Signal: tests pass at HEAD with no production code changes.

3. **Tracing spine pass.** Thread the `CorrelationContext` through the seams that don't yet honor it. **This is smaller than the original draft framed it** — `withActiveSpan` already exists at `tracing.ts:238` with call sites in `app/src/lib/coder-agent.ts:429`, so the pass is "plug the leaks" rather than "build the topology." Tracing must be passive: any propagation that requires changing function signatures in `useChat.ts` or `useAgentDelegation.ts` is a stop sign — extract a `CorrelationContext` helper before continuing. Signal: a single failing tool call can be followed end-to-end across surfaces from one query, *and* the characterization tests from step 2 still pass.

4. **Extract sandbox-tools verification family.** Move `sandbox_run_tests`, `sandbox_check_types`, `sandbox_verify_workspace` behind a handler-context shape. `executeSandboxToolCall` stays as the public dispatcher. **Stop here and evaluate the pattern** — don't start git/release until the verification extraction has been exercised in real usage. "Real usage" here means actual coding sessions on actual work, not a calendar count; see [*Solo Developer Operating Notes*](#solo-developer-operating-notes) below for what that means in practice.

   Honest framing: verification is **not** side-effect-free. `sandbox_run_tests` marks the workspace mutated; `sandbox_check_types` can run `npm install`; `sandbox_verify_workspace` can install dependencies and run tests. Verification is "no GitHub side effects" but absolutely has filesystem and workspace side effects. It still beats the alternatives because read-only inspection has hidden coupling to file version caches, file ledger state, and edit guards (it looks safe and isn't), and git/release is too high-risk for a first proof of the extraction pattern.

5. ~~Decide~~ **Resolved: the `coder-agent.ts` web binding is a permanent boundary, formalized in `Web and CLI Runtime Contract.md`.** Evidence gathered 2026-04-14: `useAgentDelegation.ts` imports directly from `@/lib/coder-agent`, `@/lib/explorer-agent`, `@/lib/auditor-agent`, and `@/lib/task-graph` with no transport layer. Zero files under `app/src/` reference `pushd`, `daemon-client`, `DaemonClient`, `PUSHD_*`, or `DAEMON_*`. `Web and CLI Runtime Contract.md:202` states plainly that "today only pushd emits these envelopes and only CLI clients consume them." `push-runtime-v2.md` marks the Phase 7 "Web-as-daemon-client" flow as out of scope for v2.0 and future tense. The dual-binding shape (`lib/coder-agent.ts` kernel + `app/src/lib/coder-agent.ts` Web binding + `makeDaemonCoderToolExec` CLI binding) is the correct way to satisfy each shell's DI contract without pushing shell concerns into `lib/`. The same rule applies to the other role kernels. A new subsection in `Web and CLI Runtime Contract.md` captures the operating rule for this pattern. The web binding only shrinks or collapses if Phase 7 ever lands.

6. ~~**Harden one runtime invariant at the execution layer.**~~ **Landed 2026-04-14.** The execution runtime now refuses any tool a declared role cannot use, before hooks, approval gates, and Protect Main run. Mechanism: an opt-in `role?: AgentRole` field on `ToolExecutionContext` in `lib/tool-execution-runtime.ts`, plus a capability check at the top of `WebToolExecutionRuntime.execute()` that delegates to the existing `roleCanUseTool` from `lib/capabilities.ts`. Explorer opts in at the `executeReadOnlyTool` seam in `app/src/lib/agent-loop-utils.ts`; Coder, Deep Reviewer, and Auditor are unchanged this round because each needs its own capability-grant audit before opt-in — in particular the `reviewer` grant does not currently include `web:search`, which the deep-reviewer flow uses, so flipping the bit without an audit would regress that path. Signal met: 8 pinning tests in `app/src/lib/web-tool-execution-runtime.test.ts`, including the regression case where `hooks` and `approvalGates` are both `undefined` (the Explorer policy hook and the read-only registry are both absent) and a mutating tool is still refused with `structuredError.type === 'ROLE_CAPABILITY_DENIED'`. A new `ROLE_CAPABILITY_DENIED` entry in `ToolErrorType` makes this branch easy to grep from logs and dashboards. **Follow-up:** symmetric enforcement on the CLI/pushd path once a daemon-side `ToolExecutionRuntime` implementation lands (see `cli/pushd.ts` lines 2144/2159/2311/2338 for the Explorer entry points that will need the same opt-in), and capability-grant audits for the other three read-only-ish roles before they opt in. This follow-up is now tracked as **Gap 2** in the [CLI Runtime Parity](#cli-runtime-parity) section below, alongside the two other known parity gaps.

Each step is reversible, each leaves the codebase strictly better than it found it, and none of them require committing to the full eight-workstream plan up front. The original draft framed this as "roughly a month of work" — that estimate assumed a team cadence and is removed deliberately. At a solo-dev cadence the work happens on whatever evenings have enough focus for the next reversible step; see [*Solo Developer Operating Notes*](#solo-developer-operating-notes).

### Containment rule for the deferred hooks

Both reviewers independently flagged that deferring `useChat.ts` and `useAgentDelegation.ts` will backfire without active defense — Gemini called it the "Waterbed Effect" (complexity removed from the daemon gets pushed up into the hooks via dirty adapter code). The containment rule for this round:

- **No new policy logic in `useChat.ts` or `useAgentDelegation.ts`.** They may compose context and callbacks; they must not learn new semantics.
- If the tracing pass tries to add eight loose params or significant branching to either hook, **stop and extract a `CorrelationContext` helper first** instead of routing through props.
- If the verification extraction's handler-context shape changes the data shape flowing back through the hooks, the mapping happens in a typed adapter at the hook boundary — not inline in the hook body.

## Solo Developer Operating Notes

This plan was originally drafted in language inherited from team-scale remediation playbooks: "wait a week," "track over 30 days," "roughly a month of work." None of that vocabulary fits the actual operating context. Push has one developer working in scarce off-work time, no production user base generating edge cases, and no other engineers exercising the code in parallel. Calendar-time prescriptions are a proxy for *exposure* — the assumption is that more time means more independent runs across more situations. For a team with users that proxy is roughly accurate. For a solo project it is a category error, and the cost of accepting it is real: off-work hours burned waiting on an artificial clock instead of either using the tool or resting.

The rules below replace the calendar-time vocabulary everywhere it appears in this document.

### Replace calendar time with exposure

Anywhere this document says "wait N days" or "track for N days," read it as "use the tool yourself in N real coding sessions on real work." A real session means: opening Push to do something you would have done anyway — fix a bug, ship a small feature, navigate a codebase, run a verification — not a contrived smoke test. Two or three real sessions across distinct workflows is enough signal that a behavior-preserving extraction actually preserved behavior. If those sessions happen on consecutive days, you are done in a weekend. If the next session is two weeks out, the project is not getting worse while you wait.

### What "real usage" actually has to surface

For the verification-family extraction specifically, two failure modes are the ones that matter and the ones to watch for in passive use:

- **Any `WORKSPACE_CHANGED` error following `sandbox_check_types` then a file edit.** This is the regression class fixed in PR #298 and is where a botched extraction would surface first.
- **Any anomaly in `sandbox_run_tests` or `sandbox_verify_workspace` output** — wrong command sequence, missing card output, malformed result shape, mutation flag not set when it should be.

If neither appears across a handful of real sessions, the extraction is behavior-preserving and the next family is unblocked. If one does, you have a specific failure with a specific reproduction and the characterization tests from step 2 tell you exactly what broke.

### Lightweight observation log instead of metric dashboards

The descriptive metrics section above (co-churn, cross-module imports, interface surface area) is correct as a postmortem signal but wrong as a gate. Building a measurement system is itself a workstream, and at solo cadence the data is too sparse to reach significance for months. The pragmatic substitute:

- Keep a one-line note per real session in `docs/remediation-observations.md` (create on first use). Format: date, session purpose, "verification tools fine" or "hit X." Three green entries discharges the evaluation step for that extraction.
- When co-churn and dependency-direction questions come up at the *next* extraction, run the `git log --name-only` query then, against whatever history exists. A retrospective query is fine; a continuous dashboard is not worth building yet.

### Off-work-hours decision rules

The remediation plan is sequenced for safety, not for speed. At solo cadence the bottleneck is focused-evening time, not technical capacity. Two rules that make the difference between progress and burnout:

- **Don't start an architecture refactor in the last 30 minutes of an evening.** The characterization-test → extract → regression-check → commit cycle for one tool family is a 2–4 hour single-evening PR if nothing goes wrong. A 20-minute window is enough for re-reading the plan, jotting an observation, or fixing an unrelated small bug — none of which require committing to a refactor and then abandoning it half-done. The handler-context template in `sandbox-verification-handlers.ts` is a durable starting point; it will still be there next week.
- **An evening with no focused time is not a failed evening.** The 3,614-line dispatcher does not get worse while it sits. Step 6 has already landed; the architecture floor is strictly better than when this plan was drafted. Resting, shipping a feature, or fixing a bug you actually hit is a legitimate use of the slot. The fossilization risk in the snapshot was about *never starting*, and that risk is already discharged — you have a pattern, a contract, a runtime invariant, and a template.

### What this means for the next extraction

When a focused evening comes up and the mood is right, the next move is the git/release family per step 4's deferred list. The handoff prompt is the same as the verification family: characterization tests first (`sandbox_diff`, `sandbox_prepare_commit`, `sandbox_push`, `promote_to_github`), extract behind the existing handler-context shape, run the regression tests, commit. The fitness rules from the measurement section apply unchanged. There is no calendar gate between "verification feels stable in real use" and "start the next one."

## What this plan deliberately does **not** include

- **Splitting `useChat.ts` or `useAgentDelegation.ts`.** Both deserve the same treatment as `sandbox-tools.ts`, but only after the verification extraction has validated the handler-context pattern. Doing them in parallel multiplies risk.
- **Tearing out the v1 synthetic downgrade.** Migration debt cleanup is real but lower urgency than runtime invariants. Defer to the next snapshot.
- **A full taxonomy of the `app/src/lib/*` shims.** Codex listed this as step 8; it's a research task, not a remediation. Park it.

## CLI Runtime Parity

Three points have now surfaced where the CLI runtime lags the web runtime in ways that matter for agent quality, not just feature completeness. The doc's own rule — stated in the trailing sentence of [Open Question #4](#open-questions) — is that when a third such gap surfaces, it gets its own top-level section instead of living as scattered open questions and follow-up notes. That threshold is met as of 2026-04-17.

Each gap below lists its origin in this document, its current state, and the shape of the parity work. None of these are themselves Big Four remediation — they are CLI-specific runtime evolution that shares motivation with the wider plan, especially **supporting smaller/local models on the CLI**, where every reliability affordance the web runtime has matters more, not less.

### Gap 1 — Harness-adaptation layer

~~**Origin:** [Open Question #4](#open-questions) (resolved 2026-04-15: *port the adaptation layer, pending scoping*).~~ **Resolved 2026-04-17** upon reconnaissance for the orchestrator-delegation tranche. The port shipped earlier in the cycle; the section above was drafted from a stale premise and is corrected here.

**Evidence:**
- `cli/harness-adaptation.ts` implements `computeAdaptation()` with two adaptation rules: **Rule 1** (high malformed calls → floor `maxCoderRounds` at 20) and **Rule 2** (high edit error rate → shrink by 5, floor 15). Each rule is one-shot per session; state is scoped by `sessionId` via `stateBySession` so concurrent sessions in one `pushd` process do not interfere.
- `cli/engine.ts:584–615` calls `computeAdaptation(state.sessionId, maxRounds)` at the top of every round inside `runAssistantLoop`, emits a `harness.adaptation` session event and `dispatchEvent` when adaptation fires, and breaks the loop immediately if the new cap is already exceeded by the current round.
- CLI-side signal counters exist in `cli/tool-call-metrics.ts`, `cli/edit-metrics.ts`, and `cli/context-metrics.ts`. They are wired into the engine at the points that produce each signal: `recordMalformedToolCall` at `cli/engine.ts:792`, `recordWriteFile` at `cli/engine.ts:510`, `recordContextTrim` at `cli/engine.ts:644`.
- 16 passing tests in `cli/tests/harness-adaptation.test.mjs` cover signal collection, rule firing, idempotence across repeated per-round calls, the 15-round floor, session isolation, and the specific case where stale writes alone do not shrink via Rule 2 (error rate excludes stale).
- Provenance: `049cc667` (port), `0b9af006` (wire into `runAssistantLoop`), `32303a70` (review fixes).

**Intentional narrowing vs. the web version.** The CLI implements 2 of web's 4 adaptation rules. The omissions are structural, not incomplete:

- Web's "enable planner" branch is omitted because the CLI has no `plannerRequired` profile flag.
- Web's "enable context resets" branch (triggered by context pressure and high edit stale rate) is omitted because the CLI has no `contextResetsEnabled` profile flag.
- Web's truncation-specific rule is omitted because `cli/tools.ts` `detectAllToolCalls` does not emit a `truncated` malformed reason — truncated output surfaces as `json_parse_error`, which still counts toward Rule 1's malformed-call threshold.

Context pressure and edit stale rate are collected into `AdaptationSignals` as diagnostic signals but do not currently trigger round reduction on the CLI. If a future CLI feature introduces the equivalent of a context-reset concept, the signals can be wired to it without a new port pass.

**Retrospective note on the original scoping.** The remediation doc as of 2026-04-15 framed this port as three pieces (signal counters, `computeAdaptiveProfile`, wiring) with signal counters "probably the largest piece." All three were in fact already shipped before the 2026-04-17 CLI Runtime Parity section was drafted. The same-day correction is retained in place rather than deleted so future reads of this document understand that a drafted section can be overtaken by shipped work, and that a reconnaissance pass at section-draft time would have surfaced the state earlier.

### Gap 2 — Daemon-side role-capability enforcement

**Origin:** [Step 6 Follow-up](#agreed-sequencing-working-proposal-revised-after-council-review) (web-side shipped 2026-04-14).

**Corrected framing (2026-04-17, after reconnaissance).** The first draft of this section said the CLI/pushd path has no role-capability enforcement. That is not quite right and the correction matters for scoping.

**What actually exists today:** `makeDaemonExplorerToolExec` at `cli/pushd.ts:1345–1395` already refuses mutations at the executor boundary. The gate is `READ_ONLY_TOOLS.has(toolName)` (a local `Set` defined in `cli/tools.ts:72`) — any tool not in that set is rejected with a prose `resultText` denial before `executeToolCall` is invoked. Functionally, this blocks the same classes of calls as the web's `ROLE_CAPABILITY_DENIED` gate blocks for Explorer.

**What is actually missing:**

- **Structural divergence, not behavioral absence.** Web enforces via `roleCanUseTool(role, canonicalToolName)` → `getToolCapabilities` → shared `TOOL_CAPABILITIES` table (`lib/capabilities.ts:75`). CLI enforces via a local `READ_ONLY_TOOLS` allowlist. Both mechanisms block Explorer mutations today, but they are parallel sources of truth. Either side can drift silently as new tools are added; a tool added to CLI without a `READ_ONLY_TOOLS` update would go through, and a role grant narrowed on the shared table without a CLI sync would not propagate.
- **Taxonomy divergence.** Web returns `structuredError.type: 'ROLE_CAPABILITY_DENIED'` (greppable in logs, countable on dashboards, consumable by structured consumers). CLI returns a prose `resultText` message that only the agent kernel consumes as a user-visible message. The agent sees an equivalent refusal; operators cannot grep for it.
- **The shared capability vocabulary is web-centric.** `TOOL_CAPABILITIES` in `lib/capabilities.ts:75` is populated almost entirely with web-namespace tool names (`sandbox_read_file`, `sandbox_write_file`, `sandbox_exec`, etc.). Of the 11 entries in CLI's `READ_ONLY_TOOLS`, only `read_file`, `search_files`, and `web_search` have matching keys in the shared table. CLI's mutation tools (`write_file`, `edit_file`, `undo_edit`) and the exec family (`exec`, `exec_start`, `exec_poll`, `exec_write`, `exec_stop`, `exec_list_sessions`) are absent from the shared table entirely. This is the load-bearing piece that a blind port would trip over: `roleCanUseTool('explorer', 'write_file')` returns `true` today, because `getToolCapabilities('write_file')` returns `[]` and the function fails-open on unknown tools (`lib/capabilities.ts:213`).

**Shape of the real work (supersedes the earlier three-bullet list):**

1. **Extend the shared `TOOL_CAPABILITIES` table with CLI-native tool names.** ~16 additions: `list_dir`, `read_symbols`, `read_symbol`, `git_status`, `git_diff`, `git_commit`, `write_file`, `edit_file`, `undo_edit`, `save_memory`, `lsp_diagnostics`, `exec`, `exec_start`, `exec_poll`, `exec_write`, `exec_stop`, `exec_list_sessions`. Most of these are mechanical (read → `repo:read`, write → `repo:write`, commit → `git:commit`).
2. **Per-tool design calls required before implementation:**
   - **`exec_poll` / `exec_list_sessions`**: currently in `READ_ONLY_TOOLS` (Explorer can call them). Conceptually they are read-verbs over exec-family objects. Options: (a) assign `['sandbox:exec']` — coherent with the family, removes Explorer access (likely fine, since Explorer cannot start execs to poll); (b) introduce a finer `sandbox:exec:observe` capability granted to Explorer separately; (c) assign `['repo:read']` — semantically a stretch but preserves current access. Current default lean: (a).
   - **`ask_user`**: already in the shared table as `['user:ask']`, and Explorer's grant includes `user:ask`. A canonical swap would grant Explorer access to `ask_user` that it does not have today (`ask_user` is not in `READ_ONLY_TOOLS`). This is a behavior change — decide whether to accept it as "Explorer's intended capabilities catching up to the shared grant" or preserve current behavior by removing `user:ask` from Explorer's grant.
   - **`coder_update_state`**: handled pre-executor in both web and CLI (working-memory path, not the tool dispatch path). Adding it to `TOOL_CAPABILITIES` is defensive — it should not reach `makeDaemonExplorerToolExec` in practice. Decide whether to add anyway for defense-in-depth or explicitly document the pre-executor handling as the enforcement point.
3. **Swap the Explorer binding gate.** Replace `READ_ONLY_TOOLS.has(toolName)` with `roleCanUseTool('explorer', toolName)` in `makeDaemonExplorerToolExec`. Preserve the prose `resultText` for the Explorer kernel's user-message feedback loop. Add structured error emission with `type: 'ROLE_CAPABILITY_DENIED'` (already in `lib/error-types.ts:22`) so logs/dashboards can grep consistently with web.
4. **Test coverage mirroring `app/src/lib/web-tool-execution-runtime.test.ts:89`**: pin refusal behavior for at least one mutation tool and one exec-family tool, and pin the capability-table entries for CLI-native names so future drift breaks the test.
5. **Coder / Deep Reviewer / Auditor audits deferred.** Matches the Web rollout phasing — Explorer opts in first because its grant is narrow and well-understood. The other roles need their own capability-grant audits before the gate can be extended to them on CLI.

**Why this is no longer single-evening shaped.** The per-tool design calls (especially `exec_poll`/`exec_list_sessions` and `ask_user`) need real judgment and probably a brief design discussion, not a same-session decision. The ~16 tool additions are mechanical but touch shared code used by web tests (`app/src/lib/capabilities.test.ts:4`) which pin the table shape. Landing this in one rushed session risks either silently changing Explorer's tool access (the behavior-change vector) or misclassifying a capability in a way that surfaces months later. A 2–3 focused-evening shape with each design call surfaced for review is the honest scope.

**B-hybrid as a narrower alternative.** A smaller tranche that ships the observability/taxonomy win without the unification: keep `READ_ONLY_TOOLS` as the actual gate, add a structured error emission with `type: 'ROLE_CAPABILITY_DENIED'` on refusal, and call `roleCanUseTool` only as a shadow log for drift detection. This is a single-evening shape and does not risk silent behavior changes, but it does not solve the drift vector — the two sources of truth remain independent. Documented here for future revisit; not the current recommendation.

### Gap 3 — Orchestrator-driven task-graph execution and typed context memory in CLI

**Origin:** `docs/decisions/Web and CLI Runtime Contract.md` Near-Term Implications §2 (items 1 and 2). Product decision **2026-04-17**: yes, CLI should reach close parity on both.

**Why:** Delegation disproportionately helps smaller models, because narrow node-scoped contexts and prepared briefs keep work inside the reliability envelope that a 7B–20B model can actually hold. Typed context-memory retrieval compounds that effect — freshness-aware sectioned packing spends scarce tokens on signal rather than a kitchen-sink dump. For a CLI that is explicitly intended as a good shell for smaller/local models, making these web-only is the wrong shape.

**Current state:** Pushd already has task-graph *execution* wired. `handleSubmitTaskGraph` in `cli/pushd.ts:1579` drives `lib/task-graph.executeTaskGraph` through its own `runExplorerForTaskGraph` / `runCoderForTaskGraph` bindings, and delegation events are schema-validated via the 2026-04-14 hardening tranche (`cli/protocol-schema.ts`, the nine delegation event payloads, strict mode opt-in via `PUSH_PROTOCOL_STRICT=1`). What is missing is:

- **The front half** — orchestrator planning invoked from CLI user input, not just pre-built graphs arriving over the `submit_task_graph` RPC. No `cli/engine.ts` path produces a graph from a prompt today.
- **The observation surface** — the planned *Pushd Attach + Event Stream UX* work in ROADMAP:32 is still `planned`. Delegation events stream on the socket and `cli/v1-downgrade.ts:214–279` downgrades them to readable lines, but there is no transcript-first attach client.
- **Typed context-memory retrieval in the node runners** — each Explorer/Coder node currently receives whatever context its task brief hand-packs, not the sectioned freshness-ranked retrieval the web runtime performs for its own delegation path.
- **A TUI rendering path beyond line logging** — `cli/tui-delegation-events.ts` exists and handles events, but there is no DAG/node-focus widget.

**Shape of the work (sequenced):**

1. **Headless orchestrator spike** — wire `plan_tasks` into `cli/engine.ts` behind a `--delegate` flag, submit the produced graph through the existing `handleSubmitTaskGraph` RPC, and thread the landed `CorrelationContext` (`executionId`, `taskGraphId`, `taskId`) from day one rather than inventing new correlation plumbing. Validate on a small model via OpenRouter; the delta versus the non-delegated baseline on that model is the go/no-go signal for the rest of the tranche.
2. **Characterization tests for delegation outcomes and task-graph execution.** This is already listed as part of [Step 2 of the main sequencing](#agreed-sequencing-working-proposal-revised-after-council-review) but has not landed for the delegation path specifically. It must land before Step 3 modifies the node runners.
3. **Typed context-memory retrieval through `runExplorerForTaskGraph` / `runCoderForTaskGraph`.** Sectioned packing so each node gets freshness-ranked context, not a raw dump. Re-run the Step 1 spike on the same small model — that delta is the real small-model reliability signal for this gap.
4. **Attach + event stream UX.** Promote ROADMAP:32 to `in_progress`; ship a transcript-first attach client that groups subagent boundaries visibly.
5. **TUI graph widget.** Extend `cli/tui-delegation-events.ts` from line-logging to a DAG/node-focus view. Transcript-compatible — no full-screen graph mode that breaks muscle memory.

### Dependencies and parallelism between the gaps

With Gap 1 now resolved, the live gaps are Gap 2 and Gap 3:

- **Gap 3 Step 1 depends on Gap 2**, or at least on the Explorer-entry subset of it. Running Explorer task-graph nodes on CLI with a small model without execution-layer role-capability enforcement leaves a defense-in-depth hole that the web surface does not have. Gap 2 is effectively a prerequisite to Gap 3 Step 1 being safe with small models on the CLI.
- **Gap 1's already-shipped adaptation compounds with Gap 3's motivation.** The adaptive round-budget in `cli/harness-adaptation.ts` specifically helps the scenario a delegated small model will produce: more malformed calls and more edit errors than a frontier model on the same task. The graceful-degradation floor exists for Gap 3 to inherit; it is not a separate piece of work.

### What this section deliberately does **not** include

- **A unified CLI parity roadmap.** These are the currently-known gaps; a fourth should trigger a re-read of the architecture rating snapshot, not an incremental append here.
- **A timeline.** Solo-dev cadence applies. Each gap's work lives in one-to-several focused evenings; no calendar gate between them.
- **Phase 7 "Web-as-daemon-client" work.** Out of scope for v2.0 per `push-runtime-v2.md`; the dual-binding shape is [permanent](#agreed-sequencing-working-proposal-revised-after-council-review) (see Step 5). These parity gaps are about CLI catching up to Web's runtime *behaviors*, not unifying transports.

## Open questions

- ~~Is anyone using `pushd` as the primary transport yet, or is it still scaffold-grade in real use? The shim decision in step 5 depends on this.~~ **Resolved 2026-04-14: `pushd` is CLI-only.** `useAgentDelegation.ts` imports role kernels directly from `@/lib/`; no file under `app/src/` references the daemon at all. `Web and CLI Runtime Contract.md:202` and `push-runtime-v2.md` both mark Phase 7 "Web-as-daemon-client" as out of scope for v2.0. See step 5.
- Resolved by council review: tracing topology already exists via `withActiveSpan` in `tracing.ts:238` with call sites in `app/src/lib/coder-agent.ts:429`. The tracing pass is "plug the leaks" rather than "propagate from scratch."
- ~~Is there a measurement system in place that could record co-churn and dependency direction across the next batch of touching PRs, or does that need to be built?~~ **Resolved 2026-04-15: retrospective `git log --name-only` queries plus a small import-graph script, run at each extraction evaluation. No standing tooling.** Matches the solo-dev cadence: at this project's PR cadence, "10 touching PRs" may take weeks or months, and building a continuous dashboard before the data reaches significance is not worth the time cost. The prescriptive fitness rules (boundary / API / behavior / dependency / locality) remain the gate at merge; these descriptive metrics are a postmortem signal that informs whether the *next* extraction should follow the same pattern, not a prerequisite for starting one.
- ~~**CLI runtime parity with web: port the harness-adaptation layer, or accept the flat ceiling?**~~ **Resolved 2026-04-15: port the adaptation layer, pending scoping.** The web side runs `computeAdaptiveProfile()` at `app/src/lib/harness-profiles.ts:145–211` over four signal classes (malformed-call rate, truncation rate, context pressure, edit-error/stale rate) and *shrinks* `maxCoderRounds` mid-session when any escalate. The CLI's `runAssistantLoop` has no equivalent — `cli/engine.ts:119` is a flat `DEFAULT_MAX_ROUNDS`, bumped `8 → 30` in commit `4b9ebb3` after a Push CLI session exhausted the 8-round budget mid-edit on 2026-04-15 (see commit `bb4fccd` for the feature work that surfaced the limit). At a flat ceiling, a session running at 25% edit-error rate grinds all 30 rounds instead of cutting to 15 and exiting gracefully. The port has three pieces: **(a)** add CLI-side signal counters — `collectAdaptationSignals()` reads web-side telemetry state (malformed call counts, truncation events, edit error rates) the CLI doesn't currently track, so (a) is probably the largest piece; **(b)** port or parallel-implement `computeAdaptiveProfile` in the CLI engine; **(c)** wire it into `runAssistantLoop` at the round-increment boundary. Sequencing against plan step 4 (verification-family extraction) is not pre-committed — they touch different parts of the codebase and neither blocks the other; pick whichever has an evening of focus available first. Direct parallel to step 6's existing "Follow-up" on CLI role-capability enforcement; both are CLI runtime parity gaps. If a third parity gap surfaces, promote this bullet to its own top-level "CLI Runtime Parity" section. **Promoted 2026-04-17** after orchestrator-driven task-graph + typed memory in CLI surfaced as the third gap; full treatment now lives in the [CLI Runtime Parity](#cli-runtime-parity) section above. This bullet is retained as the provenance record for Gap 1.

## Council Review (2026-04-14)

After the first draft was written, the plan was reviewed by both Gemini and Codex via the `/council` skill. Both reviewers were given the same prompt and the same four hard questions (sequencing, first-extraction target, measurement signals, deferred hooks). Their reads converged on three of four questions and split on one. The body of this document has been updated in place to reflect the council's pushback; this section preserves what changed and why.

### Where the reviewers agreed

1. **Tracing-before-tests was wrong.** Both pushed back unanimously. Gemini wanted the order swapped outright; Codex was more nuanced — tracing-first is defensible only as a contract-definition + passive-instrumentation pass, not as a propagation rewrite. The revised sequencing reflects this: define the `CorrelationContext` contract first (step 1), pin behavior with characterization tests (step 2), then thread tracing through the existing seams (step 3).

2. **The four original measurement signals were too gameable.** Both reviewers flagged this independently. Gemini proposed metric-shaped fixes (co-churn, cross-module imports, interface surface area). Codex proposed rule-shaped fixes (boundary, API, behavior, dependency, locality). The revised section uses both — descriptive metrics plus prescriptive fitness rules — because neither alone is enough.

3. **Deferring `useChat.ts` and `useAgentDelegation.ts` needs active containment.** Gemini called this the "Waterbed Effect": complexity removed from the daemon gets pushed up into the hooks via dirty adapter code. Codex wanted a hard "no new policy logic in those hooks this round" rule. The containment rule in the sequencing section combines both flavors.

### Where the reviewers disagreed

**First extraction target.** Gemini picked read-only inspection on the grounds that verification involves child processes, stdout capture, timeouts, and non-deterministic outputs — conflating architectural refactoring with operational debugging. Codex picked verification despite the operational mess on the grounds that read-only inspection has hidden coupling to file version caches, file ledger state, symbol reads, and edit guards — it looks safe and isn't.

The plan keeps verification as the first target. Codex's argument is grounded in actually reading the code; the file-ledger coupling is a real thing in this codebase and would surface immediately. Gemini's caution about non-determinism is fair but addressable: the characterization tests pin the deterministic *contract* (command sequence, mutation flags, cache invalidation, card shapes) rather than asserting on flaky subprocess output.

### Material corrections from Codex's code reading

Codex spot-checked the codebase while answering and surfaced four factual corrections:

1. **Verification is not side-effect-free.** The first draft framed it that way. `sandbox_run_tests` (line 2451) marks the workspace mutated; `sandbox_check_types` (line 2599) can run `npm install`; `sandbox_verify_workspace` (line 2791) can install dependencies and run tests. Verification is "no GitHub side effects" but absolutely has filesystem and workspace side effects. The body of the plan now states this honestly.

2. **The tracing topology already exists.** `withActiveSpan` is at `tracing.ts:238` with call sites in `app/src/lib/coder-agent.ts:429`. The tracing pass is much smaller than the first draft framed it — "plug the leaks" rather than "build the topology."

3. **"Explorer cannot mutate" is not a fresh invariant.** It already exists at `explorer-policy.ts:20` and `tool-registry.ts:372`. Adding another hook-level check would be duplicate comfort, not a stronger guarantee. The useful new check is lower-level: the execution runtime itself should reject mutating tools when role is `explorer`, independent of policy-hook registration and registry construction. Step 6 was rewritten to reflect this.

4. **Test coverage for the verification family is uneven.** `sandbox-tools.test.ts:161` covers `sandbox_verify_workspace` but Codex couldn't find equivalent coverage for `sandbox_run_tests` or `sandbox_check_types`. Step 2 (characterization tests) now calls these out explicitly as the priority cases.

### Latent bug surfaced during review

~~Codex noticed during code reading that `sandbox_check_types` near line 2607 of `app/src/lib/sandbox-tools.ts` checks for `tsconfig.app.json` and `tsconfig.node.json` *after* an `ls` command that does not list those files.~~ **Resolved 2026-04-14 in commit `5e4b1d0` ("fix(tools): correct sandbox_check_types config detection").** The `ls -1 tsconfig.json pyrightconfig.json mypy.ini 2>/dev/null | head -1` detection was replaced with an explicit-priority `for f in tsconfig.json tsconfig.app.json tsconfig.node.json pyrightconfig.json mypy.ini; do [ -f "$f" ] && echo "$f" && break; done` loop that fixes both the missing-tsconfig-variants bug and the `ls` alphabetization bug (which would return `mypy.ini` ahead of `tsconfig.json` in projects that have both). Unit coverage for this path is still the step 2 characterization tests' job.

## Provenance

This document was produced from a 2026-04-14 working session reviewing Codex's eight-workstream remediation plan against the refreshed Architecture Rating Snapshot. The original eight-step plan is Codex's. The first-pass critique is Claude's. The body was revised after a `/council` review on 2026-04-14 in which both Gemini and Codex pushed back on three structural choices (sequencing, measurement signals, deferred-hook containment) and Codex surfaced four material corrections from spot-checking the code. All claims about line counts, file paths, and existing infrastructure are grounded in verified reads; tool-name taxonomy is grounded in actual `case` arms in `executeSandboxToolCall`.
