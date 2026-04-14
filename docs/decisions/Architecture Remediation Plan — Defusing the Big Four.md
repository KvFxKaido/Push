# Architecture Remediation Plan — Defusing the Big Four

Date: 2026-04-14
Status: Draft, working discussion (not a committed plan yet) — revised after council review on 2026-04-14
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

**Descriptive metrics (track over 30 days post-extraction):**

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

4. **Extract sandbox-tools verification family.** Move `sandbox_run_tests`, `sandbox_check_types`, `sandbox_verify_workspace` behind a handler-context shape. `executeSandboxToolCall` stays as the public dispatcher. **Stop here and evaluate the pattern** — don't start git/release until the verification extraction has been exercised under real usage for at least a week.

   Honest framing: verification is **not** side-effect-free. `sandbox_run_tests` marks the workspace mutated; `sandbox_check_types` can run `npm install`; `sandbox_verify_workspace` can install dependencies and run tests. Verification is "no GitHub side effects" but absolutely has filesystem and workspace side effects. It still beats the alternatives because read-only inspection has hidden coupling to file version caches, file ledger state, and edit guards (it looks safe and isn't), and git/release is too high-risk for a first proof of the extraction pattern.

5. ~~Decide~~ **Resolved: the `coder-agent.ts` web binding is a permanent boundary, formalized in `Web and CLI Runtime Contract.md`.** Evidence gathered 2026-04-14: `useAgentDelegation.ts` imports directly from `@/lib/coder-agent`, `@/lib/explorer-agent`, `@/lib/auditor-agent`, and `@/lib/task-graph` with no transport layer. Zero files under `app/src/` reference `pushd`, `daemon-client`, `DaemonClient`, `PUSHD_*`, or `DAEMON_*`. `Web and CLI Runtime Contract.md:202` states plainly that "today only pushd emits these envelopes and only CLI clients consume them." `push-runtime-v2.md` marks the Phase 7 "Web-as-daemon-client" flow as out of scope for v2.0 and future tense. The dual-binding shape (`lib/coder-agent.ts` kernel + `app/src/lib/coder-agent.ts` Web binding + `makeDaemonCoderToolExec` CLI binding) is the correct way to satisfy each shell's DI contract without pushing shell concerns into `lib/`. The same rule applies to the other role kernels. A new subsection in `Web and CLI Runtime Contract.md` captures the operating rule for this pattern. The web binding only shrinks or collapses if Phase 7 ever lands.

6. ~~**Harden one runtime invariant at the execution layer.**~~ **Landed 2026-04-14.** The execution runtime now refuses any tool a declared role cannot use, before hooks, approval gates, and Protect Main run. Mechanism: an opt-in `role?: AgentRole` field on `ToolExecutionContext` in `lib/tool-execution-runtime.ts`, plus a capability check at the top of `WebToolExecutionRuntime.execute()` that delegates to the existing `roleCanUseTool` from `lib/capabilities.ts`. Explorer opts in at the `executeReadOnlyTool` seam in `app/src/lib/agent-loop-utils.ts`; Coder, Deep Reviewer, and Auditor are unchanged this round because each needs its own capability-grant audit before opt-in — in particular the `reviewer` grant does not currently include `web:search`, which the deep-reviewer flow uses, so flipping the bit without an audit would regress that path. Signal met: 8 pinning tests in `app/src/lib/web-tool-execution-runtime.test.ts`, including the regression case where `hooks` and `approvalGates` are both `undefined` (the Explorer policy hook and the read-only registry are both absent) and a mutating tool is still refused with `structuredError.type === 'ROLE_CAPABILITY_DENIED'`. A new `ROLE_CAPABILITY_DENIED` entry in `ToolErrorType` makes this branch easy to grep from logs and dashboards. **Follow-up:** symmetric enforcement on the CLI/pushd path once a daemon-side `ToolExecutionRuntime` implementation lands (see `cli/pushd.ts` lines 2144/2159/2311/2338 for the Explorer entry points that will need the same opt-in), and capability-grant audits for the other three read-only-ish roles before they opt in.

That's roughly a month of work. Each step is reversible, each leaves the codebase strictly better than it found it, and none of them require committing to the full eight-workstream plan up front.

### Containment rule for the deferred hooks

Both reviewers independently flagged that deferring `useChat.ts` and `useAgentDelegation.ts` will backfire without active defense — Gemini called it the "Waterbed Effect" (complexity removed from the daemon gets pushed up into the hooks via dirty adapter code). The containment rule for this round:

- **No new policy logic in `useChat.ts` or `useAgentDelegation.ts`.** They may compose context and callbacks; they must not learn new semantics.
- If the tracing pass tries to add eight loose params or significant branching to either hook, **stop and extract a `CorrelationContext` helper first** instead of routing through props.
- If the verification extraction's handler-context shape changes the data shape flowing back through the hooks, the mapping happens in a typed adapter at the hook boundary — not inline in the hook body.

## What this plan deliberately does **not** include

- **Splitting `useChat.ts` or `useAgentDelegation.ts`.** Both deserve the same treatment as `sandbox-tools.ts`, but only after the verification extraction has validated the handler-context pattern. Doing them in parallel multiplies risk.
- **Tearing out the v1 synthetic downgrade.** Migration debt cleanup is real but lower urgency than runtime invariants. Defer to the next snapshot.
- **A full taxonomy of the `app/src/lib/*` shims.** Codex listed this as step 8; it's a research task, not a remediation. Park it.

## Open questions

- ~~Is anyone using `pushd` as the primary transport yet, or is it still scaffold-grade in real use? The shim decision in step 5 depends on this.~~ **Resolved 2026-04-14: `pushd` is CLI-only.** `useAgentDelegation.ts` imports role kernels directly from `@/lib/`; no file under `app/src/` references the daemon at all. `Web and CLI Runtime Contract.md:202` and `push-runtime-v2.md` both mark Phase 7 "Web-as-daemon-client" as out of scope for v2.0. See step 5.
- Resolved by council review: tracing topology already exists via `withActiveSpan` in `tracing.ts:238` with call sites in `app/src/lib/coder-agent.ts:429`. The tracing pass is "plug the leaks" rather than "propagate from scratch."
- Is there a measurement system in place that could record co-churn and dependency direction over 30 days, or does that need to be built? If it needs to be built, that may itself be a workstream — though most of it can be approximated by `git log --name-only` queries plus a small import-graph script.

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
